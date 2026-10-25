import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserControlToolDescriptors,
  shouldExposeBrowserControlTools,
} from '../core/browser-control/tool';
import {
  BrowserControlService,
  getBrowserControlElementPoint,
  getControllableState,
} from '../core/browser-control/service';
import {
  DEFAULT_BROWSER_CONTROL_SETTINGS,
  normalizeBrowserControlSettings,
} from '../core/browser-control/settings';
import { BROWSER_CONTROL_STORAGE_KEY } from '../core/browser-control/types';
import { formatAccessibilitySnapshot } from '../core/browser-control/snapshot';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser control settings and descriptors', () => {
  it('normalizes settings with browser control disabled by default', () => {
    const settings = normalizeBrowserControlSettings({
      enabled: true,
      targetTabId: 12,
      includeSnapshotAfterActions: false,
      maxSnapshotNodes: 10_000,
      maxSnapshotTextBytes: 1,
    });

    expect(normalizeBrowserControlSettings(null)).toEqual(DEFAULT_BROWSER_CONTROL_SETTINGS);
    expect(settings).toMatchObject({
      enabled: true,
      targetTabId: 12,
      includeSnapshotAfterActions: false,
      maxSnapshotNodes: 1500,
      maxSnapshotTextBytes: 4000,
    });
  });

  it('exposes the full browser tool set only after explicit enablement', async () => {
    const storage = new Map<string, unknown>();
    vi.stubGlobal('chrome', createChromeStub(storage));

    expect(await shouldExposeBrowserControlTools()).toBe(false);

    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
    });

    expect(await shouldExposeBrowserControlTools()).toBe(true);
    expect(createBrowserControlToolDescriptors('en').map((tool) => tool.name)).toEqual([
      'browser_navigate',
      'browser_go_back',
      'browser_go_forward',
      'browser_refresh',
      'browser_list_tabs',
      'browser_select_tab',
      'browser_close_tab',
      'browser_snapshot',
      'browser_click',
      'browser_hover',
      'browser_fill',
      'browser_fill_form',
      'browser_key',
      'browser_type',
      'browser_attach_file',
      'browser_wait_for',
      'browser_handle_dialog',
      'browser_evaluate_script',
    ]);
  });
});

describe('browser accessibility snapshot formatter', () => {
  it('formats AX nodes with stable element ids and backend node mapping', () => {
    const snapshot = formatAccessibilitySnapshot({
      url: 'https://example.com/',
      title: 'Example',
      maxNodes: 20,
      maxTextBytes: 4000,
      axNodes: [
        { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Example' }, childIds: ['2'] },
        { nodeId: '2', role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 42 },
      ],
    });

    expect(snapshot.result.text).toContain('URL: https://example.com/');
    expect(snapshot.result.text).toContain('[e2] button "Submit"');
    expect(snapshot.uidToBackendNodeId.get('e2')).toBe(42);
  });

  it('truncates snapshots by node and text budgets', () => {
    const snapshot = formatAccessibilitySnapshot({
      url: 'https://example.com/',
      title: 'Example',
      maxNodes: 1,
      maxTextBytes: 200,
      axNodes: [
        { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Example' }, childIds: ['2'] },
        { nodeId: '2', role: { value: 'button' }, name: { value: 'Second' }, backendDOMNodeId: 43 },
      ],
    });

    expect(snapshot.result.nodes).toHaveLength(1);
    expect(snapshot.result.truncated).toBe(true);
    expect(snapshot.result.text).toContain('...[snapshot truncated]');
  });
});

describe('browser element point calculation', () => {
  it('scrolls offscreen elements into view before returning a click point', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    let scrolled = false;
    button.scrollIntoView = vi.fn(() => {
      scrolled = true;
    });
    button.getBoundingClientRect = vi.fn(() => scrolled
      ? createRect({ left: 20, top: 100, width: 80, height: 40 })
      : createRect({ left: 20, top: 1200, width: 80, height: 40 }));

    const point = await getBrowserControlElementPoint.call(button);

    expect(button.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      inline: 'center',
      behavior: 'auto',
    });
    expect(point).toMatchObject({
      x: 60,
      y: 120,
      width: 80,
      height: 40,
      visible: true,
    });
  });
});

describe('browser navigation tool', () => {
  it('lists tabs when tabGroups is blocked by the browser', async () => {
    const storage = new Map<string, unknown>();
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'Example', url: 'https://example.com/' }),
    ]);
    Object.defineProperty(chromeStub, 'tabGroups', {
      get() {
        throw new Error("'tabGroups' is not allowed for specified extension ID.");
      },
    });
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const state = await service.getState();

    expect(state.supported).toBe(true);
    expect(state.targets).toHaveLength(1);
    expect(state.targets[0]).toMatchObject({
      id: 12,
      title: 'Example',
      groupName: undefined,
    });
  });

  it('opens a new tab by default so the chat tab is not replaced', async () => {
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: 12,
      includeSnapshotAfterActions: false,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'GLM', url: 'https://chat.z.ai/a/chat/s/current' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const result = await service.execute('browser_navigate', { url: 'https://example.com/' });

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      tabId: 100,
      url: 'https://example.com/',
      newTab: true,
    });
    expect(chromeStub.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com/', active: true });
    expect(chromeStub.debugger.attach).not.toHaveBeenCalled();
    expect(chromeStub.debugger.sendCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      'Page.navigate',
      expect.anything(),
    );
    await expect(chromeStub.tabs.get(12)).resolves.toMatchObject({
      url: 'https://chat.z.ai/a/chat/s/current',
    });
    await expect(chromeStub.storage.local.get(BROWSER_CONTROL_STORAGE_KEY)).resolves.toMatchObject({
      [BROWSER_CONTROL_STORAGE_KEY]: expect.objectContaining({ targetTabId: 100 }),
    });
  });

  it('can still replace the selected tab when newTab is explicitly false', async () => {
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: 12,
      includeSnapshotAfterActions: false,
    });
    // ⚠️ 这里刻意**不用 z.ai 的 URL**：z.ai 标签不可作为控制目标（见下面的排除用例），
    // 用它会让这条用例从「测导航」变成「测排除」，两条判据混在一起。
    // ⚠️ **起始 URL 与导航目标必须不同** —— 同值的话 `waitForTabUrl` 第一条就命中，
    // 「URL 真的变了」这件事不再被验证。
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'Example', url: 'https://example.com/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const result = await service.execute('browser_navigate', {
      url: 'https://example.org/',
      newTab: false,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      tabId: 12,
      url: 'https://example.org/',
      newTab: false,
    });
    expect(chromeStub.tabs.create).not.toHaveBeenCalled();
    expect(chromeStub.debugger.attach).toHaveBeenCalledWith({ tabId: 12 }, '1.3');
    expect(chromeStub.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 12 },
      'Page.navigate',
      { url: 'https://example.org/' },
    );
    await expect(chromeStub.tabs.get(12)).resolves.toMatchObject({
      url: 'https://example.org/',
    });
  });
});

/**
 * **z.ai 标签不能作为浏览器控制的目标。**
 *
 * ⚠️ 判据是 CDP 独占：`chrome.debugger.attach` 拒的是「同一个 tab + 同一个扩展」
 * （Chromium `debugger_api.cc` 的 `FindClientHost()` 按 `agent_host` + `extension_id` 匹配），
 * 而续跑期间的保活会话正挂在 z.ai 标签上 ⇒ 浏览器控制再 attach 必被拒，
 * 报「Another debugger is already attached」（这句含自己，容易被误读成「别的扩展」）。
 *
 * ⚠️ 让浏览器控制退一步，是因为两边代价不对称：保活挂了 ⇒ 页面被节流 ⇒ 续跑静默收尾且**零日志**；
 * 浏览器控制少一个目标 ⇒ 只是少一个可操作对象。
 */
describe('browser control: z.ai tabs are not controllable targets', () => {
  const ZAI_URLS = [
    'https://chat.z.ai/',
    'https://chat.z.ai/c/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
    'https://zchat.z.ai/',
  ];

  it.each(ZAI_URLS)('marks %s as blocked with a reason the panel can render', async (url) => {
    const storage = new Map<string, unknown>();
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'GLM', url }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const state = await service.getState();

    expect(state.targets).toHaveLength(1);
    expect(state.targets[0]).toMatchObject({ id: 12, controllable: false });
    expect(state.targets[0].reason).toMatch(/z\.ai/);
  });

  it('refuses to select a z.ai tab as the target', async () => {
    const storage = new Map<string, unknown>();
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'GLM', url: 'https://chat.z.ai/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    await expect(service.setTarget(12)).rejects.toMatchObject({
      code: 'browser_target_not_controllable',
    });
  });

  it('skips the z.ai tab when auto-picking a target', async () => {
    // ⚠️ **这条守的是最容易踩的那条路径**：`targetTabId` 为 null 时，自动挑选会先看
    // 「当前窗口的活动标签」—— 而用户正在 z.ai 里聊天时，那个标签就是 z.ai。
    // 不排除的话，浏览器控制会自己把 z.ai 选成目标，然后每次调用都撞 CDP 独占。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: null,
      includeSnapshotAfterActions: false,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'GLM', url: 'https://chat.z.ai/' }),
      createTab({ id: 13, active: false, title: 'Example', url: 'https://example.com/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const result = await service.execute('browser_snapshot', {});

    expect(result.ok).toBe(true);
    expect(chromeStub.debugger.attach).toHaveBeenCalledWith({ tabId: 13 }, '1.3');
    expect(chromeStub.debugger.attach).not.toHaveBeenCalledWith({ tabId: 12 }, '1.3');
  });

  it('keeps look-alike hosts and query strings controllable (exact origin match only)', () => {
    // ⚠️⚠️ **这条守的是「过度拦截」那一侧** —— 判据一旦被放宽成 `includes('z.ai')` 或
    // `hostname.endsWith('.z.ai')`，下面这些都会变成不可控，而 `contracts.ts` 的注释与
    // `zai-dual-site-contract.test.ts` 明确禁止后缀匹配（站点自己有 `zcode.z.ai` 这类同域子站）。
    // ⚠️ 上面那组正向用例抓不住放宽：它们只要求「z.ai 被拦」，放宽后照样拦得住。
    const cases = [
      'https://zcode.z.ai/',
      'https://chat.z.ai.evil.test/',
      'https://example.com/?u=z.ai',
      'https://example.com/?ref=chat.z.ai',
      'https://z.ai/',
      'https://space-z.ai/',
    ];
    for (const url of cases) {
      expect(getControllableState(url).controllable, url).toBe(true);
    }
  });

  it('refuses to navigate the controlled tab to z.ai', async () => {
    // ⚠️⚠️ **导航也是入口** —— `getControllableState` 只在选目标那一刻看 URL，
    // 把受控标签导到 z.ai 之后 debugger 就留在 z.ai 上了，而动作末尾的快照会重新解析目标、
    // 当场抛 `browser_target_missing`（表现成「导航成功却整条报失败」）。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: 12,
      includeSnapshotAfterActions: true,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'Example', url: 'https://example.com/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    // ⚠️ **`execute` 不 reject** —— 它把 `BrowserControlError` 收敛成 `{ ok: false, error }` 返回。
    // 这条用例原来写的是 `.rejects`，永远等不到 rejection（`execute` 的 catch 就是拦这个的）。
    const result = await service.execute('browser_navigate', {
      url: 'https://chat.z.ai/',
      newTab: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('browser_target_not_controllable');

    // 拒绝必须发生在 `Page.navigate` 之前 —— 否则标签已经被导过去了。
    expect(chromeStub.debugger.sendCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      'Page.navigate',
      expect.anything(),
    );
    await expect(chromeStub.tabs.get(12)).resolves.toMatchObject({ url: 'https://example.com/' });
  });

  it('refuses to walk the history into z.ai', async () => {
    // ⚠️ **前进 / 后退是第二个导航入口** —— 目的地来自历史记录，受控标签的历史里留一条
    // z.ai 记录就够了。这条与上一条同落点，只是路径不同。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: 12,
      includeSnapshotAfterActions: true,
    });
    const chromeStub = createChromeStub(
      storage,
      [createTab({ id: 12, active: true, title: 'Example', url: 'https://example.com/b' })],
      {
        history: {
          currentIndex: 1,
          entries: [
            { id: 71, url: 'https://chat.z.ai/' },
            { id: 72, url: 'https://example.com/b' },
          ],
        },
      },
    );
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const result = await service.execute('browser_go_back', {});

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('browser_target_not_controllable');
    // 拒绝必须发生在 `Page.navigateToHistoryEntry` 之前 —— 否则标签已经被导过去了。
    expect(chromeStub.debugger.sendCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      'Page.navigateToHistoryEntry',
      expect.anything(),
    );
    await expect(chromeStub.tabs.get(12)).resolves.toMatchObject({ url: 'https://example.com/b' });
  });

  it('keeps ordinary https tabs controllable', async () => {
    const storage = new Map<string, unknown>();
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'Example', url: 'https://example.com/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const state = await service.getState();

    expect(state.targets[0]).toMatchObject({ controllable: true });
  });
});

/**
 * **动作把受控标签带到不可控状态之后，附着必须被解除。**
 *
 * 触发形态：模型在一个普通标签上点了通往 z.ai 的链接（这里用 `evaluate_script` 改地址栏
 * 模拟同一件事 —— 两者都是「动作成功、标签的 URL 变了」）。不解除的话，下一轮续跑保活
 * 要 attach 同一个标签时会被拒，而保活调用方是 `void` + 内部 catch ⇒ 静默失效。
 */
describe('browser control: release a target that became uncontrollable', () => {
  it('takes the snapshot from the action tab and releases it afterwards', async () => {
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: 12,
      includeSnapshotAfterActions: true,
    });
    const chromeStub = createChromeStub(
      storage,
      [
        createTab({ id: 12, active: true, title: 'Example', url: 'https://example.com/' }),
        createTab({ id: 13, active: false, title: 'Other', url: 'https://example.org/' }),
      ],
      { evaluateLandsOn: 'https://chat.z.ai/' },
    );
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const result = await service.execute('browser_evaluate_script', { expression: 'location.href' });

    // 动作本身成功，且**不因为目标变了而报失败**。
    expect(result.ok).toBe(true);
    // ⚠️ 快照必须取自**动作那条标签**（12），不能「重新挑一个」落到 13 上。
    expect(result.output).toMatchObject({ tabId: 12 });
    expect(result.snapshot?.url).toBe('https://chat.z.ai/');
    // 附着被解除。
    expect(chromeStub.debugger.detach).toHaveBeenCalledWith({ tabId: 12 });
    expect(result.detail).toContain('Released control of tab 12');
  });

  it('releases even when snapshots after actions are turned off', async () => {
    // ⚠️ 这一条单独存在的原因：解除附着**不能只挂在快照路径上** —— 那个开关一关，
    // `createSnapshot` 整段就不跑，残留会静默留下。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: 12,
      includeSnapshotAfterActions: false,
    });
    const chromeStub = createChromeStub(
      storage,
      [createTab({ id: 12, active: true, title: 'Example', url: 'https://example.com/' })],
      { evaluateLandsOn: 'https://zchat.z.ai/' },
    );
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const result = await service.execute('browser_evaluate_script', { expression: 'location.href' });

    expect(result.ok).toBe(true);
    expect(result.snapshot).toBeUndefined();
    expect(chromeStub.debugger.detach).toHaveBeenCalledWith({ tabId: 12 });
  });

  it('releases on the failure exit too', async () => {
    // ⚠️⚠️ **这条守的是「两条出口都过」这个理由本身** —— 残留恰恰出现在失败路径上：
    // 前一次成功动作把连接留在了 12 上，本次动作在 `ensureAttached` **之前**就抛
    // （无可控标签 ⇒ `browser_target_missing`），那一刻不清就再没人清了。
    // 实测过：把失败分支改回直接 `return outcome`，其余用例**全绿**、只有这条会红。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: 12,
      includeSnapshotAfterActions: false,
    });
    const chromeStub = createChromeStub(
      storage,
      [createTab({ id: 12, active: true, title: 'Example', url: 'https://example.com/' })],
    );
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    // 第一次成功：连接停在 12 上（URL 不变，所以这一轮不触发清理）。
    const first = await service.execute('browser_evaluate_script', { expression: '1' });
    expect(first.ok).toBe(true);
    expect(chromeStub.debugger.attach).toHaveBeenCalledWith({ tabId: 12 }, '1.3');
    expect(chromeStub.debugger.detach).not.toHaveBeenCalled();

    // 12 变成不可控（点击跳走 / 页面自己跳走），且**没有别的可控标签** ⇒
    // 下一条动作在 attach 之前就抛 `browser_target_missing`。
    chromeStub.__setTabLocation(12, { url: 'https://chat.z.ai/' });
    const second = await service.execute('browser_snapshot', {});

    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe('browser_target_missing');
    expect(chromeStub.debugger.detach).toHaveBeenCalledWith({ tabId: 12 });
    // ⚠️ 失败结果原本没有 `output` ⇒ 不凭空造一个（否则面板会多一行无用的 JSON）。
    expect(second.output).toBeUndefined();
  });

  it('treats a pending navigation as uncontrollable even before it commits', async () => {
    // ⚠️ `chrome.tabs.get` 在导航**提交之前**返回的 `url` 还是旧地址，新地址只在
    // `pendingUrl` 里 —— 而「动作触发一次导航」正是最需要判准的时机。
    // ⚠️ 这条走 `getState()` 而不是走 release：两个字段分别是「旧地址」与「新地址」，
    // 判据本身（`describeTargetControllability`）要在**选目标那一刻**也生效，不只是清理时。
    const storage = new Map<string, unknown>();
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'Example', url: 'https://example.com/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    expect((await service.getState()).targets[0]).toMatchObject({ controllable: true });

    // 只有 `pendingUrl` 变 —— `url` 仍是旧地址。
    chromeStub.__setTabLocation(12, { pendingUrl: 'https://chat.z.ai/' });
    const state = await service.getState();

    expect(state.targets[0]).toMatchObject({ controllable: false });
    expect(state.targets[0].reason).toMatch(/z\.ai/);
  });
});

/**
 * **正在续跑保活的标签不许被关。**
 *
 * 关掉等于当场掐断那一轮续跑：内容脚本随标签一起消失，后台 DOM 任务收不到终态，
 * 只能等 180 秒的租约到期。
 */
describe('browser control: closing a kept-alive tab', () => {
  it('refuses to close the tab a continuation loop is keeping alive', async () => {
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: null,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'GLM', url: 'https://chat.z.ai/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({
      chromeApi: chromeStub as unknown as typeof chrome,
      tabKeepAlive: { isKeepingAlive: (tabId: number) => tabId === 12 },
    });
    const result = await service.execute('browser_close_tab', { tabId: 12 });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('browser_target_protected');
    expect(chromeStub.tabs.remove).not.toHaveBeenCalled();
  });

  it('still closes ordinary tabs while another tab is kept alive', async () => {
    // ⚠️ 反向用例：判据收窄到「就是保活那条」，不能放宽成「保活开着就谁都不许关」。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: null,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'GLM', url: 'https://chat.z.ai/' }),
      createTab({ id: 13, active: false, title: 'Other', url: 'https://example.org/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({
      chromeApi: chromeStub as unknown as typeof chrome,
      tabKeepAlive: { isKeepingAlive: (tabId: number) => tabId === 12 },
    });
    const result = await service.execute('browser_close_tab', { tabId: 13 });

    expect(result.ok).toBe(true);
    expect(chromeStub.tabs.remove).toHaveBeenCalledWith(13);
  });
});

function createTab(overrides: Partial<chrome.tabs.Tab> & { id: number }): chrome.tabs.Tab {
  return {
    id: overrides.id,
    windowId: overrides.windowId ?? 1,
    groupId: overrides.groupId ?? -1,
    active: overrides.active ?? false,
    title: overrides.title ?? '',
    url: overrides.url ?? 'about:blank',
    pendingUrl: overrides.pendingUrl,
    highlighted: false,
    incognito: false,
    index: 0,
    pinned: false,
    selected: false,
    discarded: false,
    frozen: false,
    autoDiscardable: true,
  };
}

function createRect(input: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  const { left, top, width, height } = input;
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => input,
  } as DOMRect;
}

function createChromeStub(
  storage: Map<string, unknown>,
  initialTabs: chrome.tabs.Tab[] = [],
  options: {
    history?: { currentIndex: number; entries: Array<{ id: number; url?: string }> };
    /** 模拟「脚本自己把页面导到别处」—— `Runtime.evaluate` 落地后该标签的 URL。 */
    evaluateLandsOn?: string;
  } = {},
) {
  let nextTabId = 100;
  let attachedTabId: number | null = null;
  const tabs = new Map<number, chrome.tabs.Tab>(
    initialTabs.map((tab) => [tab.id!, { ...tab }]),
  );

  return {
    /**
     * 测试专用：直接改一条标签的 `url` / `pendingUrl`。
     *
     * 用来造「动作之外发生的导航」（点击跳转、页面自己跳走）—— 桩里的
     * `Runtime.evaluate` / `Page.navigate` 只模拟**我们自己发起**的那两种。
     */
    __setTabLocation(tabId: number, next: { url?: string; pendingUrl?: string }): void {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id ${tabId}`);
      if (next.url !== undefined) tab.url = next.url;
      if (next.pendingUrl !== undefined) tab.pendingUrl = next.pendingUrl;
    },
    runtime: {
      id: 'extension-id',
      sendMessage: vi.fn(),
      getURL: vi.fn(),
      connectNative: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          for (const [key, storedValue] of Object.entries(value)) storage.set(key, storedValue);
        }),
      },
    },
    debugger: {
      attach: vi.fn(async (source: chrome.debugger.Debuggee) => {
        attachedTabId = source.tabId ?? null;
      }),
      detach: vi.fn(async (source: chrome.debugger.Debuggee) => {
        if (source.tabId === attachedTabId) attachedTabId = null;
      }),
      sendCommand: vi.fn(async (
        source: chrome.debugger.Debuggee,
        method: string,
        params?: Record<string, unknown>,
      ) => {
        if (source.tabId !== attachedTabId) throw new Error('No tab is attached.');
        if (method === 'Page.getNavigationHistory' && options.history) return options.history;
        if (method === 'Page.navigateToHistoryEntry' && options.history) {
          const entry = options.history.entries.find((item) => item.id === params?.entryId);
          const tab = tabs.get(source.tabId);
          if (tab && entry?.url) tab.url = entry.url;
        }
        if (method === 'Page.navigate' && typeof params?.url === 'string') {
          const tab = tabs.get(source.tabId);
          if (tab) tab.url = params.url;
        }
        if (method === 'Runtime.evaluate' && options.evaluateLandsOn) {
          const tab = tabs.get(source.tabId);
          if (tab) tab.url = options.evaluateLandsOn;
        }
        return {};
      }),
      onDetach: { addListener: vi.fn() },
      onEvent: { addListener: vi.fn() },
    },
    tabs: {
      query: vi.fn(async (queryInfo: chrome.tabs.QueryInfo = {}) => {
        let result = Array.from(tabs.values());
        if (queryInfo.active === true) {
          result = result.filter((tab) => tab.active);
        }
        if (queryInfo.currentWindow === true) {
          result = result.filter((tab) => tab.windowId === 1);
        }
        return result.map((tab) => ({ ...tab }));
      }),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return { ...tab };
      }),
      create: vi.fn(async (options: chrome.tabs.CreateProperties) => {
        const tab = createTab({
          id: nextTabId++,
          active: options.active === true,
          url: options.url ?? 'about:blank',
        });
        if (tab.active) {
          for (const existing of tabs.values()) {
            existing.active = false;
          }
        }
        tabs.set(tab.id!, tab);
        return { ...tab };
      }),
      update: vi.fn(async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        if (properties.active === true) {
          for (const existing of tabs.values()) {
            existing.active = false;
          }
          tab.active = true;
        }
        if (typeof properties.url === 'string') {
          tab.url = properties.url;
        }
        return { ...tab };
      }),
      remove: vi.fn(async (tabId: number) => {
        tabs.delete(tabId);
      }),
    },
    tabGroups: {
      // ⚠️ 必须返回数组：`listTargets` 是 `await tabGroups.query({}).catch(…)`，
      // 返回 `undefined` 时那个 `.catch` 直接抛 TypeError（`getState()` 整条挂掉）。
      query: vi.fn(async () => []),
    },
  };
}
