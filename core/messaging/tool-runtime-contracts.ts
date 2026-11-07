import type {
  McpServerConfig,
  McpServerHealth,
  McpToolCacheEntry,
} from '../mcp/types';
import type {
  McpCapabilitySettings,
} from '../mcp/capability-types';
import type {
  BrowserControlSettings,
  BrowserControlState,
  BrowserControlTarget,
} from '../browser-control/types';
import type { TabKeepaliveSettings } from '../browser-control/keepalive-settings';
import type { PlatformEnvironment } from '../platform/capabilities';
import type {
  MessageAction,
  ToolAuthorizationGrantSummary,
  ToolCallHistoryRecord,
  ToolDescriptor,
  ToolResult,
} from '../types';

type DeclaredRuntimeRequest<TType extends MessageAction['type']> = Extract<
  MessageAction,
  { type: TType }
>;

type Ack = { ok: true };
type DomainFailure = { ok: false; error: string };

/**
 * These commands authorize or consume a tool grant, so their receiver-owned
 * chat identity must be refreshed from the current browser tab before they
 * reach a privileged handler.
 */
export const TOOL_AUTHORIZATION_SUBJECT_RUNTIME_COMMANDS: ReadonlySet<string> = new Set([
  'CREATE_TOOL_AUTHORIZATION',
  'CLOSE_TOOL_AUTHORIZATION',
  'EXECUTE_TOOL_CALL',
]);

export function requiresCurrentToolAuthorizationSubject(type: string): boolean {
  return TOOL_AUTHORIZATION_SUBJECT_RUNTIME_COMMANDS.has(type);
}

export type McpServerPermissionResponse =
  | { ok: boolean; origin: string | null }
  | DomainFailure;

export interface McpServerConnectionResponse {
  ok: boolean;
  cache: McpToolCacheEntry;
  health: McpServerHealth;
}

export interface ToolRuntimeCommandContracts {
  GET_MCP_SERVERS: {
    request: DeclaredRuntimeRequest<'GET_MCP_SERVERS'>;
    response: McpServerConfig[];
  };
  GET_MCP_CAPABILITY_SETTINGS: {
    request: DeclaredRuntimeRequest<'GET_MCP_CAPABILITY_SETTINGS'>;
    response: McpCapabilitySettings;
  };
  UPDATE_MCP_CAPABILITY_SETTINGS: {
    request: DeclaredRuntimeRequest<'UPDATE_MCP_CAPABILITY_SETTINGS'>;
    response: McpCapabilitySettings;
  };
  SET_MCP_CAPABILITY_SERVER_EXPOSURE: {
    request: DeclaredRuntimeRequest<'SET_MCP_CAPABILITY_SERVER_EXPOSURE'>;
    response: McpCapabilitySettings;
  };
  GET_MCP_SERVER: {
    request: DeclaredRuntimeRequest<'GET_MCP_SERVER'>;
    response: McpServerConfig | null;
  };
  CREATE_MCP_SERVER: {
    request: DeclaredRuntimeRequest<'CREATE_MCP_SERVER'>;
    response: McpServerConfig;
  };
  UPDATE_MCP_SERVER: {
    request: DeclaredRuntimeRequest<'UPDATE_MCP_SERVER'>;
    response: McpServerConfig | null;
  };
  SET_MCP_TOOL_SELECTION: {
    request: DeclaredRuntimeRequest<'SET_MCP_TOOL_SELECTION'>;
    response: McpServerConfig | null;
  };
  DELETE_MCP_SERVER: {
    request: DeclaredRuntimeRequest<'DELETE_MCP_SERVER'>;
    response: Ack;
  };
  GET_MCP_TOOL_CACHE: {
    request: DeclaredRuntimeRequest<'GET_MCP_TOOL_CACHE'>;
    response: McpToolCacheEntry | null;
  };
  REFRESH_MCP_SERVER_TOOLS: {
    request: DeclaredRuntimeRequest<'REFRESH_MCP_SERVER_TOOLS'>;
    response: McpToolCacheEntry;
  };
  REQUEST_MCP_SERVER_PERMISSION: {
    request: { type: 'REQUEST_MCP_SERVER_PERMISSION'; payload: { serverId: string } };
    response: McpServerPermissionResponse;
  };
  TEST_MCP_SERVER_CONNECTION: {
    request: { type: 'TEST_MCP_SERVER_CONNECTION'; payload: { serverId: string } };
    response: McpServerConnectionResponse;
  };
  GET_BROWSER_CONTROL_SETTINGS: {
    request: { type: 'GET_BROWSER_CONTROL_SETTINGS' };
    response: BrowserControlSettings;
  };
  SAVE_BROWSER_CONTROL_SETTINGS: {
    request: {
      type: 'SAVE_BROWSER_CONTROL_SETTINGS';
      payload?: Partial<BrowserControlSettings>;
    };
    response: BrowserControlSettings;
  };
  SET_TAB_KEEPALIVE_ENABLED: {
    request: { type: 'SET_TAB_KEEPALIVE_ENABLED'; payload: { enabled: boolean } };
    response: { ok: true };
  };
  SET_BROWSER_CONTROL_ENABLED: {
    request: { type: 'SET_BROWSER_CONTROL_ENABLED'; payload: { enabled: boolean } };
    response: BrowserControlSettings;
  };
  GET_TAB_KEEPALIVE_SETTINGS: {
    request: { type: 'GET_TAB_KEEPALIVE_SETTINGS' };
    response: TabKeepaliveSettings;
  };
  GET_BROWSER_CONTROL_STATE: {
    request: { type: 'GET_BROWSER_CONTROL_STATE' };
    response: BrowserControlState;
  };
  SET_BROWSER_CONTROL_TARGET: {
    request: { type: 'SET_BROWSER_CONTROL_TARGET'; payload: { tabId: number } };
    response: { ok: true; target: BrowserControlTarget };
  };
  DETACH_BROWSER_CONTROL: {
    request: { type: 'DETACH_BROWSER_CONTROL' };
    response: Ack;
  };
  /**
   * 让内容脚本所在的标签**留在后台也能正常跑**（续跑链活在页面里，见
   * `core/browser-control/tab-keepalive.ts`）。
   *
   * ⚠️ 标签 id 取自 `context.tabId`，**不由调用方传** —— 内容脚本自己报的 id 可以被伪造，
   * 而 sender 是浏览器给的。
   */
  START_TAB_KEEPALIVE: {
    request: { type: 'START_TAB_KEEPALIVE' };
    response: Ack;
  };
  STOP_TAB_KEEPALIVE: {
    request: { type: 'STOP_TAB_KEEPALIVE' };
    response: Ack;
  };
  GET_TOOL_DESCRIPTORS: {
    request: DeclaredRuntimeRequest<'GET_TOOL_DESCRIPTORS'>;
    response: ToolDescriptor[];
  };
  REFRESH_TOOL_DESCRIPTORS: {
    request: DeclaredRuntimeRequest<'REFRESH_TOOL_DESCRIPTORS'>;
    response: ToolDescriptor[];
  };
  CREATE_TOOL_AUTHORIZATION: {
    request: DeclaredRuntimeRequest<'CREATE_TOOL_AUTHORIZATION'>;
    response: ToolAuthorizationGrantSummary | DomainFailure;
  };
  CLOSE_TOOL_AUTHORIZATION: {
    request: DeclaredRuntimeRequest<'CLOSE_TOOL_AUTHORIZATION'>;
    response: Ack | DomainFailure;
  };
  EXECUTE_TOOL_CALL: {
    request: DeclaredRuntimeRequest<'EXECUTE_TOOL_CALL'>;
    response: ToolResult;
  };
  GET_TOOL_CALL_HISTORY: {
    request: DeclaredRuntimeRequest<'GET_TOOL_CALL_HISTORY'>;
    // ⚠️ **不是裸数组**：`dropped` 要跨进程带给内容脚本，由它打一行页面控制台可见的 log
    // （背景的 console 只出现在 `chrome://extensions` 的 SW 控制台，用户按 F12 看不到）。
    // 见 `ToolCallHistoryReadResult` 的说明。
    response: { records: ToolCallHistoryRecord[]; dropped: number };
  };
  CLEAR_TOOL_CALL_HISTORY: {
    request: DeclaredRuntimeRequest<'CLEAR_TOOL_CALL_HISTORY'>;
    response: Ack;
  };
  GET_PLATFORM_CAPABILITIES: {
    request: DeclaredRuntimeRequest<'GET_PLATFORM_CAPABILITIES'>;
    response: PlatformEnvironment;
  };
}
