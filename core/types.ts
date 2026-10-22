import type {
  McpServerCreateInput,
  McpServerId,
  McpServerUpdateInput,
} from './mcp/types';
import type {
  McpCapabilityExposureMode,
  McpCapabilitySettings,
  McpCapabilitySettingsPatch,
} from './mcp/capability-types';
import type {
  CurrentZaiConversation,
  ProjectContextCreateInput,
  ProjectContextState,
  ProjectContextUpdateInput,
  ProjectConversationInput,
} from './project/types';
import type { PromptInjectionSettings as PromptInjectionSettingsType } from './prompt/settings';
import type { SkillAutoActivationSettings } from './skill/auto-activation-settings';
import type {
  SavedItemInput,
} from './saved-items/types';
import type {
  ToolCall as GenericToolCall,
  ToolPayload,
  ToolProviderIdentity,
  ToolResult as GenericToolResult,
} from './tool/types';
import type {
  UsageRangeDays as UsageRangeDaysType,
  UsageTurnInput as UsageTurnInputType,
} from './usage/types';

export type {
  McpHeaderValue,
  McpSecretValue,
  McpServerConfig,
  McpServerConfigVersion,
  McpServerCreateInput,
  McpServerExecutionDefaults,
  McpServerId,
  McpServerResultLimits,
  McpServerStatus,
  McpServerStorageState,
  McpServerStorageVersion,
  McpServerTimeouts,
  McpServerTransportConfig,
  McpServerUpdateInput,
  McpServerHealth,
  McpToolAllowlist,
  McpToolCacheEntry,
} from './mcp/types';

export type {
  McpCapabilityExposureMode,
  McpCapabilityProjection,
  McpCapabilityServerSettings,
  McpCapabilitySettings,
  McpCapabilitySettingsPatch,
} from './mcp/capability-types';

export type {
  JsonPrimitive,
  JsonValue,
  ToolCallId,
  ToolCallHistoryRecord,
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
} from './tool/types';

export type {
  CurrentZaiConversation,
  ProjectContext,
  ProjectContextCreateInput,
  ProjectContextState,
  ProjectContextUpdateInput,
  ProjectConversation,
  ProjectConversationInput,
  ProjectPromptContext,
} from './project/types';

export type {
  PromptInjectionSettings,
  PromptPresetCadence,
  ForcedResponseLanguage,
} from './prompt/settings';

export type {
  SavedItem,
  SavedItemInput,
  SavedItemKind,
  SavedItemsState,
} from './saved-items/types';

export type {
  UsageDailyModelSummary,
  UsageDailySummary,
  UsageHeatmapCell,
  UsageModelSummary,
  UsageRangeDays,
  UsageRecordSource,
  UsageSummary,
  UsageTurnInput,
  UsageTurnRecord,
} from './usage/types';

export type {
  PlatformCapability,
  PlatformCapabilityMap,
  PlatformEnvironment,
  PlatformKind,
} from './platform';

export type MemoryType = 'user' | 'feedback' | 'topic' | 'reference';
export type MemoryScope = 'global' | 'project';

export interface BackgroundConfig {
  enabled: boolean;
  type: 'upload' | 'url';
  url?: string;
  imageData?: string;
  opacity: number;
}

export interface Memory {
  id?: number;
  syncId: string;
  scope: MemoryScope;
  projectId?: string;
  type: MemoryType;
  name: string;
  content: string;
  description: string;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
}

export type NewMemory = Omit<
  Memory,
  'id' | 'syncId' | 'scope' | 'projectId' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessedAt'
> & {
  syncId?: string;
  scope?: MemoryScope;
  projectId?: string;
};

export type SkillSource = 'builtin' | 'custom' | 'remote';

export type ImportedSkillProvider = 'github' | 'local';

export interface RemoteSkillFile {
  path: string;
  bytes: number;
}

export interface RemoteSkillMetadata {
  provider: ImportedSkillProvider;
  sourceId: string;
  sourceUrl?: string;
  repository?: string;
  ref?: string;
  commitSha?: string;
  path: string;
  originalName: string;
  importedAt: number;
  updatedAt: number;
  lastCheckedAt?: number;
  localRootPath?: string;
  localDirectory?: string;
  localDisplayName?: string;
  licenseName?: string;
  licenseSpdxId?: string;
  upstreamVersion?: string;
  upstreamUpdatedAt?: string;
  includedFiles: RemoteSkillFile[];
  omittedFiles: RemoteSkillFile[];
  scriptFiles?: RemoteSkillFile[];
  warnings: string[];
}

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  source: SkillSource;
  memoryEnabled: boolean;
  enabled?: boolean;
  metadata?: Record<string, string>;
  remote?: RemoteSkillMetadata;
}

export type SaveSkillPayload = Skill | { skill: Skill; previousName?: string };

export interface GitHubSkillSource {
  id: string;
  provider: 'github';
  url: string;
  owner: string;
  repo: string;
  repository: string;
  ref: string;
  rootPath: string;
  commitSha: string;
  defaultBranch: string;
  repoUrl: string;
  licenseName?: string;
  licenseSpdxId?: string;
  packageVersion?: string;
  description?: string;
  skillPaths: string[];
  importedSkillNames: string[];
  importedAt: number;
  updatedAt: number;
  lastCheckedAt?: number;
}

export interface LocalSkillSource {
  id: string;
  provider: 'local';
  rootPath: string;
  displayName: string;
  directoryName: string;
  skillPaths: string[];
  importedSkillNames: string[];
  importedAt: number;
  updatedAt: number;
  lastCheckedAt?: number;
  warnings: string[];
}

export type SkillImportSource = GitHubSkillSource | LocalSkillSource;

export interface GitHubSkillPreviewItem {
  path: string;
  name: string;
  importName: string;
  description: string;
  version?: string;
  lastUpdated?: string;
  bytes: number;
  bodyBytes: number;
  includedFiles: RemoteSkillFile[];
  omittedFiles: RemoteSkillFile[];
  warnings: string[];
  nameChanged: boolean;
  existingSkillName?: string;
  existingSourceId?: string;
}

export interface GitHubSkillPreview {
  source: GitHubSkillSource;
  skills: GitHubSkillPreviewItem[];
  warnings: string[];
  truncated: boolean;
}

export interface GitHubSkillImportRequest {
  url: string;
  selectedPaths: string[];
}

export interface GitHubSkillImportResult {
  ok: true;
  source: GitHubSkillSource;
  imported: Skill[];
  replaced: number;
  renamed: number;
  warnings: string[];
}

export type LocalSkillImportBlockCode =
  | 'shell_host_update_required'
  | 'shell_reader_unavailable'
  | 'shell_discovery_failed';

export interface LocalSkillImportBlock {
  code: LocalSkillImportBlockCode;
  detail?: string;
}

export interface LocalSkillPreviewItem {
  path: string;
  name: string;
  importName: string;
  description: string;
  version?: string;
  lastUpdated?: string;
  bytes: number;
  bodyBytes: number;
  includedFiles: RemoteSkillFile[];
  omittedFiles: RemoteSkillFile[];
  scriptFiles: RemoteSkillFile[];
  warnings: string[];
  importBlock?: LocalSkillImportBlock;
  nameChanged: boolean;
  existingSkillName?: string;
  existingSourceId?: string;
}

export interface LocalSkillPreview {
  source: LocalSkillSource;
  skills: LocalSkillPreviewItem[];
  warnings: string[];
  truncated: boolean;
}

export interface LocalSkillImportRequest {
  rootPath: string;
  selectedPaths: string[];
  selectedImportNames?: Record<string, string>;
}

export interface LocalSkillImportResult {
  ok: true;
  source: LocalSkillSource;
  imported: Skill[];
  replaced: number;
  renamed: number;
  warnings: string[];
}

export interface LocalSkillImportFailure {
  ok: false;
  error: string;
  importBlock: LocalSkillImportBlock;
}

export type LocalSkillImportResponse = LocalSkillImportResult | LocalSkillImportFailure;

export interface GitHubSkillUpdatePreview {
  source: GitHubSkillSource;
  latestCommitSha: string;
  latestVersion?: string;
  hasUpdates: boolean;
  changedPaths: string[];
  missingPaths: string[];
  newPaths: string[];
  warnings: string[];
  checkedAt: number;
}

export interface SkillInvocation {
  skillName: string;
  args: string;
  rawInput: string;
}

export interface ToolCall extends GenericToolCall {}

export interface ToolCardResult extends Pick<
  GenericToolResult,
  'ok' | 'summary' | 'detail' | 'output' | 'truncated' | 'error' | 'descriptorId' | 'provider' | 'name'
> {}

export interface ToolExecutionRecord {
  callId?: string;
  pending?: boolean;
  name: string;
  result: ToolCardResult;
  provider?: ToolProviderIdentity;
  descriptorId?: string;
}

export interface ToolCallRestoreRecord {
  id: string;
  calls?: ToolCall[];
  executions?: ToolExecutionRecord[];
  content?: string;
  source?: 'history' | 'storage';
  url?: string;
  createdAt?: number;
  metadata?: ToolPayload;
}

export interface SystemPromptPreset {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export type MessageAction =
  | { type: 'GET_MEMORIES' }
  | { type: 'GET_MEMORY_BY_ID'; payload: { id: number } }
  | { type: 'GET_SKILLS' }
  | { type: 'GET_SKILL_LIBRARY' }
  | { type: 'GET_SKILL_SOURCES' }
  | { type: 'GET_GITHUB_SKILL_SOURCES' }
  | { type: 'PREVIEW_GITHUB_SKILL_SOURCE'; payload: { url: string } }
  | { type: 'IMPORT_GITHUB_SKILL_SOURCE'; payload: GitHubSkillImportRequest }
  | { type: 'PREVIEW_LOCAL_SKILL_SOURCE'; payload: { rootPath: string } }
  | { type: 'PICK_LOCAL_SKILL_FOLDER'; payload?: { defaultPath?: string } }
  | { type: 'IMPORT_LOCAL_SKILL_SOURCE'; payload: LocalSkillImportRequest }
  | { type: 'UPDATE_LOCAL_SKILL_SOURCE'; payload: { sourceId: string } }
  | { type: 'RELOCATE_LOCAL_SKILL_SOURCE'; payload: { sourceId: string; newRootPath: string } }
  | { type: 'CHECK_GITHUB_SKILL_SOURCE_UPDATES'; payload: { sourceId: string } }
  | { type: 'UPDATE_GITHUB_SKILL_SOURCE'; payload: { sourceId: string } }
  | { type: 'DELETE_GITHUB_SKILL_SOURCE'; payload: { sourceId: string } }
  | { type: 'SAVE_MEMORY'; payload: NewMemory }
  | { type: 'IMPORT_MEMORY_DRAFTS'; payload: { memories: NewMemory[] } }
  | { type: 'DELETE_MEMORY'; payload: { id: number } }
  | { type: 'UPDATE_MEMORY'; payload: Memory }
  | { type: 'SAVE_SKILL'; payload: SaveSkillPayload }
  | { type: 'DELETE_SKILL'; payload: { name: string } }
  | { type: 'SET_SKILL_ENABLED'; payload: { name: string; enabled: boolean } }
  | { type: 'SET_SKILLS_ENABLED'; payload: { updates: Array<{ name: string; enabled: boolean }> } }
  | { type: 'GET_PRESETS' }
  | { type: 'SAVE_PRESET'; payload: SystemPromptPreset }
  | { type: 'DELETE_PRESET'; payload: { id: string } }
  | { type: 'SET_ACTIVE_PRESET'; payload: { id: string | null } }
  | { type: 'GET_ACTIVE_PRESET' }
  | { type: 'GET_PROMPT_INJECTION_SETTINGS' }
  | { type: 'SAVE_PROMPT_INJECTION_SETTINGS'; payload: Partial<PromptInjectionSettingsType> }
  | { type: 'GET_SKILL_AUTO_ACTIVATION_SETTINGS' }
  | { type: 'SAVE_SKILL_AUTO_ACTIVATION_SETTINGS'; payload: Partial<SkillAutoActivationSettings> }
  | { type: 'GET_SAVED_ITEMS' }
  | { type: 'SAVE_SAVED_ITEM'; payload: SavedItemInput }
  | { type: 'DELETE_SAVED_ITEM'; payload: { id: string } }
  | { type: 'INSERT_SAVED_PROMPT_INTO_CHAT'; payload: { text: string } }
  | { type: 'GET_MCP_SERVERS' }
  | { type: 'GET_MCP_CAPABILITY_SETTINGS' }
  | { type: 'UPDATE_MCP_CAPABILITY_SETTINGS'; payload: McpCapabilitySettingsPatch }
  | {
    type: 'SET_MCP_CAPABILITY_SERVER_EXPOSURE';
    payload: {
      serverId: McpServerId;
      mode: McpCapabilityExposureMode;
      pinnedDescriptorIds?: string[];
    };
  }
  | { type: 'GET_MCP_SERVER'; payload: { id: McpServerId } }
  | { type: 'CREATE_MCP_SERVER'; payload: McpServerCreateInput }
  | { type: 'UPDATE_MCP_SERVER'; payload: { id: McpServerId; patch: McpServerUpdateInput } }
  | { type: 'DELETE_MCP_SERVER'; payload: { id: McpServerId } }
  | { type: 'GET_MCP_TOOL_CACHE'; payload: { serverId: McpServerId } }
  | { type: 'REFRESH_MCP_SERVER_TOOLS'; payload: { serverId: McpServerId } }
  | { type: 'GET_TOOL_DESCRIPTORS' }
  | { type: 'REFRESH_TOOL_DESCRIPTORS' }
  | {
    type: 'CREATE_TOOL_AUTHORIZATION';
    payload: {
      requestId: string;
      trigger: 'manual_chat' | 'agent_run';
      chatSessionId: string | null;
      runId?: string;
      descriptorIds?: string[];
      toolIntent?: string;
      /** Background-validated local-skill directory; page/model untrusted, written to grant by background after validation */
      localSkillDir?: string;
    };
  }
  | { type: 'CLOSE_TOOL_AUTHORIZATION'; payload: { authorizationId: string } }
  | { type: 'APPEND_EXTERNAL_TOOL_PAYLOAD_CHUNK'; payload: { authorizationId: string; callId: string; invocationName: string; chunk: string } }
  | { type: 'EXECUTE_TOOL_CALL'; payload: ToolCall & { authorizationId?: string } }
  | { type: 'GET_TOOL_CALL_HISTORY'; payload?: { limit?: number } }
  | { type: 'CLEAR_TOOL_CALL_HISTORY' }
  | { type: 'GET_PLATFORM_CAPABILITIES' }
  | { type: 'GET_PROJECT_CONTEXT_STATE' }
  | { type: 'CREATE_PROJECT_CONTEXT'; payload: ProjectContextCreateInput }
  | { type: 'UPDATE_PROJECT_CONTEXT'; payload: { projectId: string; patch: ProjectContextUpdateInput } }
  | { type: 'DELETE_PROJECT_CONTEXT'; payload: { projectId: string } }
  | { type: 'ADD_CONVERSATION_TO_PROJECT'; payload: { projectId: string; conversation: ProjectConversationInput } }
  | { type: 'REMOVE_CONVERSATION_FROM_PROJECT'; payload: { conversationId: string } }
  | { type: 'SET_PENDING_PROJECT_CONTEXT'; payload: { projectId: string | null } }
  | { type: 'GET_CURRENT_ZAI_CONVERSATION' }
  | { type: 'GET_PROJECT_CONTEXT_FOR_CONVERSATION'; payload: { conversation: ProjectConversationInput; bindPendingProject?: boolean } }
  | { type: 'GET_CONFIG' }
  | { type: 'RECORD_USAGE_TURN'; payload: UsageTurnInputType }
  | { type: 'GET_USAGE_SUMMARY'; payload?: { rangeDays?: UsageRangeDaysType } }
  | { type: 'CLEAR_USAGE_STATS' }
  | { type: 'TOOL_CALL_EXECUTED'; payload: ToolCall }
  | { type: 'MEMORIES_UPDATED' }
  | { type: 'GET_BACKGROUND' }
  | { type: 'SAVE_BACKGROUND'; payload: BackgroundConfig }
  | { type: 'CLEAR_BACKGROUND' };

export interface PromptConfig {
  memoryTokenBudget: number;
  systemTemplate: string;
}
