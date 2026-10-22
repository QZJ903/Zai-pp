import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyBackground,
  isBackgroundActive,
  removeBackground,
} from '../core/zai/page-background';
import type { BackgroundConfig } from '../core/types';

const IMAGE_DATA = 'data:image/png;base64,AAAA';

function config(overrides: Partial<BackgroundConfig> = {}): BackgroundConfig {
  return {
    enabled: true,
    type: 'upload',
    url: '',
    imageData: IMAGE_DATA,
    opacity: 0.3,
    ...overrides,
  };
}

/** 造一个最小 z.ai 形状：`#app` 往下 3 层容器，输入框在最深处。 */
function mountZaiShell(): HTMLTextAreaElement {
  document.body.innerHTML = '';
  const app = document.createElement('div');
  app.id = 'app';
  // 前两层与注入样式覆盖的层重合（样式已把它们清透）
  const appInner = document.createElement('div');
  appInner.id = 'app-inner';
  const pageWrap = document.createElement('div');
  pageWrap.id = 'page-wrap';
  // 第 3 层：超出 `#app > div > div` 的范围，需要 patchContainerBackgrounds 兜住
  const page = document.createElement('div');
  page.id = 'page';
  page.style.background = 'rgb(248, 248, 248)';
  const shell = document.createElement('div');
  shell.id = 'shell';
  // 输入框外壳：圆角 ≥12px + 有背景 → 命中 isTightPromptInputFrame
  shell.style.borderRadius = '12px';
  shell.style.background = 'rgba(255, 255, 255, 0.9)';
  const textarea = document.createElement('textarea');
  textarea.id = 'chat-input';
  shell.appendChild(textarea);
  page.appendChild(shell);
  pageWrap.appendChild(page);
  appInner.appendChild(pageWrap);
  app.appendChild(appInner);
  document.body.appendChild(app);
  return textarea;
}

describe('zai page background', () => {
  beforeEach(() => {
    removeBackground();
    document.documentElement.className = '';
    document.body.innerHTML = '';
  });

  it('injects a fixed image layer and the overlay style while enabled', () => {
    mountZaiShell();
    applyBackground(config());

    const bg = document.getElementById('zpp-bg');
    expect(bg).not.toBeNull();
    expect(bg!.style.position).toBe('fixed');
    expect(bg!.style.zIndex).toBe('-1');
    expect(bg!.style.backgroundImage).toContain(IMAGE_DATA);

    expect(document.body.classList.contains('zpp-bg-active')).toBe(true);
    expect(isBackgroundActive()).toBe(true);

    const style = document.getElementById('zpp-bg-style');
    expect(style?.textContent).toContain('html.dark #zpp-bg::after');
    // 遮罩透明度 = 1 - opacity，模糊 = (1 - opacity) * 8
    expect(document.body.style.getPropertyValue('--zpp-overlay-light'))
      .toBe('rgba(255, 255, 255, 0.700)');
    expect(document.body.style.getPropertyValue('--zpp-blur')).toBe('blur(5.6px)');
  });

  it('marks the container chain above the composer as transparent', () => {
    mountZaiShell();
    applyBackground(config());

    // 输入框外壳之上那条链里有可见背景的容器都该被标透明（#page 是代表）
    const marked = Array.from(document.querySelectorAll('[data-zpp-transparent]'));
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.map((el) => el.id)).toContain('page');
  });

  it('accepts a URL config and escapes it into the CSS url()', () => {
    mountZaiShell();
    applyBackground(config({
      type: 'url',
      url: 'https://example.com/a)"b.png',
      imageData: '',
    }));

    const bg = document.getElementById('zpp-bg')!;
    expect(bg.style.backgroundImage).toContain('https://example.com/a');
    // 引号与括号被转义，URL 不会被提前截断
    expect(bg.style.backgroundImage).toContain('\\"');
  });

  it('cleans every trace when the config is disabled or empty', () => {
    mountZaiShell();
    applyBackground(config());
    expect(document.getElementById('zpp-bg')).not.toBeNull();

    applyBackground(config({ enabled: false }));

    expect(document.getElementById('zpp-bg')).toBeNull();
    expect(document.getElementById('zpp-bg-style')).toBeNull();
    expect(document.body.classList.contains('zpp-bg-active')).toBe(false);
    expect(document.body.style.getPropertyValue('--zpp-blur')).toBe('');
    expect(document.querySelectorAll('[data-zpp-transparent]').length).toBe(0);
    expect(isBackgroundActive()).toBe(false);
  });

  it('treats a null config as "no background"', () => {
    mountZaiShell();
    applyBackground(config());
    applyBackground(null);
    expect(document.getElementById('zpp-bg')).toBeNull();
  });

  it('does nothing when the composer is absent', () => {
    document.body.innerHTML = '';
    const app = document.createElement('div');
    app.id = 'app';
    document.body.appendChild(app);

    expect(() => applyBackground(config())).not.toThrow();
    // 图片层仍然注入（用户开了背景），只是没有可标透明的容器链
    expect(document.getElementById('zpp-bg')).not.toBeNull();
    expect(document.querySelectorAll('[data-zpp-transparent]').length).toBe(0);
  });

  it('re-applies in place instead of stacking duplicate layers', () => {
    mountZaiShell();
    applyBackground(config());
    applyBackground(config({ opacity: 0.8 }));

    expect(document.querySelectorAll('#zpp-bg').length).toBe(1);
    expect(document.querySelectorAll('#zpp-bg-style').length).toBe(1);
    expect(document.body.style.getPropertyValue('--zpp-overlay-light'))
      .toBe('rgba(255, 255, 255, 0.200)');
  });
});