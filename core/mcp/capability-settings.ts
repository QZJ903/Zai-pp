import { createSerialOperationQueue } from '../persistence/serial-operation-queue';
import {
  MCP_CAPABILITY_EXPOSURE_MODES,
  MCP_CAPABILITY_SETTINGS_VERSION,
  type McpCapabilityExposureMode,
  type McpCapabilityServerSettings,
  type McpCapabilitySettings,
  type McpCapabilitySettingsPatch,
} from './capability-types';

export const MCP_CAPABILITY_SETTINGS_STORAGE_KEY = 'zai_pp_mcp_capability_settings';

export const DEFAULT_MCP_CAPABILITY_SETTINGS: McpCapabilitySettings = Object.freeze({
  version: MCP_CAPABILITY_SETTINGS_VERSION,
  adaptiveMaxDirectTools: 8,
  adaptiveMaxPromptBytes: 24_000,
  servers: {},
});

/**
 * 自适应预算的合法区间 —— **唯一真源**。
 *
 * ⚠️⚠️ **这四个常量必须导出：侧边栏表单也拿它们做校验**
 * （`entrypoints/sidepanel/pages/McpPage.tsx` 的 `AdaptiveCapabilityBudget`）。
 * 那边曾经手抄过一份同样的数字，两侧一旦分叉：放宽后台区间时 UI 仍然拒绝新值
 * （用户看到「数值无效」而配置其实合法）；收窄后台区间时 UI 放行后
 * `boundedInteger` 抛 `mcp_capability_settings_corrupt` ⇒ 读设置整条失败。
 * ⇒ 改数值只改这里，别在任何地方再写一份字面量。
 */
export const MIN_ADAPTIVE_DIRECT_TOOLS = 1;
export const MAX_ADAPTIVE_DIRECT_TOOLS = 64;
export const MIN_ADAPTIVE_PROMPT_BYTES = 2_000;
export const MAX_ADAPTIVE_PROMPT_BYTES = 256_000;
const capabilitySettingsOperations = createSerialOperationQueue();

export type McpCapabilitySettingsErrorCode =
  | 'mcp_capability_settings_corrupt'
  | 'mcp_capability_settings_version_unsupported';

export class McpCapabilitySettingsError extends Error {
  constructor(
    public readonly code: McpCapabilitySettingsErrorCode,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpCapabilitySettingsError';
  }
}

export function createDefaultMcpCapabilitySettings(): McpCapabilitySettings {
  return {
    version: MCP_CAPABILITY_SETTINGS_VERSION,
    adaptiveMaxDirectTools: DEFAULT_MCP_CAPABILITY_SETTINGS.adaptiveMaxDirectTools,
    adaptiveMaxPromptBytes: DEFAULT_MCP_CAPABILITY_SETTINGS.adaptiveMaxPromptBytes,
    servers: {},
  };
}

/** Pure, strict v1 decoder. It never repairs or rewrites persisted state. */
export function decodeMcpCapabilitySettings(raw: unknown): McpCapabilitySettings {
  if (raw === undefined) return createDefaultMcpCapabilitySettings();
  const value = requireRecord(raw, '$');
  if (value.version !== MCP_CAPABILITY_SETTINGS_VERSION) {
    throw new McpCapabilitySettingsError(
      typeof value.version === 'number' && Number.isInteger(value.version) && value.version > MCP_CAPABILITY_SETTINGS_VERSION
        ? 'mcp_capability_settings_version_unsupported'
        : 'mcp_capability_settings_corrupt',
      '$.version',
      `Unsupported MCP capability settings version: ${String(value.version)}.`,
    );
  }
  assertOnlyKeys(value, ['version', 'adaptiveMaxDirectTools', 'adaptiveMaxPromptBytes', 'servers'], '$');
  const adaptiveMaxDirectTools = boundedInteger(
    value.adaptiveMaxDirectTools,
    '$.adaptiveMaxDirectTools',
    MIN_ADAPTIVE_DIRECT_TOOLS,
    MAX_ADAPTIVE_DIRECT_TOOLS,
  );
  const adaptiveMaxPromptBytes = boundedInteger(
    value.adaptiveMaxPromptBytes,
    '$.adaptiveMaxPromptBytes',
    MIN_ADAPTIVE_PROMPT_BYTES,
    MAX_ADAPTIVE_PROMPT_BYTES,
  );
  const servers = requireRecord(value.servers, '$.servers');
  const decodedServers: Record<string, McpCapabilityServerSettings> = {};
  for (const [serverId, rawSettings] of Object.entries(servers)) {
    if (!isIdentity(serverId)) fail(`$.servers.${serverId}`, 'MCP server id must be a non-empty string.');
    decodedServers[serverId] = decodeServerSettings(rawSettings, `$.servers.${serverId}`);
  }
  return {
    version: MCP_CAPABILITY_SETTINGS_VERSION,
    adaptiveMaxDirectTools,
    adaptiveMaxPromptBytes,
    servers: decodedServers,
  };
}

export function encodeMcpCapabilitySettings(settings: McpCapabilitySettings): McpCapabilitySettings {
  return decodeMcpCapabilitySettings(settings);
}

export async function getMcpCapabilitySettings(): Promise<McpCapabilitySettings> {
  return capabilitySettingsOperations.run(async () => readSettings());
}

export async function updateMcpCapabilitySettings(
  patch: McpCapabilitySettingsPatch,
): Promise<McpCapabilitySettings> {
  return capabilitySettingsOperations.run(async () => {
    const current = await readSettings();
    const next = decodeMcpCapabilitySettings({
      ...current,
      ...(patch.adaptiveMaxDirectTools === undefined
        ? {}
        : { adaptiveMaxDirectTools: patch.adaptiveMaxDirectTools }),
      ...(patch.adaptiveMaxPromptBytes === undefined
        ? {}
        : { adaptiveMaxPromptBytes: patch.adaptiveMaxPromptBytes }),
    });
    await writeSettings(next);
    return next;
  });
}

export async function setMcpCapabilityServerExposure(input: {
  serverId: string;
  mode: McpCapabilityExposureMode;
  pinnedDescriptorIds?: readonly string[];
}): Promise<McpCapabilitySettings> {
  return capabilitySettingsOperations.run(async () => {
    const serverId = requireIdentity(input.serverId, 'serverId');
    const current = await readSettings();
    const previous = current.servers[serverId];
    const nextServer = decodeServerSettings({
      mode: input.mode,
      pinnedDescriptorIds: input.pinnedDescriptorIds ?? previous?.pinnedDescriptorIds ?? [],
    }, '$.servers[mutation]');
    const servers = { ...current.servers, [serverId]: nextServer };
    const next = { ...current, servers };
    await writeSettings(next);
    return next;
  });
}

/**
 * Drops one server's exposure entry when that server is deleted.
 *
 * ⚠️ **成对动作的另一半** —— `DELETE_MCP_SERVER` 此前只清 `servers` 与 `toolCaches`，
 * 这一格（`zai_pp_mcp_capability_settings.servers[serverId]`）会一直留着：格数随删除次数
 * 单调增长，而 `decodeMcpCapabilitySettings` 的 `assertOnlyKeys` 只管形状不管数量，
 * 所以它永远不报错、也永远不会被读到 —— 属于「删了不清理」。
 *
 * ⚠️ **删不存在的键是幂等的**（返回原状态，不写盘），所以调用方不必先查。
 */
export async function deleteMcpCapabilityServerSettings(serverId: string): Promise<McpCapabilitySettings> {
  return capabilitySettingsOperations.run(async () => {
    const id = requireIdentity(serverId, 'serverId');
    const current = await readSettings();
    if (!Object.hasOwn(current.servers, id)) return current;
    const servers = { ...current.servers };
    delete servers[id];
    const next = { ...current, servers };
    await writeSettings(next);
    return next;
  });
}

export function getMcpCapabilityServerSettings(
  settings: McpCapabilitySettings,
  serverId: string,
): McpCapabilityServerSettings {
  const configured = settings.servers[serverId];
  return configured
    ? { mode: configured.mode, pinnedDescriptorIds: [...configured.pinnedDescriptorIds] }
    : { mode: 'direct', pinnedDescriptorIds: [] };
}

async function readSettings(): Promise<McpCapabilitySettings> {
  const data = await chrome.storage.local.get(MCP_CAPABILITY_SETTINGS_STORAGE_KEY) as Record<string, unknown>;
  return decodeMcpCapabilitySettings(data[MCP_CAPABILITY_SETTINGS_STORAGE_KEY]);
}

async function writeSettings(settings: McpCapabilitySettings): Promise<void> {
  await chrome.storage.local.set({
    [MCP_CAPABILITY_SETTINGS_STORAGE_KEY]: encodeMcpCapabilitySettings(settings),
  });
}

function decodeServerSettings(value: unknown, path: string): McpCapabilityServerSettings {
  const settings = requireRecord(value, path);
  assertOnlyKeys(settings, ['mode', 'pinnedDescriptorIds'], path);
  if (!(MCP_CAPABILITY_EXPOSURE_MODES as readonly string[]).includes(String(settings.mode))) {
    fail(`${path}.mode`, 'Unsupported MCP capability exposure mode.');
  }
  const pinnedDescriptorIds = requireArray(settings.pinnedDescriptorIds, `${path}.pinnedDescriptorIds`)
    .map((item, index) => requireIdentity(item, `${path}.pinnedDescriptorIds[${index}]`));
  if (new Set(pinnedDescriptorIds).size !== pinnedDescriptorIds.length) {
    fail(`${path}.pinnedDescriptorIds`, 'Pinned descriptor ids must be unique.');
  }
  return {
    mode: settings.mode as McpCapabilityExposureMode,
    pinnedDescriptorIds,
  };
}

function boundedInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(path, `Expected an integer between ${min} and ${max}.`);
  }
  return value;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    fail(path, 'Expected a plain object.');
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'Expected an array.');
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, 'Unexpected property.');
  }
}

function requireIdentity(value: unknown, path: string): string {
  if (!isIdentity(value)) fail(path, 'Expected a non-empty string.');
  return value.trim();
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function fail(path: string, message: string): never {
  throw new McpCapabilitySettingsError('mcp_capability_settings_corrupt', path, message);
}
