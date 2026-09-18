/**
 * z.ai 模型侧工具裁剪（过滤，非删除）。
 *
 * agent 模式原生自带服务端沙箱工具，扩展注入的本地工具目录里若混入
 * web_search / web_fetch / artifact / skill 起草 / 记忆导入 / 本地 skill 预览
 * 会导致模型误以为能调这些（实际由服务端或独立后端处理）。这里只从「注入给
 * 模型的目录」中隐藏，执行 catalog 与 provider 注册表原样保留（老会话 XML
 * 仍要能解析）。
 */

import type { ToolDescriptor } from '../tool/types';

const FILTERED_MODEL_FACING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'web_search',
  'web_fetch',
  'artifact_create',
  'artifact_bundle_create',
  'skill_draft_create',
  'memory_import_preview',
  'local_skill_preview',
]);

export function isFilteredZaiModelFacingTool(descriptor: ToolDescriptor): boolean {
  return FILTERED_MODEL_FACING_TOOL_NAMES.has(descriptor.invocationName) ||
    FILTERED_MODEL_FACING_TOOL_NAMES.has(descriptor.name);
}

/** 过滤 model-facing 工具目录（保留执行 catalog 与 provider 注册表）。 */
export function filterZaiModelFacingToolDescriptors(
  descriptors: readonly ToolDescriptor[],
): ToolDescriptor[] {
  return descriptors.filter((descriptor) => !isFilteredZaiModelFacingTool(descriptor));
}