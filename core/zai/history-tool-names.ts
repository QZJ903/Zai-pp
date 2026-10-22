/**
 * 历史剥离用的**内置工具名基线**。
 *
 * ⚠️⚠️ **为什么不能只用 `hookState.toolDescriptorNames`**：那个快照由隔离世界经
 * `SYNC_HOOK_STATE` 同步过来，而**页面加载时会话历史请求往往早于同步完成** ——
 * 那一刻快照是空集，于是**一个块都剥不掉**（失败方向静默：用户仍看得见 XML）。
 *
 * ⚠️ **为什么这份是「手抄的第二份清单」却仍然要写**：`core/tool/*` 的 descriptor
 * 工厂要拖整条 i18n 资源链（约 80–92 KB），而本模块跑在**页面主世界**、每个 z.ai
 * 页面都会加载它 ⇒ 不能 import 那些工厂。
 *
 * ⚠️⚠️ **防漂移靠守卫，不靠自觉**：`tests/zai-history-cleanup.test.ts` 会**从真
 * 工厂派生**全部内置工具名，断言这份清单**恰好等于**那个集合。加了新内置工具却忘了
 * 往这里补，那条用例会红 —— 这正是「手抄必然分叉」那条通则要求的对账机制。
 *
 * ⚠️ **不含 MCP 工具名**（它们由用户配置、名字含随机 server UUID）—— 那部分只能靠
 * 动态快照。所以实际用的是**本清单 ∪ 快照**（见 `resolveHistoryToolNames`）。
 */

/**
 * **已经从扩展里删掉的**内置工具名。
 *
 * ⚠️ **它们必须继续被剥离** —— 老会话的历史里（服务端 `messages/batch` 与
 * `zai_pp_tool_history`）还留着这些标签的 XML，删掉这一项的表现是
 * **旧会话里的工具块突然原样显示出来**（失败方向静默）。
 *
 * ⚠️ 这一份**不参与**「与真工厂派生集合恰好相等」的对账（那几个工厂已经不生产它们了），
 * 只作为历史剥离的额外基线。
 */
export const ZAI_RETIRED_TOOL_NAMES: readonly string[] = [
  'web_search',
  'web_fetch',
];

export const ZAI_BUILTIN_HISTORY_TOOL_NAMES: readonly string[] = [
  // shell / 本地执行（`core/shell/contracts.ts` 的 SHELL_TOOL_NAMES）
  'shell_exec',
  'shell_status',
  'python_status',
  'python_exec',
  'local_skill_preview',
  'local_folder_pick',
  'local_file_stat',
  'local_file_read',
  'local_file_write',
  'shell_session_begin',
  'shell_session_exec',
  'shell_session_end',
  // 记忆（`core/tool/memory.ts`）
  'memory_save',
  'memory_update',
  'memory_delete',
  // Skill 起草 / 记忆导入预览（`core/skill/creator-tool.ts` / `core/memory/import-tool.ts`，
  // 结果走 `core/ui/` 的卡片渲染）
  'skill_draft_create',
  'memory_import_preview',
  // 已退役的内置工具名（本文件上方的 `ZAI_RETIRED_TOOL_NAMES`，零依赖、只需展开）
  ...ZAI_RETIRED_TOOL_NAMES,
];

/**
 * 合并「内置基线」与「动态快照」，去重。
 *
 * ⚠️ **动态快照是增量、不是替代** —— 它带来用户自配的 MCP 工具名，但不保证在
 * 页面加载早期可用（见本文件顶部说明）。两者取并集后，早期请求靠基线兜住、
 * 之后靠快照补上 MCP。
 */
export function resolveHistoryToolNames(
  dynamicNames: Iterable<string> | null | undefined,
): string[] {
  const names = new Set<string>(ZAI_BUILTIN_HISTORY_TOOL_NAMES);
  if (dynamicNames) {
    for (const name of dynamicNames) {
      if (typeof name === 'string' && name) names.add(name);
    }
  }
  return [...names];
}
