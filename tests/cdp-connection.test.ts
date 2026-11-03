import { describe, expect, it, vi } from 'vitest';
import { BrowserConnection } from '../core/browser-control/cdp';

/**
 * `BrowserConnection` 的附着生命周期。
 *
 * ⚠️ 这一组守的核心是**「假断开」不会发生** —— 先清内部状态再 await detach 的话，
 * 一次失败就会让本地以为断了、Chrome 侧仍挂着我们那条会话，而那个假状态**无法自愈**：
 * `attach` 会撞上「Another debugger is already attached」（指的是自己）、
 * `releaseUncontrollableTarget` 与 `onDetach` 监听读到的都是 null ⇒ 全部跳过。
 */

type SentCommand = { tabId: number; method: string };

const ENABLE_COMMANDS = [
  'Runtime.enable',
  'Page.enable',
  'DOM.enable',
  'Accessibility.enable',
  'Target.setAutoAttach',
];

function createChromeStub() {
  const attached: number[] = [];
  const detached: number[] = [];
  const sent: SentCommand[] = [];
  const detachListeners: Array<(source: { tabId?: number }) => void> = [];
  let attachedTabId: number | null = null;

  const chromeApi = {
    debugger: {
      attach: vi.fn(async ({ tabId }: { tabId: number }) => {
        if (attachedTabId === tabId) {
          throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
        }
        attachedTabId = tabId;
        attached.push(tabId);
      }),
      detach: vi.fn(async ({ tabId }: { tabId: number }) => {
        if (attachedTabId !== tabId) {
          throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
        }
        attachedTabId = null;
        detached.push(tabId);
      }),
      sendCommand: vi.fn(async ({ tabId }: { tabId: number }, method: string) => {
        sent.push({ tabId, method });
        return {};
      }),
      onDetach: {
        addListener: (listener: (source: { tabId?: number }) => void) => {
          detachListeners.push(listener);
        },
      },
      onEvent: { addListener: vi.fn() },
    },
  };

  return {
    chromeApi: chromeApi as unknown as typeof chrome,
    attached,
    detached,
    /** 浏览器侧实际发出的全部命令（按顺序）。 */
    sent,
    /** 只留 attach 之后的那批 enable 命令，顺序也被钉住。 */
    enableCommands: () => sent.map((command) => command.method)
      .filter((method) => ENABLE_COMMANDS.includes(method)),
    /** 模拟「用户按 F12」把浏览器侧会话顶掉。 */
    simulateExternalDetach(tabId: number) {
      attachedTabId = null;
      for (const listener of detachListeners) listener({ tabId });
    },
    /** 浏览器侧实际还挂着哪条标签（用来抓「本地说断了、Chrome 还挂着」）。 */
    get actuallyAttachedTabId() {
      return attachedTabId;
    },
  };
}

describe('browser connection attach lifecycle', () => {
  it('attaches and enables the CDP domains in order', async () => {
    const stub = createChromeStub();
    const connection = new BrowserConnection(stub.chromeApi);

    await connection.attach(7);

    expect(connection.tabId).toBe(7);
    expect(stub.attached).toEqual([7]);
    // ⚠️ 顺序也守：`Target.setAutoAttach` 必须最后发（它依赖前面几个域已启用）。
    expect(stub.enableCommands()).toEqual(ENABLE_COMMANDS);
  });

  it('is idempotent when attaching to the same tab twice', async () => {
    const stub = createChromeStub();
    const connection = new BrowserConnection(stub.chromeApi);

    await connection.attach(7);
    await connection.attach(7);

    // 第二次直接 return —— 不重复 attach、也不重复发 enable 命令。
    expect(stub.attached).toEqual([7]);
    expect(stub.enableCommands()).toHaveLength(ENABLE_COMMANDS.length);
  });

  it('drops the binding when an enable command fails, so the next attach retries it', async () => {
    // ⚠️⚠️ **这条守的是「假连接」** —— `attach` 先把 `attachedTabId` 置位、再发 5 条
    // enable。初始化中途失败却不收回绑定时，下一次 `attach(同一标签)` 会在
    // 「同一条就 return」处早退，**一条 enable 都不重发** ⇒ 那几个 CDP 域永远没启用
    // （`Accessibility.getFullAXTree` 依赖 `Accessibility.enable`、
    // `DOM.resolveNode` 依赖 `DOM.enable`），而 `attached` 报 `true`。
    // 那个中间态没有任何出口：`attach` 早退、`onDetach` 不触发、`detach` 又要有人调。
    const stub = createChromeStub();
    const connection = new BrowserConnection(stub.chromeApi);

    const realSendCommand = stub.chromeApi.debugger.sendCommand;
    let failed = false;
    stub.chromeApi.debugger.sendCommand = vi.fn(async (source, method, params) => {
      if (!failed && method === 'DOM.enable') {
        failed = true;
        throw new Error("'DOM.enable' wasn't found");
      }
      return realSendCommand(source, method, params);
    }) as unknown as typeof stub.chromeApi.debugger.sendCommand;

    await expect(connection.attach(7)).rejects.toThrow("'DOM.enable' wasn't found");
    expect(connection.tabId, '初始化失败不能留下绑定').toBeNull();
    expect(connection.attached).toBe(false);
    expect(stub.actuallyAttachedTabId, '浏览器侧也要真的卸掉').toBeNull();

    // 第二次 attach 必须重新走一遍全部 enable —— 否则「域没启用」这件事永远补不回来。
    // 第一次只发到 `DOM.enable` 就炸了（桩在 push 之前抛），所以这里看「第二批」是完整 5 条。
    await connection.attach(7);
    expect(connection.tabId).toBe(7);
    expect(stub.enableCommands().slice(-ENABLE_COMMANDS.length)).toEqual([...ENABLE_COMMANDS]);
    expect(stub.enableCommands().length).toBeGreaterThan(ENABLE_COMMANDS.length);
  });

  it('drops the binding even when the cleanup detach itself fails', async () => {
    // ⚠️ 与 `detach()` 的「失败保留绑定」方向相反：这条路的意图是**丢弃**这条半成品
    // 会话，所以 detach 也失败时仍要清掉本地绑定（否则下次 `attach` 会早退、永远不自愈）。
    const stub = createChromeStub();
    const connection = new BrowserConnection(stub.chromeApi);

    const realSendCommand = stub.chromeApi.debugger.sendCommand;
    stub.chromeApi.debugger.sendCommand = vi.fn(async (source, method, params) => {
      if (method === 'Runtime.enable') throw new Error('Command failed');
      return realSendCommand(source, method, params);
    }) as unknown as typeof stub.chromeApi.debugger.sendCommand;
    stub.chromeApi.debugger.detach = vi.fn(async () => {
      throw new Error('Extension context invalidated.');
    }) as unknown as typeof stub.chromeApi.debugger.detach;

    await expect(connection.attach(7)).rejects.toThrow('Command failed');
    expect(connection.tabId).toBeNull();
    expect(connection.attached).toBe(false);
  });
});

describe('browser connection detach lifecycle', () => {
  it('clears the binding once the detach succeeds', async () => {
    const stub = createChromeStub();
    const connection = new BrowserConnection(stub.chromeApi);
    await connection.attach(7);

    await connection.detach();

    expect(connection.tabId).toBeNull();
    expect(connection.attached).toBe(false);
    expect(stub.detached).toEqual([7]);
  });

  it('treats both "already gone" wordings as success', async () => {
    // ⚠️ 两种措辞来自不同 API：`chrome.tabs.*` 是 `No tab with id: N.`，
    // `chrome.debugger.*` 是 `No tab with given id N.`（Chromium `kNoTargetError`
    // 模板里 `given` 夹在中间）。只认前者会让「标签已经没了」掉进抛错分支。
    for (const message of [
      'Debugger is not attached to the tab with id: 7.',
      'No tab with id: 7.',
      'No tab with given id 7.',
    ]) {
      const stub = createChromeStub();
      const connection = new BrowserConnection(stub.chromeApi);
      await connection.attach(7);
      stub.chromeApi.debugger.detach = vi.fn(async () => {
        throw new Error(message);
      }) as unknown as typeof stub.chromeApi.debugger.detach;

      await expect(connection.detach(), message).resolves.toBeUndefined();
      expect(connection.tabId, message).toBeNull();
    }
  });

  it('keeps the binding when the detach fails for any other reason', async () => {
    // ⚠️⚠️ **这条是这一组的重点** —— 先清再 await 会让「假断开」永远自愈不了：
    // `attach` 撞上「already attached（自己）」、`releaseUncontrollableTarget` 与
    // `onDetach` 监听读到的都是 null ⇒ 全部跳过。保留绑定才是与 Chrome 一致的真相。
    const stub = createChromeStub();
    const connection = new BrowserConnection(stub.chromeApi);
    await connection.attach(7);
    stub.chromeApi.debugger.detach = vi.fn(async () => {
      throw new Error('Extension context invalidated.');
    }) as unknown as typeof stub.chromeApi.debugger.detach;

    await expect(connection.detach()).rejects.toThrow('Extension context invalidated');

    expect(connection.tabId, '失败时不能清掉绑定').toBe(7);
    // 浏览器侧确实还挂着 —— 本地状态与它一致，没有分叉。
    expect(stub.actuallyAttachedTabId).toBe(7);
  });

  it('retries the detach after a failure instead of silently claiming it succeeded', async () => {
    // 保留绑定的直接收益：下一次 detach 仍然知道该卸哪一条。
    const stub = createChromeStub();
    const connection = new BrowserConnection(stub.chromeApi);
    await connection.attach(7);

    const realDetach = stub.chromeApi.debugger.detach;
    stub.chromeApi.debugger.detach = vi.fn(async () => {
      throw new Error('Extension context invalidated.');
    }) as unknown as typeof stub.chromeApi.debugger.detach;
    await expect(connection.detach()).rejects.toThrow();

    stub.chromeApi.debugger.detach = realDetach;
    await connection.detach();

    expect(connection.tabId).toBeNull();
    expect(stub.detached).toEqual([7]);
  });

  it('detaches the previous target before switching tabs', async () => {
    const stub = createChromeStub();
    const connection = new BrowserConnection(stub.chromeApi);

    await connection.attach(7);
    await connection.attach(9);

    expect(stub.detached).toEqual([7]);
    expect(stub.attached).toEqual([7, 9]);
    expect(connection.tabId).toBe(9);
  });

  it('does not move the binding when switching tabs fails to detach the old one', async () => {
    // ⚠️ 换目标时旧会话卸不掉 ⇒ 这次 attach **必须失败**，而不是把绑定挪到新标签上
    // （否则旧那条会话永远没人认领，而新标签又以为自己是当前目标）。
    const stub = createChromeStub();
    const connection = new BrowserConnection(stub.chromeApi);
    await connection.attach(7);
    stub.chromeApi.debugger.detach = vi.fn(async () => {
      throw new Error('Extension context invalidated.');
    }) as unknown as typeof stub.chromeApi.debugger.detach;

    await expect(connection.attach(9)).rejects.toThrow('Extension context invalidated');

    expect(connection.tabId, '绑定必须仍指向旧标签').toBe(7);
    expect(stub.attached).toEqual([7]);
  });

  it('clears the binding when DevTools takes the session away', async () => {
    const stub = createChromeStub();
    const connection = new BrowserConnection(stub.chromeApi);
    await connection.attach(7);

    stub.simulateExternalDetach(7);

    // F12 顶掉会话时 Chrome 会发 onDetach —— 那一路本来就该清。
    expect(connection.tabId).toBeNull();
  });
});
/**
 * **已经取消的 signal 不许再发出一条命令。**
 *
 * ⚠️⚠️ 这条守的是「先副作用、后判取消」——`sendCommand` 原来是
 * 「先 `chrome.debugger.sendCommand(...)` 拿到 pending，再 `throwIfAborted(signal)`」。
 * 对 `Page.navigate` / `Input.dispatchMouseEvent` / `DOM.setFileInputFiles` 这类
 * **有副作用**的命令，signal 已经 abort 时命令**已经真的执行了**，而抛出来的文案
 * 还写着 "cancelled before it started"（说的是假话）。`raceWithAbort` 只负责「不再等」，
 * 收不回已经发出去的那一条。
 */
describe('cdp sendCommand respects an already-aborted signal', () => {
  it('does not dispatch the command at all', async () => {
    const stub = createChromeStub();
    const connection = new BrowserConnection(stub.chromeApi);
    await connection.attach(7);
    const before = stub.sent.length;

    const controller = new AbortController();
    controller.abort();

    await expect(
      connection.sendCommand('Page.navigate', { url: 'https://example.com/' }, controller.signal),
    ).rejects.toThrow();

    expect(
      stub.sent.slice(before).map((item) => item.method),
      '已经 abort 的 signal 不该发出任何命令',
    ).not.toContain('Page.navigate');
  });

  it('still dispatches when the signal is live', async () => {
    // 反向自检：上一条若写成「什么都不发」也能过 —— 这条证明正常路径没被误伤。
    const stub = createChromeStub();
    const connection = new BrowserConnection(stub.chromeApi);
    await connection.attach(7);
    const before = stub.sent.length;

    await connection.sendCommand('Page.navigate', { url: 'https://example.com/' }, new AbortController().signal);

    expect(stub.sent.slice(before).map((item) => item.method)).toContain('Page.navigate');
  });
});
