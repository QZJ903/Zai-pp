import type { AutomationErrorState } from '../../core/automation/types';
import type { LocaleMessageKey, MessageParams } from '../../core/i18n';
import { looksLikeErrorCode } from '../../core/messaging/error-code';

/**
 * 自动化失败的**错误码 → 用户文案**映射。
 *
 * ⚠️⚠️ **为什么要有这一层**：失败记录的 `message` 有两种来源，只有一种是给人看的：
 *  - **裸码**：内容脚本回传的那批，经 `background.ts` 的 `dom_automation_${code}` 写进
 *    `message` 字段（`composer_inject_failed` / `no_textarea` / `dom_task_handshake_timeout` …）
 *    —— 它们**在中英资源里都没有文案**，直接渲染就是一行蛇形标识符。
 *  - **英文句子**：`scheduler.ts` / `store.ts` 自己造的那几条
 *    （`Automation run exceeded 300 seconds.`）—— 中文界面下同样是外语。
 *
 * **判据是 `code` 而不是 `message`**：`code` 是必填字段、`storage-codec` 在校验它，
 * 且 `message` 里可能出现任意字符串（`resolveDomTab` 的 catch 直接把 `error.message`
 * 当 outcome.error 用）。
 *
 * ⚠️ **为什么放在 UI 层而不是写入时翻译**：`lastError` 是**持久化**的。写入时翻译会把
 * 「当时那个 locale」刻进记录，用户后来切语言那条红条不会跟着变。UI 层映射每次渲染重算。
 * 而且写入点（`createAutomationRunnerFailure`）**拿不到 locale** ——
 * `AutomationRunnerRequest.locale` 声明了但从未赋值，scheduler 那条路也不经过它。
 *
 * ⚠️ **新增失败码时在这里补一条**；不补不会报错，只会回落成通用文案（见 `formatAutomationError`）。
 */

/** 一条失败记录里真正决定「给用户看什么」的字段。 */
type FailureLike = Pick<AutomationErrorState, 'code' | 'message'>;

/**
 * 已覆盖的错误码 → i18n 键。
 *
 * ⚠️ **dom 那条链的 code 带 `dom_automation_` 前缀**（`background.ts` 拼的
 * `` `dom_automation_${outcome.error}` ``），所以键名要按**完整 code** 写。
 */
const AUTOMATION_ERROR_KEYS: Readonly<Record<string, LocaleMessageKey>> = Object.freeze({
  // ── 排期校验（core/automation/schedule.ts 的 ScheduleError.code）──
  // 13 个 code 归成 6 条文案：给用户看的差别只有「哪一类表达式错了」。
  schedule_too_frequent: 'sidepanel.automationPage.error.scheduleTooFrequent',
  cron_no_next_run: 'sidepanel.automationPage.error.scheduleNoNextRun',
  invalid_cron: 'sidepanel.automationPage.error.scheduleInvalidCron',
  invalid_cron_field: 'sidepanel.automationPage.error.scheduleInvalidCron',
  invalid_cron_range: 'sidepanel.automationPage.error.scheduleInvalidCron',
  invalid_cron_step: 'sidepanel.automationPage.error.scheduleInvalidCron',
  invalid_rrule: 'sidepanel.automationPage.error.scheduleInvalidRrule',
  invalid_rrule_frequency: 'sidepanel.automationPage.error.scheduleInvalidRrule',
  invalid_rrule_interval: 'sidepanel.automationPage.error.scheduleInvalidRrule',
  unsupported_rrule_part: 'sidepanel.automationPage.error.scheduleInvalidRrule',
  unsupported_schedule: 'sidepanel.automationPage.error.scheduleUnsupported',
  missing_expression: 'sidepanel.automationPage.error.scheduleMissingExpression',
  invalid_timezone: 'sidepanel.automationPage.error.scheduleInvalidTimezone',

  // ── 运行期（scheduler.ts / store.ts 直造）──
  automation_run_timeout: 'sidepanel.automationPage.error.runTimeout',
  automation_run_cancelled: 'sidepanel.automationPage.error.runCancelled',
  automation_run_lease_lost: 'sidepanel.automationPage.error.runLeaseLost',
  automation_executor_failed: 'sidepanel.automationPage.error.runExecutorFailed',
  automation_run_interrupted: 'sidepanel.automationPage.error.runInterrupted',

  // ── 页面执行（内容脚本 / 协调器回传，带 dom_automation_ 前缀）──
  dom_automation_failed: 'sidepanel.automationPage.error.pageFailed',
  dom_automation_composer_inject_failed: 'sidepanel.automationPage.error.pageInjectFailed',
  dom_automation_no_textarea: 'sidepanel.automationPage.error.pageNoInput',
  dom_automation_prompt_input_not_found: 'sidepanel.automationPage.error.pageNoInput',
  dom_automation_form_not_connected: 'sidepanel.automationPage.error.pageNoInput',
  dom_automation_agent_not_idle: 'sidepanel.automationPage.error.pageBusy',
  dom_automation_busy: 'sidepanel.automationPage.error.pageBusy',
  dom_automation_wrong_conversation: 'sidepanel.automationPage.error.pageWrongConversation',
  dom_automation_dom_task_handshake_timeout: 'sidepanel.automationPage.error.pageHandshakeTimeout',
  dom_automation_cancelled: 'sidepanel.automationPage.error.pageStopped',
  dom_automation_continuation_loop_missing: 'sidepanel.automationPage.error.pageContinuationBroken',
  dom_automation_continuation_loop_superseded: 'sidepanel.automationPage.error.pageContinuationBroken',
  dom_automation_continuation_send_unconfirmed: 'sidepanel.automationPage.error.pageSendUnconfirmed',
  dom_automation_continuation_session_id_missing: 'sidepanel.automationPage.error.pageSessionMissing',
  dom_automation_no_current_conversation: 'sidepanel.automationPage.error.pageSessionMissing',
  dom_automation_missing_task_id_or_prompt: 'sidepanel.automationPage.error.pageTaskParamsMissing',
  dom_automation_empty_prompt_text: 'sidepanel.automationPage.error.pageTaskParamsMissing',
  dom_automation_task_already_registered: 'sidepanel.automationPage.error.pageTaskAlreadyRunning',
  // ⚠️ **这两条来自协调器的兜底字面量**（`dom-task-coordinator.ts` 的
  // `record.error ?? 'dom_task_rejected'` 与 `event.error || 'dom_task_failed'`），
  // 经 `background.ts` 的前缀拼装后变成上面这个形状。
  // **可达但概率低**：`RUN_DOM_TASK` 的每个 `ok:false` 都带 `error`（只有「响应形状意外」才命中前者），
  // 而后者要求 `event.error` 为空串（6 个发送点全都带非空 error）。
  // 不补也不会泄漏裸码（三级回退会套通用文案），补上是为了给出**可诊断**的那一句。
  dom_automation_dom_task_rejected: 'sidepanel.automationPage.error.pageFailed',
  dom_automation_dom_task_failed: 'sidepanel.automationPage.error.pageFailed',
});

/**
 * 取这条失败的 i18n 键。**没有覆盖时返回 `null`**（不是返一个通用键）——
 * 调用方据此判断「该翻译」还是「该用 `message` 兜底」。
 */
export function automationErrorKey(code: string): LocaleMessageKey | null {
  return AUTOMATION_ERROR_KEYS[code] ?? null;
}

/**
 * 把失败记录渲染成**给用户看的一句话**。
 *
 * 三级回退，顺序是有意的：
 *  1. 有映射 → 用本地化文案（覆盖了绝大多数据实可诊断的失败）；
 *  2. 没有映射但 `message` 是自然语言 → **原样用它**（scheduler 那批英文句子至少读得懂，
 *     换成通用文案反而是信息降级）；
 *  3. 没有映射、`message` 又是裸码 → 套一层通用文案 + 把码附在里面。
 *     ⚠️ **裸码不能直接摆给用户** —— `composer_inject_failed` 是这次要修的表现本身。
 */
export function formatAutomationError(
  error: FailureLike,
  t: (key: LocaleMessageKey, params?: MessageParams) => string,
): string {
  const key = automationErrorKey(error.code);
  if (key) return t(key);
  if (!looksLikeErrorCode(error.message)) return error.message;
  return t('sidepanel.automationPage.error.runFailedWithCode', { code: error.message });
}