/**
 * z.ai 模型侧工具裁剪（过滤，非删除）。
 *
 * 只从「注入给模型的目录」中隐藏，执行 catalog 与 provider 注册表原样保留
 * （老会话里的 XML 仍要能解析执行）。分两类：
 *
 * 1. **永远裁掉**：本地 Skill 预览 —— 见下面那份名单的说明。
 * 2. **永远裁掉 web 工具**（`web_search` / `web_fetch`）—— 站点只剩 agent 模式，
 *    其联网由服务端沙箱原生承担，扩展自带的那两个没有任何用武之地。
 *
 * ⚠️ **「永远裁掉 web 工具」是 2026-10 起的状态**（站点只剩 agent）。
 * 在此之前它按「chat 模式开关 / 页面原生联网」放行；chat 若回归，判据在
 * `isFilteredZaiModelFacingTool` 里恢复（那里保留了 `webToolsEnabled` / `nativeSearchOn`
 * 两个选项的形参）。
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
  /**
   * 侧边栏「联网搜索」开关是否开着（存储值）。
   *
   * ⚠️ **站点只剩 agent 模式后，这两个字段已不再影响 web 工具的取舍** ——
   * agent 的联网由服务端沙箱承担，`web_search` / `web_fetch` **恒裁**（见下）。
   * 字段保留是为了不动调用点的形状；将来若 chat 回归，判据就在这里恢复。
   */
  webToolsEnabled?: boolean;
  /** 本轮是否开着页面原生联网（等同「用户想搜」）。同上，agent 下不再影响结果。 */
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
  // ⚠️ **恒裁**：站点只剩 agent 模式，联网由服务端沙箱承担，扩展自带的 web 工具
  // 没有任何用武之地。⚠️ `webToolsEnabled` / `nativeSearchOn` 两个选项**不再参与判定** ——
  // 保留它们是为了不动调用点形状（chat 回归时判据在这里恢复）。
  void options;
  return true;
}

/** 过滤 model-facing 工具目录（保留执行 catalog 与 provider 注册表）。 */
export function filterZaiModelFacingToolDescriptors(
  descriptors: readonly ToolDescriptor[],
  options?: ZaiModelFacingFilterOptions,
): ToolDescriptor[] {
  return descriptors.filter((descriptor) => !isFilteredZaiModelFacingTool(descriptor, options));
}