/**
 * GLM++ DOM 任务协调器（方案 §4.3 Step 2）。
 *
 * 自动化任务不再在后台 fetch completion，而是由后台「找到/打开一个
 * chat.z.ai 标签页 → 把 prompt 交给该页 content script → content 复用
 * zai.content.ts 的 DOM 注入 + 续跑循环让页面自己发请求」。本模块负责：
 *
 *   1. resolveTab：找/开 chat.z.ai 标签页（优先复用空闲后台 tab，busy 一 tab 一任务）；
 *   2. startTask：握手（RUN_DOM_TASK，退避重试）→ 登记 pending → 等终态事件；
 *   3. cancelTask：发 CANCEL_DOM_TASK；
 *   4. on*Event：消费 content 回传的 DOM_TASK_STARTED/COMPLETE/FAILED/NEEDS_ACTION/PROGRESS。
 *
 * 工具执行与续跑仍由 content 自闭环（zai.content.ts 现状），本模块只做「工具执行器
 * （EXECUTE_TOOL_CALL handler 现状）＋ 最终结果消费者（收 DOM_TASK_COMPLETE）」。
 */

import type { ToolExecutionRecord } from '../types';
import { buildZaiChatSessionUrl } from './chat-session';
import { ZAI_DOM_TASK_CANCELLED_CODE } from './contracts';

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

export interface DomTaskNeedsActionEvent {
  taskId: string;
  kind: 'captcha' | 'peak';
}

export interface DomTaskProgressEvent {
  taskId: string;
  text: string;
  phase: string;
}

export type DomTaskOutcome =
  | {
      ok: true;
      taskId: string;
      chatSessionId: string | null;
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
    };

export interface DomTaskStartInput {
  taskId: string;
  kind: DomTaskKind;
  prompt: string;
  chatSessionId: string | null;
  /** 自动化任务是否开启 z.ai 联网搜索（任务归属请求体里置 features.web_search/auto_web_search）。 */
  searchEnabled?: boolean;
  /** 自动化任务选定的模型 id（chat 模式下覆写请求体的 model）；null = 跟随页面默认。 */
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
   */
  onSessionStarted?(chatSessionId: string): void;
}

export interface DomTaskCoordinatorDeps {
  homeUrl?: string;
  tabUrlPattern?: string;
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
  cancelTask(taskId: string): void;
  onStarted(event: DomTaskStartedEvent): void;
  onComplete(event: DomTaskCompleteEvent): void;
  onFailed(event: DomTaskFailedEvent): void;
  onNeedsAction(event: DomTaskNeedsActionEvent): void;
  onProgress(event: DomTaskProgressEvent): void;
}

const DEFAULT_HOME_URL = 'https://chat.z.ai/';
const DEFAULT_TAB_URL_PATTERN = '*://chat.z.ai/*';
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
  /** 会话 id 是否已经回调过 onSessionStarted（只回调一次）。 */
  sessionReported: boolean;
  onSessionStarted?: (chatSessionId: string) => void;
  settled: boolean;
  resolve: (outcome: DomTaskOutcome) => void;
  reject: (error: unknown) => void;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
}

export function createDomTaskCoordinator(
  deps: DomTaskCoordinatorDeps = {},
): DomTaskCoordinator {
  const homeUrl = (deps.homeUrl ?? DEFAULT_HOME_URL).replace(/\/+$/, '') + '/';
  const tabUrlPattern = deps.tabUrlPattern ?? DEFAULT_TAB_URL_PATTERN;
  const queryTabs = deps.queryTabs ?? ((query) => chrome.tabs.query(query));
  const createTab = deps.createTab ?? ((props) => chrome.tabs.create(props));
  const updateTab = deps.updateTab ?? ((tabId, props) => chrome.tabs.update(tabId, props));
  const sendTabMessage = deps.sendTabMessage ?? ((tabId, message) => chrome.tabs.sendMessage(tabId, message));
  const reportError = deps.reportError ?? ((code, error) => console.error(`[GLM++] ${code}`, error));

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
   * 这里把 deps 注入的 `homeUrl` 作为 baseUrl 传进去，保证自定义 host 时两边仍然一致。
   */
  function buildSessionUrl(chatSessionId: string): string {
    return buildZaiChatSessionUrl(chatSessionId, homeUrl);
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

  /**
   * 解析要用的 chat.z.ai 标签页，并返回「实际生效的会话 id」。
   *
   * 返回的 chatSessionId 与输入可能不同：续用会话时找不到精确 /c/<id> tab，
   * 就降级为「新会话」语义（chatSessionId 置 null、走新对话的标签页解析），
   * 而不是新开目标会话 tab 后又被 content 的 wrong_conversation 校验拒绝。
   * content 收到 null 会跳过会话一致性校验（新会话本来就是 null）。
   */
  async function resolveDomTab(
    chatSessionId: string | null,
  ): Promise<{ tabId: number; chatSessionId: string | null; isNewlyCreated: boolean }> {
    const sessionId = chatSessionId && chatSessionId.trim() ? chatSessionId : null;
    const tabs = await queryTabs({ url: tabUrlPattern });
    const idleTabs = tabs.filter((tab) => tab.id != null && !busyTabs.has(tab.id));

    // 续用会话：必须落在精确的 /c/<id>（content 侧会做 wrong_conversation 校验）。
    if (sessionId != null) {
      const target = buildSessionUrl(sessionId);
      const exact = idleTabs.find((tab) => normalizeTabUrl(tab.url) === target);
      if (exact?.id != null) return { tabId: exact.id, chatSessionId: sessionId, isNewlyCreated: false };
      // 找不到精确 tab：**新开目标会话 tab**（固定会话场景），而不是降级新会话。
      // 让用户即使关掉了原会话窗口，后续运行也能找回同一个对话继续。
      const created = await createTab({ url: target, active: false });
      if (created.id == null) throw new Error('zai_tab_create_failed');
      return { tabId: created.id, chatSessionId: sessionId, isNewlyCreated: true };
    }

    // 新对话：优先精确 home 页；找不到就新开一个 home tab。**绝不复用任何已有 /c/<id>
    // 对话 tab**——否则会把 prompt 塞进用户当前停留的、不属于该任务的会话里。
    const exactHome = idleTabs.find((tab) => normalizeTabUrl(tab.url) === homeUrl);
    if (exactHome?.id != null) return { tabId: exactHome.id, chatSessionId: null, isNewlyCreated: false };

    const created = await createTab({ url: homeUrl, active: false });
    if (created.id == null) throw new Error('zai_tab_create_failed');
    return { tabId: created.id, chatSessionId: null, isNewlyCreated: true };
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
          searchEnabled: input.searchEnabled === true,
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
    let isNewlyCreated = false;
    try {
      const resolved = await resolveDomTab(input.chatSessionId);
      tabId = resolved.tabId;
      effectiveChatSessionId = resolved.chatSessionId;
      isNewlyCreated = resolved.isNewlyCreated;
    } catch (error) {
      return { ok: false, taskId, error: errorMessage(error), phase: 'tab' };
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
          });
        },
        (error) => {
          if (!entry.settled) {
            settleEntry(entry, { ok: false, taskId, error: errorMessage(error), phase: 'bridge' });
          }
        },
      );
    });
  }

  function cancelTask(taskId: string): void {
    const entry = pending.get(taskId);
    if (entry) void cancelDomTaskMessage(entry.tabId, taskId);
  }

  function onStarted(event: DomTaskStartedEvent): void {
    const entry = pending.get(event.taskId);
    if (!entry) return;
    entry.startedChatSessionId = event.chatSessionId ?? entry.startedChatSessionId;
    // 首次拿到会话 id 就立刻回调：内容脚本在 SPA 跳到 /c/<id> 后才发得出这个值，
    // 此刻把会话落库，运行中/失败后侧边栏都能打开会话。
    if (!entry.sessionReported && entry.startedChatSessionId) {
      entry.sessionReported = true;
      try {
        entry.onSessionStarted?.(entry.startedChatSessionId);
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
    });
  }

  function onNeedsAction(event: DomTaskNeedsActionEvent): void {
    const entry = pending.get(event.taskId);
    if (!entry) return;
    void updateTab(entry.tabId, { active: true })
      .catch((error) => reportError('dom_task_needs_action_tab_focus_failed', error));
    reportError(
      'dom_task_needs_action',
      new Error(`${event.kind} requires user action (task ${event.taskId}).`),
    );
  }

  function onProgress(_event: DomTaskProgressEvent): void {
    // 一期单块终答，无动作。
  }

  return Object.freeze({
    startTask,
    cancelTask,
    onStarted,
    onComplete,
    onFailed,
    onNeedsAction,
    onProgress,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
