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

  it('keeps nodes and text in step when the text budget cuts first', () => {
    // ⚠️⚠️ **两个预算的截断点必须同源** —— 文本预算若判在 `nodes.push` 之后，
    // 撞线那个节点会进 `nodes` 与 `uidToBackendNodeId`，但它的行没进 `text`
    // ⇒ 模型按 `text` 看不见它，而 `browser_click { uid }` 照样能解析成功
    // ⇒ **看不见却能点**，`nodeCount` 也比实际可见的多 1。
    const axNodes = Array.from({ length: 4 }, (_, index) => ({
      nodeId: `n${index}`,
      role: { value: 'button' },
      name: { value: 'x'.repeat(100) },
      backendDOMNodeId: index + 1,
    }));
    const snapshot = formatAccessibilitySnapshot({
      url: 'u',
      title: 't',
      maxNodes: 400,
      maxTextBytes: 260,
      axNodes,
    });

    expect(snapshot.result.truncated).toBe(true);
    const textUids = [...snapshot.result.text.matchAll(/\[(e\d+)\]/g)].map((match) => match[1]);
    expect(snapshot.result.nodes.map((node) => node.uid)).toEqual(textUids);
    // 映射里也只能有文本里出现过的那些。
    expect([...snapshot.uidToBackendNodeId.keys()]).toEqual(textUids);
  });
});

describe('browser accessibility snapshot byte budget', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // ⚠️⚠️ 预算叫 `maxTextBytes`、面板文案写「字节数」，判据就必须是字节。
    // **构造上必须让两种判据分叉** —— 取 2_000 个「中」、预算 4_000：
    //   按码元：2_000 + 前缀 ≈ 2_050 < 4_000 ⇒ **不截断**，实际吐出 6_050 字节；
    //   按字节：6_000 + 前缀 > 4_000 ⇒ **截断**，实际 ≤ 4_000 字节。
    // 用 200 个「中」那种短名字测不出来：两种判据都不超，断言恒真。
    const name = '中'.repeat(2_000);
    const snapshot = formatAccessibilitySnapshot({
      url: 'u',
      title: 't',
      maxNodes: 400,
      maxTextBytes: 4_000,
      axNodes: [{ nodeId: '1', role: { value: 'button' }, name: { value: name }, backendDOMNodeId: 1 }],
    });
    expect(snapshot.result.truncated, '按字节判必须截断（按码元判会漏判）').toBe(true);
    expect(Buffer.byteLength(snapshot.result.text, 'utf8')).toBeLessThanOrEqual(4_000);
  });

  it('keeps a whole English line and drops a Chinese one under the same budget', () => {
    // ⚠️ 同预算下两种语言能放的节点数**本来就该不同** —— 中文一个字符占 3 字节。
    // 这条守的是「偏差方向」：按字节判时中文少放，按码元判时中文多放一倍。
    const build = (nameFor: (i: number) => string) => formatAccessibilitySnapshot({
      url: 'u',
      title: 't',
      maxNodes: 1_500,
      maxTextBytes: 24_000,
      axNodes: Array.from({ length: 3_000 }, (_, i) => ({
        nodeId: `n${i}`,
        role: { value: 'link' },
        name: { value: nameFor(i) },
        backendDOMNodeId: i + 1,
      })),
    });
    const chinese = build((i) => `订单 #${1000 + i} — 待发货，预计送达日期 2026-11-01，请联系客服确认地址`);
    const english = build((i) => `Order #${1000 + i} — Pending shipment, estimated delivery 2026-11-01`);

    expect(Buffer.byteLength(chinese.result.text, 'utf8')).toBeLessThanOrEqual(24_000);
    expect(Buffer.byteLength(english.result.text, 'utf8')).toBeLessThanOrEqual(24_000);
    expect(chinese.result.nodes.length, '中文一行更长，同预算下节点更少').toBeLessThan(
      english.result.nodes.length,
    );
  });

  it('counts the truncation marker against the budget instead of overshooting it', () => {
    // ⚠️⚠️ **截断标记是 25 字节，它自己也占预算** —— 判据原来在循环里、标记在判完
    // 之后才追加，最终 `text` 会比 `maxTextBytes` 多 25 字节。
    // 后果不是功能错，是**两处截断信号叠加**：英文页 24_000 字节 ≈ 24_000 字符，
    // 再进 `continuation.ts` 的 24_000 **字符** clamp 时会多出第二个 `...[truncated]`。
    // 判据：`text` 的 UTF-8 字节数**永远不超过预算**，含标记在内。
    const name = 'x'.repeat(60);
    for (const budget of [200, 1_000, 24_000]) {
      const snapshot = formatAccessibilitySnapshot({
        url: 'u',
        title: 't',
        maxNodes: 5_000,
        maxTextBytes: budget,
        axNodes: Array.from({ length: 2_000 }, (_, i) => ({
          nodeId: `n${i}`,
          role: { value: 'link' },
          name: { value: `${name}${i}` },
          backendDOMNodeId: i + 1,
        })),
      });
      expect(snapshot.result.truncated, `预算 ${budget} 应当截断`).toBe(true);
      expect(
        Buffer.byteLength(snapshot.result.text, 'utf8'),
        `预算 ${budget}：含截断标记在内不得超过预算`,
      ).toBeLessThanOrEqual(budget);
    }
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

    // ⚠️ **必须是 `'instant'`** —— `'auto'` 会尊重页面的 CSS `scroll-behavior`，
    // 页面写了 `smooth` 时滚动是异步的，紧接着的同步 `getBoundingClientRect()`
    // 读到的仍是旧位置。而这里**不能等一帧**（后台标签永远等不到 rAF）。
    expect(button.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      inline: 'center',
      behavior: 'instant',
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
describe('browser control: closing a tab that is running a continuation loop', () => {
  it('refuses to close it while the page reports a running loop', async () => {
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: null,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'GLM', url: 'https://chat.z.ai/' }),
    ]);
    chromeStub.__setContinuationRunning(12, true);
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const result = await service.execute('browser_close_tab', { tabId: 12 });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('browser_target_protected');
    expect(chromeStub.tabs.remove).not.toHaveBeenCalled();
  });

  it('protects it even when keep-alive is off and the tab is in the foreground', async () => {
    // ⚠️⚠️ **这条是 U16-4 的核心** —— 原来判的是 `isKeepingAlive`，而那个集合是
    // `wanted ∩ 真在后台` ⇒ **开关关着（默认值）** 或 **标签在前台** 时恒为 false，
    // 这两格恰恰是最常见的情况 ⇒ 默认配置下这条保护等于不存在。
    // 现在的判据由内容脚本直接回答「有没有续跑在跑」，与保活挂没挂无关。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: null,
    });
    const chromeStub = createChromeStub(storage, [
      // 前台标签：`active: true` —— `isKeepingAlive` 在这种标签上恒 false。
      createTab({ id: 12, active: true, title: 'GLM', url: 'https://chat.z.ai/' }),
    ]);
    chromeStub.__setContinuationRunning(12, true);
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({
      chromeApi: chromeStub as unknown as typeof chrome,
    });
    const result = await service.execute('browser_close_tab', { tabId: 12 });

    expect(result.error?.code).toBe('browser_target_protected');
    expect(chromeStub.tabs.remove).not.toHaveBeenCalled();
  });

  it('still closes ordinary tabs while another tab runs a continuation', async () => {
    // ⚠️ 反向用例：判据收窄到「就是那条标签」，不能放宽成「有续跑在跑就谁都不许关」。
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
    chromeStub.__setContinuationRunning(12, true);
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const result = await service.execute('browser_close_tab', { tabId: 13 });

    expect(result.ok).toBe(true);
    expect(chromeStub.tabs.remove).toHaveBeenCalledWith(13);
  });

  it('closes the tab when the content script cannot be reached', async () => {
    // ⚠️ **查不到就放行** —— 标签已关 / 内容脚本没注入 / 消息没回，一律按「没有续跑在跑」。
    // 失败方向：少拦一次只是退回改造前的行为，多拦一次会让用户关不掉一个正常标签。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: null,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: false, title: 'Other', url: 'https://example.org/' }),
    ]);
    chromeStub.tabs.sendMessage.mockImplementation(async () => {
      throw new Error('Receiving end does not exist.');
    });
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const result = await service.execute('browser_close_tab', { tabId: 12 });

    expect(result.ok).toBe(true);
    expect(chromeStub.tabs.remove).toHaveBeenCalledWith(12);
  });
});

describe('browser control: closeTab does not overwrite a concurrent target change', () => {
  it('keeps a target that was changed while the tab was being removed', async () => {
    // ⚠️⚠️ **判据必须落在写盘那一刻** —— `closeTab` 尾部原来是「用开函数时读的 settings
    // 判断要不要清空」，而中间隔着 `await tabs.remove`。实测：target 12 → 关 12 期间
    // 侧边栏把 target 改成 13 → 结果被旧快照覆盖成 null（U2-4 同族）。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: 12,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'A', url: 'https://a.example/' }),
      createTab({ id: 13, active: false, title: 'B', url: 'https://b.example/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    // 在 remove 的 await 窗口里改 target —— 模拟侧边栏同时操作。
    // ⚠️ **必须取 `getMockImplementation()` 而不是 `chromeStub.tabs.remove` 本身** ——
    // 后者是同一个 vi.fn，在它自己的 mockImplementation 里调它就是无限递归（第一版踩过）。
    const realRemove = chromeStub.tabs.remove.getMockImplementation()!;
    chromeStub.tabs.remove.mockImplementation(async (tabId: number) => {
      await realRemove(tabId);
      storage.set(BROWSER_CONTROL_STORAGE_KEY, {
        ...(storage.get(BROWSER_CONTROL_STORAGE_KEY) as Record<string, unknown>),
        targetTabId: 13,
      });
    });

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const result = await service.execute('browser_close_tab', { tabId: 12 });

    expect(result.ok).toBe(true);
    expect(
      (storage.get(BROWSER_CONTROL_STORAGE_KEY) as { targetTabId?: number }).targetTabId,
      '侧边栏刚设的 target 不能被 closeTab 的旧快照清掉',
    ).toBe(13);
  });

  it('still clears the target when the closed tab is still the current one', async () => {
    // 反向用例：关的正好是当前 target ⇒ 必须清空，否则会留下一条指向已关闭标签的绑定。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: 12,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'A', url: 'https://a.example/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const result = await service.execute('browser_close_tab', { tabId: 12 });

    expect(result.ok).toBe(true);
    expect(
      (storage.get(BROWSER_CONTROL_STORAGE_KEY) as { targetTabId?: number | null }).targetTabId,
    ).toBeNull();
  });
});

describe('browser fill writes through the native value setter', () => {
  it('bypasses the page framework value tracker instead of tripping it', async () => {
    // ⚠️⚠️ **判据不是「原生 setter 有没有被调到」** —— `input.value = x` 走的是原型上的
    // 原生 setter，**两种写法都会调到它**。真正的分界是 React 那层 **value tracker**：
    // React 在元素**自身**上装一个 `value` 访问器记录「我上次写下去的值」，并在 `input`
    // 事件里比对「DOM 当前值 vs 记录值」——直接赋值把记录值一起改了 ⇒ 判定「没变化」
    // ⇒ state 不更新 ⇒ 页面下一次重渲染把 DOM 值**回写成旧值**。
    // `Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, x)` 绕开自身那层，
    // 记录值不变 ⇒ React 看得到变化。
    // ⇒ 这里在元素**自身**装一个仿 React 的 tracker，断言 tracker **没**被碰到。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: 12,
      includeSnapshotAfterActions: false,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'Example', url: 'https://example.com/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    const input = document.createElement('input');
    document.body.append(input);

    // 仿 React 的 value tracker：装在元素自身，直接赋值会被它接住。
    const nativeDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    let tracked = '';
    let trackerHits = 0;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() { return tracked; },
      set(next: string) { trackerHits += 1; tracked = next; },
    });

    try {
      chromeStub.debugger.sendCommand.mockImplementation(async (
        _source: chrome.debugger.Debuggee,
        method: string,
        params?: Record<string, unknown>,
      ) => {
        if (method === 'Runtime.evaluate') return { result: { objectId: 'element-1', subtype: 'node' } };
        if (method === 'Runtime.callFunctionOn') {
          const declaration = String(params?.functionDeclaration ?? '');
          const args = (params?.arguments ?? []) as Array<{ value: unknown }>;
          const fn = new Function(`return (${declaration});`)() as (
            this: HTMLElement,
            value: string,
          ) => unknown;
          return { result: { value: fn.call(input, String(args[0]?.value)) } };
        }
        return {};
      });

      const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
      const result = await service.execute('browser_fill', { selector: '#target', value: 'hello' });

      expect(result.ok).toBe(true);
      expect(nativeDescriptor.get!.call(input), '原生值必须真的被写进去').toBe('hello');
      // ⚠️ 判据只用 `trackerHits` —— 上面那个 getter 拦住了 `nativeDescriptor.get.call`，
      // 所以 `tracked` 在这里读不到真实值，拿它做断言会恒真。
      expect(trackerHits, '不能碰元素自身的 value tracker —— 碰了 React 就看不见这次变化').toBe(0);
    } finally {
      delete (input as unknown as Record<string, unknown>).value;
    }
  });
});

describe('browser control: switching targets drops the snapshot uid map', () => {
  it('re-resolves a uid from the new tab instead of reusing the old backendNodeId', async () => {
    // ⚠️ `uidToBackendNodeId` 里的 uid 是**快照当时那条标签**的 `backendNodeId`。
    // 换标签之后不清的话，`browser_click { uid: 'e1' }` 不会重新拍快照
    // （映射里还有 `e1`），直接拿旧标签的 nodeId 去新标签上 `DOM.resolveNode`。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: 12,
      includeSnapshotAfterActions: false,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'A', url: 'https://example.com/' }),
      createTab({ id: 13, active: false, title: 'B', url: 'https://example.org/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    // 每次快照只给一个节点，`backendNodeId` 跟着当前标签走（12 → 1200、13 → 1300）。
    const axTree = (tabId: number | undefined) => ({
      nodes: [{
        nodeId: '1',
        role: { value: 'button' },
        name: { value: `on-${tabId}` },
        backendDOMNodeId: (tabId ?? 0) * 100,
      }],
    });
    let snapshotTabId: number | null = null;
    let resolvedBackendNodeId: number | null = null;
    chromeStub.debugger.sendCommand.mockImplementation(async (
      source: chrome.debugger.Debuggee,
      method: string,
      params?: Record<string, unknown>,
    ) => {
      if (method === 'Accessibility.getFullAXTree') {
        snapshotTabId = source.tabId ?? null;
        return axTree(source.tabId);
      }
      if (method === 'DOM.resolveNode') {
        resolvedBackendNodeId = (params as { backendNodeId?: number } | undefined)?.backendNodeId ?? null;
        return { object: { objectId: 'node-1' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { x: 1, y: 1, width: 2, height: 2, visible: true } } };
      }
      return {};
    });

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });

    // ① 在标签 12 上拍一张快照，`e1` 指向 1200。
    await service.execute('browser_snapshot', {});
    expect(snapshotTabId).toBe(12);

    // ② 换到标签 13 —— 必须清掉那份 uid 映射。
    await service.execute('browser_select_tab', { tabId: 13 });

    // ③ 用旧 uid 点一下：映射已清 ⇒ 会重新拍快照（取自 13），解析到 1300。
    const click = await service.execute('browser_click', { uid: 'e1' });
    expect(click.ok).toBe(true);
    expect(snapshotTabId, '旧 uid 必须重新拍快照，且取自新标签').toBe(13);
    expect(resolvedBackendNodeId, '不能拿旧标签的 backendNodeId 去新标签上解析').toBe(1300);
  });
});

describe('browser attach_file rejects an empty file list', () => {
  it('does not silently clear the file input', async () => {
    // ⚠️ `[].every(...)` 恒 `true` —— 只写 `every` 的话空数组会通过「非空数组」校验，
    // 而 `DOM.setFileInputFiles` 收空数组是**清空**文件选择，不是报错。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: 12,
      includeSnapshotAfterActions: false,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'Example', url: 'https://example.com/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const result = await service.execute('browser_attach_file', { selector: '#f', files: [] });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('browser_invalid_files');
    // ⚠️⚠️ **匹配器个数必须与生产的实参个数一致（三个）** ——
    // `BrowserConnection.sendCommand` 是 `sendCommand(session, method, params)` 三参调用
    // （`cdp.ts`）。写成四个 `expect.anything()` 时，参数个数不同即不相等，
    // 这条**负向**断言永远通过 —— 「空数组不发命令」一点没钉住。
    // 判据是「把它改成恒真也能过」：删掉生产里的 `files.length === 0` 那道判据，
    // 本条必须红；改前不会。
    expect(chromeStub.debugger.sendCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      'DOM.setFileInputFiles',
      expect.anything(),
    );
  });
});

describe('browser key dispatch', () => {
  async function runKey(key: string) {
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: 12,
      includeSnapshotAfterActions: false,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'Example', url: 'https://example.com/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);
    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const result = await service.execute('browser_key', { key });
    const dispatches = chromeStub.debugger.sendCommand.mock.calls
      .filter((call) => call[1] === 'Input.dispatchKeyEvent')
      .map((call) => call[2] as Record<string, unknown>);
    return { result, dispatches };
  }

  it('sends a character key as keyDown with text, not rawKeyDown', async () => {
    // ⚠️⚠️ CDP 规范：`text` 参数「Not needed for `keyUp` and `rawKeyDown` events」
    // ⇒ `rawKeyDown` **不产生字符输入**。原来恒用 `rawKeyDown`，于是
    // `browser_key { key: 'a' }` 在页面上什么都不发生，而工具描述写的是「or a character」。
    const { result, dispatches } = await runKey('a');
    expect(result.ok).toBe(true);
    expect(dispatches[0]).toMatchObject({ type: 'keyDown', key: 'a', text: 'a', unmodifiedText: 'a' });
    // `keyUp` 不带 `text`（规范：对 keyUp 无意义）。
    expect(dispatches[1]).toMatchObject({ type: 'keyUp', key: 'a' });
    expect(dispatches[1]).not.toHaveProperty('text');
  });

  it('keeps special keys on rawKeyDown', async () => {
    // 反向用例：Enter 这类键**不该**带 `text`，否则页面会收到一个字符事件。
    const { result, dispatches } = await runKey('Enter');
    expect(result.ok).toBe(true);
    expect(dispatches[0]).toMatchObject({ type: 'rawKeyDown', key: 'Enter', code: 'Enter' });
    expect(dispatches[0]).not.toHaveProperty('text');
  });

  it('does not fabricate code / virtual key code for non-ASCII characters', async () => {
    // `Key中` 与 20013 都是编出来的假值，喂给 CDP 只会让页面的 KeyboardEvent 带一身错数据。
    const { result, dispatches } = await runKey('中');
    expect(result.ok).toBe(true);
    expect(dispatches[0]).toMatchObject({ type: 'keyDown', key: '中', text: '中' });
    expect(dispatches[0]).not.toHaveProperty('code');
    expect(dispatches[0]).not.toHaveProperty('windowsVirtualKeyCode');
  });
});

describe('browser control: snapshot text appears exactly once per result', () => {
  it('keeps the snapshot body in detail only, not duplicated inside output', async () => {
    // ⚠️⚠️ **同一份快照文本在一条结果里出现过两次** —— `detail` 一份、`output.snapshot.text`
    // 一份。实测一份 400 节点的中文列表页：两份合计 64,865 字节，去掉之后 31,865 字节。
    // 而进模型时两份都会被各自裁掉（detail 4000 字符 / output 8000 字符），
    // **裁下来的还都是同一份文本的开头** ⇒ 第二次纯属浪费，而且 output 那份是 JSON
    // 转义形态（换行占两字符），同样的可见字符要多花约 7% 的长度。
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

    chromeStub.debugger.sendCommand.mockImplementation(async (
      _source: chrome.debugger.Debuggee,
      method: string,
    ) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [{
            nodeId: '1',
            role: { value: 'button' },
            name: { value: 'SNAPSHOT-BODY-MARKER' },
            backendDOMNodeId: 7,
          }],
        };
      }
      // `resolveElement` 走 `Runtime.evaluate(document.querySelector(...))`，要回一个 objectId。
      if (method === 'Runtime.evaluate') return { result: { objectId: 'element-1', subtype: 'node' } };
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { x: 1, y: 1, width: 2, height: 2, visible: true } } };
      }
      return {};
    });

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const result = await service.execute('browser_click', { selector: '#b' });

    expect(result.ok).toBe(true);
    // 正文在 detail 里（模型与面板都从这里读）。
    expect(result.detail).toContain('SNAPSHOT-BODY-MARKER');
    // ⚠️ output 里**不能再有一份** —— 只留元数据。
    const snapshotOutput = (result.output as { snapshot?: Record<string, unknown> }).snapshot;
    expect(snapshotOutput, 'output.snapshot 的元数据仍要在').toBeDefined();
    expect(snapshotOutput).not.toHaveProperty('text');
    expect(snapshotOutput).toMatchObject({ url: 'https://example.com/', nodeCount: 1 });
    // ⚠️ **`output` 与 `detail` 合起来只该有一份正文** —— 这两个才是会落库、会进模型的
    // 那两个字段（`BrowserActionResult.snapshot` 是 service 内部字段，
    // `executeBrowserControlToolCall` 只从它取 `truncated`）。
    const surfaced = JSON.stringify({ detail: result.detail, output: result.output });
    expect(surfaced.split('SNAPSHOT-BODY-MARKER').length - 1).toBe(1);
  });
});

describe('browser control: no list_tabs exemption when disabled', () => {
  it('rejects every browser tool while the feature is off', async () => {
    // ⚠️⚠️ **那条 `name !== 'browser_list_tabs'` 豁免曾经是死分支** —— 工具能不能被调到
    // 取决于它在不在目录里，而 `shouldExposeBrowserControlTools()` 在 `enabled === false`
    // 时返回 `[]` ⇒ 模型根本没有这个名字可调。唯一能命中的是「目录按开启态构建完、
    // 执行前用户关掉开关」那个竞态窗口。
    // ⚠️ 这条用例守两件事：① 关闭时 `list_tabs` 不再被特殊对待；
    // ② 目录门与执行门**口径一致**（目录门关掉的东西，执行门也必须关掉）。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: false,
      targetTabId: 12,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'Example', url: 'https://example.com/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    // 目录门：关闭时一个浏览器工具都不暴露。
    expect(await shouldExposeBrowserControlTools()).toBe(false);

    // 执行门：同一时刻调 `browser_list_tabs` 也必须被拒 —— 不能出现
    // 「目录里没有、但侥幸调到却又能跑」的不一致。
    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const result = await service.execute('browser_list_tabs', {});

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('browser_control_disabled');
  });
});

describe('browser control: execution timeout reaches the CDP command', () => {
  it('aborts a hung debugger command instead of waiting forever', async () => {
    // ⚠️⚠️ **`chrome.debugger.sendCommand` 自己没有超时** —— 页面卡死时那个 Promise
    // 可以永不 settle，而整条链（`service.execute` → `providerRegistry.execute`
    // → `executeRuntimeToolCall`）一路都是裸 await ⇒ 一次挂住就让内容脚本的
    // `pendingExecutions` 永不减、续跑循环停在 `running`。
    // 修法是 `executeRuntimeToolCall` 按描述符的 `timeoutMs` 建 scope，signal 一路
    // 传到 `cdp.sendCommand`。这条用例直接测那一跳：喂一个永不返回的 sendCommand，
    // 看它在取消后是否收敛成 `browser_control_aborted`。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: 12,
      includeSnapshotAfterActions: false,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'Example', url: 'https://example.com/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    chromeStub.debugger.sendCommand.mockImplementation(async (
      _source: chrome.debugger.Debuggee,
      method: string,
    ) => {
      // `Page.reload` 永不返回 —— 模拟页面卡死 / CDP 会话半掉线。
      if (method === 'Page.reload') return new Promise(() => {});
      return {};
    });

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const started = Date.now();
    const result = await service.execute('browser_refresh', {}, controller.signal);
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('browser_control_aborted');
    expect(elapsed, '必须在取消后立刻返回，而不是等 CDP').toBeLessThan(1_000);
  });

  it('leaves the next execute unaffected after an aborted one', async () => {
    // ⚠️ **`activeSignal` 必须还原** —— 上一次那个 signal 多半已经 abort，
    // 不还原的话下一次动作的第一条命令会被立刻判成取消。
    const storage = new Map<string, unknown>();
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      enabled: true,
      targetTabId: 12,
      includeSnapshotAfterActions: false,
    });
    const chromeStub = createChromeStub(storage, [
      createTab({ id: 12, active: true, title: 'Example', url: 'https://example.com/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);

    chromeStub.debugger.sendCommand.mockImplementation(async (
      _source: chrome.debugger.Debuggee,
      method: string,
    ) => {
      if (method === 'Page.reload') return new Promise(() => {});
      return {};
    });

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await service.execute('browser_refresh', {}, controller.signal);

    // 第二次不带 signal —— 必须正常跑完。
    chromeStub.debugger.sendCommand.mockImplementation(async () => ({}));
    const second = await service.execute('browser_refresh', {});
    expect(second.ok).toBe(true);
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
  /** 哪些标签上「有续跑在跑」—— `QUERY_CONTINUATION_STATE` 的答案来源。 */
  const continuationRunningTabs = new Set<number>();

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
    /** 测试专用：标记某条标签上「有续跑在跑」。 */
    __setContinuationRunning(tabId: number, running: boolean): void {
      if (running) continuationRunningTabs.add(tabId);
      else continuationRunningTabs.delete(tabId);
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
      /**
       * 后台问内容脚本「这条标签上有没有续跑在跑」。
       *
       * ⚠️ 默认回 `{ continuationRunning: false }` —— 绝大多数用例与续跑无关。
       * 需要「正在跑」的场景用 `__setContinuationRunning(tabId)`。
       */
      sendMessage: vi.fn(async (tabId: number) => {
        if (!tabs.has(tabId)) throw new Error('Receiving end does not exist.');
        return { continuationRunning: continuationRunningTabs.has(tabId) };
      }),
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
