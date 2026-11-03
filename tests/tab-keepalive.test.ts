import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabKeepAliveSession } from '../core/browser-control/tab-keepalive';
import { DEFAULT_TAB_KEEPALIVE_SETTINGS } from '../core/browser-control/keepalive-settings';

/**
 * 标签保活会话的行为。
 *
 * ⚠️ 这一组守三件事，全是 AST 断言够不到的部分（`core/browser-control/tab-keepalive.ts`
 * 不 import 站点模块，可以直接测行为）：
 * ① **两条命令都发出去**；② **按标签各一条、互不顶替**（并发的前提）；
 * ③ **前台不挂**（挂 debugger 会让 Chrome 在**所有窗口**画调试横幅，而前台不被节流）。
 */

type SentCommand = { tabId: number; method: string; params?: Record<string, unknown> };

interface StubOptions {
  /** 哪些标签是「前台」（active + 窗口有焦点）。默认全部后台。 */
  foreground?: readonly number[];
  /** 这些标签 `chrome.tabs.get` 会抛（模拟已关闭）。 */
  missing?: readonly number[];
}

function createChromeStub(options: StubOptions = {}) {
  const sent: SentCommand[] = [];
  const attached: number[] = [];
  const detached: number[] = [];
  const detachListeners: Array<(source: { tabId?: number }) => void> = [];
  const activatedListeners: Array<(info: { tabId: number }) => void> = [];
  const focusListeners: Array<(windowId: number) => void> = [];
  const foreground = new Set(options.foreground ?? []);
  const missing = new Set(options.missing ?? []);
  /** 被谁的会话占着（模拟「同一条标签上已有本扩展另一条 client host」）。 */
  let occupiedByOtherSession: number | null = null;

  const chromeApi = {
    tabs: {
      get: vi.fn(async (tabId: number) => {
        if (missing.has(tabId)) throw new Error(`No tab with id: ${tabId}.`);
        return { id: tabId, active: foreground.has(tabId), windowId: 1 };
      }),
      onActivated: {
        addListener: (listener: (info: { tabId: number }) => void) => {
          activatedListeners.push(listener);
        },
      },
    },
    windows: {
      get: vi.fn(async () => ({ id: 1, focused: true })),
      onFocusChanged: {
        addListener: (listener: (windowId: number) => void) => {
          focusListeners.push(listener);
        },
      },
    },
    debugger: {
      attach: vi.fn(async ({ tabId }: { tabId: number }) => {
        if (occupiedByOtherSession === tabId) {
          throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
        }
        attached.push(tabId);
      }),
      detach: vi.fn(async ({ tabId }: { tabId: number }) => {
        if (occupiedByOtherSession === tabId) {
          // 扩展作用域：放掉的是「我们自己」那条会话。
          occupiedByOtherSession = null;
          return;
        }
        detached.push(tabId);
      }),
      sendCommand: vi.fn(async (
        { tabId }: { tabId: number },
        method: string,
        params?: Record<string, unknown>,
      ) => {
        sent.push({ tabId, method, params });
        return {};
      }),
      onDetach: {
        addListener: (listener: (source: { tabId?: number }) => void) => {
          detachListeners.push(listener);
        },
      },
    },
  };

  return {
    chromeApi: chromeApi as unknown as typeof chrome,
    sent,
    attached,
    detached,
    /** 模拟「用户按 F12 / 页面刷新」把会话顶掉。 */
    simulateDetach(tabId: number) {
      for (const listener of detachListeners) listener({ tabId });
    },
    /** 模拟「浏览器控制那条会话还挂在同一条标签上」。 */
    occupyWithOtherSession(tabId: number) {
      occupiedByOtherSession = tabId;
    },
    /** 模拟标签切换：把这条设为前台，其余后台，并触发 onActivated。 */
    activate(tabId: number) {
      foreground.clear();
      foreground.add(tabId);
      for (const listener of activatedListeners) listener({ tabId });
    },
    get occupiedTab() {
      return occupiedByOtherSession;
    },
  };
}

function emulationCommands(sent: SentCommand[], tabId: number): string[] {
  return sent
    .filter((command) => command.tabId === tabId)
    .map((command) => command.method)
    .filter((method) => method === 'Emulation.setFocusEmulationEnabled'
      || method === 'Page.setWebLifecycleState');
}

/** 让 `syncAll()` 里那些 `void` 的异步跑完。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tab keepalive session', () => {
  it('is off by default — the debug banner is not something to opt users into', async () => {
    // ⚠️ 默认值来自 `DEFAULT_TAB_KEEPALIVE_SETTINGS`（单一真源）。
    // ⚠️⚠️ **这里要显式传 `enabled: false`** —— 它代表「开关值已确定、且是关的」。
    // 不传的话是「还没读到」（`enabledResolved === false`），那种状态故意按「开着」
    // 放行（见下一条用例），不能用它来测「默认关」。
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: false });

    expect(session.isEnabled).toBe(false);
    await session.want(7);
    expect(session.attachedTabIds).toEqual([]);
    expect(stub.attached).toEqual([]);
  });

  it('falls back to the default (off) once the switch value is resolved', async () => {
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi });
    // 构造时不传 ⇒ 未确定；显式 setEnabled 之后按真实值走。
    await session.setEnabled(DEFAULT_TAB_KEEPALIVE_SETTINGS.enabled);
    expect(session.isEnabled).toBe(DEFAULT_TAB_KEEPALIVE_SETTINGS.enabled);
    await session.want(7);
    expect(session.attachedTabIds).toEqual([]);
  });

  it('honours an explicit enabled: true from the caller', async () => {
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    expect(session.isEnabled).toBe(true);
    await session.want(7);
    expect(session.attachedTabIds).toEqual([7]);
  });

  it('sends both emulation commands when it attaches', async () => {
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    await session.want(7);

    // ⚠️ **两条缺一不可**：只发 lifecycle ⇒ 页面不冻结但仍自报 hidden；
    // 只发 focus ⇒ 自报 visible 但冻结/节流仍在。
    expect(stub.attached).toEqual([7]);
    expect(emulationCommands(stub.sent, 7)).toEqual([
      'Emulation.setFocusEmulationEnabled',
      'Page.setWebLifecycleState',
    ]);
  });

  it('does not attach while the tab is in the foreground', async () => {
    // ⚠️⚠️ **这条是「正常用的时候不该看到调试横幅」的核心。**
    // 挂 debugger 会让 Chrome 在**所有窗口**顶部画横幅，而前台页面本来不被节流 ⇒
    // 前台挂上去是纯代价。判据是 `tabs.active && windows.focused`，
    // **不能用 `document.hidden`**（它会被我们自己的焦点模拟改成 false）。
    const stub = createChromeStub({ foreground: [7] });
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    await session.want(7);

    expect(stub.attached).toEqual([]);
    expect(session.attachedTabIds).toEqual([]);
  });

  it('attaches once the tab goes to the background, and detaches when it comes back', async () => {
    // 意图登记之后，**切走 / 切回都要跟着动** —— 靠 tabs.onActivated 重算。
    const stub = createChromeStub({ foreground: [7] });
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });
    await session.want(7);
    expect(stub.attached).toEqual([]);

    stub.activate(9);           // 用户切到别的标签 ⇒ 7 变后台
    await settle();
    expect(stub.attached).toEqual([7]);

    stub.activate(7);           // 切回来 ⇒ 立刻卸，横幅随之消失
    await settle();
    expect(session.attachedTabIds).toEqual([]);
    expect(stub.detached).toEqual([7]);
  });

  it('keeps several tabs alive at once instead of replacing the previous one', async () => {
    // ⚠️⚠️ **两个自动化并发的前提**：旧实现只持一个 `tabId`，`attach` 第一件事是
    // 「挂着别的先 detach」⇒ 第二个标签一挂上就把第一个顶掉，而第一个正卡在发送链的
    // 短轮询里 ⇒ 被 Chrome 节流 ⇒ 静默收尾。
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    await session.want(7);
    await session.want(9);

    expect(session.attachedTabIds).toEqual([7, 9]);
    expect(stub.detached).toEqual([]);
    expect(emulationCommands(stub.sent, 7).length).toBe(2);
    expect(emulationCommands(stub.sent, 9).length).toBe(2);
  });

  it('releases only the requested tab', async () => {
    // ⚠️ **`unwant(tabId)` 只解这一条** —— 无参形式会一次性解掉所有标签，
    // 那正是并发时代「一方收尾、另一方被静默断掉」的成因。
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    await session.want(7);
    await session.want(9);
    await session.unwant(7);

    expect(stub.detached).toEqual([7]);
    expect(session.attachedTabIds).toEqual([9]);
    expect(session.isKeepingAlive(9)).toBe(true);
    expect(session.isKeepingAlive(7)).toBe(false);
  });

  it('re-applies the emulation on every sync, even when still attached', async () => {
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    await session.want(7);
    const afterFirst = emulationCommands(stub.sent, 7).length;
    await session.want(7);
    const afterSecond = emulationCommands(stub.sent, 7).length;

    // ⚠️ 每轮都要重发 —— 页面换了文档之后模拟状态不跟过去。
    expect(afterFirst).toBe(2);
    expect(afterSecond).toBe(4);
    // 没有重新 attach（会话还活着）。
    expect(stub.attached).toEqual([7]);
  });

  it('re-attaches after the session is dropped by DevTools', async () => {
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    await session.want(7);
    stub.simulateDetach(7);
    await session.want(7);

    // ⚠️ **F12 / 刷新会静默顶掉会话** —— 重挂是这一层唯一能自愈的地方。
    expect(stub.attached).toEqual([7, 7]);
    expect(emulationCommands(stub.sent, 7).length).toBe(4);
  });

  it('keeps the other tab alive when DevTools drops one of them', async () => {
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    await session.want(7);
    await session.want(9);
    stub.simulateDetach(7);

    expect(session.attachedTabIds).toEqual([9]);
  });

  it('treats an already-gone tab as success when detaching', async () => {
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });
    await session.want(7);

    stub.chromeApi.debugger.detach = vi.fn(async () => {
      throw new Error('Debugger is not attached to the tab with id: 7.');
    }) as unknown as typeof stub.chromeApi.debugger.detach;

    await expect(session.unwant(7)).resolves.toBeUndefined();
    expect(session.attachedTabIds).toEqual([]);
  });

  it('treats the debugger-API "given id" wording as success too', async () => {
    // ⚠️⚠️ **同样是「标签没了」，两个 API 的措辞不同**：
    // - `chrome.tabs.*` → `No tab with id: 7.`
    // - `chrome.debugger.*` → `No tab with given id 7.`
    //   （Chromium `debugger_api_constants.cc` 的 `kNoTargetError` 模板
    //   `"No * with given id *."`，展开后 `given` 卡在中间）
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });
    await session.want(7);

    stub.chromeApi.debugger.detach = vi.fn(async () => {
      throw new Error('No tab with given id 7.');
    }) as unknown as typeof stub.chromeApi.debugger.detach;

    await expect(session.unwant(7)).resolves.toBeUndefined();
    expect(session.attachedTabIds).toEqual([]);
  });

  it('keeps the tab bound when detach fails for any other reason', async () => {
    // ⚠️⚠️ **失败时要保留绑定** —— 先移除再 await 的话，内部状态与浏览器实际状态分叉：
    // 之后 `sync(sameTab)` 会重走 `attach`，而浏览器侧会话可能还挂着
    // ⇒ Chrome 报「another debugger already attached」⇒ 被调用方的空 catch 吞掉
    // ⇒ **保活从此静默不可用**。
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });
    await session.want(7);

    stub.chromeApi.debugger.detach = vi.fn(async () => {
      throw new Error('Extension context invalidated.');
    }) as unknown as typeof stub.chromeApi.debugger.detach;

    await expect(session.unwant(7)).rejects.toThrow('Extension context invalidated');
    expect(session.attachedTabIds, '非「已掉线」的失败不能清掉绑定').toEqual([7]);
  });

  it('rolls the session back when the emulation commands fail', async () => {
    const stub = createChromeStub();
    stub.chromeApi.debugger.sendCommand = vi.fn(async () => {
      throw new Error('Cannot access a chrome:// URL');
    }) as unknown as typeof stub.chromeApi.debugger.sendCommand;
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    // ⚠️ 命令发失败就把会话收回去 —— 留一条挂着的空会话只会挡住浏览器控制。
    await expect(session.want(7)).rejects.toThrow();
    expect(session.attachedTabIds).toEqual([]);
    expect(stub.detached).toEqual([7]);
  });

  it('releases a stale session on the same tab and retries the attach once', async () => {
    // ⚠️⚠️ `attach` 撞上 `Another debugger is already attached`（这句含自己，按
    // agent_host + extension_id 匹配到的是**本扩展**另一个 client host）时，
    // 先 detach 放掉它、再重试一次。
    const stub = createChromeStub();
    stub.occupyWithOtherSession(7);
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    await session.want(7);

    expect(session.attachedTabIds).toEqual([7]);
    expect(stub.occupiedTab, '重试前必须先放掉那条占位会话').toBeNull();
    expect(stub.attached).toEqual([7]);
  });

  it('does not retry when the tab is held by DevTools instead of our own session', async () => {
    // ⚠️ 反向用例：竞争者是用户按的 F12 时，我们这侧 detach 返回「未挂」，
    // 重试仍失败 ⇒ 最终行为与不重试时一致（抛给调用方），**不能无限重试**。
    const stub = createChromeStub();
    let attempts = 0;
    stub.chromeApi.debugger.attach = vi.fn(async () => {
      attempts += 1;
      throw new Error('Another debugger is already attached to the tab with id: 7.');
    }) as unknown as typeof stub.chromeApi.debugger.attach;
    stub.chromeApi.debugger.detach = vi.fn(async () => {
      throw new Error('Debugger is not attached to the tab with id: 7.');
    }) as unknown as typeof stub.chromeApi.debugger.detach;
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    await expect(session.want(7)).rejects.toThrow('already attached');
    expect(attempts).toBe(2);
    expect(session.attachedTabIds).toEqual([]);
  });

  it('propagates attach failures that are not about an occupied tab', async () => {
    const stub = createChromeStub();
    stub.chromeApi.debugger.attach = vi.fn(async () => {
      throw new Error('Cannot attach to this target.');
    }) as unknown as typeof stub.chromeApi.debugger.attach;
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    await expect(session.want(7)).rejects.toThrow('Cannot attach to this target.');
    expect(stub.detached).toEqual([]);
    expect(session.attachedTabIds).toEqual([]);
  });

  it('treats a tab that cannot be queried as foreground (fail safe: no banner)', async () => {
    // 查不到标签（已关 / chrome 出错）⇒ 按「前台」处理、不挂。失败方向安全：
    // 少挂一次只是可能被节流，多挂一次则会让用户看到横幅。
    const stub = createChromeStub({ missing: [7] });
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    await session.want(7);

    expect(stub.attached).toEqual([]);
  });
  it('attaches nothing while the switch is off, and drops what is already attached', async () => {
    // ⚠️ 开关关掉是个**用户可见的承诺**：不该再有横幅。所以已挂的必须立刻卸，
    // 而不是等下一次 sync（那可能永远不来 —— 循环早就结束了）。
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    await session.want(7);
    expect(stub.attached).toEqual([7]);

    await session.setEnabled(false);
    expect(session.isEnabled).toBe(false);
    // ⚠️ `stub.attached` 是「**曾经**挂过」的累计列表（stub 的 detach 不会把它移除），
    // 所以「当前还挂着几条」只能看 `session.attachedTabIds`。
    expect(session.attachedTabIds).toEqual([]);
    expect(stub.detached).toContain(7);

    // 关闭期间内容脚本仍然会发 START_TAB_KEEPALIVE —— 必须一条都挂不上。
    await session.want(9);
    expect(session.attachedTabIds).toEqual([]);
    expect(stub.attached).not.toContain(9);
  });

  it('does not resurrect old tabs when the switch is turned back on', async () => {
    // ⚠️ **关闭时要把 `wanted` 一起清掉** —— 留着的话，重新开启后 `syncAll()`
    // 会把一堆早就结束了的续跑标签全挂上（横幅永久亮着，而没有任何任务在跑）。
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    await session.want(7);
    await session.setEnabled(false);
    await session.setEnabled(true);
    await session.syncAll();

    expect(session.attachedTabIds).toEqual([]);
  });

  it('does not remember a want() that arrived while the switch was off', async () => {
    // ⚠️ 这条守的是 `want()` 里那个 `if (!this.enabled) return` ——
    // 去掉它的话，关闭期间收到的 START 会留在 `wanted` 里，重新开启后
    // `syncAll()` 就把那条标签挂上了（横幅亮着、而那个续跑可能早就结束了）。
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    await session.setEnabled(false);
    await session.want(9);          // 关闭期间内容脚本照旧会发 START
    await session.setEnabled(true);
    await session.syncAll();

    expect(session.attachedTabIds).toEqual([]);
    expect(stub.attached).not.toContain(9);
  });

  it('resumes honouring want() after the switch is turned back on', async () => {
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi, enabled: true });

    await session.setEnabled(false);
    await session.setEnabled(true);
    await session.want(7);

    expect(stub.attached).toEqual([7]);
    expect(session.isEnabled).toBe(true);
  });
  it('honours want() before the switch value is known (SW restart window)', async () => {
    // ⚠️⚠️ **这一格是 P1**：`background.ts` 启动时异步读开关，而内容脚本的
    // `START_TAB_KEEPALIVE` 可能先到。那时 `enabled` 还是构造默认值（false），
    // 但它**不代表用户的选择** —— 只是「还没读到」。
    // 直接 return 会把这一轮的意图丢掉，而没人会重放 ⇒ 第一次发送静默失去保护。
    // 方向不对称（多挂一次只是横幅闪一下，少挂一次是静默失败）⇒ 按「开着」放行。
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi });
    // 构造时没给 enabled ⇒ enabledResolved = false
    await session.want(7);
    expect(session.attachedTabIds).toEqual([7]);
  });

  it('stops honouring want() once the switch is known to be off', async () => {
    // ⚠️ 显式 `setEnabled(false)` 之后 `enabledResolved` 置位 ⇒ 行为回到「关掉就是关掉」，
    // 不会再因为「还没读到」放行。
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi });
    await session.setEnabled(false);
    await session.want(7);
    expect(session.attachedTabIds).toEqual([]);
  });

  it('settles enabledResolved even when setEnabled receives the same value', async () => {
    // ⚠️ 「构造默认是 false、显式 setEnabled(false)」这一格：若早退就永远不置位，
    // `want()` 会一直按「开着」放行 —— 用户的关闭动作静默失效。
    const stub = createChromeStub();
    const session = new TabKeepAliveSession({ chromeApi: stub.chromeApi });
    expect(session.isEnabled).toBe(false);
    await session.setEnabled(false);
    await session.want(7);
    expect(session.attachedTabIds).toEqual([]);
  });
});

describe('browser control settings write serialization', () => {
  it('does not lose a patch made while another patch is in flight', async () => {
    // ⚠️⚠️ `saveBrowserControlSettings` 是「读 → 合并 → 写」。不串行的话，后写者会拿
    // **自己的旧快照**覆盖前者 —— 真实场景：`browser_navigate { newTab:true }` 内部
    // 写 `targetTabId`，同时侧边栏在调 `maxSnapshotNodes`，先落地的那次被整条覆盖。
    // 判别点：两个**不同字段**的补丁，两次都必须留下。
    const storage = new Map<string, unknown>();
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => {
            const snapshot = { [key]: storage.get(key) };
            await delay(5);
            return snapshot;
          },
          set: async (value: Record<string, unknown>) => {
            await delay(1);
            for (const [key, storedValue] of Object.entries(value)) storage.set(key, storedValue);
          },
        },
      },
    });

    const { saveBrowserControlSettings, getBrowserControlSettings } = await import(
      '../core/browser-control/settings'
    );

    await Promise.all([
      saveBrowserControlSettings({ targetTabId: 42 }),
      saveBrowserControlSettings({ maxSnapshotNodes: 900 }),
    ]);

    const final = await getBrowserControlSettings();
    expect(final.targetTabId, '导航写下的目标不能被侧边栏的保存覆盖掉').toBe(42);
    expect(final.maxSnapshotNodes, '侧边栏的改动也不能被导航覆盖掉').toBe(900);
  });
});

describe('tab keepalive settings write serialization', () => {
  it('serializes two writers so neither reads a stale snapshot', async () => {
    // ⚠️ 与上面那条同因：`saveTabKeepaliveSettings` 也是「读 → 合并 → 写」。
    // ⚠️ `TabKeepaliveSettings` 目前只有一个字段，所以「值被覆盖」这件事看不出差别 ——
    // 判别力放在**读的时刻**上：不串行时两个写会**同时**读到 `undefined`（两次读的
    // 起始时间几乎相同），串行时第二次读必须发生在第一次 `set` **之后**。
    const storage = new Map<string, unknown>();
    const events: Array<'read' | 'write'> = [];
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => {
            events.push('read');
            const snapshot = { [key]: storage.get(key) };
            await delay(5);
            return snapshot;
          },
          set: async (value: Record<string, unknown>) => {
            events.push('write');
            await delay(1);
            for (const [key, storedValue] of Object.entries(value)) storage.set(key, storedValue);
          },
        },
      },
    });

    const { saveTabKeepaliveSettings } = await import('../core/browser-control/keepalive-settings');

    await Promise.all([
      saveTabKeepaliveSettings({ enabled: true }),
      saveTabKeepaliveSettings({ enabled: false }),
    ]);

    // 串行 ⇒ read,write,read,write；不串行 ⇒ read,read,write,write。
    expect(events).toEqual(['read', 'write', 'read', 'write']);
  });
});
