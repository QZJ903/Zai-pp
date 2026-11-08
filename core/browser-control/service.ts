import {
  getBrowserControlSettings,
  saveBrowserControlSettings,
  updateBrowserControlSettingsWith,
} from './settings';
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
  /*
   * ⚠️⚠️ **取消信号是逐层传的参数，不是实例字段。**
   *
   * 曾经它是个 `activeSignal` 实例字段 —— 理由是「十几处 `sendCommand`，逐层加参数
   * 要改二十几个私有方法签名」。那个理由省了改动，但**建在一个不成立的前提上**：
   * 原注释说「本类不是并发安全的，因为工具执行串行在内容脚本的 `executionChain` 上」。
   * 而 `executionChain` 是**每个内容脚本实例自己的**（`zai.content.ts` 里按 requestId
   * 分桶的 `ToolTurnState.executionChain`），只管单页面内的串行；后台那条
   * `EXECUTE_TOOL_CALL` 链上**没有任何串行队列**（`runtime-command-registry.ts` 的
   * `dispatch` 直接 `await handler.handle(...)`）。
   *
   * ⇒ 两个 z.ai 标签、或「手动聊天 + 自动化」同时调 `browser_*` 时，后进的那个会覆盖
   * 先进那个挂上的 signal：A 写 signalA → B 写 signalB（`previousSignal` = signalA）
   * → A 的后续命令读到 **B** 的 signal。B 取消/超时后 A 的动作被误判
   * `browser_control_aborted`；且 B 结束把字段还原成 signalA、A 结束再还原成更早的值，
   * **链式污染**。
   *
   * ⚠️ **复现不是「一并发就中」** —— 要 A 那条链上有**第二个 `sendCommand`**、且 B 在
   * 两步之间插入才踩得到（实测：单步的 A 读到的是自己的 signal）。真实动作基本都多步
   * （`navigate` = `Page.navigate` → 等落点 → `createSnapshot`），所以这条不是理论风险。
   *
   * ⚠️ **为什么不改成外层加互斥**：那会让两个**独立标签**的 `browser_*` 动作真串行，
   * 而它们本来可以并行（各自独立的 CDP 会话）—— 为一个单标签场景下不存在的并发问题
   * 引入一个行为退步。显式传参没有任何锁、也没有行为变化。
   */

  constructor(dependencies: BrowserControlDependencies = {}) {
    this.dependencies = dependencies;
    const chromeApi = this.getChromeApi();
    this.connection = chromeApi ? new BrowserConnection(chromeApi) : null;
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
    // ⚠️⚠️ **换目标必须清 uid 映射** —— `uidToBackendNodeId` 里的 uid 是**快照当时那条
    // 标签**的 `backendNodeId`，换标签之后它们指向另一棵树上的节点。不清的话
    // `browser_click { uid: 'e5' }` 不会重新拍快照（映射里还有 `e5`），
    // 直接拿旧标签的 nodeId 去新标签上 `DOM.resolveNode`。
    // ⚠️ 与 `createSnapshot` 里那次 `clear()` 不重复：那条只在「重新拍快照」时生效。
    this.uidToBackendNodeId.clear();
    await saveBrowserControlSettings({ targetTabId: tabId });
    return target;
  }

  async detach(): Promise<void> {
    await this.connection?.detach();
    // 会话没了 ⇒ 那份 uid → backendNodeId 映射也不再有任何意义。
    this.uidToBackendNodeId.clear();
  }

  async execute(
    name: BrowserControlToolName,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BrowserActionResult> {
    const started = this.now();
    let outcome: BrowserActionResult;
    try {
      const settings = await getBrowserControlSettings();
      // ⚠️ **没有 `browser_list_tabs` 豁免** —— 曾经写过
      // `if (!settings.enabled && name !== 'browser_list_tabs')`，但那条豁免**走不到**：
      // 工具能不能被调到，取决于它在不在目录里，而 `shouldExposeBrowserControlTools()`
      // 在 `enabled === false` 时返回 `[]`（`tool.ts`）⇒ 模型根本没有这个名字可调。
      // 唯一能命中的是「目录按开启态构建完、执行前用户关掉开关」那个竞态窗口。
      // ⇒ 删掉，不留一条读者会以为「关闭时还能列标签」的死分支。
      // 真要让它在关闭时可用，得先改目录门（单独给它一条「只要 tabs 可用就暴露」的
      // 判据），那是另一件事、不是这里加个 `||`。
      if (!settings.enabled) {
        throw new BrowserControlError(
          'browser_control_disabled',
          'Browser control is disabled. Enable it in the Zai++ side panel before using browser tools.',
        );
      }

      const result = await this.executeEnabled(name, payload, settings, signal);
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

  /**
   * 这条标签上有没有正在跑的续跑循环。
   *
   * ⚠️ **只有页面知道答案** —— `continuationLoop` 活在内容脚本里，后台没有镜像。
   * 所以要发一条消息问（`QUERY_CONTINUATION_STATE`，走 `chrome.tabs.sendMessage`）。
   *
   * ⚠️⚠️ **必须带超时，且失败一律按「没有」处理** —— `tabs.sendMessage` 在
   * 「标签已关 / 内容脚本没注入 / 扩展刚重载」三种情况下都会抛
   * `Receiving end does not exist`，而**永不回**那种（页面卡死）如果一直等，
   * 会把 `browser_close_tab` 本身也拖住。这里给 1 秒的硬上界。
   * ⚠️ **失败方向：少拦一次只是退回改造前的行为，多拦一次会让用户关不掉正常标签。**
   */
  private async isContinuationRunning(tabId: number): Promise<boolean> {
    const chromeApi = this.getChromeApi();
    if (!chromeApi?.tabs?.sendMessage) return false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const response = await Promise.race([
        chromeApi.tabs.sendMessage(tabId, { type: 'QUERY_CONTINUATION_STATE' }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1_000);
        }),
      ]);
      return Boolean(
        response
        && typeof response === 'object'
        && (response as { continuationRunning?: unknown }).continuationRunning === true,
      );
    } catch {
      return false;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private async executeEnabled(
    name: BrowserControlToolName,
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
    signal: AbortSignal | undefined,
  ): Promise<BrowserActionResult> {
    switch (name) {
      case 'browser_navigate':
        return this.navigate(payload, settings, signal);
      case 'browser_go_back':
        return this.navigateHistory('back', settings, signal);
      case 'browser_go_forward':
        return this.navigateHistory('forward', settings, signal);
      case 'browser_refresh':
        return this.refresh(settings, signal);
      case 'browser_list_tabs':
        return this.listTabs(signal);
      case 'browser_select_tab':
        return this.selectTab(payload, signal);
      case 'browser_close_tab':
        return this.closeTab(payload, signal);
      case 'browser_snapshot':
        return this.snapshotAction(settings, signal);
      case 'browser_click':
        return this.pointAction('click', payload, settings, signal);
      case 'browser_hover':
        return this.pointAction('hover', payload, settings, signal);
      case 'browser_fill':
        return this.fill(payload, settings, signal);
      case 'browser_fill_form':
        return this.fillForm(payload, settings, signal);
      case 'browser_key':
        return this.key(payload, settings, signal);
      case 'browser_type':
        return this.typeText(payload, settings, signal);
      case 'browser_attach_file':
        return this.attachFile(payload, settings, signal);
      case 'browser_wait_for':
        return this.waitFor(payload, settings, signal);
      case 'browser_handle_dialog':
        return this.handleDialog(payload, signal);
      case 'browser_evaluate_script':
        return this.evaluateScript(payload, settings, signal);
      default:
        throw new BrowserControlError('browser_tool_unsupported', `Unsupported browser tool: ${name}`);
    }
  }

  private async navigate(
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
    signal: AbortSignal | undefined,
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
      await this.connection!.sendCommand('Page.navigate', { url }, signal);
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
    }, settings, tabId, signal);
  }

  private async navigateHistory(
    direction: 'back' | 'forward',
    settings: BrowserControlSettings,
    signal: AbortSignal | undefined,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    const history = await this.connection!.sendCommand<{
      currentIndex?: number;
      entries?: Array<{ id?: number; url?: string }>;
    }>('Page.getNavigationHistory', undefined, signal);
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
    await this.connection!.sendCommand('Page.navigateToHistoryEntry', { entryId: entry.id }, signal);
    return this.withOptionalSnapshot({
      ok: true,
      summary: direction === 'back' ? 'Went back' : 'Went forward',
      detail: `Navigated ${direction} to ${entry.url ?? '(unknown URL)'}.`,
      output: { tabId, direction, url: entry.url ?? '' },
    }, settings, tabId, signal);
  }

  private async refresh(
    settings: BrowserControlSettings,
    signal: AbortSignal | undefined,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    await this.connection!.sendCommand('Page.reload', { ignoreCache: false }, signal);
    return this.withOptionalSnapshot({
      ok: true,
      summary: 'Reloaded controlled tab',
      detail: `Reloaded tab ${tabId}.`,
      output: { tabId },
    }, settings, tabId, signal);
  }

  private async listTabs(signal: AbortSignal | undefined): Promise<BrowserActionResult> {
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

  private async selectTab(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<BrowserActionResult> {
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

  private async closeTab(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<BrowserActionResult> {
    const settings = await getBrowserControlSettings();
    const requestedTabId = typeof payload.tabId === 'number'
      ? requireInteger(payload, 'tabId')
      : settings.targetTabId;
    // ⚠️⚠️ **正在跑续跑循环的标签不许关** —— 关掉等于当场掐断那一轮续跑：
    // 内容脚本随标签一起消失，后台 DOM 任务收不到终态，只能等 `deadlineAt`（180 秒）到期。
    //
    // ⚠️⚠️ **判据是「这条标签上有没有正在跑的续跑循环」，不是「我有没有挂着 debugger」**。
    // 原来判的是 `keepAlive.isKeepingAlive(tabId)`，而那个集合是
    // `wanted ∩ 真在后台` ⇒ 开关关着（**默认值**）、或标签在前台时它恒为 `false`，
    // 这两格恰恰是最常见的情况 ⇒ **默认配置下这条保护等于不存在**。
    // 现在的判据由内容脚本直接回答（`QUERY_CONTINUATION_STATE`），它读的是页面里那份
    // `continuationLoop?.status === 'running'` —— 这才是「关掉会不会掐断续跑」的真身。
    //
    // ⚠️ **必须在解析目标之前判**（`ensureTargetTabId` 会写 storage 并静默换目标）：
    // 否则「存的 target 正是那条、又没有别的可控标签」时会先抛 `browser_target_missing`
    // （还说 retryable），错误码与事实不符。
    // ⚠️ **查不到就放行** —— 见 `isContinuationRunning` 的失败方向说明。
    if (requestedTabId !== null && await this.isContinuationRunning(requestedTabId)) {
      throw new BrowserControlError(
        'browser_target_protected',
        `Tab ${requestedTabId} is running a continuation loop and cannot be closed.`,
      );
    }
    const tabId = requestedTabId ?? await this.ensureTargetTabId(settings);
    // ⚠️ 「保活 `detach()` 失败后 `tabId` 留在原地、那条标签一直受保护」这一格已在
    // `tab-keepalive.ts` 收口：两类「标签已经没了」的措辞都会清掉绑定。
    if (this.connection?.tabId === tabId) await this.connection.detach();
    await this.requireChromeApi().tabs.remove(tabId);
    // ⚠️⚠️ **判断必须在写盘那一刻做，不能用开函数时读的 `settings`** ——
    // 中间隔着 `await tabs.remove`，若这期间侧边栏把 target 改成了另一条标签，
    // 拿旧快照判断就会把它的改动**覆盖成 null**（实测：target 12 → 关 12 期间改成 13
    // → 结果被清成 null）。`updateBrowserControlSettingsWith` 的 patch 在队列内求值，
    // 与 U2-4 的 `updateAutomationRuntimeWith` 同形。
    // ⚠️ `settings` 本身仍要用 —— 它决定 `requestedTabId` 的默认值（「关当前目标」是
    // 调用那一刻的意图，读旧值是对的），只是不再拿它做写决策。
    await updateBrowserControlSettingsWith((current) => (
      current.targetTabId === tabId ? { targetTabId: null } : null
    ));
    return {
      ok: true,
      summary: `Closed tab ${tabId}`,
      detail: `Closed browser tab ${tabId}.`,
      output: { tabId },
    };
  }

  private async snapshotAction(
    settings: BrowserControlSettings,
    signal: AbortSignal | undefined,
  ): Promise<BrowserActionResult> {
    const snapshot = await this.createSnapshot(settings, signal);
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
    signal: AbortSignal | undefined,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    const element = await this.resolveElement(payload, signal);
    const point = await this.getElementPoint(element.objectId, signal);
    if (!point.visible) {
      throw new BrowserControlError('browser_element_not_visible', `${element.label} is not visible.`);
    }

    await this.connection!.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
    }, signal);
    if (action === 'click') {
      const button = readString(payload.button, 'left');
      const clickCount = clampInteger(payload.clickCount, 1, 1, 3);
      await this.connection!.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button,
        clickCount,
      }, signal);
      await this.connection!.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button,
        clickCount,
      }, signal);
    }

    return this.withOptionalSnapshot({
      ok: true,
      summary: action === 'click' ? `Clicked ${element.label}` : `Hovered ${element.label}`,
      detail: `${action === 'click' ? 'Clicked' : 'Hovered'} ${element.label} at (${Math.round(point.x)}, ${Math.round(point.y)}).`,
      output: { tabId, action, target: element.label, point },
    }, settings, tabId, signal);
  }

  private async fill(
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
    signal: AbortSignal | undefined,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    const value = requireString(payload, 'value');
    const element = await this.resolveElement(payload, signal);
    await this.fillElement(element, value, signal);
    return this.withOptionalSnapshot({
      ok: true,
      summary: `Filled ${element.label}`,
      detail: `Filled ${element.label} using DOM value assignment and input/change events.`,
      output: { tabId, target: element.label, valueLength: value.length },
    }, settings, tabId, signal);
  }

  private async fillForm(
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
    signal: AbortSignal | undefined,
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
      const element = await this.resolveElement(record, signal);
      await this.fillElement(element, value, signal);
      filled.push({ target: element.label, valueLength: value.length });
    }

    return this.withOptionalSnapshot({
      ok: true,
      summary: `Filled ${filled.length} form fields`,
      detail: `Filled ${filled.length} fields using DOM value assignment and input/change events.`,
      output: { tabId, filled },
    }, settings, tabId, signal);
  }

  private async key(
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
    signal: AbortSignal | undefined,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    if (payload.uid || payload.selector) {
      const element = await this.resolveElement(payload, signal);
      await this.focusElement(element, signal);
    }
    const key = requireString(payload, 'key');
    const { params, text } = keyEventParams(key);
    // ⚠️⚠️ **有 `text` 的键必须用 `keyDown`，不能用 `rawKeyDown`** —— CDP 规范明写
    // `text` 参数「Not needed for `keyUp` and `rawKeyDown` events」，即 `rawKeyDown`
    // **不产生字符输入**（它只是「按下了一个键」）。原来恒用 `rawKeyDown` ⇒
    // `browser_key { key: 'a' }` 在页面上什么都不发生，而工具描述写的是
    // 「... or a character」。Puppeteer 的写法同样是 `type: text ? 'keyDown' : 'rawKeyDown'`。
    await this.connection!.sendCommand('Input.dispatchKeyEvent', {
      type: text === undefined ? 'rawKeyDown' : 'keyDown',
      ...params,
      ...(text === undefined ? {} : { text, unmodifiedText: text }),
    }, signal);
    // `keyUp` 不带 `text`（规范：`text` 对 `keyUp` 无意义）。
    await this.connection!.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      ...params,
    }, signal);

    return this.withOptionalSnapshot({
      ok: true,
      summary: `Pressed ${key}`,
      detail: `Pressed key ${key}.`,
      output: { tabId, key },
    }, settings, tabId, signal);
  }

  private async typeText(
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
    signal: AbortSignal | undefined,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    if (payload.uid || payload.selector) {
      const element = await this.resolveElement(payload, signal);
      await this.focusElement(element, signal);
    }
    const text = requireString(payload, 'text');
    await this.connection!.sendCommand('Input.insertText', { text }, signal);
    return this.withOptionalSnapshot({
      ok: true,
      summary: `Typed ${text.length} characters`,
      detail: `Inserted ${text.length} characters into the focused element.`,
      output: { tabId, textLength: text.length },
    }, settings, tabId, signal);
  }

  private async attachFile(
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
    signal: AbortSignal | undefined,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    const files = payload.files;
    // ⚠️ **`length === 0` 必须单独判** —— `[].every(...)` 恒 `true`，只写 `every` 的话
    // 空数组会通过这道「非空数组」校验，而 `DOM.setFileInputFiles` 收空数组是
    // **清空**文件选择，不是报错。同文件的 `fillForm` 用的是 `length === 0`，两处对齐。
    if (
      !Array.isArray(files) ||
      files.length === 0 ||
      !files.every((item) => typeof item === 'string' && item.trim())
    ) {
      throw new BrowserControlError('browser_invalid_files', 'files must be a non-empty string array of absolute file paths.');
    }
    const element = await this.resolveElement(payload, signal);
    await this.connection!.sendCommand('DOM.setFileInputFiles', {
      objectId: element.objectId,
      files,
    }, signal);
    return this.withOptionalSnapshot({
      ok: true,
      summary: `Attached ${files.length} file(s)`,
      detail: `Attached ${files.length} file(s) to ${element.label}.`,
      output: { tabId, target: element.label, fileCount: files.length },
    }, settings, tabId, signal);
  }

  private async waitFor(
    payload: Record<string, unknown>,
    settings: BrowserControlSettings,
    signal: AbortSignal | undefined,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    const timeoutMs = clampInteger(payload.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, 250, MAX_WAIT_TIMEOUT_MS);
    const started = this.now();
    const expression = waitExpression(payload);

    while (this.now() - started <= timeoutMs) {
      const matched = await this.evaluateBoolean(expression, signal);
      if (matched) {
        return this.withOptionalSnapshot({
          ok: true,
          summary: 'Wait condition matched',
          detail: `Condition matched after ${this.now() - started}ms.`,
          output: { tabId, waitedMs: this.now() - started },
        }, settings, tabId, signal);
      }
      await delay(250);
    }

    throw new BrowserControlError('browser_wait_timeout', `Condition did not match within ${timeoutMs}ms.`, {
      retryable: true,
    });
  }

  private async handleDialog(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<BrowserActionResult> {
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
    }, signal);
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
    signal: AbortSignal | undefined,
  ): Promise<BrowserActionResult> {
    const tabId = await this.ensureTargetTabId(settings);
    await this.ensureAttached(tabId);
    const expression = typeof payload.expression === 'string'
      ? payload.expression
      : requireString(payload, 'script');
    const result = await this.evaluate(expression, { awaitPromise: payload.awaitPromise !== false }, signal);
    return this.withOptionalSnapshot({
      ok: true,
      summary: 'Evaluated script',
      detail: `Result: ${JSON.stringify(result).slice(0, 4_000)}`,
      output: { tabId, result: toJsonSafe(result) },
    }, settings, tabId, signal);
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
    signal: AbortSignal | undefined,
    tabId?: number,
  ): Promise<BrowserSnapshotResult> {
    const resolvedTabId = tabId ?? await this.ensureTargetTabId(settings);
    await this.ensureAttached(resolvedTabId);
    const tab = await this.requireChromeApi().tabs.get(resolvedTabId);
    const ax = await this.connection!.sendCommand<{ nodes?: unknown[] }>('Accessibility.getFullAXTree', undefined, signal);
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
    signal: AbortSignal | undefined,
  ): Promise<BrowserActionResult> {
    if (!settings.includeSnapshotAfterActions) return result;
    const snapshot = await this.createSnapshot(settings, signal, tabId);
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

  private async resolveElement(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<ElementHandle> {
    const uid = typeof payload.uid === 'string' ? payload.uid.trim() : '';
    const selector = typeof payload.selector === 'string' ? payload.selector.trim() : '';
    if (!uid && !selector) {
      throw new BrowserControlError('browser_target_required', 'Either uid or selector is required.');
    }

    if (uid) {
      let backendNodeId = this.uidToBackendNodeId.get(uid);
      if (backendNodeId === undefined) {
        const settings = await getBrowserControlSettings();
        await this.createSnapshot(settings, signal);
        backendNodeId = this.uidToBackendNodeId.get(uid);
      }
      if (backendNodeId === undefined) {
        throw new BrowserControlError('browser_uid_not_found', `Snapshot uid not found: ${uid}`, {
          retryable: true,
        });
      }
      const resolved = await this.connection!.sendCommand<{
        object?: RuntimeRemoteObject;
      }>('DOM.resolveNode', { backendNodeId }, signal);
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
    }, signal);
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

  private async getElementPoint(
    objectId: string,
    signal: AbortSignal | undefined,
  ): Promise<ElementPoint> {
    const value = await this.callFunctionOn(
      objectId,
      String(getBrowserControlElementPoint),
      [],
      signal,
    );
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

  private async fillElement(
    element: ElementHandle,
    value: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await this.callFunctionOn(element.objectId, String(function fillElement(
      this: HTMLElement & { value?: string },
      nextValue: string,
    ) {
      this.focus();
      if ('value' in this) {
        // ⚠️⚠️ **必须走原型上的原生 setter，不能直接 `this.value = x`** ——
        // 直接赋值对 **React 受控组件无效**：React 在 `input` 事件里比对
        // 「DOM 当前值 vs 它上一次写下去的那份」，直接赋值把它那份快照一起改了
        // ⇒ 判定「没变化」⇒ 不更新 state。随后页面任何一次重渲染都会把 DOM 值
        // **回写成 state 里那个旧值**（实测：填完显示 hello，点一下别处就变回空串）。
        // 原生 setter 绕开这层记录，React 才能看到真实变化。
        //
        // ⚠️ **取 `Object.getPrototypeOf(this)` 而不是写死 `HTMLInputElement.prototype`** ——
        // textarea / select 各有自己的 setter，拿 input 的 setter 去调它们会
        // `Illegal invocation`。取自己的原型对三者都对。
        // ⚠️ 这与内容脚本 `setTextareaValue` 是同一套写法（那里已在 z.ai 真机验证有效）。
        const setter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(this) as object,
          'value',
        )?.set;
        if (setter) setter.call(this, nextValue);
        else this.value = nextValue;
      } else {
        this.textContent = nextValue;
      }
      this.dispatchEvent(new InputEvent('input', { bubbles: true, data: nextValue }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }), [{ value }], signal);
  }

  private async focusElement(
    element: ElementHandle,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await this.callFunctionOn(element.objectId, String(function focusElement(this: HTMLElement) {
      this.focus();
      return document.activeElement === this;
    }), [], signal);
  }

  private async callFunctionOn(
    objectId: string,
    functionDeclaration: string,
    args: Array<{ value: unknown }> = [],
    signal?: AbortSignal,
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
    }, signal);
    if (result.exceptionDetails) {
      throw new BrowserControlError(
        'browser_dom_call_failed',
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'DOM call failed.',
      );
    }
    return remoteObjectValue(result.result);
  }

  private async evaluate(
    expression: string,
    options: { awaitPromise: boolean },
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const result = await this.connection!.sendCommand<{
      result?: RuntimeRemoteObject;
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise,
    }, signal);
    if (result.exceptionDetails) {
      throw new BrowserControlError(
        'browser_script_failed',
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Script evaluation failed.',
      );
    }
    return remoteObjectValue(result.result);
  }

  private async evaluateBoolean(
    expression: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    return await this.evaluate(expression, { awaitPromise: true }, signal) === true;
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

  const point = readPoint(this);
  if (point.visible) return point;

  // ⚠️⚠️ **滚动之后不能再等一帧** —— `requestAnimationFrame` 在**后台标签**上永远不会
  // 被调用（Chrome 自 2011 年起就不给后台标签发 rAF，见 *Background tabs in Chrome 57*：
  // "Chrome does not call requestAnimationFrame() when a page is in the background"）。
  // 而浏览器控制的目标标签**常态就是在后台**（用户切回 z.ai 看输出、`newTab: false`
  // 时不激活）⇒ 在这里 `await` 会让整个 `Runtime.callFunctionOn`（`awaitPromise: true`）
  // 永不返回 ⇒ 整条 `EXECUTE_TOOL_CALL` 卡死 ⇒ 内容脚本 `pendingExecutions` 永不减
  // ⇒ 会合点永不触发 ⇒ **续跑循环停在 running**。本该报的 `browser_element_not_visible`
  // 变成静默永久挂住。
  //
  // ⚠️ **不等也读得到新位置**：`scrollIntoView({ behavior: 'instant' })` 是同步滚动，
  // 紧随其后的 `getBoundingClientRect()` 会强制布局并拿到滚动后的值。
  // ⚠️ **必须是 `'instant'` 不是 `'auto'`** —— `'auto'` 会尊重 CSS 的 `scroll-behavior`，
  // 页面写了 `smooth` 时滚动是异步的，同步读到的仍是旧位置。
  this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  return readPoint(this);
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

/**
 * 把工具入参的 `key` 翻成 CDP 的派发参数。
 *
 * 返回的 `text` **有值就代表这个键会产生字符输入**（调用方据此选 `keyDown` 还是
 * `rawKeyDown`）—— 这个区分不能省，见 `key()` 里的说明。
 */
function keyEventParams(key: string): { params: Record<string, unknown>; text?: string } {
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
  if (known) return { params: { key, ...known } };
  if (key.length === 1) {
    // ⚠️ **非 ASCII 单字符不拼 `code` / `windowsVirtualKeyCode`** —— `Key中` 与
    // 20013 都是编出来的假值，喂给 CDP 只会让页面的 KeyboardEvent 带一身错数据。
    // 只给 `key` + `text`，字符照样能插进去。
    if (key.charCodeAt(0) > 0x7f) return { params: { key }, text: key };
    return {
      params: {
        key,
        code: `Key${key.toUpperCase()}`,
        windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
      },
      text: key,
    };
  }
  return { params: { key } };
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

/**
 * 快照的**结构化元数据**（不含正文）。
 *
 * ⚠️⚠️ **`text` 刻意不在这里** —— 快照正文一律走 `detail`（`snapshotAction` 的
 * `detail: snapshot.text`、`withOptionalSnapshot` 的 `` `${detail}\n\n${text}` ``）。
 * 把它也塞进 `output` 的后果是**同一份文本在一条结果里出现两次**：
 * 实测一份 400 节点的中文列表页，`detail` 一份 + `output.snapshot.text` 一份
 * = 64,865 字节，去掉之后 31,865 字节 —— 载荷直接减半。
 * 而两份在进模型时都会被各自裁掉（detail 4000 字符 / output 8000 字符），
 * **裁下来的还都是同一份文本的开头**，并集只等于较长的那一份 ⇒ 第二次纯属浪费。
 * 更糟的是 output 那份是 JSON 转义形态（换行占两字符、引号要转义），同样的可见字符
 * 要多花约 7% 的长度，而且截断后是**不完整的 JSON 字符串**。
 *
 * ⚠️ **`output.snapshot` 在生产代码里零消费者**（`grep` 过：只有测试读顶层
 * `result.snapshot`，没有任何地方读 `output.snapshot.text`）⇒ 去掉它没有现实代价。
 * `truncated` 与 `nodeCount` 保留 —— 它们是「这份快照有没有被预算截断」的信号，
 * 与 `ToolResult.truncated` 同源。
 */
function snapshotToJson(snapshot: BrowserSnapshotResult): Record<string, unknown> {
  return {
    url: snapshot.url,
    title: snapshot.title,
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

/**
 * 「这个 tab id 已经不存在了」—— 用来决定「换一个目标」还是「原样抛出去」。
 *
 * ⚠️ **本函数只服务 `ensureTargetTabId` 这一条路，它的上游只调 `chrome.tabs.*`。**
 * 那两处判「`debugger.detach` 时目标已经没了」的地方（`cdp.ts` / `tab-keepalive.ts`）
 * **故意不共用本函数** —— 它们判断的是「目标状态已达成 ⇒ 不抛」，与这里「换一个目标」
 * 处置相反；把三处并成一份会让两个相反的语义缠在一起。
 *
 * ⚠️ **`invalid tab id` 那半是防御性的、当前不可达** —— `chrome.tabs.get` 现版本抛的是
 * `No tab with id: N`。留着是因为这条措辞在 Chromium 各版本间变过（早先是
 * `Invalid tab ID`），而**判错方向的代价是用户看到一个本该自愈的报错**。
 *
 * ⚠️ **不做成错误码判据**：Chrome 的扩展 API 不暴露结构化错误码（只有 `runtime.lastError`
 * 的一段文案），这里已经是能拿到的最稳定的形态。
 */
function isMissingTargetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no tab with id|invalid tab id/i.test(message);
}
