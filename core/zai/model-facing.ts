/**
 * z.ai 模型侧工具裁剪（过滤，非删除）。
 *
 * 只从「注入给模型的目录」中隐藏，执行 catalog 与 provider 注册表原样保留
 * （老会话里的 XML 仍要能解析执行）。分两类：
 *
 * 1. **永远裁掉**：本地 Skill 预览 —— 见下面那份名单的说明。
 * 2. **按条件裁掉 web 工具**（web_search / web_fetch）：
 *    - agent 模式恒裁 —— 其联网由服务端沙箱原生承担。
 *    - chat 模式：侧边栏的联网开关关着、且本轮也没开页面原生联网时裁掉；
 *      只要有一个开着就放行。**页面原生联网开着也放行**，是为了让「用户想搜」
 *      这件事永远落到扩展自己的搜索上 —— 原生通道那侧会被
 *      zai.content.ts 的 disableZaiNativeWebSearch 关掉。
 */

import { isExtensionWebToolDescriptor } from '../tool/web-search';
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
  // ⚠️⚠️ **web 工具的身份判据不在本文件** —— 是 `core/tool/web-search.ts` 的
  // `isExtensionWebToolDescriptor`（**名字 + provider 契约**，不能只看名字）。
  // 裁剪 web 工具的理由是「agent 模式联网由服务端沙箱承担」与「用户这轮没想搜」——
  // 那两条**只对扩展自带的联网成立**。第三方 MCP 可以把工具命名为 `web_search`，
  // 那与我们的联网策略无关；只按名字判会让**用户的工具凭空消失**（失败方向静默）。
  // ⚠️ 提示词侧（联网引导该不该注入）问的是**同一个问题**，用**同一份判据** ——
  // 各自写一遍会在分叉时静默出错（一边裁了、另一边照样注入引导）。
  // ⚠️ 与「按 `descriptor.name` 判工具身份」那条通则同族：`name` 不保证唯一，
  // 要判「属于哪一类」时得连 provider 一起看；要按 id 定位时用 `descriptorId`。
  if (!isExtensionWebToolDescriptor(descriptor)) return false;
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