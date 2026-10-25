import { getBrowserControlSettings, saveBrowserControlSettings } from './settings';
import { BrowserConnection, BrowserControlError } from './cdp';
import { TabKeepAliveSession } from './tab-keepalive';
import { formatAccessibilitySnapshot } from './snapshot';
import { readOptionalChromeApi } from '../platform/chrome-api';
import { isZaiSiteOrigin } from '../zai/contracts';
import type {
  BrowserActionResult,
  BrowserControlDependencies,
  BrowserControlSettings,
  BrowserControlState,
  BrowserControlTarget,
  BrowserControlToolName,
  BrowserSnapshotResult,
} from './types';

type RuntimeRemoteObject = {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  objectId?: string;
  description?: string;
};

type ElementHandle = {
  objectId: string;
  label: string;
};

export type ElementPoint = {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
};

const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const MAX_WAIT_TIMEOUT_MS = 60_000;

export class BrowserControlService {
  private readonly dependencies: BrowserControlDependencies;
  private readonly connection: BrowserConnection | null;
  private readonly uidToBackendNodeId = new Map<string, number>();
  private lastError: string | null = null;

  constructor(dependencies: BrowserControlDependencies = {}) {
    this.dependencies = dependencies;
    const chromeApi = this.getChromeApi();
    this.connection = chromeApi ? new BrowserConnection(chromeApi) : null;
  }

  /**
   * 续跑保活会话（只读它「这条标签有没有被我保活着」）。
   *
   * ⚠️ **必须是 getter，不能在构造里取** —— 模块级单例 `tabKeepAliveSession` 声明在
   * `browserControlService = new BrowserControlService()` **之后**，构造期读它会撞上
   * const 的暂时性死区，整个模块加载即抛错。
   */
  private get keepAlive(): { isKeepingAlive(tabId: number): boolean } {
    return this.dependencies.tabKeepAlive ?? tabKeepAliveSession;
  }

  isSupported(): boolean {
    const chromeApi = this.getChromeApi();
    return Boolean(
      readOptionalChromeApi(() => chromeApi?.debugger?.attach) &&
      readOptionalChromeApi(() => chromeApi?.debugger?.sendCommand) &&
      readOptionalChromeApi(() => chromeApi?.tabs?.query) &&
      readOptionalChromeApi(() => chromeApi?.tabs?.get),
    );
  }

  async getState(): Promise<BrowserControlState> {
    const settings = await getBrowserControlSettings();
    const supported = this.isSupported();
    const targets = supported ? await this.listTargets() : [];
    const target = settings.targetTabId === null
      ? null
      : targets.find((item) => item.id === settings.targetTabId) ?? null;

    return {
      supported,
      enabled: settings.enabled,
      attached: this.connection?.attached ?? false,
      targetTabId: settings.targetTabId,
      target,
      targets,
      error: this.lastError,
    };
  }

  async listTargets(): Promise<BrowserControlTarget[]> {
    const chromeApi = this.requireChromeApi();
    const activeCurrent = await chromeApi.tabs.query({ active: true, currentWindow: true });
    const activeCurrentId = activeCurrent[0]?.id ?? null;
    const tabGroups = readOptionalChromeApi(() => chromeApi.tabGroups);
    const groups = tabGroups?.query
      ? await tabGroups.query({}).catch(() => [])
      : [];
    const groupNames = new Map(
      (groups ?? []).map((group) => [group.id, group.title || group.color || `Group ${group.id}`]),
    );
    const tabs = await chromeApi.tabs.query({});
    return tabs
      .filter((tab) => typeof tab.id === 'number')
      .map((tab) => {
        const { controllable, reason } = describeTargetControllability(tab);
        const groupId = typeof tab.groupId === 'number' ? tab.groupId : -1;
        return {
          id: tab.id!,
          windowId: tab.windowId,
          groupId,
          groupName: groupNames.get(groupId),
          active: tab.active,
          currentWindow: tab.id === activeCurrentId,
          title: tab.title ?? '',
          url: tab.url ?? '',
          controllable,
          reason,
        };
      });
  }

  async setTarget(tabId: number): Promise<BrowserControlTarget> {
    const target = await this.getTargetOrThrow(tabId);
    if (!target.controllable) {
      throw new BrowserControlError(
        'browser_target_not_controllable',
        target.reason ?? 'This tab cannot be controlled by chrome.debugger.',
      );
    }
    const current = await getBrowserControlSettings();
    if (current.targetTabId !== tabId && this.connection?.attached) {
      await this.connection.detach();
    }
    await saveBrowserControlSettings({ targetTabId: tabId });
    return target;
  }

  async detach(): Promise<void> {
    await this.connection?.detach();
  }

  async execute(
    name: BrowserControlToolName,
    payload: Record<string, unknown>,
  ): Promise<BrowserActionResult> {
    const started = this.now();
    let outcome: BrowserActionResult;
    try {
      const settings = await getBrowserControlSettings();
      if (!settings.enabled && name !== 'browser_list_tabs') {
        throw new BrowserControlError(
          'browser_control_disabled',
          'Browser control is disabled. Enable it in the Zai++ side panel before using browser tools.',
        );
      }

      const result = await this.executeEnabled(name, payload, settings);
      this.lastError = null;
      outcome = {
        ...result,
        output: {
          ...asObject(result.output),
          durationMs: this.now() - started,
        },
      };
    } catch (error) {
      const normalized = normalizeError(error);
      this.lastError = normalized.message;
      outcome = {
        ok: false,
        summary: normalized.message,
        detail: normalized.message,
        error: {
          code: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable,
          details: normalized.details,
        },
      };
    }
    // ⚠️ **成功与失败两条出口都要过这一关** —— 残留恰恰出现在失败路径上
    // （`ensureTargetTabId` 在 `ensureAttached` 之前抛 `browser_target_missing`）。
    return this.releaseUncontrollableTarget(outcome);
  }

  /**
   * **动作把受控标签带到不可控状态之后，解除附着。**
   *
   * 触发形态：模型在一个普通标签上点了通往 z.ai 的链接。标签的 URL 变了，但附着关系
   * 还挂在它上面 —— 而**下一轮续跑保活要 attach 同一个标签时会被拒**（`chrome.debugger`
   * 拒的是「同一个 tab + 同一个扩展」），保活调用方是 `void` + 内部 catch ⇒ 静默失效。
   *
   * ⚠️ **不能只靠 `createSnapshot` 顺带清掉**：它只在 `includeSnapshotAfterActions`
   * 打开时才会跑，而且目标不可控时它走的是「重新挑一个标签」那条路 —— 有别的可控标签
   * 时快照取自另一条（报告里的 tabId 与快照对不上），一条都没有时它直接抛错。
   * ⚠️ **也不靠 `attach` 的「挂着别的就先 detach」** —— 那条只在确实重新 attach 时才生效，
   * 而上面两种情况下 attach 要么没发生、要么发生在抛错之前。
   *
   * ⚠️ **它清的是「上一次」动作留下的附着，不是本次调用的**：走到失败出口时本次根本没
   * attach（`ensureTargetTabId` 在 `ensureAttached` 之前就抛了），残留来自前一次成功动作。
   * 所以成功与失败两条出口都必须过这一关。
   *
   * ⚠️ **本方法假设同一时刻只有一个 browser_* 动作在跑**（工具执行串行在 `executionChain`
   * 上）。并发时一条动作的清理会 detach 掉另一条正在用的标签。
   *
   * 失败方向：这一关只是清理，**任何异常都不许改写动作结果**。
   */
  private async releaseUncontrollableTarget(result: BrowserActionResult): Promise<BrowserActionResult> {
    const tabId = this.connection?.tabId;
    if (typeof tabId !== 'number') return result;
    const controllable = await this.isTabControllable(tabId);
    if (controllable !== false) return result;
    await this.connection?.detach().catch(() => undefined);
    return {
      ...result,
      detail: `${result.detail ?? result.summary}\n\nReleased control of tab ${tabId}: it is no longer a controllable target.`,
      // ⚠️ **原本没有 `output` 时不要凭空造一个** —— 失败结果的 `output` 会被工具面板
      // 原样渲染成一行 JSON（`tool-block-adapter` 对 `!ok` 也追加 `output:` 段），
      // 而 `{ releasedTabId: N }` 对用户没有信息量。清理动作本身照做。
      ...(result.output === undefined
        ? {}
        : { output: { ...asObject(result.output), releasedTabId: tabId } }),
    };
  }

  /** `null` = 查不到（标签已关 / chrome 出错），与「可控」一样按放行处理。 */
  private async isTabControllable(tabId: number): Promise<boolean | null> {
    try {
      const tab = await this.requireChromeApi().tabs.get(tabId);
      return describeTargetControllability(tab).controllable;
    } catch {
      return null;
    }
  }

  private async executeEnabled(
    name: BrowserControlToolName,
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
  ): Promise<BrowserActionResult> {
    switch (name) {
      case 'browser_navigate':
        return this.navigate(payload, settings);
      case 'browser_go_back':
        return this.navigateHistory('back', settings);
      case 'browser_go_forward':
        return this.navigateHistory('forward', settings);
      case 'browser_refresh':
        return this.refresh(settings);
      case 'browser_list_tabs':
        return this.listTabs();
      case 'browser_select_tab':
        return this.selectTab(payload);
      case 'browser_close_tab':
        return this.closeTab(payload);
      case 'browser_snapshot':
        return this.snapshotAction(settings);
      case 'browser_click':
        return this.pointAction('click', payload, settings);
      case 'browser_hover':
        return this.pointAction('hover', payload, settings);
      case 'browser_fill':
        return this.fill(payload, settings);
      case 'browser_fill_form':
        return this.fillForm(payload, settings);
      case 'browser_key':
        return this.key(payload, settings);
      case 'browser_type':
        return this.typeText(payload, settings);
      case 'browser_attach_file':
        return this.attachFile(payload, settings);
      case 'browser_wait_for':
        return this.waitFor(payload, settings);
      case 'browser_handle_dialog':
        return this.handleDialog(payload);
      case 'browser_evaluate_script':
        return this.evaluateScript(payload, settings);
      default:
        throw new BrowserControlError('browser_tool_unsupported', `Unsupported browser tool: ${name}`);
    }
  }

  private async navigate(
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
  ): Promise<BrowserActionResult> {
    const url = normalizeUrl(requireString(payload, 'url'));
    // ⚠️⚠️ **导航目的地是 z.ai 时直接拒绝，必须在 `Page.navigate` 之前** ——
    // `getControllableState` 只在**选目标那一刻**看 URL，导航改变 URL 之后没有任何再次校验：
    // 受控标签一旦被导到 z.ai，debugger 就留在 z.ai 上了（下一次续跑保活 attach 会被拒、
    // 且失败是静默的），而动作末尾的 `withOptionalSnapshot` 会重新解析目标、当场抛
    // `browser_target_missing` —— 表现成「导航明明成功却整条报失败」。
    assertNavigableDestination(url);
    const newTab = readOptionalBoolean(payload, 'newTab', true);
    let tabId: number;
    let previousUrl: string | undefined;
    if (newTab) {
      const tab = await this.requireChromeApi().tabs.create({ url, active: true });
      if (typeof tab.id !== 'number') {
        throw new BrowserControlError('browser_tab_create_failed', 'Chrome did not return a tab id for the new tab.');
      }
      tabId = tab.id;
      previousUrl = tab.url ?? 'about:blank';
      if (this.connection?.attached) {
        await this.connection.detach();
      }
      await saveBrowserControlSettings({ targetTabId: tabId });
    } else {
      tabId = await this.ensureTargetTabId(settings, { createIfMissing: true, navigateUrl: url });
      await this.ensureAttached(tabId);
      const before = await this.requireChromeApi().tabs.get(tabId);
      previousUrl = before.url;
      await this.connection!.sendCommand('Page.navigate', { url });
    }

    const settled = await this.waitForTabUrl(tabId, url, previousUrl, 3_000).catch(() => false);
    if (!settled) {
      // Navigation did not reach the requested URL within the window; report
      // it instead of silently claiming success.
      throw new BrowserControlError(
        'browser_navigation_timeout',
        `Controlled tab did not reach ${url} within 3 seconds.`,
        { retryable: true },
      );
    }
    return this.withOptionalSnapshot({
      ok: true,
      summary: newTab ? `Opened ${url}` : `Navigated to ${url}`,
      detail: newTab
        ? `Opened new controlled tab ${tabId} at ${url}.`
        : `Navigated controlled tab ${tabId} to ${url}.`,
      output: { tabId, url, newTab },
    }, settings, tabId);
  }

  private async navigateHistory(
    direction: 'back' | 'forward',
    settings: BrowserControlSettings,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    const history = await this.connection!.sendCommand<{
      currentIndex?: number;
      entries?: Array<{ id?: number; url?: string }>;
    }>('Page.getNavigationHistory');
    const currentIndex = history.currentIndex ?? 0;
    const nextIndex = direction === 'back' ? currentIndex - 1 : currentIndex + 1;
    const entry = history.entries?.[nextIndex];
    if (!entry || typeof entry.id !== 'number') {
      throw new BrowserControlError(
        `browser_cannot_go_${direction}`,
        direction === 'back' ? 'No previous history entry.' : 'No forward history entry.',
      );
    }
    // ⚠️ **前进 / 后退也是导航入口** —— 目的地来自历史记录，受控标签的历史里留一条 z.ai
    // 记录就够了（用户先在该标签开过 z.ai，之后标签停在别的页）。落点与 `navigate` 相同：
    // debugger 留在 z.ai 上，而这一发是在 `ensureAttached` **之后**才被拒的，标签不会被导过去。
    if (entry.url) assertNavigableDestination(entry.url);
    await this.connection!.sendCommand('Page.navigateToHistoryEntry', { entryId: entry.id });
    return this.withOptionalSnapshot({
      ok: true,
      summary: direction === 'back' ? 'Went back' : 'Went forward',
      detail: `Navigated ${direction} to ${entry.url ?? '(unknown URL)'}.`,
      output: { tabId, direction, url: entry.url ?? '' },
    }, settings, tabId);
  }

  private async refresh(settings: BrowserControlSettings): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    await this.connection!.sendCommand('Page.reload', { ignoreCache: false });
    return this.withOptionalSnapshot({
      ok: true,
      summary: 'Reloaded controlled tab',
      detail: `Reloaded tab ${tabId}.`,
      output: { tabId },
    }, settings, tabId);
  }

  private async listTabs(): Promise<BrowserActionResult> {
    const targets = await this.listTargets();
    const lines = targets.map((target) => {
      const marker = target.currentWindow ? '*' : ' ';
      const status = target.controllable ? 'controllable' : `blocked: ${target.reason}`;
      return `${marker} ${target.id} ${target.title || '(untitled)'} - ${target.url || '(no url)'} [${status}]`;
    });
    return {
      ok: true,
      summary: `Found ${targets.length} browser tabs`,
      detail: lines.join('\n'),
      output: { targets: targets.map(targetToJson) },
    };
  }

  private async selectTab(payload: Record<string, unknown>): Promise<BrowserActionResult> {
    const tabId = requireInteger(payload, 'tabId');
    const target = await this.setTarget(tabId);
    await this.requireChromeApi().tabs.update(tabId, { active: true }).catch(() => undefined);
    return {
      ok: true,
      summary: `Selected tab ${tabId}`,
      detail: `Selected tab ${tabId}: ${target.title || target.url || '(untitled)'}.`,
      output: { target: targetToJson(target) },
    };
  }

  private async closeTab(payload: Record<string, unknown>): Promise<BrowserActionResult> {
    const settings = await getBrowserControlSettings();
    const requestedTabId = typeof payload.tabId === 'number'
      ? requireInteger(payload, 'tabId')
      : settings.targetTabId;
    // ⚠️⚠️ **正在被续跑保活挂着的标签不许关** —— 关掉等于当场掐断那一轮的续跑循环：
    // 内容脚本随标签一起消失，后台 DOM 任务收不到终态，只能等 `deadlineAt`（180 秒）到期。
    // 判据与「z.ai 不可作为控制目标」同源（两者护的都是保活那条 CDP 会话），但**范围更窄**：
    // 关一个 z.ai 标签本身是合法操作（`closeTab` 不碰 debugger，只是 `tabs.remove`），
    // 拦住它的是「别把正在跑的续跑拆掉」，不是「z.ai 不能碰」。
    //
    // ⚠️ **必须在解析目标之前判**（`ensureTargetTabId` 会写 storage 并静默换目标）：
    // 否则「存的 target 正是被保活那条、又没有别的可控标签」时会先抛
    // `browser_target_missing`（还说 retryable），错误码与事实不符。
    // ⚠️ **缺省目标时只判存着的那个**，不提前跑一遍「重新挑一个」：挑出来的目标不可能是
    // 保活那条（z.ai 恒不可控），所以提前判不会漏。
    if (requestedTabId !== null && this.keepAlive.isKeepingAlive(requestedTabId)) {
      throw new BrowserControlError(
        'browser_target_protected',
        `Tab ${requestedTabId} is kept alive by an active continuation loop and cannot be closed.`,
      );
    }
    const tabId = requestedTabId ?? await this.ensureTargetTabId(settings);
    // ⚠️ 覆盖不到的一格，是刻意的：自动化首条消息（chatNew）阶段还没建续跑循环、
    // 保活没挂 ⇒ 那一刻关标签拦不住（要盖住得读协调器的私有 `busyTabs`，代价不成比例）。
    // ⚠️ 「保活 `detach()` 失败后 `tabId` 留在原地、那条标签一直受保护」这一格已在
    // `tab-keepalive.ts` 收口：两类「标签已经没了」的措辞都会清掉绑定。
    if (this.connection?.tabId === tabId) await this.connection.detach();
    await this.requireChromeApi().tabs.remove(tabId);
    if (settings.targetTabId === tabId) {
      await saveBrowserControlSettings({ targetTabId: null });
    }
    return {
      ok: true,
      summary: `Closed tab ${tabId}`,
      detail: `Closed browser tab ${tabId}.`,
      output: { tabId },
    };
  }

  private async snapshotAction(settings: BrowserControlSettings): Promise<BrowserActionResult> {
    const snapshot = await this.createSnapshot(settings);
    return {
      ok: true,
      summary: `Captured ${snapshot.nodes.length} accessibility nodes`,
      detail: snapshot.text,
      output: snapshotToJson(snapshot),
      snapshot,
    };
  }

  private async pointAction(
    action: 'click' | 'hover',
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    const element = await this.resolveElement(payload);
    const point = await this.getElementPoint(element.objectId);
    if (!point.visible) {
      throw new BrowserControlError('browser_element_not_visible', `${element.label} is not visible.`);
    }

    await this.connection!.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
    });
    if (action === 'click') {
      const button = readString(payload.button, 'left');
      const clickCount = clampInteger(payload.clickCount, 1, 1, 3);
      await this.connection!.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button,
        clickCount,
      });
      await this.connection!.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button,
        clickCount,
      });
    }

    return this.withOptionalSnapshot({
      ok: true,
      summary: action === 'click' ? `Clicked ${element.label}` : `Hovered ${element.label}`,
      detail: `${action === 'click' ? 'Clicked' : 'Hovered'} ${element.label} at (${Math.round(point.x)}, ${Math.round(point.y)}).`,
      output: { tabId, action, target: element.label, point },
    }, settings, tabId);
  }

  private async fill(
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    const value = requireString(payload, 'value');
    const element = await this.resolveElement(payload);
    await this.fillElement(element, value);
    return this.withOptionalSnapshot({
      ok: true,
      summary: `Filled ${element.label}`,
      detail: `Filled ${element.label} using DOM value assignment and input/change events.`,
      output: { tabId, target: element.label, valueLength: value.length },
    }, settings, tabId);
  }

  private async fillForm(
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    const fields = payload.fields;
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new BrowserControlError('browser_invalid_fields', 'fields must be a non-empty array.');
    }

    const filled: Array<{ target: string; valueLength: number }> = [];
    for (const field of fields) {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        throw new BrowserControlError('browser_invalid_field', 'Each field must be an object.');
      }
      const record = field as Record<string, unknown>;
      const value = requireString(record, 'value');
      const element = await this.resolveElement(record);
      await this.fillElement(element, value);
      filled.push({ target: element.label, valueLength: value.length });
    }

    return this.withOptionalSnapshot({
      ok: true,
      summary: `Filled ${filled.length} form fields`,
      detail: `Filled ${filled.length} fields using DOM value assignment and input/change events.`,
      output: { tabId, filled },
    }, settings, tabId);
  }

  private async key(
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    if (payload.uid || payload.selector) {
      const element = await this.resolveElement(payload);
      await this.focusElement(element);
    }
    const key = requireString(payload, 'key');
    const keyParams = keyEventParams(key);
    await this.connection!.sendCommand('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      ...keyParams,
    });
    await this.connection!.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      ...keyParams,
    });

    return this.withOptionalSnapshot({
      ok: true,
      summary: `Pressed ${key}`,
      detail: `Pressed key ${key}.`,
      output: { tabId, key },
    }, settings, tabId);
  }

  private async typeText(
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    if (payload.uid || payload.selector) {
      const element = await this.resolveElement(payload);
      await this.focusElement(element);
    }
    const text = requireString(payload, 'text');
    await this.connection!.sendCommand('Input.insertText', { text });
    return this.withOptionalSnapshot({
      ok: true,
      summary: `Typed ${text.length} characters`,
      detail: `Inserted ${text.length} characters into the focused element.`,
      output: { tabId, textLength: text.length },
    }, settings, tabId);
  }

  private async attachFile(
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    const files = payload.files;
    if (!Array.isArray(files) || !files.every((item) => typeof item === 'string' && item.trim())) {
      throw new BrowserControlError('browser_invalid_files', 'files must be a non-empty string array of absolute file paths.');
    }
    const element = await this.resolveElement(payload);
    await this.connection!.sendCommand('DOM.setFileInputFiles', {
      objectId: element.objectId,
      files,
    });
    return this.withOptionalSnapshot({
      ok: true,
      summary: `Attached ${files.length} file(s)`,
      detail: `Attached ${files.length} file(s) to ${element.label}.`,
      output: { tabId, target: element.label, fileCount: files.length },
    }, settings, tabId);
  }

  private async waitFor(
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    const timeoutMs = clampInteger(payload.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, 250, MAX_WAIT_TIMEOUT_MS);
    const started = this.now();
    const expression = waitExpression(payload);

    while (this.now() - started <= timeoutMs) {
      const matched = await this.evaluateBoolean(expression);
      if (matched) {
        return this.withOptionalSnapshot({
          ok: true,
          summary: 'Wait condition matched',
          detail: `Condition matched after ${this.now() - started}ms.`,
          output: { tabId, waitedMs: this.now() - started },
        }, settings, tabId);
      }
      await delay(250);
    }

    throw new BrowserControlError('browser_wait_timeout', `Condition did not match within ${timeoutMs}ms.`, {
      retryable: true,
    });
  }

  private async handleDialog(payload: Record<string, unknown>): Promise<BrowserActionResult> {
    const settings = await getBrowserControlSettings();
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    const dialog = this.connection!.getLatestDialog(tabId);
    if (!dialog) {
      throw new BrowserControlError('browser_dialog_not_open', 'No JavaScript dialog is currently open.');
    }
    const accept = payload.accept !== false;
    const promptText = typeof payload.promptText === 'string' ? payload.promptText : undefined;
    await this.connection!.sendCommand('Page.handleJavaScriptDialog', {
      accept,
      ...(promptText !== undefined ? { promptText } : {}),
    });
    this.connection!.clearDialog(tabId);
    return {
      ok: true,
      summary: accept ? 'Accepted JavaScript dialog' : 'Dismissed JavaScript dialog',
      detail: `${accept ? 'Accepted' : 'Dismissed'} ${dialog.type} dialog: ${dialog.message}`,
      output: {
        tabId,
        accepted: accept,
        dialog: {
          type: dialog.type,
          message: dialog.message,
          defaultPrompt: dialog.defaultPrompt ?? null,
        },
      },
    };
  }

  private async evaluateScript(
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    const expression = typeof payload.expression === 'string'
      ? payload.expression
      : requireString(payload, 'script');
    const result = await this.evaluate(expression, { awaitPromise: payload.awaitPromise !== false });
    return this.withOptionalSnapshot({
      ok: true,
      summary: 'Evaluated script',
      detail: `Result: ${JSON.stringify(result).slice(0, 4_000)}`,
      output: { tabId, result: toJsonSafe(result) },
    }, settings, tabId);
  }

  private async ensureTargetTabId(
    settings: BrowserControlSettings,
    options: { createIfMissing?: boolean; navigateUrl?: string } = {},
  ): Promise<number> {
    if (typeof settings.targetTabId === 'number') {
      try {
        const target = await this.getTargetOrThrow(settings.targetTabId);
        if (target.controllable) return settings.targetTabId;
        // ⚠️ 存着的目标不可控时**落到下面重新挑一个**，这里刻意不抛。
        // 这条路径同时是「z.ai 被排除」的存量迁移通道：老记录里 `targetTabId` 可能指着
        // z.ai 标签。两条去向 —— 还有别的可控标签就换过去并落库；一个都没有则抛
        // `browser_target_missing`。改成无条件抛错会让这些老记录**每次调用都失败**。
        // ⚠️ 代价：换目标对调用方是静默的（模型以为还在操作原来那个标签）。
      } catch (error) {
        // The stored target tab is gone (closed or invalidated): clear the
        // stale binding instead of failing every subsequent call (M22).
        if (!isMissingTargetError(error)) throw error;
        await saveBrowserControlSettings({ targetTabId: null }).catch(() => undefined);
      }
    }

    const targets = await this.listTargets();
    const active = targets.find((target) => target.currentWindow && target.controllable)
      ?? targets.find((target) => target.controllable);
    if (active) {
      await saveBrowserControlSettings({ targetTabId: active.id });
      return active.id;
    }

    if (options.createIfMissing && options.navigateUrl) {
      const tab = await this.requireChromeApi().tabs.create({ url: options.navigateUrl, active: true });
      if (typeof tab.id === 'number') {
        await saveBrowserControlSettings({ targetTabId: tab.id });
        return tab.id;
      }
    }

    throw new BrowserControlError('browser_target_missing', 'No controllable browser tab is available.', {
      retryable: true,
    });
  }

  private async ensureAttached(tabId: number): Promise<void> {
    if (!this.connection) {
      throw new BrowserControlError('browser_control_unsupported', 'Browser control is not supported in this context.');
    }
    await this.connection.attach(tabId);
  }

  /**
   * 拍一张可访问性快照。
   *
   * ⚠️ **给了 `tabId` 就不再重新解析目标** —— 快照必须取自「动作刚操作过的那条标签」。
   * 不传时（`browser_snapshot` 与 `resolveElement` 的补拍）沿用既有的「按当前设置挑目标」。
   */
  private async createSnapshot(
    settings: BrowserControlSettings,
    tabId?: number,
  ): Promise<BrowserSnapshotResult> {
    const resolvedTabId = tabId ?? await this.ensureTargetTabId(settings);
    await this.ensureAttached(resolvedTabId);
    const tab = await this.requireChromeApi().tabs.get(resolvedTabId);
    const ax = await this.connection!.sendCommand<{ nodes?: unknown[] }>('Accessibility.getFullAXTree');
    const formatted = formatAccessibilitySnapshot({
      axNodes: Array.isArray(ax.nodes) ? ax.nodes as never[] : [],
      url: tab.url ?? '',
      title: tab.title ?? '',
      maxNodes: settings.maxSnapshotNodes,
      maxTextBytes: settings.maxSnapshotTextBytes,
    });
    this.uidToBackendNodeId.clear();
    for (const [uid, backendNodeId] of formatted.uidToBackendNodeId) {
      this.uidToBackendNodeId.set(uid, backendNodeId);
    }
    return formatted.result;
  }

  /**
   * 动作成功之后补一张快照。
   *
   * ⚠️⚠️ **`tabId` 是必填，不是可选** —— 快照必须取自「动作刚操作过的那条标签」，
   * 不传就会退回 `ensureTargetTabId` 重新解析目标（有别的可控标签时快照取自另一条、
   * 报告里的 `tabId` 与快照对不上；一条都没有时当场抛 `browser_target_missing`，
   * 表现成「动作成功却整条报失败」）。做成必填是为了让将来新增的调用点由 tsc 逼着做决定，
   * 而不是静默退回旧行为。
   */
  private async withOptionalSnapshot(
    result: BrowserActionResult,
    settings: BrowserControlSettings,
    tabId: number,
  ): Promise<BrowserActionResult> {
    if (!settings.includeSnapshotAfterActions) return result;
    const snapshot = await this.createSnapshot(settings, tabId);
    return {
      ...result,
      detail: `${result.detail ?? result.summary}\n\n${snapshot.text}`,
      output: {
        ...asObject(result.output),
        snapshot: snapshotToJson(snapshot),
      },
      snapshot,
    };
  }

  private async resolveElement(payload: Record<string, unknown>): Promise<ElementHandle> {
    const uid = typeof payload.uid === 'string' ? payload.uid.trim() : '';
    const selector = typeof payload.selector === 'string' ? payload.selector.trim() : '';
    if (!uid && !selector) {
      throw new BrowserControlError('browser_target_required', 'Either uid or selector is required.');
    }

    if (uid) {
      let backendNodeId = this.uidToBackendNodeId.get(uid);
      if (backendNodeId === undefined) {
        const settings = await getBrowserControlSettings();
        await this.createSnapshot(settings);
        backendNodeId = this.uidToBackendNodeId.get(uid);
      }
      if (backendNodeId === undefined) {
        throw new BrowserControlError('browser_uid_not_found', `Snapshot uid not found: ${uid}`, {
          retryable: true,
        });
      }
      const resolved = await this.connection!.sendCommand<{
        object?: RuntimeRemoteObject;
      }>('DOM.resolveNode', { backendNodeId });
      if (!resolved.object?.objectId) {
        throw new BrowserControlError('browser_node_resolve_failed', `Could not resolve snapshot uid: ${uid}`);
      }
      return { objectId: resolved.object.objectId, label: uid };
    }

    const result = await this.connection!.sendCommand<{
      result?: RuntimeRemoteObject;
      exceptionDetails?: unknown;
    }>('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      objectGroup: 'zai-pp-browser-control',
    });
    if (result.exceptionDetails) {
      throw new BrowserControlError('browser_selector_failed', `Selector failed: ${selector}`);
    }
    if (!result.result?.objectId || result.result.subtype === 'null') {
      throw new BrowserControlError('browser_selector_not_found', `Selector not found: ${selector}`, {
        retryable: true,
      });
    }
    return { objectId: result.result.objectId, label: selector };
  }

  private async getElementPoint(objectId: string): Promise<ElementPoint> {
    const value = await this.callFunctionOn(objectId, String(getBrowserControlElementPoint));
    if (!value || typeof value !== 'object') {
      throw new BrowserControlError('browser_element_point_failed', 'Could not compute the element point.');
    }
    const point = value as Partial<ElementPoint>;
    if (
      typeof point.x !== 'number' ||
      typeof point.y !== 'number' ||
      typeof point.width !== 'number' ||
      typeof point.height !== 'number'
    ) {
      throw new BrowserControlError('browser_element_point_failed', 'Element point result was invalid.');
    }
    return {
      x: point.x,
      y: point.y,
      width: point.width,
      height: point.height,
      visible: point.visible === true,
    };
  }

  private async fillElement(element: ElementHandle, value: string): Promise<void> {
    await this.callFunctionOn(element.objectId, String(function fillElement(
      this: HTMLElement & { value?: string },
      nextValue: string,
    ) {
      this.focus();
      if ('value' in this) {
        this.value = nextValue;
      } else {
        this.textContent = nextValue;
      }
      this.dispatchEvent(new InputEvent('input', { bubbles: true, data: nextValue }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }), [{ value }]);
  }

  private async focusElement(element: ElementHandle): Promise<void> {
    await this.callFunctionOn(element.objectId, String(function focusElement(this: HTMLElement) {
      this.focus();
      return document.activeElement === this;
    }));
  }

  private async callFunctionOn(
    objectId: string,
    functionDeclaration: string,
    args: Array<{ value: unknown }> = [],
  ): Promise<unknown> {
    const result = await this.connection!.sendCommand<{
      result?: RuntimeRemoteObject;
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      arguments: args,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new BrowserControlError(
        'browser_dom_call_failed',
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'DOM call failed.',
      );
    }
    return remoteObjectValue(result.result);
  }

  private async evaluate(expression: string, options: { awaitPromise: boolean }): Promise<unknown> {
    const result = await this.connection!.sendCommand<{
      result?: RuntimeRemoteObject;
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise,
    });
    if (result.exceptionDetails) {
      throw new BrowserControlError(
        'browser_script_failed',
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Script evaluation failed.',
      );
    }
    return remoteObjectValue(result.result);
  }

  private async evaluateBoolean(expression: string): Promise<boolean> {
    return await this.evaluate(expression, { awaitPromise: true }) === true;
  }

  private async getTargetOrThrow(tabId: number): Promise<BrowserControlTarget> {
    const chromeApi = this.requireChromeApi();
    const tab = await chromeApi.tabs.get(tabId);
    const current = await chromeApi.tabs.query({ active: true, currentWindow: true });
    const { controllable, reason } = describeTargetControllability(tab);
    return {
      id: tabId,
      windowId: tab.windowId,
      groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
      groupName: undefined,
      active: tab.active,
      currentWindow: current[0]?.id === tabId,
      title: tab.title ?? '',
      url: tab.url ?? '',
      controllable,
      reason,
    };
  }

  private async waitForTabUrl(
    tabId: number,
    url: string,
    previousUrl: string | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    const started = this.now();
    while (this.now() - started <= timeoutMs) {
      const tab = await this.requireChromeApi().tabs.get(tabId);
      if (tab.url === url || tab.pendingUrl === url) return true;
      // Sites commonly redirect (http→https, trailing slash, canonical host),
      // so an exact match is too strict: any navigation away from the
      // pre-navigation URL means the command took effect. A tab that never
      // navigates (e.g. navigation blocked) still fails the timeout.
      if (previousUrl && tab.url && tab.url !== previousUrl) return true;
      await delay(100);
    }
    return false;
  }

  private requireChromeApi(): typeof chrome {
    const chromeApi = this.getChromeApi();
    if (!chromeApi) {
      throw new BrowserControlError(
        'chrome_api_unavailable',
        'Chrome extension APIs are unavailable in this context.',
      );
    }
    return chromeApi;
  }

  private getChromeApi(): typeof chrome | null {
    if (this.dependencies.chromeApi) return this.dependencies.chromeApi;
    try {
      return typeof chrome !== 'undefined' ? chrome : null;
    } catch {
      return null;
    }
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }
}

export const browserControlService = new BrowserControlService();

/**
 * 「让 z.ai 标签留在后台也能跑」的保活会话 —— **与浏览器控制互不干扰**。
 *
 * ⚠️ **不能复用 `browserControlService` 的那条连接**：它是单例且只持一个 `attachedTabId`，
 * `attach()` 第一件事就是「挂着别的就先 detach」⇒ 浏览器控制去驱动目标标签时会把保活顶掉。
 * 而 `chrome.debugger` 本身按 tabId 挂，同一扩展可以同时挂多个标签。
 */
export const tabKeepAliveSession = new TabKeepAliveSession();

export async function getBrowserControlElementPoint(this: Element): Promise<ElementPoint> {
  function readPoint(target: Element): ElementPoint {
    const rect = target.getBoundingClientRect();
    const style = window.getComputedStyle(target);
    const rendered = rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none';
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    const visible = rendered && right > left && bottom > top;
    return {
      x: visible ? (left + right) / 2 : rect.left + rect.width / 2,
      y: visible ? (top + bottom) / 2 : rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      visible,
    };
  }

  let point = readPoint(this);
  if (point.visible) return point;

  this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
  if (typeof requestAnimationFrame === 'function') {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  point = readPoint(this);
  return point;
}

export function getControllableState(url: string): { controllable: boolean; reason?: string } {
  if (!url) return { controllable: true };
  if (url === 'about:blank') return { controllable: true };
  if (isZaiSiteOrigin(url)) {
    // ⚠️⚠️ **z.ai 自己的标签页必须排除** —— 不是 URL 形状问题，是 CDP 独占问题。
    //
    // `chrome.debugger.attach` 的拒判据是「**同一个 tab + 同一个扩展**」（见 Chromium
    // `debugger_api.cc` 的 `FindClientHost()`：按 `agent_host` + `extension_id` 匹配），
    // 而续跑期间保活会话（`TabKeepAliveSession`）正挂在 z.ai 标签上 ⇒ 浏览器控制再 attach
    // 同一条必被拒，报「Another debugger is already attached」（这句话含自己，容易误读）。
    //
    // 两条链的代价不对称：保活挂了 ⇒ 页面被 Chrome 节流 ⇒ 续跑发送链的短轮询全部超时 ⇒
    // 任务静默收尾，且**没有任何日志**；浏览器控制少了 z.ai 这个目标 ⇒ 只是少一个可操作对象。
    // ⇒ 让浏览器控制退一步。
    //
    // ⚠️ **代价（用户已知情并接受）**：模型不能用 browser_* 去点 z.ai 自己的页面
    // （关弹窗、滚动、读侧边栏之类）。真要操作 z.ai，得换一个不带保活的普通标签窗口。
    return {
      controllable: false,
      // ⚠️ **英文**：这个函数是 core 里的纯函数、拿不到 locale，而 `core/browser-control`
      // 不在 i18n 覆盖率豁免名单里（中文会被 `i18n-coverage-audit` 判成硬编码文案）。
      // ⚠️ **面板不走这条文案** —— `BrowserControlPage` 按同一个 `isZaiSiteOrigin`
      // 换成本地化的 `zaiTabBlocked`；这里这句英文只给模型侧看（`browser_list_tabs` 的 detail）。
      reason: 'Cannot target a z.ai tab: continuation keep-alive requires exclusive use of that tab\'s debugger attachment.',
    };
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return { controllable: true };
  }
  return {
    controllable: false,
    reason: `Unsupported URL scheme for browser control: ${url.split(':')[0] || 'unknown'}`,
  };
}

/**
 * **一个标签当前是否可被浏览器控制** —— `url` 与 `pendingUrl` **两个都要过**。
 *
 * ⚠️ **`pendingUrl` 不能省**：`chrome.tabs.get` 在导航**提交之前**返回的 `url` 还是旧地址，
 * 新地址只在 `pendingUrl` 里。而「动作触发一次导航」正是最需要判准的时机
 * （点击通往 z.ai 的链接 / 目标标签自己跳走）—— 只看 `url` 会把正在跳向 z.ai 的标签
 * 判成可控，选目标与解除附着两条路都会漏。
 * ⚠️ **任一不可控即不可控**（向宽）：两个字段分别是「旧地址」与「新地址」，只要有一头是
 * 不可控目标，就不该继续挂着它。
 */
function describeTargetControllability(
  tab: Pick<chrome.tabs.Tab, 'url' | 'pendingUrl'>,
): { controllable: boolean; reason?: string } {
  const current = getControllableState(tab.url ?? '');
  if (!current.controllable) return current;
  if (!tab.pendingUrl) return current;
  return getControllableState(tab.pendingUrl);
}

/**
 * **拒绝把受控标签导航到 z.ai** —— `navigate` 与 `navigateHistory` 共用。
 *
 * ⚠️ 两处都要拦：`getControllableState` 只在**选目标那一刻**看 URL，导航改变 URL 之后
 * 没有任何再次校验。真被导过去的话，debugger 留在 z.ai 标签上（下一轮续跑保活 attach 被拒、
 * 静默），而动作末尾的快照会重新解析目标、当场抛 `browser_target_missing`
 * —— 表现成「导航明明成功却整条报失败」。
 */
function assertNavigableDestination(url: string): void {
  if (!isZaiSiteOrigin(url)) return;
  throw new BrowserControlError(
    'browser_target_not_controllable',
    getControllableState(url).reason ?? 'z.ai tabs cannot be controlled.',
  );
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new BrowserControlError('browser_invalid_payload', `${key} is required.`);
  }
  return value;
}

function requireInteger(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BrowserControlError('browser_invalid_payload', `${key} must be an integer.`);
  }
  return value;
}

function readOptionalBoolean(
  payload: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) return fallback;
  const value = payload[key];
  if (typeof value !== 'boolean') {
    throw new BrowserControlError('browser_invalid_payload', `${key} must be a boolean.`);
  }
  return value;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    // file: is deliberately excluded: browser control must not navigate to or
    // read local files — the AX-tree snapshot would expose file contents.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Unsupported URL protocol: ${url.protocol}`);
    }
    return url.toString();
  } catch (error) {
    throw new BrowserControlError(
      'browser_invalid_url',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function keyEventParams(key: string): Record<string, unknown> {
  const special: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
    Enter: { code: 'Enter', windowsVirtualKeyCode: 13 },
    Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
    Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
    Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
    Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
    ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  };
  const known = special[key];
  if (known) return { key, ...known };
  if (key.length === 1) {
    return {
      key,
      text: key,
      code: `Key${key.toUpperCase()}`,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
    };
  }
  return { key };
}

function waitExpression(payload: Record<string, unknown>): string {
  if (typeof payload.selector === 'string' && payload.selector.trim()) {
    return `Boolean(document.querySelector(${JSON.stringify(payload.selector.trim())}))`;
  }
  if (typeof payload.text === 'string' && payload.text.trim()) {
    return `Boolean(document.body && document.body.innerText.includes(${JSON.stringify(payload.text)}))`;
  }
  if (typeof payload.expression === 'string' && payload.expression.trim()) {
    return `Boolean((${payload.expression}))`;
  }
  throw new BrowserControlError(
    'browser_wait_condition_required',
    'Provide selector, text, or expression for browser_wait_for.',
  );
}

function remoteObjectValue(object: RuntimeRemoteObject | undefined): unknown {
  if (!object) return null;
  if (Object.prototype.hasOwnProperty.call(object, 'value')) return object.value;
  if (typeof object.unserializableValue === 'string') return object.unserializableValue;
  if (object.subtype === 'null') return null;
  return object.description ?? object.type ?? null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function snapshotToJson(snapshot: BrowserSnapshotResult): Record<string, unknown> {
  return {
    url: snapshot.url,
    title: snapshot.title,
    text: snapshot.text,
    nodeCount: snapshot.nodes.length,
    truncated: snapshot.truncated,
  };
}

function targetToJson(target: BrowserControlTarget): Record<string, unknown> {
  return {
    id: target.id,
    windowId: target.windowId,
    groupId: target.groupId,
    groupName: target.groupName ?? null,
    active: target.active,
    currentWindow: target.currentWindow,
    title: target.title,
    url: target.url,
    controllable: target.controllable,
    reason: target.reason ?? null,
  };
}

function normalizeError(error: unknown): BrowserControlError {
  if (error instanceof BrowserControlError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new BrowserControlError('browser_control_failed', message, { retryable: true });
}

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return String(value);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingTargetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('No tab with id') || message.includes('Invalid tab id');
}
