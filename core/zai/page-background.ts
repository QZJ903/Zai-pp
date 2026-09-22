/**
 * 自定义背景的应用层：把「设置 → 通用 → 背景设置」里保存的配置，
 * 变成 z.ai 页面上真实的背景。
 *
 * 做法：往 body 前置一个固定定位的图片层，把挡住它的页面容器标成透明，
 * 再叠一层按透明度算出的遮罩（浅色主题用白、深色主题用深灰）保证正文可读。
 *
 * 选择器与几何判据都按 z.ai 真机 DOM 校准：
 * - 根容器是 `#app`（不是 `#root` / `#__next`）；
 * - 主题标记是 `html` 上的 `light` / `dark` 类（Tailwind class 策略）；
 * - 输入框外壳是 `#chat-input` 往上第一个「圆角 ≥12px 且带背景或边框」的 div。
 */

import type { BackgroundConfig } from '../types';
import { normalizeBackgroundConfig } from '../background/config';
import { ZAI_CHAT_INPUT_SELECTOR } from './contracts';

/** 注入元素的 id 与标记属性。 */
const BG_ELEMENT_ID = 'dpp-bg';
const BG_STYLE_ID = 'dpp-bg-style';
const BG_ACTIVE_CLASS = 'dpp-bg-active';
const TRANSPARENT_ATTR = 'data-dpp-transparent';

/** z.ai 的 SPA 根容器。 */
const APP_ROOT_ID = 'app';

/** 遮罩模糊的上限：再高就不是「背景」而是毛玻璃墙了。 */
const MAX_BLUR_PX = 8;

export function applyBackground(config: BackgroundConfig | null): void {
  const normalized = normalizeBackgroundConfig(config);
  if (!normalized?.enabled) {
    removeBackground();
    return;
  }

  const imageUrl =
    (normalized.type === 'url' ? normalized.url : normalized.imageData) || null;
  if (!imageUrl) {
    removeBackground();
    return;
  }

  const existingBg = document.getElementById(BG_ELEMENT_ID);
  const existingStyle = document.getElementById(BG_STYLE_ID);

  document.body.classList.add(BG_ACTIVE_CLASS);

  // 透明度语义与侧边栏预览一致：值越小遮罩越厚、图片越淡。
  const overlayAlpha = (1 - normalized.opacity).toFixed(3);
  const blurPx = ((1 - normalized.opacity) * MAX_BLUR_PX).toFixed(1);
  document.body.style.setProperty('--dpp-overlay-light', `rgba(255, 255, 255, ${overlayAlpha})`);
  document.body.style.setProperty('--dpp-overlay-dark', `rgba(30, 30, 30, ${overlayAlpha})`);
  document.body.style.setProperty('--dpp-blur', `blur(${blurPx}px)`);

  const bgDiv = existingBg ?? document.createElement('div');
  bgDiv.id = BG_ELEMENT_ID;
  Object.assign(bgDiv.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    bottom: '0',
    zIndex: '-1',
    backgroundImage: `url("${escapeCssUrl(imageUrl)}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    pointerEvents: 'none',
  });
  if (!existingBg) document.body.prepend(bgDiv);

  const styleEl = existingStyle ?? document.createElement('style');
  styleEl.id = BG_STYLE_ID;
  styleEl.textContent = `
    #dpp-bg::after {
      content: '';
      position: absolute;
      inset: 0;
      background: var(--dpp-overlay-light);
      backdrop-filter: var(--dpp-blur);
      -webkit-backdrop-filter: var(--dpp-blur);
      pointer-events: none;
    }

    body.dpp-bg-active,
    body.dpp-bg-active #app,
    body.dpp-bg-active #app > div,
    body.dpp-bg-active #app > div > div {
      background: transparent !important;
    }

    body.dpp-bg-active [data-dpp-transparent] {
      background: transparent !important;
    }

    html.dark #dpp-bg::after {
      background: var(--dpp-overlay-dark);
    }
  `;
  if (!existingStyle) document.head.appendChild(styleEl);

  patchContainerBackgrounds();
}

export function removeBackground(): void {
  document.getElementById(BG_ELEMENT_ID)?.remove();
  document.getElementById(BG_STYLE_ID)?.remove();
  document.body.classList.remove(BG_ACTIVE_CLASS);
  document.body.style.removeProperty('--dpp-overlay-light');
  document.body.style.removeProperty('--dpp-overlay-dark');
  document.body.style.removeProperty('--dpp-blur');
  document
    .querySelectorAll(`[${TRANSPARENT_ATTR}]`)
    .forEach((element) => element.removeAttribute(TRANSPARENT_ATTR));
}

export function isBackgroundActive(): boolean {
  return document.body.classList.contains(BG_ACTIVE_CLASS);
}

/**
 * 把输入框到根容器这一路上的页面背景标成透明，让背景图透出来。
 *
 * 只扫这一条链（不是全文档）：聊天正文、消息气泡、侧边栏都不在里面，
 * 它们的背景保留，正文可读性不受影响。
 */
export function patchContainerBackgrounds(): void {
  if (!isBackgroundActive()) return;
  const root = document.getElementById(APP_ROOT_ID);
  if (!root) return;

  const textarea = document.querySelector<HTMLTextAreaElement>(ZAI_CHAT_INPUT_SELECTOR);
  if (!textarea) return;

  const inputBox = findPromptInputBox(textarea, root);
  if (!inputBox) return;

  let el: Element | null = inputBox.parentElement;
  while (el && el !== root && el !== document.body) {
    const style = getComputedStyle(el);
    if (hasVisibleBackground(style)) {
      (el as HTMLElement).setAttribute(TRANSPARENT_ATTR, '');
    }

    // 悬浮/吸顶容器通常自己带背景，且与输入框不在同一条视觉层上，
    // 这里把它们除输入框分支以外的可见背景子节点一并清掉。
    if (style.position === 'sticky' || style.position === 'fixed') {
      for (const child of el.children) {
        if (child.contains(textarea)) continue;
        if (hasVisibleBackground(getComputedStyle(child))) {
          (child as HTMLElement).setAttribute(TRANSPARENT_ATTR, '');
        }
      }
    }

    el = el.parentElement;
  }
}

/** 从输入框往上找到「输入框外壳」：圆角 ≥12px 且带背景或边框的那个容器。 */
function findPromptInputBox(
  textarea: HTMLTextAreaElement,
  root: HTMLElement,
): HTMLElement | null {
  const textareaRect = textarea.getBoundingClientRect();
  let candidate: HTMLElement | null = null;
  let el: Element | null = textarea.parentElement;

  while (el && el !== root && el !== document.body) {
    if (el instanceof HTMLElement) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (isTightPromptInputFrame(rect, textareaRect, style)) return el;
      if (!candidate && isPromptInputFrameCandidate(rect, textareaRect, style)) {
        candidate = el;
      }
    }
    el = el.parentElement;
  }

  return candidate ?? textarea.parentElement;
}

function isPromptInputFrameCandidate(
  rect: DOMRect,
  textareaRect: DOMRect,
  style: CSSStyleDeclaration,
): boolean {
  return (
    rect.width >= textareaRect.width &&
    rect.height >= textareaRect.height &&
    rect.height <= Math.max(260, textareaRect.height + 180) &&
    rect.width <= Math.max(textareaRect.width + 260, textareaRect.width * 1.25) &&
    (hasVisibleBackground(style) ||
      Number.parseFloat(style.borderRadius) > 0 ||
      Number.parseFloat(style.borderTopWidth) > 0 ||
      Number.parseFloat(style.borderBottomWidth) > 0)
  );
}

function isTightPromptInputFrame(
  rect: DOMRect,
  textareaRect: DOMRect,
  style: CSSStyleDeclaration,
): boolean {
  const borderRadius = Number.parseFloat(style.borderRadius);
  const hasBorder =
    Number.parseFloat(style.borderTopWidth) > 0 ||
    Number.parseFloat(style.borderBottomWidth) > 0;

  return (
    isPromptInputFrameCandidate(rect, textareaRect, style) &&
    borderRadius >= 12 &&
    (hasVisibleBackground(style) || hasBorder || style.overflow === 'hidden')
  );
}

function hasVisibleBackground(style: CSSStyleDeclaration): boolean {
  const bg = style.backgroundColor;
  const bgImg = style.backgroundImage;
  return (
    (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') ||
    (bgImg !== 'none' && bgImg !== '')
  );
}

/**
 * 图片 URL 直接拼进 CSS 的 `url("…")`。需要转义的是能提前终结该字符串的字符：
 * 反斜杠、双引号、右括号（左括号在引号内是字面量，不会闭合函数），以及换行。
 */
function escapeCssUrl(url: string): string {
  return url
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\)/g, '\\)')
    .replace(/\n/g, '\\a ')
    .replace(/\r/g, '\\d ');
}