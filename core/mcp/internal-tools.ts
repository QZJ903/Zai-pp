/**
 * **由扩展自己调用、不对模型也不对用户暴露的 MCP 工具** —— 唯一真源。
 *
 * ⚠️⚠️ **这份清单有三个消费者，各在一个层面**，三处各写一遍字符串会在改工具名时
 * 静默分叉（一边认得、另一边不认，且没有任何报错）：
 * ① **模型可见目录**（`core/zai/model-facing.ts`）—— 不进提示词、不参与标签识别；
 * ② **提示词里的工具名清单**（`core/shell/contracts.ts` 的 `EXPOSED_SHELL_TOOL_NAMES`）；
 * ③ **MCP 页的工具列表**（`entrypoints/sidepanel/pages/McpPage.tsx`）—— 不显示给用户。
 *
 * ⚠️ **为什么三处都要裁**：这三层回答的是三个不同的问题 ——「模型能不能调」
 * 「提示词里点不点名」「用户在面板上勾不勾得到」。只裁其中一层，另外两层就会
 * 说出一件不成立的事（最典型：面板上能勾选并显示「已启用」，而模型根本看不见它）。
 *
 * ⚠️ **它仍然是可以执行的**：执行 catalog 与 provider 注册表原样保留
 * （扩展自己经 `core/skill/local-importer.ts` 调用它读本地技能文件夹）。
 * 所以 `applyMcpToolPolicy` 对这份清单**跳过 allowlist 那一层**，
 * 只保留服务级的三道门（见那里的说明）。
 */
export const EXTENSION_INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  /** 本地 Skill 导入的传输层：扩展自己读技能文件夹用，模型调它没有落点。 */
  'local_skill_preview',
]);

export function isExtensionInternalTool(name: string): boolean {
  return EXTENSION_INTERNAL_TOOL_NAMES.has(name);
}
