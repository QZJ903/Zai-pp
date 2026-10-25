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