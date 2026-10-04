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
   * 失败时页面上已经建立的会话 id。新会话场景下 `request.chatSessionId` 恒为 null
   * （发出时还没有会话），只有内容脚本回传的 DOM_TASK_STARTED 才有真值 ——
   * 不带上它，失败收尾后侧边栏会显示会话「未创建」、打不开。
   */
  sessionIdOverride?: string | null,
): AutomationRunnerFailure {
  return {
    ok: false,
    chatSessionId: sessionIdOverride !== undefined
      ? sessionIdOverride
      : request.chatSessionId,
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
