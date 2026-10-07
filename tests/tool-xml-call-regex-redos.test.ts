import { describe, expect, it } from 'vitest';
import {
  createToolInvocationCatalog,
  createXmlToolCallRegex,
} from '../core/tool/invocation';
import type { ToolDescriptor } from '../core/tool/types';

/**
 * `createXmlToolCallRegex` 扫块用的正则**必须不回溯**。
 *
 * ⚠️⚠️ **背景**：它原本写成
 * `<\s*(名)\s*>\s*([\s\S]*?)\s*<\/\s*\1\s*>` —— 捕获组两侧的 `\s*` 与
 * `[\s\S]*?` **量词重叠**，在「开标签后跟**连续空白**、且全文没有配对闭合标签」时
 * **灾难性回溯**（实测 2,000 空白 0.9s / 4,000 空白 6.4s / 8,000 空白 >20s）。
 * 这与 `parseToolXml` 当初修掉的那条**形状完全相同**（见 `core/zai/tool-xml.ts`）。
 *
 * ⚠️ **标签名两侧的 `\s*` 保留是刻意的** —— 它支持 `< shell_exec >` 这类带空格开标签，
 * 且不参与重叠。所以下面有一档专门钉它。
 *
 * ⚠️ **修法的代价（已由调用方承担）**：捕获组会带上尾部空白，调用方需自行 `trim()`。
 * 本函数当前无生产消费者；唯一用法在 `scripts/web-search-smoke.mjs`，那里本来就 `.trim()`。
 *
 * ⚠️⚠️ **为什么分「小档 / 大档」两段测**：缺陷存在时大档会把进程挂死，
 * 而**挂死的测试不算「红」**（3,000 空白约 2.8s，120,000 空白按同一倍率外推是十几万秒）。
 * 所以先用小档拿到一个**能终止的明确红**，只有小档过了才跑大档证明线性。
 */
const BUDGET_MS = 500;
/** 小档：缺陷存在时约 2.8s 就能拿到红（可终止）。 */
const PROBE_WHITESPACE = 3_000;
/** 大档：只有小档过了才跑，用来证明线性。 */
const LONG_WHITESPACE = 120_000;

const NAMES = ['shell_exec', 'web_search', 'web_fetch', 'memory_save'];

const CATALOG = createToolInvocationCatalog(
  NAMES.map((name): ToolDescriptor => ({
    id: `local:test:${name}`,
    provider: { kind: 'local', id: 'test', displayName: 'Test', transport: 'in_process' },
    name,
    invocationName: name,
    title: name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  })),
);

function elapsed(text: string): { ms: number; matches: string[] } {
  const regex = createXmlToolCallRegex(CATALOG);
  const t0 = performance.now();
  const matches = [...text.matchAll(regex)].map((match) => match[0]);
  return { ms: performance.now() - t0, matches };
}

/**
 * 小档拿结论，过了才跑大档。
 * ⚠️ 传入的是**构造器**而不是拼接好的前缀 —— 否则「前缀里已经含一长段空白」的用例
 * 会让小档本身也变成大输入、同样挂死。
 */
function expectLinear(build: (n: number) => string, label: string): void {
  expect(
    elapsed(build(PROBE_WHITESPACE)).ms,
    `${label} 小档 ${PROBE_WHITESPACE}`,
  ).toBeLessThan(BUDGET_MS);
  expect(
    elapsed(build(LONG_WHITESPACE)).ms,
    `${label} 大档 ${LONG_WHITESPACE}`,
  ).toBeLessThan(BUDGET_MS);
}

describe('createXmlToolCallRegex does not backtrack on whitespace runs', () => {
  it('scans an opening tag followed by a long space run', () => {
    expectLinear((n) => `<shell_exec>${' '.repeat(n)}`, '空格');
    expect(elapsed(`<shell_exec>${' '.repeat(LONG_WHITESPACE)}`).matches).toHaveLength(0);
  });

  it('scans newlines and tabs just as fast', () => {
    for (const whitespace of ['\n', '\t']) {
      expectLinear((n) => `<shell_exec>${whitespace.repeat(n)}`, JSON.stringify(whitespace));
    }
  });

  it('scans a long whitespace run followed by a truncated closing tag', () => {
    for (const tail of ['</shell_stat', '</ shell_exec', '<']) {
      expectLinear((n) => `<shell_exec>${' '.repeat(n)}${tail}`, tail);
    }
  });
});

describe('createXmlToolCallRegex keeps its matching semantics', () => {
  it('still finds a well-formed call embedded in 120K of text', () => {
    const text = `${'x'.repeat(60_000)}<shell_exec>{"command":"ls"}</shell_exec>${'y'.repeat(60_000)}`;
    const { ms, matches } = elapsed(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain('<shell_exec>');
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('keeps accepting whitespace inside the opening tag', () => {
    // ⚠️ 这一档钉的是「标签名两侧的 `\s*` 不许顺手一起删」—— 删了就匹配不到。
    // ⚠️ 只钉**开标签**带空格这一种形态：`</ shell_exec>`（`<` 与 `/` 之间有空格）
    // 本来就匹配不到，那是修前修后一致的既有行为，**不能**当成本次改动的语义写进断言。
    const { matches } = elapsed('a< shell_exec >{"command":"ls"}</ shell_exec >b');
    expect(matches).toHaveLength(1);
  });

  it('matches only the same tool name for the closing tag', () => {
    const { matches } = elapsed('<shell_exec>{"a":1}</memory_save>');
    expect(matches).toHaveLength(0);
  });

  it('finds every block in order', () => {
    const text = [
      '<memory_save>{"n":1}</memory_save>',
      '<shell_exec>{"command":"ls"}</shell_exec>',
    ].join('\n');
    const { matches } = elapsed(text);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toContain('memory_save');
    expect(matches[1]).toContain('shell_exec');
  });
});
