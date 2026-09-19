/**
 * z.ai 模型侧工具裁剪（过滤，非删除）。
 *
 * 只从「注入给模型的目录」中隐藏，执行 catalog 与 provider 注册表原样保留
 * （老会话里的 XML 仍要能解析执行）。分两类：
 *
 * 1. **永远裁掉**：artifact / skill 起草 / 记忆导入 / 本地 skill 预览 —— 这些能力由
 *    服务端或侧边栏自己的 UI 流程承担，模型调不到。
 * 2. **按条件裁掉 web 工具**（web_search / web_fetch）：
 *    - agent 模式恒裁 —— 其联网由服务端沙箱原生承担。
 *    - chat 模式：侧边栏的联网开关关着、且本轮也没开页面原生联网时裁掉；
 *      只要有一个开着就放行。**页面原生联网开着也放行**，是为了让「用户想搜」
 *      这件事永远落到扩展自己的搜索上 —— 原生通道那侧会被
 *      zai.content.ts 的 disableZaiNativeWebSearch 关掉。
 */

import type { ToolDescriptor } from '../tool/types';

/** 永远裁掉的工具：能力由服务端或独立 UI 流程承担，模型调不到。 */
const ALWAYS_FILTERED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'artifact_create',
  'artifact_bundle_create',
  'skill_draft_create',
  'memory_import_preview',
  'local_skill_preview',
]);

/** 按条件裁掉的 web 工具。 */
const WEB_TOOL_NAMES: ReadonlySet<string> = new Set([
  'web_search',
  'web_fetch',
]);

export interface ZaiModelFacingFilterOptions {
  /** agent 模式（服务端沙箱语境）时为 true。 */
  isAgent?: boolean;
  /**
   * 侧边栏「联网搜索」开关是否开着（存储值）。
   * 与 `nativeSearchOn` 取或：任一为真就放行 web 工具。
   */
  webToolsEnabled?: boolean;
  /** 本轮是否开着页面原生联网（等同「用户想搜」）。 */
  nativeSearchOn?: boolean;
}

function isWebTool(descriptor: ToolDescriptor): boolean {
  return WEB_TOOL_NAMES.has(descriptor.invocationName) || WEB_TOOL_NAMES.has(descriptor.name);
}

export function isFilteredZaiModelFacingTool(
  descriptor: ToolDescriptor,
  options?: ZaiModelFacingFilterOptions,
): boolean {
  if (
    ALWAYS_FILTERED_TOOL_NAMES.has(descriptor.invocationName) ||
    ALWAYS_FILTERED_TOOL_NAMES.has(descriptor.name)
  ) {
    return true;
  }
  if (!isWebTool(descriptor)) return false;
  // agent 模式：联网走服务端沙箱，恒裁。
  if (options?.isAgent) return true;
  // chat 模式：开关关着、本轮也没开原生联网 → 裁掉；否则放行。
  return options?.webToolsEnabled !== true && options?.nativeSearchOn !== true;
}

/** 过滤 model-facing 工具目录（保留执行 catalog 与 provider 注册表）。 */
export function filterZaiModelFacingToolDescriptors(
  descriptors: readonly ToolDescriptor[],
  options?: ZaiModelFacingFilterOptions,
): ToolDescriptor[] {
  return descriptors.filter((descriptor) => !isFilteredZaiModelFacingTool(descriptor, options));
}