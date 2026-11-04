export type {
  JsonPrimitive,
  JsonValue,
  ToolCall,
  ToolCallHistoryRecord,
  ToolCallId,
  ToolCallSource,
  ToolCapabilityScope,
  ToolAuthorizationDescriptorSnapshot,
  ToolAuthorizationGrantSummary,
  ToolAuthorizationId,
  ToolAuthorizationSubject,
  ToolAuthorizationSurface,
  ToolDescriptor,
  ToolDescriptorExecution,
  ToolDescriptorId,
  ToolDescriptorSchema,
  ToolError,
  ToolExecutionContext,
  ToolExecutionMode,
  ToolExecutionTrigger,
  ToolPayload,
  ToolProviderId,
  ToolProviderIdentity,
  ToolProviderKind,
  ToolRegistrySnapshot,
  ToolResult,
  ToolRiskLevel,
  RuntimeToolAuthorizationContext,
  ToolGrantExecutionContext,
  TrustedToolExecutionContext,
  ToolTransportKind,
} from './types';

export {
  MEMORY_TOOL_NAMES,
  MEMORY_TOOL_PROVIDER,
  createMemoryToolDescriptors,
  createMemoryToolProviderIdentity,
  executeMemoryToolCall,
  isMemoryToolName,
} from './memory';

export {
  ToolProviderRegistry,
  ToolProviderRegistryError,
  type RuntimeToolProvider,
  type ToolProviderDescriptorContext,
  type ToolProviderExecutionContext,
  type ToolProviderRegistration,
} from './provider-registry';

export {
  createRuntimeToolRuntime,
  type RuntimeToolCallOptions,
  type RuntimeCapabilityInvocationInput,
  type RuntimeCapabilityInvocationResolution,
  type RuntimeCapabilityInvocationResolver,
  type RuntimeToolRuntime,
  type RuntimeToolRuntimeOptions,
} from './runtime';

export {
  SKILL_CREATOR_TOOL_NAMES,
  SKILL_CREATOR_TOOL_PROVIDER,
  createSkillCreatorToolDescriptors,
  createSkillDraft,
  executeSkillCreatorToolCall,
  isSkillCreatorToolName,
  type SkillCreatorToolName,
} from '../skill/creator-tool';

export {
  MEMORY_IMPORT_TOOL_NAMES,
  MEMORY_IMPORT_TOOL_PROVIDER,
  createMemoryImportToolDescriptors,
  executeMemoryImportToolCall,
  isMemoryImportToolName,
  type MemoryImportToolName,
} from '../memory/import-tool';

export {
  BROWSER_CONTROL_TOOL_NAMES,
  BROWSER_CONTROL_PROVIDER,
  createBrowserControlToolDescriptors,
  executeBrowserControlToolCall,
  isBrowserControlToolName,
  type BrowserControlToolName,
} from '../browser-control/tool';

export {
  DEFAULT_TOOL_DESCRIPTORS,
  createDefaultToolDescriptors,
  createToolCallFromInvocation,
  createToolInvocationCatalog,
  getPreferredToolInvocationName,
  getToolInvocationNames,
} from './invocation';

export type {
  MemoryToolName,
  MemoryToolRuntime,
  MemoryToolSaveConfirmation,
} from './memory';

/**
 * `GET_TOOL_CALL_HISTORY` 的**权威响应形状**。
 *
 * ⚠️⚠️ **它必须从这里出去** —— 内容脚本拿到的响应就是它，而别的消费者（侧边栏）走的是
 * `decodeToolCallHistoryEnvelope`。两边各自手写一份「记录 + 丢弃数」的形状，就是
 * 「同一事实几份实现」的老形态：改一处另一处不报错，只会让某一侧静默按错形状读。
 * ⚠️ 内容脚本用 `import type` 引它 —— 类型导入编译后被擦除，**不会把 `history.ts`
 * 的运行时依赖（合并队列、配额预算）拖进内容脚本的 bundle**。
 */
export {
  type ToolCallHistoryReadResult,
} from './history';

export type {
  ToolInvocationCatalog,
  ToolParsingInput,
} from './invocation';
