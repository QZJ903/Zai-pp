export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ToolPayload = Record<string, unknown>;

export const TOOL_PROVIDER_KINDS = ['local', 'mcp'] as const;

export type ToolProviderKind = typeof TOOL_PROVIDER_KINDS[number];

export type ToolProviderId = string;

export type ToolDescriptorId = string;

export type ToolCallId = string;

export type ToolAuthorizationId = string;

export const TOOL_EXECUTION_TRIGGERS = [
  'manual_chat',
  'agent_run',
  'automation',
  'test',
  'sidepanel_chat',
] as const;

export type ToolExecutionTrigger = typeof TOOL_EXECUTION_TRIGGERS[number];

// 'manual' was removed: enabled tools are auto-executable by the model on
// trusted surfaces; 'disabled' is the only opt-out.
export const TOOL_EXECUTION_MODES = ['auto', 'disabled'] as const;

export type ToolExecutionMode = typeof TOOL_EXECUTION_MODES[number];

export const TOOL_RISK_LEVELS = ['low', 'medium', 'high'] as const;

export type ToolRiskLevel = typeof TOOL_RISK_LEVELS[number];

export const TOOL_TRANSPORT_KINDS = [
  'in_process',
  'http',
  'sse',
  'streamable_http',
  'stdio_bridge',
  'native_messaging',
] as const;

export type ToolTransportKind = typeof TOOL_TRANSPORT_KINDS[number];

export interface ToolProviderIdentity {
  kind: ToolProviderKind;
  id: ToolProviderId;
  displayName: string;
  transport: ToolTransportKind;
}

export interface ToolDescriptorSchema {
  type: 'object';
  properties?: Record<string, JsonValue>;
  required?: string[];
  additionalProperties?: boolean | Record<string, JsonValue>;
  description?: string;
}

export interface ToolDescriptorExecution {
  mode: ToolExecutionMode;
  enabled: boolean;
  risk: ToolRiskLevel;
  timeoutMs?: number;
  maxResultBytes?: number;
}

export interface ToolDescriptor {
  id: ToolDescriptorId;
  provider: ToolProviderIdentity;
  name: string;
  invocationName: string;
  title: string;
  description: string;
  inputSchema: ToolDescriptorSchema;
  outputSchema?: ToolDescriptorSchema;
  execution: ToolDescriptorExecution;
  annotations?: Record<string, string>;
}

export interface ToolCallSource {
  trigger: ToolExecutionTrigger;
  requestId?: string;
  chatSessionId?: string | null;
  parentMessageId?: number | null;
  taskId?: string;
  runId?: string;
  messageId?: number | null;
  /**
   * **z.ai 的助手消息 id（uuid 字符串）** —— 与上面那个数字的 `messageId` 是两回事。
   *
   * ⚠️⚠️ **`messageId` / `parentMessageId` 是上游 DeepSeek 的数字 id**（`number | null`），
   * 而 z.ai 的消息 id 是 **uuid 字符串**（DOM 上是 wrapper 的 `message-<uuid>` 类，
   * 逐字等于服务端 `messages/batch` 的键）。**别把两者合成一个字段** ——
   * 一个字段担两种语义，将来必然混。那两个数字字段在本项目**零写入点**。
   *
   * ⚠️ **用途是让存储腿自带锚点**：上游 `persistToolBlockSession` 把
   * `metadata.assistantMessageId` 写进持久化块，于是存储腿**不依赖历史腿也能定位**
   * （`findRestoredToolTargetByMessageId`）。我们原先没有等价物 ⇒ 存储腿没有锚点、
   * 只能靠「工具签名」与历史腿猜着合流 —— 真机出过两个缺陷：「用了好几次工具、
   * 刷新后只显示一次」与「两条消息同命令时跨消息错并」。
   *
   * ⚠️ **真机已验证读得到**（探针 12）：工具执行那一刻面板的块 id 是
   * `history:<uuid>`（不是 `live:<requestId>`）⇒ 那一刻 `readZaiMessageId` 返回了 uuid。
   * ⚠️ **但仍然可能读不到**（助手消息还在流式、wrapper 上的类还没挂）⇒ 类型可选、
   * 读不到就**不写**（`undefined`），下游按「没有锚点」处理、退回签名合流 ——
   * 与改造前行为一致，不会更糟。
   */
  assistantMessageId?: string;
  automationId?: string;
  automationRunId?: string;
}

export interface ToolCall {
  id?: ToolCallId;
  descriptorId?: ToolDescriptorId;
  provider?: ToolProviderIdentity;
  name: string;
  invocationName?: string;
  payload: ToolPayload;
  raw: string;
  parseError?: ToolError;
  source?: ToolCallSource;
  createdAt?: number;
  // Written by the parser when a local skill is activated: serves as the
  // "initial cwd hint" for this call (shell_exec / shell_session_begin) on the
  // Native Host side. Carried cross-process via the message channel to the
  // background runtime, where parseExternalizedToolPayload uses it to initialize
  // cwd (not a hard persistent binding). The trusted source is
  // the background grant-derived value; page fields are stripped.
  localSkillDir?: string;
}

export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
  details?: ToolPayload;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  detail?: string;
  callId?: ToolCallId;
  descriptorId?: ToolDescriptorId;
  provider?: ToolProviderIdentity;
  name?: string;
  output?: JsonValue;
  error?: ToolError;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  truncated?: boolean;
}

export interface ToolExecutionContext {
  trigger: ToolExecutionTrigger;
  requestId: string;
  chatSessionId?: string | null;
  taskId?: string;
  runId?: string;
  timeoutMs?: number;
  maxResultBytes?: number;
}

export interface ToolRegistrySnapshot {
  providers: ToolProviderIdentity[];
  tools: ToolDescriptor[];
  refreshedAt: number;
}

export interface ToolCallHistoryRecord {
  id: string;
  call: ToolCall;
  result: ToolResult;
  createdAt: number;
  source: ToolExecutionTrigger;
}

export type ToolAuthorizationSurface =
  | 'zai_content'
  | 'extension_context'
  | 'background_workflow';

/**
 * Receiver-owned identity for the runtime that is allowed to execute a tool.
 * MAIN-world ToolCall fields are correlation claims only and must never be
 * used to construct this subject.
 */
export interface ToolAuthorizationSubject {
  surface: ToolAuthorizationSurface;
  documentSessionId: string;
  tabId?: number;
  frameId?: number;
  chatSessionId?: string | null;
}

/**
 * A background-owned capability scope. It is derived after the outer tool
 * call has passed normal runtime authorization; it is never accepted from a
 * page/model payload as authority.
 */
export interface ToolCapabilityScope {
  kind: 'grant' | 'trusted';
  scopeId: string;
  trigger: ToolExecutionTrigger;
  chatSessionId: string | null;
  subject?: ToolAuthorizationSubject;
}

export interface ToolAuthorizationDescriptorSnapshot {
  id: ToolDescriptorId;
  provider: Pick<ToolProviderIdentity, 'kind' | 'id' | 'transport'>;
  name: string;
  invocationName: string;
  execution: ToolDescriptorExecution;
  inputSchemaDigest: string;
}

export interface ToolAuthorizationGrantSummary {
  id: ToolAuthorizationId;
  requestId: string;
  trigger: ToolExecutionTrigger;
  chatSessionId: string | null;
  descriptors: ToolDescriptor[];
  expiresAt: number;
}

export interface ToolGrantExecutionContext {
  kind: 'grant';
  grantId: ToolAuthorizationId;
  subject: ToolAuthorizationSubject;
}

export interface TrustedToolExecutionContext {
  kind: 'trusted';
  trigger: ToolExecutionTrigger;
  requestId: string;
  /**
   * Optional background-owned continuity key for a multi-step trusted run.
   * It is intentionally separate from ToolCall.source, whose fields are
   * model/page routing claims rather than an authority boundary.
   */
  capabilityScopeId?: string;
  chatSessionId?: string | null;
  taskId?: string;
  runId?: string;
  automationId?: string;
  automationRunId?: string;
}

export type RuntimeToolAuthorizationContext =
  | ToolGrantExecutionContext
  | TrustedToolExecutionContext;
