import type { ToolRiskLevel } from '../tool/types';
import { isExtensionInternalTool } from '../mcp/internal-tools';

export const SHELL_MCP_SERVER_NAME = 'Shell Local';
export const SHELL_MCP_NATIVE_HOST = 'com.zai_pp.shell';

/**
 * `local_skill_preview` 的**结构化失败码**。
 *
 * ⚠️ **与 `packages/shell-host/native/contracts.mjs` 的 `LOCAL_SKILL_ERROR_CODES`
 * 逐字对齐，改一边要改两边** —— host 侧是纯 `.mjs`，引不到 TS 常量
 * （`native/` 会被拷到安装目录，与 `packages/shell-host` 是两个独立 npm 包，
 * 跨包 import 不成立）。对齐由契约测试守着。
 *
 * ⚠️ **为什么要有码**：扩展侧靠它决定「这次失败要不要引导用户重新选择文件夹」。
 * 按 message 文案判会随 host 措辞变化静默失效，而那种失效表现为「明明只需要重选路径，
 * 却只弹一句原始报错」或反向的「存储失败也让人白选一遍」。
 */
export const LOCAL_SKILL_ERROR_CODES = {
  rootUnreadable: 'local_skill_root_unreadable',
  notFound: 'local_skill_not_found',
  pathsMissing: 'local_skill_paths_missing',
  unreadable: 'local_skill_unreadable',
  previewTooLarge: 'local_skill_preview_too_large',
  tooLarge: 'local_skill_too_large',
  previewFailed: 'local_skill_preview_failed',
  /**
   * 用户在文件夹选择框里点了取消。
   *
   * ⚠️⚠️ **这不是失败** —— 它只是「什么都没发生」。所以它**不在**
   * `LOCAL_SKILL_PATH_UNAVAILABLE_CODES` 里（那一档会引导用户重选文件夹），
   * 也不该显示成错误。给它一个码而不是靠 message 文案，是因为文案是 UI 字符串，
   * 改一次措辞就静默失效。
   */
  folderPickCancelled: 'local_folder_pick_cancelled',
  /**
   * 文件夹选择器**真的失败了**（osascript 被拦、PowerShell 起不来等）。
   *
   * ⚠️ 与 `folderPickCancelled` 分开是因为两者语义相反：那个是「什么都没发生」，
   * 这个要如实报错。共用一个码会让后续消费者把真实故障读成用户取消。
   */
  folderPickFailed: 'local_folder_pick_failed',
} as const;

/**
 * 「原文件夹已不可用」这一档 —— **只有它值得引导用户重新选择路径**。
 *
 * ⚠️ `previewTooLarge` / `tooLarge` 不在其中：那两个是「这个技能本身有问题」，
 * 重选文件夹不会变好。
 */
export const LOCAL_SKILL_PATH_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  LOCAL_SKILL_ERROR_CODES.rootUnreadable,
  LOCAL_SKILL_ERROR_CODES.notFound,
  LOCAL_SKILL_ERROR_CODES.pathsMissing,
  LOCAL_SKILL_ERROR_CODES.unreadable,
]);

export function isLocalSkillPathUnavailableCode(code: unknown): boolean {
  return typeof code === 'string' && LOCAL_SKILL_PATH_UNAVAILABLE_CODES.has(code);
}

export const SHELL_TOOL_NAMES = ['shell_exec', 'shell_status', 'python_status', 'python_exec', 'local_skill_preview', 'local_folder_pick', 'local_file_stat', 'local_file_read', 'local_file_write', 'shell_session_begin', 'shell_session_exec', 'shell_session_end'] as const;
export type ShellToolName = typeof SHELL_TOOL_NAMES[number];

/**
 * 暴露给模型/提示词的 shell 工具名（`local_skill_preview` 退役）。
 * 完整 SHELL_TOOL_NAMES 仍保留用于执行 catalog（老会话 XML 解析），
 * 这里只裁剪「提示词里点名」的工具清单。
 *
 * ⚠️ **判据从 `core/mcp/internal-tools.ts` 派生** —— 与「模型可见目录」
 * 和「MCP 页工具列表」共用同一份真源，别在这里另写工具名。
 */
export const EXPOSED_SHELL_TOOL_NAMES = SHELL_TOOL_NAMES.filter(
  (name) => !isExtensionInternalTool(name),
);

export interface ShellToolSpec {
  name: ShellToolName;
  title: string;
  description: string;
  risk: ToolRiskLevel;
}

export const SHELL_TOOL_SPECS: readonly ShellToolSpec[] = [
  {
    name: 'shell_exec',
    title: '执行命令',
    description: '在本地系统执行 shell 命令，返回 stdout、stderr 和退出码。',
    risk: 'high',
  },
  {
    name: 'shell_status',
    title: '主机状态',
    description: '报告 Native Host 健康状态、平台、shell 类型和工作目录。',
    risk: 'low',
  },
  {
    name: 'python_status',
    title: 'Python 状态',
    description: '报告本机 Python 解释器、版本和可导入的快速验证库。',
    risk: 'low',
  },
  {
    name: 'python_exec',
    title: '执行 Python',
    description: '执行短 Python 代码，用于快速验证想法、复杂计算和小型数据处理。',
    risk: 'high',
  },
  {
    name: 'local_skill_preview',
    title: '预览本地 Skill',
    description: '只读扫描本地 Skill 目录，返回 SKILL.md、文本资源和脚本清单；不会执行本地代码。',
    risk: 'medium',
  },
  {
    name: 'local_folder_pick',
    title: '选择本地文件夹',
    description: '打开系统文件夹选择器并返回用户选择的本地绝对路径。',
    risk: 'low',
  },
  {
    name: 'local_file_stat',
    title: '查看本地文件信息',
    description: '返回本地文件是否存在、大小、类型和修改时间；不读取文件正文。',
    risk: 'medium',
  },
  {
    name: 'local_file_read',
    title: '读取本地文本文件',
    description: '按字符窗口读取本地 UTF-8 文本文件，支持分片读取大型文件。',
    risk: 'medium',
  },
  {
    name: 'local_file_write',
    title: '写入本地文本文件',
    description: '将 UTF-8 文本原样写入本地文件，支持覆盖或追加，并可自动创建父目录。',
    risk: 'high',
  },
  {
    name: 'shell_session_begin',
    title: '开启持久 Shell 会话',
    description: '启动一个长生存的 Shell 会话，其工作目录、环境变量与常驻子进程可在后续多次 shell_session_exec 之间保持。适用于多步骤工作流，避免分次 shell_exec 丢失状态。返回 session_id 供后续调用使用。',
    risk: 'high',
  },
  {
    name: 'shell_session_exec',
    title: '在持久会话中执行命令',
    description: '在先前开启的持久 Shell 会话中执行命令。状态（工作目录、export 的变量、常驻进程）在调用之间保持。返回与 shell_exec 一致的 stdout、stderr 和退出码。会话闲置一段时间后会自动关闭。',
    risk: 'high',
  },
  {
    name: 'shell_session_end',
    title: '关闭持久 Shell 会话',
    description: '关闭由 shell_session_begin 开启的持久 Shell 会话并释放其子进程。调用后该 session_id 不再有效。',
    risk: 'medium',
  },
] as const;
