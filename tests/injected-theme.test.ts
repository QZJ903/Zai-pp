import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { afterEach, describe, expect, it } from 'vitest';
import { injectInjectedThemeStyles, syncInjectedTheme } from '../core/ui/injected-theme';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';

/**
 * z.ai 的主题标记是 `html` 上的 `light` / `dark` 类（Tailwind class 策略），
 * 而注入的 UI 挂在 `body` 上 —— 所以要搬一层。
 *
 * ⚠️ **不能只靠 `prefers-color-scheme`** —— 页面主题与系统主题会分叉，
 * 而分叉时走错变量块的表现是「深色页面上近黑的字配近透明的底」= 看不见。
 */
function setPageTheme(value: 'light' | 'dark' | null): void {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  if (value) root.classList.add(value);
}

afterEach(() => {
  document.documentElement.className = '';
  document.body.className = '';
  document.head.innerHTML = '';
});

describe('injected theme projection', () => {
  it('projects a dark page onto the body so the dark variable block applies', () => {
    setPageTheme('dark');

    syncInjectedTheme();

    expect(document.body.classList.contains('dpp-theme-dark')).toBe(true);
    expect(document.body.classList.contains('dpp-theme-light')).toBe(false);
  });

  it('projects a light page and clears a previously applied dark class', () => {
    setPageTheme('dark');
    syncInjectedTheme();

    setPageTheme('light');
    syncInjectedTheme();

    expect(document.body.classList.contains('dpp-theme-light')).toBe(true);
    expect(document.body.classList.contains('dpp-theme-dark')).toBe(false);
  });

  it('clears our classes when the page declares no theme class, so the media query decides', () => {
    // ⚠️ 「保持现状」是错的：`body.dpp-theme-dark` 与媒体查询里的
    // `body:not(.dpp-theme-light)` 特异度相同、后者在样式表后面 —— 旧类留着会盖住兜底。
    // 「页面深色 → 跟随系统且系统浅色」正好走这条路（移除 `dark` 而不加 `light`）。
    setPageTheme(null);
    document.body.classList.add('dpp-theme-dark');

    syncInjectedTheme();

    expect(document.body.classList.contains('dpp-theme-dark')).toBe(false);
    expect(document.body.classList.contains('dpp-theme-light')).toBe(false);
  });

  it('injects the variable block exactly once', () => {
    injectInjectedThemeStyles();
    injectInjectedThemeStyles();

    expect(document.querySelectorAll('#dpp-injected-theme-css')).toHaveLength(1);
  });

  it('ships both a dark class block and a prefers-color-scheme fallback', () => {
    injectInjectedThemeStyles();
    const css = document.getElementById('dpp-injected-theme-css')!.textContent ?? '';

    expect(css).toContain('body.dpp-theme-dark');
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain('--dpp-ui-text');
  });

  it('is actually wired into the content script main(), not just exported', () => {
    // ⚠️ 这条守的是**接线**，不是实现 —— `syncInjectedTheme` 曾一度零调用：
    // 函数写好了、导出也齐，但没人调，于是深色页面上卡片用浅色板的字配近透明的底。
    // 那种缺陷跑遍单元测试都不会红（函数本身是对的），只有「有没有人调它」能拦住。
    //
    // ⚠️⚠️ **不能用 `source.includes('installInjectedThemeWatch()')`** —— 函数定义体
    // 自己就含这个子串，把调用点整行删掉它照样为 true（等于没守）。
    // 所以这里走 AST：在 `main()` 的函数体范围内找这次调用。
    const program = parseTypeScriptSource(
      'entrypoints/zai.content.ts',
      readFileSync('entrypoints/zai.content.ts', 'utf8'),
    );
    const range = findContentMainRange(program);
    expect(range, 'defineContentScript({ main }) 没找到').not.toBeNull();

    const callsInsideMain: string[] = [];
    walkSourceAst(program, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      const start = node.start ?? -1;
      if (start < range!.start || start > range!.end) return;
      callsInsideMain.push(node.callee.name);
    });

    expect(callsInsideMain).toContain('installInjectedThemeWatch');
  });
});

/** `defineContentScript({ … main() { … } })` 里那个 `main` 方法体的字符区间。 */
function findContentMainRange(program: t.Program): { start: number; end: number } | null {
  let range: { start: number; end: number } | null = null;
  walkSourceAst(program, (node) => {
    if (range || !t.isCallExpression(node)) return;
    if (!t.isIdentifier(node.callee, { name: 'defineContentScript' })) return;
    const arg = node.arguments[0];
    if (!t.isObjectExpression(arg)) return;
    for (const member of arg.properties) {
      if (!t.isObjectMethod(member)) continue;
      if (!t.isIdentifier(member.key, { name: 'main' })) continue;
      if (member.body.start == null || member.body.end == null) continue;
      range = { start: member.body.start, end: member.body.end };
    }
  });
  return range;
}
