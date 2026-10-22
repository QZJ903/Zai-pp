/**
 * Zai++ DOM 任务协调器（方案 §4.3 Step 2）。
 *
 * 自动化任务不再在后台 fetch completion，而是由后台「找到/打开一个
 * z.ai 标签页 → 把 prompt 交给该页 content script → content 复用
 * zai.content.ts 的 DOM 注入 + 续跑循环让页面自己发请求」。本模块负责：
 *
 *   1. resolveTab：找/开 z.ai 标签页（优先复用空闲后台 tab，busy 一 tab 一任务；
 *      **两个站点都查**，站点归属按「显式指定 → 当前活动标签页 → 已开着的标签页
 *      → 最近活跃站 → 默认站」定下，见 `resolveDomTab`）；
 *   2. startTask：握手（RUN_DOM_TASK，退避重试）→ 登记 pending → 等终态事件；
 *   3. on*Event：消费 content 回传的 DOM_TASK_STARTED/COMPLETE/FAILED。
 *
 * 取消只有一条路：`startTask` 收到的 `signal` 被 abort 时发 `CANCEL_DOM_TASK`，
 * 以及 `deadlineAt` 到点时同样发一条。**没有独立的 cancelTask 入口** ——
 * 这个 signal 由 `scheduler` 的租约持有，三种情况会 abort 它：运行超时、租约丢失、
 * 以及用户在侧边栏删掉这条自动化（`DELETE_AUTOMATION`）。
 *
 * 工具执行与续跑仍由 content 自闭环（zai.content.ts 现状），本模块只做「工具执行器
 * （EXECUTE_TOOL_CALL handler 现状）＋ 最终结果消费者（收 DOM_TASK_COMPLETE）」。
 */

import type { ToolExecutionRecord } from '../types';
import { buildZaiChatSessionUrl } from './chat-session';
import { sleep } from './async';
import {
  ZAI_DOM_TASK_CANCELLED_CODE,
  ZAI_HOME_URL,
  ZAI_SITES,
  ZAI_TAB_URL_PATTERNS,
  ZAI_WEB_ORIGIN,
  resolveZaiSiteOrigin,
} from './contracts';
import { readActiveZaiSiteOrigin } from './active-site';

export type DomTaskKind = 'automation';

export interface DomTaskStartedEvent {
  taskId: string;
  chatSessionId: string | null;
}

export interface DomTaskCompleteEvent {
  taskId: string;
  chatSessionId: string | null;
  assistantText: string;
  toolExecutions: ToolExecutionRecord[];
  steps: number;
}

export interface DomTaskFailedEvent {
  taskId: string;
  error: string;
  /**
   * 失败时页面上已经建立的会话 id。首轮生成中途被暂停时，DOM_TASK_STARTED 那两次
   * 都还没拿到 `/c/<id>`，只有内容脚本在失败回传这一刻能读到真值 ——
   * 不带回来，自动化就会永远停在会话「未创建」。
   */
  chatSessionId?: string | null;
}

/**
 * 一次 DOM 任务落在**哪个站点**（origin，不含尾斜杠）。
 *
 * ⚠️⚠️ **它是「本次运行实际落在哪」的载体** —— 后台没有页面上下文，而会话链接必须有
 * 正确的 origin。协调器在 `resolveDomTab` 那一刻就知道这个任务用的是哪个站的标签页
 * （那是它自己挑的/自己开的），所以把结论**随结果带回来**，而不是让下游去猜
 * 「当前站是哪个」。
 *
 * ⚠️ **为什么不读「最近活跃站」**：一条固定会话的自动化任务可能一直跑在 A 站，
 * 而用户此刻在 B 站看别的东西 —— 跟随「活跃站」会让那条记录的链接在用户切站时
 * 跳到另一个站（那个站既没有这条会话、token 也不通用 ⇒ 打开是 401）。
 * 「这条任务跑在哪」是**这条任务自己的属性**，只能由跑它的那一刻决定。
 */
export type DomTaskSiteOrigin = string;

export type DomTaskOutcome =
  | {
      ok: true;
      taskId: string;
      chatSessionId: string | null;
      /** 本次运行落在哪个站（`resolveDomTab` 挑中的标签页所属站点）。 */
      siteOrigin: DomTaskSiteOrigin;
      assistantText: string;
      toolExecutions: ToolExecutionRecord[];
      steps: number;
    }
  | {
      ok: false;
      taskId: string;
      error: string;
      /**
       * 失败发生的环节。
       *
       * ⚠️ **`'cancelled'` 只由 `onFailed` 产出**（内容脚本回传 `error: 'cancelled'`），
       * 判据是**错误码本身**而不是「谁调用的」—— 因为其余失败码与取消码走的是同一条
       * 回传通道，只有码能区分。它存在的意义是把「用户主动停止」从 `'runner'` 里分出来：
       * 否则 `scheduler.completeRun` 只能靠 `code === 'dom_automation_cancelled'` 特判
       * （那是**判定端与生产端各写一遍**的老形态）。
       */
      phase: 'tab' | 'bridge' | 'runner' | 'cancelled';
      retrySafe?: boolean;
      /**
       * 失败时页面上已经建立的会话 id（来自 DOM_TASK_STARTED）。
       * 失败结果要把它带回后台落库，否则「新会话跑一半失败」的自动化永远停在
       * 会话「未创建」——页面明明已经建了对话，侧边栏却打不开。
       */
      chatSessionId?: string | null;
      /**
       * 失败前已经落定的站点。⚠️ **`'tab'` 阶段失败时它可能是 `null`** ——
       * 那一刻还没挑中任何标签页（如 `zai_tab_create_failed`），无从知道站点。
       * 下游要按「null = 不知道」处理，退回记录里已有的站点，
       * **不能当成「不属于任何站」**。
       */
      siteOrigin?: DomTaskSiteOrigin | null;
    };

export interface DomTaskStartInput {
  taskId: string;
  kind: DomTaskKind;
  prompt: string;
  chatSessionId: string | null;
  /**
   * **本次运行指定去哪个站**（origin）。`null` / 缺省 = 不指定，由协调器就地判定。
   *
   * ⚠️ **只有「复用已有会话」的任务才带它** —— 会话 id 在两站之间不通用
   * （token 也互不认），拿错站去拼 `/c/<id>` 会打开一个 401 或「会话不存在」的页面。
   * 其余情况传 null：协调器按「用户当前所在的标签页 → 已开着的标签页 →
   * 最近活跃站 → 默认站」判定（见 `resolveDomTab`）。
   * 输入侧是这里，输出侧是 `DomTaskOutcome.siteOrigin`。
   */
  siteOrigin?: string | null;
  /** 自动化任务选定的模型 id（两种模式下都覆写请求体的 model）；null = 跟随页面默认。 */
  model?: string | null;
}

export interface DomTaskStartOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  handshakeTimeoutMs?: number;
  /**
   * 内容脚本首次确认「本次运行落在哪个会话」时回调一次（新会话下 chatNew 阶段读不到
   * `/c/<id>`，要等 SPA 跳转后的那次 DOM_TASK_STARTED 才有值）。
   * 消费者据此立刻把会话落库，而不是等 run 收尾 —— 否则运行期间（以及失败收尾后）
   * 侧边栏一直显示会话「未创建」、打不开。
   *
   * ⚠️⚠️ **站点必须随回调一起给出** —— 消费者要**当场**拼一条可打开的会话 URL，
   * 而会话 id 在两站之间不通用（token 也互不认）。它自己只能读到「记录里**上一次**
   * 运行的站点」，首次运行时那个值是 null ⇒ 会拼成默认站的链接（国际站上跑任务时
   * 点开是 401）。
   * ⚠️ 站点在 `resolveDomTab` 挑中标签页时就已经定下（`entry.siteOrigin`），
   * 信息是齐的，**不许让消费者去猜**（也不要让它读「最近活跃站」—— 那条路在
   * 「任务跑在 A 站、用户正在看 B 站」时必然给错）。
   */
  onSessionStarted?(chatSessionId: string, siteOrigin: DomTaskSiteOrigin): void;
}

export interface DomTaskCoordinatorDeps {
  /**
   * 找标签页用的 URL 匹配模式（`chrome.tabs.query` 的 `url` 字段）。
   *
   * ⚠️ **不传时用 `ZAI_TAB_URL_PATTERNS`（两个站都查）** —— 只查默认站会让
   * 国际站上已经开着的空闲标签页**永远找不到**，于是每次任务都新开一个国区站的
   * 标签页，而那个标签页在用户的代理环境下未必打得开。
   */
  tabUrlPatterns?: readonly string[];
  /**
   * 读「最近活跃站」（A 兜底）。不传时用 `readActiveZaiSiteOrigin`。
   *
   * ⚠️ **只有在「显式站点」与「已开着的标签页」都给不出结论时才读它** ——
   * 见 `resolveDomTab` 的判定顺序说明。
   */
  readActiveSiteOrigin?: () => Promise<string>;
  queryTabs?(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
  createTab?(props: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
  updateTab?(
    tabId: number,
    props: chrome.tabs.UpdateProperties,
  ): Promise<chrome.tabs.Tab>;
  sendTabMessage?(tabId: number, message: unknown): Promise<unknown>;
  reportError?(code: string, error: unknown): void;
}

export interface DomTaskCoordinator {
  startTask(
    input: DomTaskStartInput,
    options?: DomTaskStartOptions,
  ): Promise<DomTaskOutcome>;
  onStarted(event: DomTaskStartedEvent): void;
  onComplete(event: DomTaskCompleteEvent): void;
  onFailed(event: DomTaskFailedEvent): void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 8_000;

const RETRYABLE_PRE_SEND_ERRORS: ReadonlySet<string> = new Set([
  'no_textarea',
  'form_not_connected',
  'agent_not_idle',
]);

interface PendingDomTask {
  taskId: string;
  kind: DomTaskKind;
  tabId: number;
  chatSessionId: string | null;
  startedChatSessionId: string | null;
  /** 本任务落在哪个站（`resolveDomTab` 挑中标签页时定下，沿用到收尾）。 */
  siteOrigin: DomTaskSiteOrigin;
  /** 会话 id 是否已经回调过 onSessionStarted（只回调一次）。 */
  sessionReported: boolean;
  onSessionStarted?: (chatSessionId: string, siteOrigin: DomTaskSiteOrigin) => void;
  settled: boolean;
  resolve: (outcome: DomTaskOutcome) => void;
  reject: (error: unknown) => void;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
}

export function createDomTaskCoordinator(
  deps: DomTaskCoordinatorDeps = {},
): DomTaskCoordinator {
  // ⚠️ **不传时用两个站的模式** —— 只查默认站会让另一站的空闲标签页永远找不到。
  const tabUrlPatterns = deps.tabUrlPatterns ?? ZAI_TAB_URL_PATTERNS;
  const queryTabs = deps.queryTabs ?? ((query) => chrome.tabs.query(query));
  const createTab = deps.createTab ?? ((props) => chrome.tabs.create(props));
  const updateTab = deps.updateTab ?? ((tabId, props) => chrome.tabs.update(tabId, props));
  const sendTabMessage = deps.sendTabMessage ?? ((tabId, message) => chrome.tabs.sendMessage(tabId, message));
  const readActiveSiteOrigin = deps.readActiveSiteOrigin ?? readActiveZaiSiteOrigin;
  const reportError = deps.reportError ?? ((code, error) => console.error(`[Zai++] ${code}`, error));

  /** tabId → taskId：一 tab 同一时刻只跑一个后台任务（busy 锁）。 */
  const busyTabs = new Map<number, string>();
  /** taskId → 现场：等终态事件的任务。 */
  const pending = new Map<string, PendingDomTask>();

  function cleanupEntry(entry: PendingDomTask): void {
    pending.delete(entry.taskId);
    if (busyTabs.get(entry.tabId) === entry.taskId) busyTabs.delete(entry.tabId);
    if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
    entry.abortCleanup?.();
  }

  function settleEntry(entry: PendingDomTask, outcome: DomTaskOutcome): void {
    if (entry.settled) return;
    entry.settled = true;
    cleanupEntry(entry);
    entry.resolve(outcome);
  }

  function failEntry(entry: PendingDomTask, error: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    cleanupEntry(entry);
    entry.reject(error);
  }

  /**
   * 会话 URL 与会话 id 的拼接只保留 `chat-session.ts` 一处真源 ——
   * 这里把**该任务所属站点**的 origin 作为 baseUrl 传进去。
   *
   * ⚠️ **不能再用 deps 注入的 `homeUrl`** —— 那是单个站的主页，而两个站的主页不同。
   * 站点由 `resolveDomTab` 在挑中标签页时定下，这里只负责把它转成 origin。
   */
  function buildSessionUrl(chatSessionId: string, siteOrigin: DomTaskSiteOrigin): string {
    return buildZaiChatSessionUrl(chatSessionId, siteOrigin);
  }

  function normalizeTabUrl(url: string | undefined): string {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  }

  /** 某站的主页（带尾斜杠）；认不出站点时退回默认站。 */
  function homeUrlFor(siteOrigin: DomTaskSiteOrigin | null): string {
    const site = Object.values(ZAI_SITES).find((candidate) => candidate.origin === siteOrigin);
    return (site?.homeUrl ?? ZAI_HOME_URL).replace(/\/+$/, '') + '/';
  }

  /**
   * 用户**此刻正在看的那个标签页**属于哪个站；不是站点集合里的页面就返回 `null`。
   *
   * ⚠️ **从 service worker 里查 `currentWindow` 拿到的是「最后聚焦的那个窗口」** ——
   * 与 `background.ts` 的「读当前对话」「插入提示词」两处用的是同一个假设。
   * ⚠️ 查失败**不抛**：这只是「更贴近用户意图」的一层偏好，失败后退回后面的
   * 主页扫描 / 活跃站 / 默认站，不该让整次解析失败。
   */
  async function readActiveTabSiteOrigin(): Promise<string | null> {
    try {
      const tabs = await queryTabs({ active: true, currentWindow: true });
      for (const tab of tabs) {
        const origin = resolveZaiSiteOrigin(tab.url);
        if (origin) return origin;
      }
    } catch (error) {
      reportError('dom_task_active_tab_query_failed', error);
    }
    return null;
  }

  /**
   * 解析要用的 z.ai 标签页，并返回「实际生效的会话 id」与**该标签页所属站点**。
   *
   * 站点的**判定顺序**：
   *
   * 1. **调用方显式给的 `input.siteOrigin`** —— 只用于**固定会话**：那条会话属于
   *    哪个站是确定的，会话 id 在两站之间不通用（非固定会话传 `null`，见
   *    `AutomationRunnerRequest.siteOrigin`）。
   * 2. **用户当前正在看的那个标签页**（新对话）：它在哪个站，新对话就开在哪个站。
   *    ⚠️ 这一层必须排在「按站点表顺序扫主页」之前 —— `ZAI_SITES` 的键顺序是
   *    `cn` 在前，两个站的主页都开着时会**永远选国区站**，与用户此刻所在的站无关。
   * 3. **已有的空闲标签页**：续用会话时按精确 URL 在两站里找；新对话时按两站的主页找。
   *    命中哪个站就用哪个站 —— 复用用户已经开着的页面，比新开一个更少打扰。
   * 4. **「最近活跃站」**（`deps.readActiveSiteOrigin`，跨上下文记录）：前几条都没结论时，
   *    用户眼下在用哪个站就去哪个站。
   * 5. **默认站**（国区站）收口。
   *
   * ⚠️ **顺序不可颠倒**：把 4 提到 1 前面会让固定会话任务跟着用户切站乱跑；
   * 把 3 提到 1 前面会让「记录说 A 站」被「B 站恰好开着个主页」顶掉。
   *
   * 返回的 chatSessionId 与输入可能不同：续用会话时找不到精确 /c/<id> tab，
   * 就降级为「新会话」语义（chatSessionId 置 null、走新对话的标签页解析），
   * 而不是新开目标会话 tab 后又被 content 的 wrong_conversation 校验拒绝。
   * content 收到 null 会跳过会话一致性校验（新会话本来就是 null）。
   */
  async function resolveDomTab(
    chatSessionId: string | null,
    requestedSiteOrigin: string | null,
  ): Promise<{
    tabId: number;
    chatSessionId: string | null;
    siteOrigin: DomTaskSiteOrigin;
    isNewlyCreated: boolean;
  }> {
    const sessionId = chatSessionId && chatSessionId.trim() ? chatSessionId : null;
    // 两站一起查：只查默认站会让另一站上开着的空闲标签页永远找不到。
    const tabs: chrome.tabs.Tab[] = [];
    for (const pattern of tabUrlPatterns) {
      try {
        tabs.push(...await queryTabs({ url: pattern }));
      } catch (error) {
        // 某个模式查失败不该让整次解析失败（另一个站仍可用）。
        reportError('dom_task_tab_query_failed', error);
      }
    }
    const idleTabs = tabs.filter((tab) => tab.id != null && !busyTabs.has(tab.id));

    const fallbackSiteOrigin = (): Promise<string> => (
      readActiveSiteOrigin().then(
        (origin) => resolveZaiSiteOrigin(origin) ?? ZAI_WEB_ORIGIN,
        () => ZAI_WEB_ORIGIN,
      )
    );

    // 续用会话：必须落在精确的 /c/<id>（content 侧会做 wrong_conversation 校验）。
    if (sessionId != null) {
      for (const candidateSite of candidateSitesFor(requestedSiteOrigin)) {
        const target = buildSessionUrl(sessionId, candidateSite);
        const exact = idleTabs.find((tab) => normalizeTabUrl(tab.url) === target);
        if (exact?.id != null) {
          return {
            tabId: exact.id,
            chatSessionId: sessionId,
            siteOrigin: candidateSite,
            isNewlyCreated: false,
          };
        }
      }
      // 找不到精确 tab：**新开目标会话 tab**（固定会话场景），而不是降级新会话。
      // 让用户即使关掉了原会话窗口，后续运行也能找回同一个对话继续。
      // 站点取「显式给的」→「最近活跃站」→「默认站」。
      const siteOrigin = requestedSiteOrigin
        ? (resolveZaiSiteOrigin(requestedSiteOrigin) ?? await fallbackSiteOrigin())
        : await fallbackSiteOrigin();
      const created = await createTab({ url: buildSessionUrl(sessionId, siteOrigin), active: false });
      if (created.id == null) throw new Error('zai_tab_create_failed');
      return { tabId: created.id, chatSessionId: sessionId, siteOrigin, isNewlyCreated: true };
    }

    // 新对话：优先精确 home 页（两站任一）；**绝不复用任何已有 /c/<id> 对话 tab**——
    // 否则会把 prompt 塞进用户当前停留的、不属于该任务的会话里。
    if (!requestedSiteOrigin) {
      // 先看用户当前正在看的那个标签页：它在哪个站，新对话就开在哪个站。
      // ⚠️ 这一层必须排在「按站点表顺序扫主页」之前 —— `ZAI_SITES` 的键顺序是
      // `cn` 在前，两个站的主页都开着时会**永远选国区站**，与用户此刻所在的站无关。
      const activeSiteOrigin = await readActiveTabSiteOrigin();
      const activeSite = activeSiteOrigin
        ? Object.values(ZAI_SITES).find((site) => site.origin === activeSiteOrigin)
        : undefined;
      if (activeSite) {
        const exactHome = idleTabs.find((tab) => normalizeTabUrl(tab.url) === activeSite.homeUrl);
        if (exactHome?.id != null) {
          return {
            tabId: exactHome.id,
            chatSessionId: null,
            siteOrigin: activeSite.origin,
            isNewlyCreated: false,
          };
        }
        // 当前标签页不是主页（比如正停在某个会话里）⇒ 在同一个站新开一个主页 tab。
        const created = await createTab({ url: activeSite.homeUrl, active: false });
        if (created.id == null) throw new Error('zai_tab_create_failed');
        return {
          tabId: created.id,
          chatSessionId: null,
          siteOrigin: activeSite.origin,
          isNewlyCreated: true,
        };
      }
      for (const site of Object.values(ZAI_SITES)) {
        const exactHome = idleTabs.find((tab) => normalizeTabUrl(tab.url) === site.homeUrl);
        if (exactHome?.id != null) {
          return {
            tabId: exactHome.id,
            chatSessionId: null,
            siteOrigin: site.origin,
            isNewlyCreated: false,
          };
        }
      }
    }

    const siteOrigin = requestedSiteOrigin
      ? (resolveZaiSiteOrigin(requestedSiteOrigin) ?? await fallbackSiteOrigin())
      : await fallbackSiteOrigin();
    const created = await createTab({ url: homeUrlFor(siteOrigin), active: false });
    if (created.id == null) throw new Error('zai_tab_create_failed');
    return { tabId: created.id, chatSessionId: null, siteOrigin, isNewlyCreated: true };
  }

  /**
   * 续用会话时「先在哪些站里找那个精确标签页」。
   *
   * ⚠️ **显式指定的站排在最前**，其余站也会找一遍 —— 因为请求方给的站可能来自一条
   * 较早的记录（那时用户可能在另一站跑过同一条会话），而**标签页存在才是硬证据**：
   * 页面在哪一站，会话就真的在哪一站。
   */
  function candidateSitesFor(requestedSiteOrigin: string | null): readonly string[] {
    const explicit = resolveZaiSiteOrigin(requestedSiteOrigin);
    const all = Object.values(ZAI_SITES).map((site) => site.origin);
    if (!explicit) return all;
    return [explicit, ...all.filter((origin) => origin !== explicit)];
  }

  async function handshake(
    tabId: number,
    input: DomTaskStartInput,
    options: DomTaskStartOptions,
  ): Promise<{ ok: boolean; error?: string; phase?: 'tab' | 'bridge' }> {
    const deadline = Date.now() + (options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
    let attempt = 0;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      try {
        const response = await sendTabMessage(tabId, {
          type: 'RUN_DOM_TASK',
          taskId: input.taskId,
          kind: input.kind,
          prompt: input.prompt,
          chatSessionId: input.chatSessionId,
          model: typeof input.model === 'string' ? input.model : null,
        });
        if (response && typeof response === 'object') {
          const record = response as { ok?: boolean; error?: string };
          if (record.ok === true) return { ok: true };
          const error = record.error ?? 'dom_task_rejected';
          return {
            ok: false,
            error,
            phase: error === 'wrong_conversation' || error === 'busy' ? 'tab' : 'bridge',
          };
        }
        // 无结构化响应：content 可能尚未注入 → 退避重试。
      } catch (error) {
        // 「Receiving end does not exist」→ content 未注入（新开 tab 加载中）→ 退避重试。
        if (options.signal?.aborted) throw abortReason(options.signal);
        void error;
      }
      await sleep(300 + attempt * 250);
      attempt += 1;
    }
    return { ok: false, error: 'dom_task_handshake_timeout', phase: 'bridge' };
  }

  function cancelDomTaskMessage(tabId: number, taskId: string): Promise<unknown> {
    return sendTabMessage(tabId, { type: 'CANCEL_DOM_TASK', taskId }).catch(() => undefined);
  }

  async function startTask(
    input: DomTaskStartInput,
    options: DomTaskStartOptions = {},
  ): Promise<DomTaskOutcome> {
    const taskId = input.taskId;
    if (!taskId || !input.prompt) {
      return { ok: false, taskId, error: 'missing_task_id_or_prompt', phase: 'runner' };
    }
    if (pending.has(taskId)) {
      return { ok: false, taskId, error: 'task_already_registered', phase: 'runner' };
    }
    const signal = options.signal;
    if (signal?.aborted) throw abortReason(signal);

    let tabId: number;
    let effectiveChatSessionId: string | null;
    let siteOrigin: DomTaskSiteOrigin;
    let isNewlyCreated = false;
    try {
      const resolved = await resolveDomTab(input.chatSessionId, input.siteOrigin ?? null);
      tabId = resolved.tabId;
      effectiveChatSessionId = resolved.chatSessionId;
      siteOrigin = resolved.siteOrigin;
      isNewlyCreated = resolved.isNewlyCreated;
    } catch (error) {
      // ⚠️ `'tab'` 阶段失败时**站点未知** —— 这里还没挑中任何标签页。
      // 下游按「null = 不知道」处理（退回记录里的站点或默认站），不当成「不属于任何站」。
      return { ok: false, taskId, error: errorMessage(error), phase: 'tab', siteOrigin: null };
    }
    busyTabs.set(tabId, taskId);

    // 只对新开的 tab 激活一次（首次加载需要前台才能完成初始化）；
    // 复用已有 tab 时绝不抢用户焦点，避免把用户正在看的前台页面切走。
    if (isNewlyCreated) {
      try {
        await updateTab(tabId, { active: true });
      } catch {
        /* 激活失败不致命，继续握手 */
      }
    }

    return new Promise<DomTaskOutcome>((resolve, reject) => {
      const entry: PendingDomTask = {
        taskId,
        kind: input.kind,
        tabId,
        chatSessionId: effectiveChatSessionId,
        startedChatSessionId: effectiveChatSessionId,
        siteOrigin,
        sessionReported: false,
        onSessionStarted: options.onSessionStarted,
        settled: false,
        resolve,
        reject,
      };
      pending.set(taskId, entry);

      if (signal) {
        const onAbort = () => {
          void cancelDomTaskMessage(tabId, taskId);
          failEntry(entry, abortReason(signal));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        entry.abortCleanup = () => signal.removeEventListener('abort', onAbort);
      }

      if (options.deadlineAt != null) {
        const waitMs = Math.max(0, options.deadlineAt - Date.now());
        entry.deadlineTimer = setTimeout(() => {
          void cancelDomTaskMessage(tabId, taskId);
          failEntry(entry, new Error('dom_task_deadline_exceeded'));
        }, waitMs);
      }

      // 握手消息使用解析后的 effectiveChatSessionId：降级成新会话时传给 content 的是
      // null，content 的 wrong_conversation 校验直接跳过。
      void handshake(tabId, { ...input, chatSessionId: effectiveChatSessionId }, options).then(
        (result) => {
          if (entry.settled) return;
          if (result.ok) return; // 等待 DOM_TASK_STARTED/COMPLETE/FAILED 事件。
          settleEntry(entry, {
            ok: false,
            taskId,
            error: result.error ?? 'dom_task_rejected',
            phase: result.phase ?? 'bridge',
            // 站点此时已经定下（标签页是 resolveDomTab 挑的），沿用它。
            siteOrigin,
          });
        },
        (error) => {
          if (!entry.settled) {
            settleEntry(entry, { ok: false, taskId, error: errorMessage(error), phase: 'bridge', siteOrigin });
          }
        },
      );
    });
  }

  function onStarted(event: DomTaskStartedEvent): void {
    const entry = pending.get(event.taskId);
    if (!entry) return;
    entry.startedChatSessionId = event.chatSessionId ?? entry.startedChatSessionId;
    // 首次拿到会话 id 就立刻回调：内容脚本在 SPA 跳到 /c/<id> 后才发得出这个值，
    // 此刻把会话落库，运行中/失败后侧边栏都能打开会话。
    // ⚠️ **站点一起传**（`entry.siteOrigin`）—— 见 `onSessionStarted` 的说明：
    // 消费者要当场拼 URL，而它自己读不到本次运行的站点。
    if (!entry.sessionReported && entry.startedChatSessionId) {
      entry.sessionReported = true;
      try {
        entry.onSessionStarted?.(entry.startedChatSessionId, entry.siteOrigin);
      } catch (error) {
        reportError('dom_task_session_started_callback_failed', error);
      }
    }
  }

  function onComplete(event: DomTaskCompleteEvent): void {
    const entry = pending.get(event.taskId);
    if (!entry || entry.settled) return;
    const chatSessionId = event.chatSessionId ?? entry.startedChatSessionId;
    settleEntry(entry, {
      ok: true,
      taskId: event.taskId,
      chatSessionId,
      siteOrigin: entry.siteOrigin,
      assistantText: event.assistantText ?? '',
      toolExecutions: event.toolExecutions ?? [],
      steps: event.steps ?? 0,
    });
  }

  function onFailed(event: DomTaskFailedEvent): void {
    const entry = pending.get(event.taskId);
    if (!entry || entry.settled) return;
    const retrySafe = RETRYABLE_PRE_SEND_ERRORS.has(event.error);
    settleEntry(entry, {
      ok: false,
      taskId: event.taskId,
      error: event.error || 'dom_task_failed',
      // 用户主动停止（点 Stop / 关标签页 / 手动暂停）走的是同一条回传通道，
      // 只有**错误码**能把它与其它失败区分开 ⇒ 在这里定档，不让判定端再去比 code。
      phase: event.error === ZAI_DOM_TASK_CANCELLED_CODE ? 'cancelled' : 'runner',
      retrySafe,
      chatSessionId: event.chatSessionId ?? entry.startedChatSessionId,
      // 站点沿用它 —— 失败也要能拼出「跑在哪个站」的会话链接。
      siteOrigin: entry.siteOrigin,
    });
  }

  return Object.freeze({
    startTask,
    onStarted,
    onComplete,
    onFailed,
  });
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason instanceof Error) return signal.reason;
  if (signal.reason !== undefined && signal.reason !== null) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
