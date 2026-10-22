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
   * ⚠️ **chat 与 agent 两种模式都生效** —— 真机实测 agent 的请求体里模型字段是活的
   * （不同轮次会带不同 id），不存在「agent 由服务端装配、覆写无效」这回事。
   */
  model: string | null;
  /** 固定会话：开启后该自动化任务的后续运行沿用同一个对话（首跑新建，之后续用）。 */
  fixedSession: boolean;
}

export interface AutomationZaiSession {
  chatSessionId: string | null;
  sessionUrl: string | null;
  /**
   * 这条任务**上一次运行落在哪个站**（站点 origin，如 `https://zchat.z.ai`）。
   *
   * ⚠️ **它与 `sessionUrl` 不是同一件事，不能互相推导**：
   * `sessionUrl` 只有在**页面上真的建出会话**之后才有值，而这个字段在「跑过、
   * 但没来得及建会话就失败」时也是有值的 —— 而那种情况恰恰是最需要它的：
   * 下一次运行该去哪个站，取决于上次落在哪，与「上次有没有建成会话」无关。
   * （从 `sessionUrl` 反推得到的是 `''`，会让下一次拿默认站兜底、跑到另一个站上去。）
   *
   * ⚠️ **`null` = 不知道**（旧记录、或 `'tab'` 阶段就失败、还没挑中标签页）——
   * 消费方**不能当成「不属于任何站」**：没有证据时保持原值，不写默认站。
   */
  siteOrigin: string | null;
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
  zai: AutomationZaiSession;
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
  Pick<Automation, 'zai' | 'lastRunAt' | 'nextRunAt' | 'lastError' | 'status'>
>;

export interface AutomationRunnerRequest {
  runId: AutomationRunId;
  automationId: AutomationId;
  deadlineAt: number;
  prompt: string;
  trigger: AutomationTrigger;
  chatSessionId: string | null;
  /**
   * **本次运行指定去哪个站**（origin）。`null` = 不指定，由协调器就地判定。
   *
   * ⚠️ 只有**复用已有会话**时才给值（`createAutomationRunnerRequest` 按
   * 「开了固定会话 **且** 记录里已有会话 id」决定）：那条会话属于哪一站是确定的，
   * 会话 id 在两站之间也不通用。
   * 其余情况（没开固定会话、或开了但还没建出会话）都是新对话、没有会话归属
   * ⇒ 传 `null`，由协调器按「用户当前所在的标签页 → 已开着的标签页 → 最近活跃站
   * → 默认站」判定（见 `resolveDomTab`）。**不能沿用记录里上一次跑过的站** ——
   * 那会把任务永久钉在它第一次跑过的那个站上。
   */
  siteOrigin: string | null;
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
  /**
   * 本次运行落在哪个站（origin）。
   *
   * ⚠️ **与 `sessionUrl` 并列、不从它推导** —— `sessionUrl` 可能因为「还没建出会话」
   * 而为 null，那时站点仍然是已知的（标签页已经挑好了），下次运行该去哪个站要靠它。
   * ⚠️ `null` = 本次运行没报站点（如 `'tab'` 阶段就失败）⇒ 收尾链退回记录里已有的
   * 证据，**没有证据就保持原值**，不写默认站。
   */
  siteOrigin: string | null;
  assistantText: string;
  toolExecutions?: ToolExecutionRecord[];
  completedAt: number;
}

export interface AutomationRunnerFailure {
  ok: false;
  chatSessionId: string | null;
  /** 失败前已经落定的站点（`null` = 还没挑中标签页，不知道）。 */
  siteOrigin: string | null;
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
