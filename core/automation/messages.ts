import type {
  AutomationErrorState,
  AutomationFailurePhase,
  AutomationRunnerFailure,
  AutomationRunnerRequest,
} from './types';

export function createAutomationRunnerFailure(
  request: Pick<AutomationRunnerRequest, 'chatSessionId'>,
  code: string,
  message: string,
  phase: AutomationFailurePhase,
  retryable: boolean,
  at: number = Date.now(),
  details?: Record<string, unknown>,
  /**
   * 失败时页面上已经建立的会话 id。
   *
   * ⚠️⚠️ **必须传** —— 不传时回落的 `request.chatSessionId` 是「**本次复用的会话**」，
   * 它在两种情况下是 `null`（非固定会话的新对话 / 固定会话但记录里没建成会话），
   * 而那时页面上**可能已经建出了新会话**，只有内容脚本回传的 `DOM_TASK_STARTED`
   * 才有真值。不带上它，失败收尾后侧边栏会显示会话「未创建」、打不开。
   * ⚠️ 反过来说：**非固定会话时它也不能是「记录里上一次的会话」** ——
   * 那会把本轮新建的会话顶掉（`request.chatSessionId` 已收窄成单口径，见
   * `createAutomationRunnerRequest` 的说明）。
   */
  sessionIdOverride?: string | null,
  /**
   * 失败前已经落定的站点（origin）。
   *
   * ⚠️ **`undefined` 与 `null` 在这里同义**（都表示「不知道」）—— 失败现场往往
   * 还没来得及挑中标签页（`'tab'` 阶段失败）。消费方按「不知道 ⇒ 退回记录里已有的
   * 站点，没有证据就保持原值」处理。
   */
  siteOriginOverride?: string | null,
): AutomationRunnerFailure {
  return {
    ok: false,
    chatSessionId: sessionIdOverride !== undefined
      ? sessionIdOverride
      : request.chatSessionId,
    siteOrigin: siteOriginOverride ?? null,
    completedAt: at,
    error: createAutomationError(code, message, phase, retryable, at, details),
  };
}

export function createAutomationError(
  code: string,
  message: string,
  phase: AutomationFailurePhase,
  retryable: boolean,
  at: number = Date.now(),
  details?: Record<string, unknown>,
): AutomationErrorState {
  return {
    code,
    message,
    phase,
    retryable,
    at,
    details,
  };
}
