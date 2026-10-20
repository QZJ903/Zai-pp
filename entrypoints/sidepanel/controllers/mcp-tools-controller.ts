import { decodeMcpCapabilitySettings } from '../../../core/mcp/capability-settings';
import { decodeMcpStorageState, MCP_STORAGE_VERSION } from '../../../core/mcp/storage-codec';
import { getMcpOriginPattern } from '../../../core/mcp/transports';
import {
  getSupportedMcpTransportKinds,
  isShellNativeHostSupported,
} from '../../../core/platform';
import {
  SHELL_MCP_NATIVE_HOST,
  SHELL_MCP_SERVER_NAME,
  createShellMcpPresetInput,
} from '../../../core/shell';
import { decodeToolCallHistory } from '../../../core/tool/history-codec';
import type {
  McpCapabilityExposureMode,
  McpCapabilitySettings,
  McpCapabilitySettingsPatch,
  McpServerConfig,
  McpServerCreateInput,
  McpServerTransportConfig,
  McpToolAllowlist,
  McpToolCacheEntry,
  PlatformEnvironment,
  ToolCallHistoryRecord,
  ToolDescriptor,
} from '../../../core/types';
import {
  sidepanelRuntimeClient,
  type SidepanelRuntimeClient,
} from '../runtime-client';

export type McpPresetKind = 'shell';
export type McpConnectionAction = 'refresh' | 'test';

export interface McpSnapshot {
  servers: McpServerConfig[];
  caches: Record<string, McpToolCacheEntry | null>;
  history: ToolCallHistoryRecord[];
  platform: PlatformEnvironment;
  capabilitySettings: McpCapabilitySettings;
}

export interface McpPermissionResult {
  ok: boolean;
  origin: string | null;
  error?: string;
}

export interface McpToolsController {
  loadMcpSnapshot(): Promise<McpSnapshot>;
  loadMcpServerState(): Promise<Pick<McpSnapshot, 'servers' | 'platform'>>;
  getToolCache(server: McpServerConfig): Promise<McpToolCacheEntry | null>;
  createServer(payload: McpServerCreateInput): Promise<McpServerConfig>;
  updateServer(server: McpServerConfig, patch: Partial<McpServerConfig>): Promise<McpServerConfig | null>;
  deleteServer(id: string): Promise<void>;
  updateCapabilitySettings(patch: McpCapabilitySettingsPatch): Promise<McpCapabilitySettings>;
  setServerExposure(input: {
    serverId: string;
    mode: McpCapabilityExposureMode;
    pinnedDescriptorIds?: readonly string[];
  }): Promise<McpCapabilitySettings>;
  requestServerPermission(server: McpServerConfig): Promise<McpPermissionResult>;
  connectServer(server: McpServerConfig, action: McpConnectionAction): Promise<McpToolCacheEntry>;
}

export interface SidepanelHostPermissionPort {
  request(origins: readonly string[]): Promise<boolean>;
}

export function createMcpToolsController(
  runtimeClient: SidepanelRuntimeClient = sidepanelRuntimeClient,
  hostPermissions: SidepanelHostPermissionPort = sidepanelHostPermissionPort,
): McpToolsController {
  const loadMcpServerState = async () => {
    const [servers, platform] = await Promise.all([
      runtimeClient.request(
        { type: 'GET_MCP_SERVERS' },
        { decode: decodeMcpServers },
      ),
      runtimeClient.request(
        { type: 'GET_PLATFORM_CAPABILITIES' },
        { decode: decodePlatformEnvironment },
      ),
    ]);
    return { servers, platform };
  };

  const getToolCache = (server: McpServerConfig) => runtimeClient.request(
    { type: 'GET_MCP_TOOL_CACHE', payload: { serverId: server.id } },
    { decode: (value) => decodeMcpToolCache(value, server) },
  );

  const requestServerPermission = async (
    server: McpServerConfig,
  ): Promise<McpPermissionResult> => {
    if (!mcpServerNeedsOriginPermission(server)) return { ok: true, origin: null };
    const origin = getMcpOriginPattern(server);
    try {
      return {
        ok: await hostPermissions.request([origin]),
        origin,
      };
    } catch (error) {
      return {
        ok: false,
        origin,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const controller: McpToolsController = {
    async loadMcpSnapshot() {
      const { servers, platform } = await loadMcpServerState();
      const [cacheEntries, history, capabilitySettings] = await Promise.all([
        Promise.all(servers.map(async (server) => (
          [server.id, await getToolCache(server)] as const
        ))),
        runtimeClient.request(
          { type: 'GET_TOOL_CALL_HISTORY', payload: { limit: 12 } },
          { decode: (value) => decodeToolCallHistory(value, 'GET_TOOL_CALL_HISTORY response') },
        ),
        runtimeClient.request(
          { type: 'GET_MCP_CAPABILITY_SETTINGS' },
          { decode: decodeMcpCapabilitySettings },
        ),
      ]);
      return {
        servers,
        platform,
        caches: Object.fromEntries(cacheEntries),
        history,
        capabilitySettings,
      };
    },
    loadMcpServerState,
    getToolCache,
    createServer: (payload) => runtimeClient.request(
      { type: 'CREATE_MCP_SERVER', payload },
      { decode: decodeMcpServer },
    ),
    updateServer: (server, patch) => runtimeClient.request(
      { type: 'UPDATE_MCP_SERVER', payload: { id: server.id, patch } },
      { decode: (value) => value === null ? null : decodeMcpServer(value) },
    ),
    async deleteServer(id) {
      await runtimeClient.request(
        { type: 'DELETE_MCP_SERVER', payload: { id } },
        { decode: decodeAck },
      );
    },
    updateCapabilitySettings: (patch) => runtimeClient.request(
      { type: 'UPDATE_MCP_CAPABILITY_SETTINGS', payload: patch },
      { decode: decodeMcpCapabilitySettings },
    ),
    setServerExposure: ({ serverId, mode, pinnedDescriptorIds }) => runtimeClient.request(
      {
        type: 'SET_MCP_CAPABILITY_SERVER_EXPOSURE',
        payload: {
          serverId,
          mode,
          ...(pinnedDescriptorIds === undefined
            ? {}
            : { pinnedDescriptorIds: [...pinnedDescriptorIds] }),
        },
      },
      { decode: decodeMcpCapabilitySettings },
    ),
    requestServerPermission,
    async connectServer(server, action) {
      if (mcpServerNeedsOriginPermission(server)) {
        const permission = await requestServerPermission(server);
        if (!permission.ok) {
          throw new McpPermissionError(permission.origin, permission.error);
        }
      }
      if (action === 'refresh') {
        return runtimeClient.request(
          { type: 'REFRESH_MCP_SERVER_TOOLS', payload: { serverId: server.id } },
          { decode: (value) => decodeRequiredMcpToolCache(value, server) },
        );
      }
      return runtimeClient.request(
        { type: 'TEST_MCP_SERVER_CONNECTION', payload: { serverId: server.id } },
        {
          acceptFailure: true,
          decode: (value) => decodeMcpConnectionResponse(value, server),
        },
      );
    },
  };
  return Object.freeze(controller);
}

const sidepanelHostPermissionPort: SidepanelHostPermissionPort = Object.freeze({
  request(origins: readonly string[]) {
    if (!chrome.permissions?.request) {
      throw new Error('Browser host permission requests are unavailable.');
    }
    return chrome.permissions.request({ origins: [...origins] });
  },
});

export const mcpToolsController = createMcpToolsController();

export class McpPermissionError extends Error {
  readonly origin: string | null;

  constructor(origin: string | null, message?: string) {
    super(message ?? 'MCP origin permission was denied.');
    this.name = 'McpPermissionError';
    this.origin = origin;
  }
}

export function getMcpPresetInput(kind: McpPresetKind): McpServerCreateInput {
  return createShellMcpPresetInput();
}

export function findMcpPreset(
  servers: readonly McpServerConfig[],
  kind: McpPresetKind,
): McpServerConfig | null {
  return servers.find((server) => isShellMcpServer(server)) ?? null;
}

export function isShellMcpServer(server: McpServerConfig): boolean {
  return server.displayName === SHELL_MCP_SERVER_NAME
    || server.transport.nativeHost === SHELL_MCP_NATIVE_HOST;
}

export function isMcpNativeMessagingSupported(
  platform: PlatformEnvironment | null | undefined,
): boolean {
  return isShellNativeHostSupported(platform);
}

export function mcpServerNeedsOriginPermission(server: McpServerConfig): boolean {
  return server.transport.kind !== 'native_messaging' && Boolean(server.transport.url);
}

export function getAllowedMcpTransportKinds(
  candidates: readonly McpServerTransportConfig['kind'][],
  platform: PlatformEnvironment | null | undefined,
): McpServerTransportConfig['kind'][] {
  return getSupportedMcpTransportKinds([...candidates], platform);
}

export function isMcpToolSelected(server: McpServerConfig, tool: ToolDescriptor): boolean {
  const selected = server.allowlist.toolNames.includes(tool.name)
    || server.allowlist.toolNames.includes(tool.invocationName);
  if (server.allowlist.mode === 'allow') return selected;
  if (server.allowlist.mode === 'deny') return !selected;
  return true;
}

export function isMcpToolEnabled(server: McpServerConfig, tool: ToolDescriptor): boolean {
  if (!server.enabled || !server.execution.enabled || server.execution.mode === 'disabled') return false;
  return isMcpToolSelected(server, tool);
}

export function countEnabledMcpTools(
  server: McpServerConfig,
  tools: readonly ToolDescriptor[],
): number {
  return tools.filter((tool) => isMcpToolEnabled(server, tool)).length;
}

/**
 * Presentation-only ordering for the discovered-tools list. Pinned tools float
 * to the top; both groups keep the order the server reported, so the list stays
 * stable while pins toggle. The prompt projection is unaffected — it keeps the
 * original descriptor order regardless of pinning.
 */
export function orderMcpToolsByPin(
  tools: readonly ToolDescriptor[],
  pinnedDescriptorIds: readonly string[],
): readonly ToolDescriptor[] {
  if (pinnedDescriptorIds.length === 0) return tools;
  const pinned = new Set(pinnedDescriptorIds);
  const pinnedTools = tools.filter((tool) => pinned.has(tool.id));
  if (pinnedTools.length === 0) return tools;
  return [...pinnedTools, ...tools.filter((tool) => !pinned.has(tool.id))];
}

export function nextMcpToolAllowlist(
  allowlist: McpToolAllowlist,
  tool: ToolDescriptor,
  shouldEnable: boolean,
): McpToolAllowlist {
  const names = new Set(allowlist.toolNames);
  const removeTool = () => {
    names.delete(tool.name);
    names.delete(tool.invocationName);
  };

  if (allowlist.mode === 'allow') {
    if (shouldEnable) names.add(tool.name);
    else removeTool();
    return { mode: 'allow', toolNames: [...names] };
  }
  if (allowlist.mode === 'deny') {
    if (shouldEnable) removeTool();
    else names.add(tool.name);
    return { mode: names.size === 0 ? 'all' : 'deny', toolNames: [...names] };
  }
  return shouldEnable ? allowlist : { mode: 'deny', toolNames: [tool.name] };
}

/**
 * 一键把某个工具（含它所在的服务）切到可用：写 `enabled` + `execution` + `allowlist` 三项。
 *
 * ⚠️ **当前生产侧零消费者，刻意保留** —— 它原先服务工具页那张 Python 卡片
 * （一次点击同时开服务开关、执行策略、白名单），卡片随工具页在 2.15.52 删除。
 * 现在唯一引用是 `tests/sidepanel-mcp-tools-controller.test.ts`。
 * ⚠️ **不删**：它是「一次开关跨三层」这一语义的唯一实现，MCP 页现在只写 allowlist
 * （`toggleTool` 走 `patchServer({ allowlist })`），两边口径不同是刻意的 ——
 * 将来若要给某个工具做「一键启用」的入口，重新接线的是这个函数而不是复制一份。
 * ⚠️ 它**不对称**：`shouldEnable ? true : server.enabled` 只会往上开、不会往下关。
 * 若要改它，先想清楚「关掉」该不该同时关服务与执行策略。
 */
export function createPythonToolTogglePatch(
  server: McpServerConfig,
  tool: ToolDescriptor,
): Partial<McpServerConfig> {
  const shouldEnable = !isMcpToolEnabled(server, tool);
  return {
    enabled: shouldEnable ? true : server.enabled,
    execution: {
      ...server.execution,
      enabled: shouldEnable ? true : server.execution.enabled,
      mode: shouldEnable ? 'auto' : server.execution.mode,
    },
    allowlist: nextMcpToolAllowlist(server.allowlist, tool, shouldEnable),
  };
}

export function normalizeHostPermissionOrigin(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Host permission URL only supports http/https.');
  }
  return `${url.origin}/*`;
}

function decodeMcpServers(value: unknown): McpServerConfig[] {
  return decodeMcpStorageState({
    version: MCP_STORAGE_VERSION,
    servers: value,
    toolCaches: [],
  }).servers;
}

function decodeMcpServer(value: unknown): McpServerConfig {
  const servers = decodeMcpServers([value]);
  return servers[0]!;
}

function decodeMcpToolCache(
  value: unknown,
  server: McpServerConfig,
): McpToolCacheEntry | null {
  if (value === null) return null;
  return decodeRequiredMcpToolCache(value, server);
}

function decodeRequiredMcpToolCache(
  value: unknown,
  server: McpServerConfig,
): McpToolCacheEntry {
  const caches = decodeMcpStorageState({
    version: MCP_STORAGE_VERSION,
    servers: [server],
    toolCaches: [value],
  }).toolCaches;
  return caches[0]!;
}

function decodeMcpConnectionResponse(
  value: unknown,
  server: McpServerConfig,
): McpToolCacheEntry {
  const record = requireRecord(value, 'TEST_MCP_SERVER_CONNECTION response');
  if (typeof record.ok !== 'boolean') {
    throw new Error('TEST_MCP_SERVER_CONNECTION response.ok must be a boolean.');
  }
  return decodeRequiredMcpToolCache(record.cache, server);
}

function decodePlatformEnvironment(value: unknown): PlatformEnvironment {
  const record = requireRecord(value, 'GET_PLATFORM_CAPABILITIES response');
  const capabilities = requireRecord(
    record.capabilities,
    'GET_PLATFORM_CAPABILITIES response.capabilities',
  );
  if ((record.kind !== 'browser_extension' && record.kind !== 'unknown')
    || typeof record.name !== 'string') {
    throw new Error('Invalid GET_PLATFORM_CAPABILITIES response.');
  }
  for (const [name, supported] of Object.entries(capabilities)) {
    if (typeof supported !== 'boolean') {
      throw new Error(`GET_PLATFORM_CAPABILITIES response.capabilities.${name} must be a boolean.`);
    }
  }
  return value as PlatformEnvironment;
}

function decodeAck(value: unknown): void {
  const record = requireRecord(value, 'runtime acknowledgement');
  if (record.ok !== true) throw new Error('Invalid runtime acknowledgement.');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}
