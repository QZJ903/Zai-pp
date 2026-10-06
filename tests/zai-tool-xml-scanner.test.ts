import { describe, expect, it } from 'vitest';
import { findZaiToolXmlBlocks } from '../core/zai/tool-xml';

/**
 * 工具 XML 块的扫描器 —— **它必须线性**。
 *
 * ⚠️⚠️ **背景**：`parseToolXml` 原来用 `<\s*(名)\s*>\s*([\s\S]*?)\s*<\/\s*\1\s*>` 正则扫块，
 * 而那族正则在「开标签后跟**连续空白**、且全文没有配对闭合标签」时**灾难性回溯**
 * （`\s*` 与 `[\s\S]*?\s*` 量词重叠）。实测（Node，逐字复刻该正则）：
 * 1,000 空白 116ms / 2,000 空白 872ms / 4,000 空白 6.5s / **8,000 空白 49s**。
 *
 * ⚠️ **为什么这是真缺陷**：`parseToolXml` 的输入是 `assistantText`
 * （`handleResponseComplete` 兜底路径）与 `detected.raw`，**两者都来自桥消息、都没有长度上限**
 * ⇒ 模型输出一段「`<shell_exec>` + 大段缩进/空行」就能让内容脚本卡死数十秒。
 *
 * ⚠️ **触发条件是「纯空白连续段」** —— 中间插一个非空白字符、或末尾补上闭合标签，
 * 都会立刻回到 0ms。所以判据不是「文本长」，是「空白量词重叠」。
 * 上游同一处也是这么修的（`core/interceptor/tool-parser.ts` 的线性扫描器）。
 *
 * ⚠️ **下面的阈值（500ms）是刻意的宽松值**：ReDoS 一旦触发是**秒到分钟级**，
 * 而扫描器在 12 万字符上是 **0.1ms 量级** —— 两者差 4 个数量级，
 * 所以这个门禁不会因机器快慢抖动，只会因「有人换回正则」而红。
 */
const NAMES = [
  'shell_exec',
  'shell_status',
  'python_exec',
  'local_file_read',
  'local_file_write',
  'memory_save',
];

const BUDGET_MS = 500;

function elapsed(text: string): { ms: number; blocks: ReturnType<typeof findZaiToolXmlBlocks> } {
  const t0 = performance.now();
  const blocks = findZaiToolXmlBlocks(text, NAMES);
  return { ms: performance.now() - t0, blocks };
}

describe('zai tool XML block scanner', () => {
  it('scans a 120K whitespace run after an opening tag without backtracking', () => {
    const { ms, blocks } = elapsed(`<shell_exec>${' '.repeat(119_000)}`);
    expect(blocks).toHaveLength(0);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('scans 120K newlines and tabs just as fast', () => {
    for (const whitespace of ['\n', '\t']) {
      const { ms, blocks } = elapsed(`<shell_exec>${whitespace.repeat(119_000)}`);
      expect(blocks, whitespace).toHaveLength(0);
      expect(ms, whitespace).toBeLessThan(BUDGET_MS);
    }
  });

  it('does not backtrack on a mismatched or truncated closing tag', () => {
    for (const tail of ['</shell_stat', '</shell_status>', '</ shell_exec', '<']) {
      const { ms, blocks } = elapsed(`<shell_exec>${' '.repeat(50_000)}${tail}`);
      expect(blocks, tail).toHaveLength(0);
      expect(ms, tail).toBeLessThan(BUDGET_MS);
    }
  });

  it('does not re-scan the closing bracket for every "<" in a long "<"-run', () => {
    // 一串 `<` 只由一个 `>` 收尾：逐个 `<` 都从零找 `>` 会退化成二次。
    // ⚠️ 这个档位是**实测定的**：扫描器自带「`knownTagEnd` 前移」优化（见 `xml-tags.ts`），
    // 去掉它以后 60 万字符要 1.6s，留着只要 23ms（差 70 倍）—— 所以 60 万才能稳定区分，
    // 5 万那一档两者都只有十几毫秒、拦不住。
    const { ms, blocks } = elapsed(`${'<'.repeat(600_000)}>`);
    expect(blocks).toHaveLength(0);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('still finds a well-formed call embedded in 120K of text', () => {
    const text = `${'x'.repeat(60_000)}<shell_exec>{"command":"ls"}</shell_exec>${'y'.repeat(60_000)}`;
    const { ms, blocks } = elapsed(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('shell_exec');
    expect(blocks[0].body).toBe('{"command":"ls"}');
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('finds every block in order and keeps scanning after an unterminated one', () => {
    const text = [
      '<memory_save>{"n":1}</memory_save>',
      `<shell_exec>${' '.repeat(4000)}`,
      ' then <memory_save>{"n":2}</memory_save>',
    ].join('\n');
    const { blocks } = elapsed(text);
    // 中间那个未闭合的 `shell_exec` 必须被跳过、且不能挡住后面那个完整块。
    expect(blocks.map((block) => block.name)).toEqual(['memory_save', 'memory_save']);
    expect(blocks.map((block) => block.body)).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('matches only the same tool name for the closing tag', () => {
    const { blocks } = elapsed('<shell_exec>{"a":1}</memory_save>');
    expect(blocks).toHaveLength(0);
  });

  it('accepts whitespace inside the tags and trims the body', () => {
    const { blocks } = elapsed('a< shell_exec >  {"command":"ls"}  < / shell_exec >b');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('shell_exec');
    expect(blocks[0].body).toBe('{"command":"ls"}');
  });

  it('keeps an empty body as an empty string rather than failing', () => {
    const { blocks } = elapsed('<shell_exec></shell_exec>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].body).toBe('');
  });

  it('returns nothing for text without a complete block', () => {
    for (const text of ['', 'plain answer', '<>', '< >', '</shell_exec>', '<shell_exe>{"a":1}</shell_exe>']) {
      expect(findZaiToolXmlBlocks(text, NAMES), text).toEqual([]);
    }
  });
});
