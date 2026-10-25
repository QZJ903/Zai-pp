/**
 * z.ai 输入区（composer）的**元素解析**：输入框本体，以及它的**外壳**。
 *
 * 为什么要单独一个「外壳」概念：给输入区定位的浮层（如斜杠命令补全）要以哪一层的
 * 矩形为锚。实测两者差别不小 ——
 *
 * | | left | top | width | height |
 * |---|---|---|---|
 * | textarea | 29 | 509 | 555 | 40 |
 * | 外壳 | 17 | 497 | 581 | 107 |
 *
 * ⚠️⚠️ **锚点要取外壳，不要取 textarea** —— 以「弹窗底边 = 锚点顶边 - 6px」为例：
 * 取 textarea 时底边落在 y=503，而外壳从 y=497 开始 ⇒ **压进外壳内部**，
 * 看起来像从输入框里长出来；取外壳时底边落在 y=491，正好浮在上方。
 * ⚠️ 外壳还把底部按钮行算进高度（107 vs 40），而 textarea 是自增高的，
 * 文本一多它的 `top` 就会变、外壳的不会。
 *
 * ⚠️ **外壳判据**（真机实测值：`borderRadius: 12px`、`borderTopWidth: 0.571429px`、
 * `background: oklab(…)`）：从输入框往上找第一个「圆角 ≥10px **且** 有不透明背景色」的祖先。
 *
 * ⚠️ **找不到外壳时回落到输入框自己** —— 失败方向必须是「照样能用、只是位置差一点」，
 * 而不是「不显示」。位置错的表现是**静默的**（浮层偏了几像素），不值得为它引入失败分支。
 */

import { ZAI_CHAT_INPUT_SELECTOR } from './contracts';

/** 判「这一层是输入区外壳」的圆角下限（实测值是 12px，留一点余量给页面微调）。 */
const SHELL_MIN_BORDER_RADIUS_PX = 10;

/** 往上找外壳时最多看几层（防意外死循环）。 */
const SHELL_MAX_ANCESTOR_DEPTH = 10;

/**
 * 当前的输入框。**每次现取、不缓存** —— 页面会重建它
 * （实测 20 秒观测期内换了 2 个节点），缓存住会指向已脱连的旧节点。
 */
export function resolveZaiComposerInput(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>(ZAI_CHAT_INPUT_SELECTOR)
    ?? document.querySelector<HTMLTextAreaElement>('textarea');
}

/** 背景色算不算「有背景」。计算值里透明是 `rgba(0, 0, 0, 0)`。 */
function hasVisibleBackground(color: string): boolean {
  const value = color.trim();
  return value !== '' && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)';
}

/**
 * 输入区外壳：从输入框往上第一个「圆角 ≥10px 且有背景」的祖先。拿不到返回 null。
 *
 * ⚠️ 不要把锚点挂进它**里面** —— 输入框的直接父层是 `div.overflow-hidden`，
 * 挂进去会被裁掉。本函数只负责「哪一层是外壳」，挂载点由调用方决定。
 */
export function resolveZaiComposerShell(input: HTMLElement | null): HTMLElement | null {
  let node = input?.parentElement ?? null;
  for (let depth = 0; depth < SHELL_MAX_ANCESTOR_DEPTH && node; depth += 1) {
    const style = window.getComputedStyle(node);
    const radius = Number.parseFloat(style.borderRadius) || 0;
    if (radius >= SHELL_MIN_BORDER_RADIUS_PX && hasVisibleBackground(style.backgroundColor)) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}