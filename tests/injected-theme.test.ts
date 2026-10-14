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
    //
    // ⚠️ **判据 2026-10-14 换过**：`installInjectedThemeWatch` 现在**不再直接写在
    // `main()` 里** —— 启动链的编排搬到了 `core/zai/capability-install.ts`
    // （依赖注入、可被行为测试直接调用）。所以「在 `main()` 里找那次调用」
    // 这条判据已经测不到东西了。
    //
    // 新的判据分两半，**合起来才等于原来的强度**：
    // ① `main()` 把 `installInjectedThemeWatch` **原样传给了** `installZaiCapabilities`
    //    （shorthand 属性 ⇒ 值就是那个标识符，不是别的同名东西）；
    // ② `installZaiCapabilities` 真的会调它 —— 那一半由行为测试守
    //    （`tests/zai-capability-install.test.ts` 的「每个 install 恰好一次」）。
    const program = parseTypeScriptSource(
      'entrypoints/zai.content.ts',
      readFileSync('entrypoints/zai.content.ts', 'utf8'),
    );
    const range = findContentMainRange(program);
    expect(range, 'defineContentScript({ main }) 没找到').not.toBeNull();

    // 在 `main()` 区间里找 `installZaiCapabilities({ … })` 的实参对象。
    let depObject: t.ObjectExpression | null = null;
    walkSourceAst(program, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      if (node.callee.name !== 'installZaiCapabilities') return;
      const start = node.start ?? -1;
      if (start < range!.start || start > range!.end) return;
      const [options] = node.arguments;
      if (t.isObjectExpression(options)) depObject = options;
    });
    expect(depObject, 'main() 里应当调 installZaiCapabilities({ … })').not.toBeNull();

    // ⚠️ **两种形态都认**：shorthand（`installInjectedThemeWatch,`）与
    // 具名（`installInjectedThemeWatch: installInjectedThemeWatch,`）——
    // 只认一种会在重构时假红。但**值必须解析到同名标识符**：
    // `installInjectedThemeWatch: () => {}` 这种「名字对、东西不对」的写法要被抓出来。
    let wired = 0;
    for (const property of (depObject as unknown as t.ObjectExpression).properties) {
      if (!t.isObjectProperty(property)) continue;
      const key = t.isIdentifier(property.key) ? property.key.name
        : (t.isStringLiteral(property.key) ? property.key.value : null);
      if (key !== 'installInjectedThemeWatch') continue;
      const value = property.value;
      const resolvesToSameName = (t.isIdentifier(value) && value.name === 'installInjectedThemeWatch')
        || (t.isMemberExpression(value) && t.isIdentifier(value.property, { name: 'installInjectedThemeWatch' }));
      if (resolvesToSameName) wired += 1;
    }
    expect(
      wired,
      'main() 必须把真正的 installInjectedThemeWatch 传给 installZaiCapabilities'
      + '（传一个同名空函数会让深色页面的字看不见，而这条断言要能抓住它）',
    ).toBe(1);
  });
});

/**
 * `defineContentScript({ … main() { … } })` 里那个 `main` 方法体的字符区间。
 *
 * ⚠️ **两种形态都认**（`async main() {}` 是 `ObjectMethod`；`main: async (ctx) => {}`
 * 是 `ObjectProperty` + 箭头）—— 只认前者时，把 `main` 改成属性形式会让这里
 * 静默返回 `null`、报出「源码被大改」这种指错方向的错。
 * 口径与 `tests/helpers/content-source-ast.ts` 的 `findMainBody` 对齐。
 */
function findContentMainRange(program: t.Program): { start: number; end: number } | null {
  let range: { start: number; end: number } | null = null;
  const take = (body: t.Node): void => {
    if (range || body.start == null || body.end == null) return;
    range = { start: body.start, end: body.end };
  };
  walkSourceAst(program, (node) => {
    if (range || !t.isCallExpression(node)) return;
    if (!t.isIdentifier(node.callee, { name: 'defineContentScript' })) return;
    const arg = node.arguments[0];
    if (!t.isObjectExpression(arg)) return;
    for (const member of arg.properties) {
      if (t.isObjectMethod(member)) {
        if (t.isIdentifier(member.key, { name: 'main' })) take(member.body);
        continue;
      }
      if (!t.isObjectProperty(member) || !t.isIdentifier(member.key, { name: 'main' })) continue;
      const value = member.value;
      if ((t.isFunctionExpression(value) || t.isArrowFunctionExpression(value))
        && t.isBlockStatement(value.body)) {
        take(value.body);
      }
    }
  });
  return range;
}
