/**
 * z.ai 模型侧工具裁剪（过滤，非删除）。
 *
 * 只从「注入给模型的目录」中隐藏，执行 catalog 与 provider 注册表原样保留
 * （老会话里的 XML 仍要能解析执行）。
 */

import type { ToolDescriptor } from '../tool/types';

/**
 * 永远裁掉的工具：能力由独立 UI 流程承担，模型调不到。
 *
 * ⚠️ **只留 `local_skill_preview`** —— 它是本地 Skill 导入的**传输层**（由扩展自己
 * 经 Shell MCP 调用，见 `core/skill/local-importer.ts`），对模型退役
 * （`core/shell/contracts.ts` 的 `EXPOSED_SHELL_TOOL_NAMES` 同样把它摘掉）。
 * 用户能用它，模型不能。
 *
 * ⚠️ **Skill 起草与记忆导入预览不在此列** —— 它们的结果是**结构化对象**，
 * 由 `core/ui/tool-result-renderer.ts` 渲染成带「保存 / 导入」按钮的卡片，
 * 需要模型主动调才可能出现。放进这份名单等于把它们的入口掐掉。
 */
const ALWAYS_FILTERED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'local_skill_preview',
]);

export function isFilteredZaiModelFacingTool(descriptor: ToolDescriptor): boolean {
  return (
    ALWAYS_FILTERED_TOOL_NAMES.has(descriptor.invocationName) ||
    ALWAYS_FILTERED_TOOL_NAMES.has(descriptor.name)
  );
}

/** 过滤 model-facing 工具目录（保留执行 catalog 与 provider 注册表）。 */
export function filterZaiModelFacingToolDescriptors(
  descriptors: readonly ToolDescriptor[],
): ToolDescriptor[] {
  return descriptors.filter((descriptor) => !isFilteredZaiModelFacingTool(descriptor));
}