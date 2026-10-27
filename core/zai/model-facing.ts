/**
 * z.ai 模型侧工具裁剪（过滤，非删除）。
 *
 * 只从「注入给模型的目录」中隐藏，执行 catalog 与 provider 注册表原样保留
 * （老会话里的 XML 仍要能解析执行）。
 */

import type { ToolDescriptor } from '../tool/types';
import { EXTENSION_INTERNAL_TOOL_NAMES } from '../mcp/internal-tools';

/**
 * 永远裁掉的工具：能力由独立 UI 流程承担，模型调不到。
 *
 * ⚠️ **清单本体在 `core/mcp/internal-tools.ts`** —— 那里是唯一真源，
 * MCP 页的工具列表与提示词的工具名清单都从同一处派生。
 * 本条只负责「模型侧」这一层：不进提示词目录、不参与标签识别。
 *
 * ⚠️ **Skill 起草与记忆导入预览不在此列** —— 它们的结果是**结构化对象**，
 * 由 `core/ui/tool-result-renderer.ts` 渲染成带「保存 / 导入」按钮的卡片，
 * 需要模型主动调才可能出现。放进这份名单等于把它们的入口掐掉。
 */
const ALWAYS_FILTERED_TOOL_NAMES: ReadonlySet<string> = EXTENSION_INTERNAL_TOOL_NAMES;

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