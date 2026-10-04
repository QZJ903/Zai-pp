import type { Memory, ToolDescriptor, ToolExecutionRecord } from '../types';
import type { SupportedLocale } from '../i18n';

export type AutomationId = string;
export type AutomationRunId = string;

export type AutomationStatus = 'active' | 'paused' | 'archived';

export type AutomationRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'skipped';

export type AutomationTrigger = 'manual' | 'schedule' | 'retry';

export type AutomationScheduleKind = 'manual' | 'cron' | 'rrule';

/**
 * 自动化失败的**阶段**（用于区分「错在哪一环」，不是给用户看的文案）。
 *
 * ⚠️ **这份清单只保留本项目真会产生的值** —— 上游还有 `auth` / `session` / `pow` /
 * `completion` / `history` / `storage` 六档，它们全部由 `core/deepseek/` 的四个错误类
 * （`DeepSeekAuthError` / `SessionError` / `PowError` / `PayloadError`）决定，
 * 而那个目录在本项目**不存在**（DOM 注入替代了 HTTP 直连）⇒ 六档在本项目**零生产者**。
 * 留着只会误导「本项目有这些失败面」。
 *
 * ⚠️ **`unknown` 是唯一一个「不是生产者产出、而是读回时兜底」的值** ——
 * `storage-codec` 读到不认识的 phase 一律归它（宽容读回，见那里的说明）。
 * 已落库的旧记录（含上游迁移来的 `pow` 等值）因此仍能加载。
 */
export type AutomationFailurePhase =
  | 'schedule'
  | 'tab'
  | 'bridge'
  | 'runner'
  /** 用户主动停止（点 Stop / 关标签页 / 手动暂停）。 */
  | 'cancelled'
  | 'unknown';

export interface AutomationSchedule {
  kind: AutomationScheduleKind;
  expression: string | null;
  timezone: string;
  enabled: boolean;
  minimumIntervalMinutes: number;
}

export interface AutomationPromptOptions {
  /**
   * 本次运行使用的模型 id（`/api/models` 里的一项），null = 跟随页面默认。
   * 只在 chat 模式生效；agent 模式的模型由服务端按 `general_agent` 装配。
   */
  model: string | null;
  searchEnabled: boolean;
  /** 固定会话：开启后该自动化任务的后续运行沿用同一个对话（首跑新建，之后续用）。 */
  fixedSession: boolean;
}

export interface AutomationGLMSession {
  chatSessionId: string | null;
  sessionUrl: string | null;
}

export interface AutomationErrorState {
  code: string;
  message: string;
  phase: AutomationFailurePhase;
  retryable: boolean;
  at: number;
  details?: Record<string, unknown>;
}

export interface Automation {
  id: AutomationId;
  name: string;
  prompt: string;
  status: AutomationStatus;
  schedule: AutomationSchedule;
  promptOptions: AutomationPromptOptions;
  glm: AutomationGLMSession;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastError: AutomationErrorState | null;
  version: number;
}

export type AutomationCreateInput = Pick<Automation, 'name' | 'prompt' | 'schedule' | 'promptOptions'>;

export type AutomationUpdateInput = Partial<
  Pick<Automation, 'name' | 'prompt' | 'status' | 'schedule' | 'promptOptions' | 'nextRunAt'>
>;

export type AutomationRuntimeUpdate = Partial<
  Pick<Automation, 'glm' | 'lastRunAt' | 'nextRunAt' | 'lastError' | 'status'>
>;

export interface AutomationRunnerRequest {
  runId: AutomationRunId;
  automationId: AutomationId;
  deadlineAt: number;
  prompt: string;
  trigger: AutomationTrigger;
  chatSessionId: string | null;
  promptOptions: AutomationPromptOptions;
  locale?: SupportedLocale;
  promptContext?: AutomationPromptContext;
  requestedAt: number;
}

export interface AutomationPromptContext {
  memories?: Memory[];
  presetContent?: string | null;
  projectContext?: string | null;
  toolDescriptors?: ToolDescriptor[];
}

export interface AutomationRunnerSuccess {
  ok: true;
  chatSessionId: string;
  sessionUrl: string | null;
  assistantText: string;
  toolExecutions?: ToolExecutionRecord[];
  completedAt: number;
}

export interface AutomationRunnerFailure {
  ok: false;
  chatSessionId: string | null;
  error: AutomationErrorState;
  completedAt: number;
}

export type AutomationRunnerResult = AutomationRunnerSuccess | AutomationRunnerFailure;

export interface AutomationRun {
  id: AutomationRunId;
  automationId: AutomationId;
  trigger: AutomationTrigger;
  status: AutomationRunStatus;
  scheduledFor: number | null;
  attempt: number;
  request: AutomationRunnerRequest | null;
  result: AutomationRunnerResult | null;
  error: AutomationErrorState | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export type AutomationRunUpdateInput = Partial<
  Pick<
    AutomationRun,
    'trigger' | 'status' | 'scheduledFor' | 'attempt' | 'request' | 'result' | 'error' | 'startedAt' | 'completedAt'
  >
>;

export interface AutomationRunListOptions {
  automationId: AutomationId;
  limit?: number;
}
