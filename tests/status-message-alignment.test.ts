import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `StatusMessage` 的**关闭按钮必须与正文首行齐平**。
 *
 * ⚠️ 这条守的是一个**只有肉眼看得出**的缺陷：容器是 `items-start` ⇒ 按钮与正文
 * 顶边对齐，而正文的行盒高度由 `html,:host` 的 `line-height: 1.5` 决定
 * （11px 字号 ⇒ 16.5px 行盒，字形垂直居中）。按钮若用 `leading-none`（行高 1），
 * 字形会顶在行盒最上沿 ⇒ **× 比正文高约 2.75px**，看起来"浮"在上面。
 *
 * **为什么用源码断言而不是几何断言**：jsdom 不做布局（`getBoundingClientRect`
 * 恒返回全 0），量不出这 2.75px。而样式来源是**产物 CSS 里的 `html` 规则**
 * （Tailwind preflight 的 `line-height:1.5`），测试环境里两边都拿不到真布局。
 * 所以退而求其次：断言「用的是继承行高，不是固定行高」这个**决定**本身。
 * ⚠️ 判据必须落在**按钮元素自己的属性**上 —— 只断言文件里出现过 `inherit`
 * 会被任何一处无关的 style 满足（`includes` 型断言的老毛病）。
 */

const SOURCE_PATH = 'entrypoints/sidepanel/components/settings/feedback-primitives.tsx';

/** 取出 `{onDismiss && (…)}` 那段 JSX —— 它是关闭按钮的唯一落点。 */
function dismissButtonSource(): string {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const start = source.indexOf('{onDismiss && (');
  expect(start, '找不到 onDismiss 分支').toBeGreaterThan(-1);
  // 从分支起点到它的收尾 `)}` —— 该分支内部不再嵌套 `{onDismiss`。
  const end = source.indexOf(')}', source.indexOf('</button>', start));
  expect(end, '找不到 button 收尾').toBeGreaterThan(start);
  // ⚠️⚠️ **必须先剥掉注释**：本文件在按钮上方写了长注释解释「为什么用 inherit」，
  // 而那条注释里就含 `inherit` / `leading-none` 这些词 —— 不剥的话，
  // **断言会被注释满足**（实测：变异回 `leading-none` 时，「inherits the container
  // line height」那条照样绿）。这是 `includes` 型断言的一个变体：
  // 断言的目标是**元素属性**，不是「这段源码里出现过这个词」。
  return source
    .slice(start, end)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('StatusMessage dismiss button alignment', () => {
  it('inherits the container line height so the × sits on the first text line', () => {
    const button = dismissButtonSource();

    expect(button).toContain("lineHeight: 'inherit'");
  });

  it('does not pin the button to a fixed line height', () => {
    // ⚠️ `leading-none` 与 `leading-*` 系列都会把行盒压到字形高度 ⇒ 按钮上浮。
    const button = dismissButtonSource();

    expect(button).not.toMatch(/className="[^"]*\bleading-/);
  });

  it('keeps the button out of the text flow width', () => {
    // 顺带：按钮不该参与正文伸缩（`shrink-0`），否则长文案会把 × 挤扁。
    const button = dismissButtonSource();

    expect(button).toContain('shrink-0');
  });
});