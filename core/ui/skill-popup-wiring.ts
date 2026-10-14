/**
 * 斜杠补全的**接线层** —— 把技能清单与三个注入原语组装起来，依赖全部由调用方给。
 *
 * ## 为什么单独一层
 *
 * `core/ui/skill-popup.ts` 是纯 DOM 模块（依赖注入、零站点耦合），它**测得到自己**，
 * 但测不到「生产真的注入了正确的东西」—— 那三处注入（写值原语 / 输入框解析 /
 * 锚点解析）此前只能靠读 `zai.content.ts` 的源码做 AST 断言，而那种断言
 * **问的是名字、不是身份**：把 `setInputValue: setTextareaValue` 换成
 * 一个同名但空实现的本地函数，AST 断言照样绿（实测过）。
 *
 * ⇒ 把组装搬到这里，测试传桩原语进来、断言「`init` 收到的那个对象里的
 * `setInputValue` **就是**我传进去的那个函数」（引用相等）—— 这一条比任何
 * 名字匹配都硬，且对上面那一族绕过在结构上免疫。
 *
 * ## 三条口径（与 `skill-popup.ts` 的契约一致）
 *
 * ① **候选只列启用中的技能** —— 与 `resolveActiveLocalSkill` 同口径；
 *    禁用技能补全出来也用不了（`parseSkillCommand` 那条路同样会滤掉它）。
 * ② **描述缺失时留空串、不丢这一条** —— 名字本身才是可用的那部分。
 * ③ **原语必须来自调用方**，本模块不 import 任何站点模块，也不另写第二份实现
 *    （写输入框这件事在自动化发送链上还有七个调用点，两份实现必然漂）。
 */

import type { SkillPopupDependencies, SkillPopupItem } from './skill-popup';

/** 一条技能记录里本层用得到的字段。 */
export interface SkillWiringRecord {
  name: string;
  description?: string;
  enabled?: boolean;
}

export interface SkillPopupWiringDeps {
  /** 取当前输入框（每次现取 —— 页面会重建它）。 */
  resolveInput: SkillPopupDependencies['resolveInput'];
  /** 取定位锚点（输入区外壳）。 */
  resolveAnchor: SkillPopupDependencies['resolveAnchor'];
  /** 写输入框的原语（生产传 `setTextareaValue`）。 */
  setInputValue: SkillPopupDependencies['setInputValue'];
  /** 实际装浮层的函数（生产传 `initSkillPopup`）。 */
  init: (
    items: SkillPopupItem[],
    copy: { hint: string },
    dependencies: SkillPopupDependencies,
  ) => void;
  /** 当前 locale 下的提示文案。 */
  hint: string;
  /** 注入 `document` / `window`（测试用）。 */
  document?: Document;
  window?: Window;
}

/** 把技能记录摊成补全候选（**只列启用中的**，描述缺失留空串）。 */
export function buildSkillPopupItems(skills: readonly SkillWiringRecord[]): SkillPopupItem[] {
  return skills
    .filter((skill) => skill.enabled !== false)
    .map((skill) => ({ name: skill.name, description: skill.description ?? '' }));
}

/**
 * 组装并调用补全的安装函数。
 *
 * ⚠️ **三个原语是「原样透传」** —— 本层不做任何包装或改名，
 * 这样测试才能用引用相等断言「生产注入的就是那三个真原语」。
 * 唯一的例外是 `resolveAnchor`：它需要把 `resolveInput` 的结果喂进去，
 * 所以包了一层箭头 —— 但**被调的那个函数仍是调用方给的**（测试断言这一点）。
 */
export function wireSkillPopup(
  skills: readonly SkillWiringRecord[],
  deps: SkillPopupWiringDeps,
): void {
  deps.init(
    buildSkillPopupItems(skills),
    { hint: deps.hint },
    {
      resolveInput: deps.resolveInput,
      resolveAnchor: (input) => deps.resolveAnchor(input),
      setInputValue: deps.setInputValue,
      ...(deps.document ? { document: deps.document } : {}),
      ...(deps.window ? { window: deps.window } : {}),
    },
  );
}
