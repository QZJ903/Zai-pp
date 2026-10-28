import { afterEach, describe, expect, it } from 'vitest';
import { injectInjectedThemeStyles } from '../core/ui/injected-theme';

/**
 * 注入主题的**可读性**校验。
 *
 * 这组断言存在的理由：深色模式下的失效形态是「近黑的字配近黑的底」，
 * 肉眼在浅色主题下开发时完全看不出来，而单元测试也拦不住 —— 除非把对比度
 * 真的算出来。所以这里从注入的样式表里解析 token、按 WCAG 相对亮度算比值。
 *
 * ⚠️ **比值阈值取 WCAG 正文档（4.5:1）**，不是「看起来还行」——
 * 面板里那些 10~12px 的小字正是最容易被配色顺手牺牲掉的地方。
 */

/** z.ai 页面自身的底色（`#app > div` 的 `bg-[#f8f8f8] dark:bg-[#161616]`）。 */
const PAGE_BACKGROUND = { light: '#f8f8f8', dark: '#161616' } as const;

/**
 * 深色下**侧边栏**底色的保守上界。
 *
 * 面板挂在 `#sidebar` 里，而侧边栏比 `#app > div` 的 `#161616` 亮（页面层级越深越亮）。
 * 侧边栏的实测值没有落档，所以取一个偏亮的 `#2a2a2a` 当**最坏情况**：浮层面只要压到
 * 这个底上仍立得起来，压到更暗的实际底色上一定更明显。
 */
const DARK_SIDEBAR_BACKGROUND = '#2a2a2a';

/**
 * 浅色下**侧边栏**底色的保守下界。
 *
 * 与深色那条对称：面板挂在 `#sidebar` 里，浅色侧边栏比 `#app > div` 的 `#f8f8f8`
 * **更暗**（页面层级越深越亮，浅色下反过来就是越深越灰）。取一个偏暗的 `#efefef`
 * 当最坏情况：深色文字压到这个底上仍够读，压到更亮的实际底色上一定更好。
 */
const LIGHT_SIDEBAR_BACKGROUND = '#efefef';

afterEach(() => {
  document.head.innerHTML = '';
});

describe('injected theme readability', () => {
  it('keeps both palettes key-for-key identical', () => {
    // ⚠️ 少一个键不会报错 —— 那一套主题下该处静默回落到继承值。
    const light = readVariableBlock('body {');
    const dark = readVariableBlock('body.zpp-theme-dark {');

    expect([...light.keys()].sort()).toEqual([...dark.keys()].sort());
    expect(light.size).toBeGreaterThan(0);
  });

  it('keeps the prefers-color-scheme fallback block in sync too', () => {
    // ⚠️ 第三份变量块（`@media (prefers-color-scheme: dark)`）是 `DARK_VARS` 用字符串
    // `replace` 换缩进拼出来的 —— 键名集合比对只覆盖前两份，那份拼坏了没人报。
    const media = readVariableBlock('body:not(.zpp-theme-light) {', '@media');
    const dark = readVariableBlock('body.zpp-theme-dark {');

    expect([...media.keys()].sort()).toEqual([...dark.keys()].sort());
    // 值也必须一致：缩进替换若吃掉某个值，键还在、值会不同。
    for (const [key, value] of dark) {
      expect(media.get(key), `${key} 在媒体查询副本里取值不同`).toBe(value);
    }
  });

  it('reads primary text at body-copy contrast in both themes', () => {
    const light = readVariableBlock('body {');
    const dark = readVariableBlock('body.zpp-theme-dark {');

    expect(contrast(resolve(light, '--zpp-ui-text'), PAGE_BACKGROUND.light))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolve(dark, '--zpp-ui-text'), PAGE_BACKGROUND.dark))
      .toBeGreaterThanOrEqual(4.5);

    // ⚠️ 与深色对称：真正的底是**侧边栏**，浅色下它比页底更暗。
    expect(
      contrast(resolve(light, '--zpp-ui-text'), LIGHT_SIDEBAR_BACKGROUND),
      '面板正文压在浅色侧边栏上也要够读',
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('reads the error status line at body-copy contrast in both themes', () => {
    // 状态行是 10px 小字，且只在出错时出现 —— 读不清就等于没提示。
    const light = readVariableBlock('body {');
    const dark = readVariableBlock('body.zpp-theme-dark {');

    expect(contrast(resolve(light, '--zpp-ui-error'), PAGE_BACKGROUND.light))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolve(dark, '--zpp-ui-error'), PAGE_BACKGROUND.dark))
      .toBeGreaterThanOrEqual(4.5);
  });

  it('reads active-state icons and badge text against what they actually sit on', () => {
    for (const [block, background] of [
      ['body {', PAGE_BACKGROUND.light],
      ['body.zpp-theme-dark {', PAGE_BACKGROUND.dark],
    ] as const) {
      const vars = readVariableBlock(block);
      const accentStrong = resolve(vars, '--zpp-ui-accent-strong');
      // ⚠️ 激活态图标的**实际**背景不是页面底色，而是 `overlay-active` 叠在页底上
      // （面板给激活按钮加了底色）。断言得对着真实面算，否则将来把图标换成文字
      // 时这条会给假绿灯。
      const activeSurface = composite(resolve(vars, '--zpp-ui-overlay-active'), background);
      // 15px 描边 SVG 属非文本，按 WCAG 1.4.11 的 3:1。
      expect(contrast(accentStrong, activeSurface), `${block} 激活态图标`).toBeGreaterThanOrEqual(3);
      // 待绑角标的文字是 10px 文本，按 4.5:1。
      const badge = composite(resolve(vars, '--zpp-ui-accent-soft'), background);
      expect(contrast(accentStrong, badge), `${block} 待绑角标`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps solid accent fills readable by pairing them with an inverted label token', () => {
    // 实心 accent 底（卡片按钮）上的字**不能写死白色** —— 浅色 accent 上白字只有
    // 3.74:1，深色 accent 上白字只有 2.27:1。字色走 `--zpp-ui-accent-contrast`。
    // ⚠️ 卡片那边「确实用了这个 token、没留字面色」由 `tool-result-renderer.test.ts` 守；
    // 这里只算配色本身够不够读。
    for (const block of ['body {', 'body.zpp-theme-dark {'] as const) {
      const vars = readVariableBlock(block);
      const fill = resolve(vars, '--zpp-ui-accent');
      const label = composite(resolve(vars, '--zpp-ui-accent-contrast'), fill);
      expect(contrast(label, fill), `${block} 实心按钮文字`).toBeGreaterThanOrEqual(4.5);
      // 这条 token 的语义就是「与 accent 反相」：两套主题的 accent 都偏亮，
      // 所以字色两边都该是**比 accent 暗**的那一侧。写死白字会同时踩坏
      // 「对 accent 的对比度」和「比 accent 暗」这两条，其中后者更直白。
      expect(
        relativeLuminance(label),
        `${block} 按钮文字应当比 accent 底暗`,
      ).toBeLessThan(relativeLuminance(fill));
    }
  });

  it('lifts the raised surface above the sidebar so overlays stay readable', () => {
    // ⚠️ 深色下浮层若用 `surface`（与页底几乎同值），菜单会糊在页面上。
    // 判据是「比底亮」，不是某个具体色值。
    const dark = readVariableBlock('body.zpp-theme-dark {');
    const raised = resolve(dark, '--zpp-ui-surface-raised');
    expect(relativeLuminance(raised)).toBeGreaterThan(relativeLuminance(PAGE_BACKGROUND.dark));

    // ⚠️ 真正的底是**侧边栏**（比 `#app` 的 `#161616` 亮），所以对着更亮的最坏情况再核一次。
    // 只对着页面底色验会漏掉「侧边栏底色偏亮 → 浮层反而比底暗」这条路。
    expect(
      luminanceRatio(relativeLuminance(raised), relativeLuminance(DARK_SIDEBAR_BACKGROUND)),
      '浮层压在侧边栏上也要看得出',
    ).toBeGreaterThanOrEqual(1.1);

    // 菜单文字落在 raised 上，同样要够读。
    expect(contrast(resolve(dark, '--zpp-ui-text'), raised)).toBeGreaterThanOrEqual(4.5);
  });

  it('makes hover and active overlays visible in both themes', () => {
    // ⚠️ 深色下继续用 `rgba(0, 0, 0, …)` 表达 hover 的话，黑叠黑等于没有 ——
    // 这条断言就是钉住那个方向：叠加层必须在**当前主题的底**上产生可见差异。
    for (const [block, background] of [
      ['body {', PAGE_BACKGROUND.light],
      ['body.zpp-theme-dark {', PAGE_BACKGROUND.dark],
    ] as const) {
      const vars = readVariableBlock(block);
      const hover = relativeLuminance(composite(resolve(vars, '--zpp-ui-overlay-hover'), background));
      const active = relativeLuminance(composite(resolve(vars, '--zpp-ui-overlay-active'), background));
      const page = relativeLuminance(background);

      expect(luminanceRatio(hover, page), `${block} hover`).toBeGreaterThanOrEqual(1.1);
      expect(luminanceRatio(active, page), `${block} active`).toBeGreaterThanOrEqual(1.15);
      // 激活态必须比 hover 更明显，否则两级反馈分不出来。
      expect(luminanceRatio(active, hover), `${block} active vs hover`).toBeGreaterThan(1);
    }
  });
});

/**
 * 从注入的样式表里取出某个选择器块的 `--zpp-ui-*` 声明。
 *
 * ⚠️ **按花括号配平取块，不按固定缩进找闭合** —— 媒体查询里那份副本是嵌套的
 * （`@media (…) { body:not(…) { … } }`），闭合括号的缩进与顶层块不同。
 */
function readVariableBlock(selector: string, context = ''): Map<string, string> {
  injectInjectedThemeStyles();
  const css = document.getElementById('zpp-injected-theme-css')?.textContent ?? '';
  const start = css.search(new RegExp(`^\\s*${escapeRegExp(selector)}`, 'm'));
  expect(start, `样式表里没有 ${selector} 块${context ? `（${context}）` : ''}`)
    .toBeGreaterThanOrEqual(0);

  const open = css.indexOf('{', start);
  expect(open, `${selector} 块没有开括号`).toBeGreaterThan(start);
  let depth = 0;
  let end = -1;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  expect(end, `${selector} 块没有闭合`).toBeGreaterThan(open);
  const block = css.slice(open, end);

  // ⚠️ **按声明扫、不按行扫** —— 「整行必须以 `;` 结尾」的正则会被行尾注释
  // （`…; /* ≈ #6b7280 */`）静默挡掉，而两套变量块同时丢掉同一个键时，
  // 键名集合比对**仍然相等** —— 于是少了一个 token 也没人报。
  const declarations = new Map<string, string>();
  for (const match of block.matchAll(/(--zpp-ui-[a-z-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1]!, match[2]!.trim());
  }

  // ⚠️ **解析必须无损** —— 每丢一条声明就等于少守一个 token。拿「块里出现的
  // 键名个数」对账（`(?=\s*:)` 保证只数键、不数 `var(--zpp-ui-x)` 那种值引用）。
  const declared = block.match(/--zpp-ui-[a-z-]+(?=\s*:)/g) ?? [];
  expect(declarations.size, `${selector} 里有声明没解析出来`).toBe(declared.length);
  expect(declarations.size, `${selector} 块里一条声明都没有`).toBeGreaterThan(0);
  return declarations;
}

/** 正则元字符转义（选择器里有 `.` `(` `)` 这类字符）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 解析一层 `var(--zpp-ui-x)` 引用；非变量值原样返回。 */function resolve(vars: Map<string, string>, name: string, depth = 0): string {
  const value = vars.get(name);
  expect(value, `样式表里没有 ${name}`).toBeDefined();
  const reference = /^var\((--zpp-ui-[a-z-]+)\)$/.exec(value!.trim());
  if (!reference || depth > 4) return value!;
  return resolve(vars, reference[1]!, depth + 1);
}

/**
 * 把颜色叠到给定底色上（CSS 的 alpha 合成在 sRGB 空间做）。
 * 不透明色原样返回；`#rrggbb` 与 `oklch(…)` 都支持。
 *
 * `extraAlpha` 用来把 CSS `opacity` 也纳入合成 —— 元素整体透明度与颜色自带的 alpha
 * 是相乘关系，所以直接乘上去即可。不传时行为与只做颜色合成完全一致。
 */
function composite(color: string, background: string, extraAlpha = 1): string {
  const parsed = parseColor(color);
  const alpha = parsed.alpha * extraAlpha;
  if (alpha >= 1) return color;
  const base = parseColor(background);
  const channel = (index: number) => (
    Math.round(parsed.rgb[index]! * alpha + base.rgb[index]! * (1 - alpha))
  );
  return `#${[0, 1, 2].map((index) => channel(index).toString(16).padStart(2, '0')).join('')}`;
}

function contrast(foreground: string, background: string): number {
  return luminanceRatio(relativeLuminance(foreground), relativeLuminance(background));
}

function luminanceRatio(a: number, b: number): number {
  const [high, low] = a >= b ? [a, b] : [b, a];
  return (high + 0.05) / (low + 0.05);
}

/** WCAG 相对亮度（对 sRGB 先做 gamma 反变换，再取 0.2126/0.7152/0.0722 加权）。 */
function relativeLuminance(color: string): number {
  const { rgb } = parseColor(color);
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** 支持 `#rgb` / `#rrggbb` / `oklch(L C H[ / A])`，够本文件用。 */
function parseColor(color: string): { rgb: [number, number, number]; alpha: number } {
  const value = color.trim();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1]!.length === 3
      ? [...hex[1]!].map((character) => character + character).join('')
      : hex[1]!;
    return {
      rgb: [0, 2, 4].map((index) => Number.parseInt(digits.slice(index, index + 2), 16)) as [
        number, number, number,
      ],
      alpha: 1,
    };
  }

  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/.exec(value);
  if (oklch) {
    return {
      rgb: oklchToSrgb(Number(oklch[1]), Number(oklch[2]), Number(oklch[3])),
      alpha: oklch[4] === undefined ? 1 : Number(oklch[4]),
    };
  }

  throw new Error(`测试不认识这个颜色写法：${color}`);
}

/** OKLCh → sRGB（Oklab 矩阵按 CSS Color 4 的取值）。 */
function oklchToSrgb(lightness: number, chroma: number, hue: number): [number, number, number] {
  // ⚠️ 色域外的值这里直接**截断**，浏览器做的是色域映射（chroma 二分）。
  // 受影响的只有几个高饱和值，实测两条路算出的对比度结论一致（差 < 0.1），
  // 所以不引入映射算法 —— 但**别拿这里的返回值当「浏览器会渲染成这个色」用**。
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3;

  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];

  return linear.map((channel) => {
    const clamped = Math.min(1, Math.max(0, channel));
    const encoded = clamped <= 0.0031308
      ? 12.92 * clamped
      : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  }) as [number, number, number];
}
