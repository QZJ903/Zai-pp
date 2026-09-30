import type {
  McpServerConfig,
  McpServerCreateInput,
  McpServerResultLimits,
  McpToolAllowlist,
} from '../mcp/types';
import { SHELL_MCP_NATIVE_HOST, SHELL_MCP_SERVER_NAME, SHELL_TOOL_NAMES } from './contracts';

export interface ShellMcpPresetOptions {
  nativeHost?: string;
  enabled?: boolean;
  executionEnabled?: boolean;
}

export const DEFAULT_SHELL_MCP_ALLOWLIST_TOOL_NAMES = [
  'shell_status',
  'python_status',
  'local_folder_pick',
] as const;

export const LOCAL_SKILL_SHELL_TOOL_NAMES = [
  'local_folder_pick',
] as const;

export const LOCAL_FILE_SHELL_TOOL_NAMES = [
  'local_file_stat',
  'local_file_read',
  'local_file_write',
] as const;

export function createShellMcpPresetInput(
  options: ShellMcpPresetOptions = {},
): McpServerCreateInput {
  return {
    displayName: SHELL_MCP_SERVER_NAME,
    enabled: options.enabled ?? false,
    transport: {
      kind: 'native_messaging',
      nativeHost: options.nativeHost ?? SHELL_MCP_NATIVE_HOST,
    },
    headers: [],
    secrets: [],
    timeouts: {
      connectMs: 5_000,
      requestMs: 120_000,
      discoveryMs: 10_000,
    },
    limits: {
      maxResultBytes: 128_000,
      // ⚠️ **必须 ≥ native host 暴露的工具总数**（当前 12，见 `SHELL_TOOL_NAMES`）。
      // 发现阶段的 `listMcpTools` 会按**服务端返回顺序** `slice(0, maxToolCount)`，
      // 而这一步在 allowlist 过滤**之前** —— 上限小于工具总数时，排在后面的工具
      // 会被**静默丢弃**：既进不了模型目录，也不会出现在 MCP 页的工具列表里
      // （用户想手动勾选都勾不到）。
      // 曾经取值 8，于是 local_file_write 与三个 shell_session_* 一直不可达。
      maxToolCount: 12,
    },
    allowlist: {
      mode: 'allow',
      toolNames: [...DEFAULT_SHELL_MCP_ALLOWLIST_TOOL_NAMES],
    },
    execution: {
      enabled: options.executionEnabled ?? false,
      mode: 'auto',
    },
  };
}

export function isShellMcpServer(
  server: Pick<McpServerConfig, 'displayName' | 'transport'>,
): boolean {
  return server.displayName === SHELL_MCP_SERVER_NAME ||
    server.transport.nativeHost === SHELL_MCP_NATIVE_HOST;
}

export function buildShellAllowlistUpgrade(allowlist: McpToolAllowlist): McpToolAllowlist | null {
  if (allowlist.mode !== 'allow') return null;

  const names = new Set(allowlist.toolNames);
  const missingLocalSkillTools = LOCAL_SKILL_SHELL_TOOL_NAMES.filter((name) => !names.has(name));
  const missingLocalFileTools = LOCAL_FILE_SHELL_TOOL_NAMES.filter((name) => !names.has(name));
  const missing = [...missingLocalSkillTools, ...missingLocalFileTools];
  if (missing.length === 0) return null;

  return {
    mode: 'allow',
    toolNames: [...allowlist.toolNames, ...missing],
  };
}

/**
 * 工具上限的兼容升级：把**已落库**的 `maxToolCount` 抬到 host 实际暴露的工具数。
 *
 * ⚠️ **为什么需要它**：`createShellMcpPresetInput()` 只在**全新安装**时被消费；
 * 已有记录的 `limits` 由 `normalizeServerForMutation` 从存储里原样读出
 * （`positiveNumber(value.limits?.maxToolCount, …)`），而 `ensureShellMcpCompatibility`
 * 此前只升 allowlist、不碰 limits —— 于是把默认值从 8 改成 12 **只对新装生效**，
 * 存量配置仍然在第 9 位被静默截断（模型看不到 `local_file_write`、MCP 页也列不出来）。
 *
 * 判据是「比工具总数小就一定错」—— 小多少都会丢尾部工具，不存在「用户故意设小」的正当用途。
 */
export function buildShellToolLimitUpgrade(
  limits: McpServerResultLimits,
): McpServerResultLimits | null {
  if (limits.maxToolCount >= SHELL_TOOL_NAMES.length) return null;
  return { ...limits, maxToolCount: SHELL_TOOL_NAMES.length };
}
