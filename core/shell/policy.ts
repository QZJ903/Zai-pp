import type {
  McpServerConfig,
  McpServerCreateInput,
  McpServerResultLimits,
} from '../mcp/types';
import { SHELL_MCP_NATIVE_HOST, SHELL_MCP_SERVER_NAME, SHELL_TOOL_NAMES } from './contracts';

export interface ShellMcpPresetOptions {
  nativeHost?: string;
  enabled?: boolean;
  executionEnabled?: boolean;
}

/**
 * 新装时的 Shell Local 预设。
 *
 * ⚠️⚠️ **刻意不写 `allowlist`** —— 缺省由 `createMcpServer` 补成
 * `{ mode: 'all', toolNames: [] }`，与其它 MCP 服务**同一口径**：工具级开关由用户在
 * MCP 页自己勾，服务级启用看 `enabled`。
 *
 * ⚠️ **曾经这里硬编码 `mode: 'allow'` + 三个只读工具**（`shell_status` /
 * `python_status` / `local_folder_pick`），配一个「启动时把缺的本地文件工具补回名单」
 * 的升级函数。后果是**用户关掉的工具每次浏览器启动都被重新打开**（`mode: 'allow'` 下
 * 关工具 = 从名单删掉，而那个升级判据正是「缺了就补」）。
 * ⇒ 那条升级与这份名单一起删除。**不要为了「safe-by-default」把名单加回来** ——
 * 真正的安全边界是服务默认 `enabled: false`（用户装完 host 再手动启用）。
 */
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
    execution: {
      // ⚠️ **默认开启「自动执行」** —— 关着的时候这三个开关任一为假，`isMcpToolEnabled`
      // 就返回 false，工具列表整列显示为「未启用」（`{active}/{total} 自动` 会显示 0/12），
      // 而面板上没有任何一处解释「是这一项在挡」。用户装完 host、连上了、也看到工具列表了，
      // 却一个都用不了。Shell 是本项目的一等能力（提示词与内置 skill 都按它写），
      // 默认值就该是「能用」。
      enabled: options.executionEnabled ?? true,
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
