import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

/**
 * ⚠️⚠️ **同一形态在别处的手抄副本也必须不回溯 —— 所以扫全仓源码，不点名文件。**
 *
 * **为什么需要它**：`scripts/` 下有三个脚本各自手抄了一份「扫 `<标签>块</标签>`」的正则，
 * 它们**不受上面那组断言保护**（那组只测 `core/tool/invocation.ts` 里的那一个函数）。
 * 实测：`scripts/mcp-smoke.mjs` 与 `scripts/mcp-live-mock.mjs` 各两处仍是老形态
 * （4,000 空白 6.4s / 8,000 空白 50s），而**没有任何测试会红**。
 *
 * ⚠️ **判据是「代码行里出现 `\s*` 紧邻惰性块组 `[\s\S]*?`」**，不是「某个文件名里有没有」——
 * 点名文件的话，将来**新加一个脚本又会漏**（这正是本条缺陷的成因：修一处、抄三处）。
 * ⚠️ 排除注释行：这两个形态在注释里出现是**正当的**（说明「为什么不能这么写」）。
 * ⚠️ 两个方向都要扫：`\s*([\s\S]*?)\s*`（带捕获组）与 `\s*[\s\S]*?\s*`（不带）。
 */
const SCANNED_ROOTS = ['core', 'entrypoints', 'scripts', 'packages', 'tests'];
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js'];
/**
 * ⚠️ **扫描要跳过本文件自己** —— 它把那个形态当成**检测用的字符串常量**写着，
 * 而不是当成正则**用**。不排除的话，守卫第一版就是被自己判违规的（实测）。
 * ⚠️ 这不是漏洞：本文件不扫工具块，所以「它里面有没有老形态」不影响任何行为。
 */
const SCANNER_SELF = 'tool-xml-call-regex-redos.test.ts';
/** 模板串里是双反斜杠、正则字面量里是单反斜杠 —— 两种写法都要抓。 */
const OVERLAP_PATTERNS = [
  String.raw`\\s*([\\s\\S]*?)\\s*`,
  String.raw`\\s*[\\s\\S]*?\\s*`,
  String.raw`\s*([\s\S]*?)\s*`,
  String.raw`\s*[\s\S]*?\s*`,
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (SCANNED_EXTENSIONS.some((extension) => full.endsWith(extension))) out.push(full);
  }
  return out;
}

/**
 * 去掉注释，**保留换行**（行号不能变）。
 *
 * ⚠️⚠️ **为什么不按行首猜**：先前用「行首是 `//` / `*` / `/*`」判注释，两个方向都会错 ——
 * ① 块注释的**续行**若没写前导 `*`，会被当代码 ⇒ **误报**；
 * ② 模板串 / 正则里以 `*` 开头的**代码行**会被静默跳过 ⇒ **漏报**。
 * 判据要落在「这行去注释后还剩什么」，不是「这行怎么开头」。
 *
 * ⚠️ **字符串里的 `//` 不会被误剥**（`'https://…'` 这类）：先扫字符串/模板串再扫注释，
 * 与同仓 `tests/zai-pure-codec-import-boundary.test.ts` 的思路一致，只是那处
 * 按「`:` 后的 `//`」近似处理 —— 这里要求更严，所以做一遍真正的引号感知扫描。
 */
function stripComments(source: string): string {
  const out: string[] = [];
  let index = 0;
  /** 正在读的引号种类；`null` 表示在代码态。 */
  let quote: "'" | '"' | '`' | null = null;

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];

    if (quote) {
      out.push(char);
      if (char === '\\') {
        // 转义序列整体照抄，避免把 `\'` 当成收尾引号。
        if (next !== undefined) {
          out.push(next);
          index += 2;
          continue;
        }
      } else if (char === quote) {
        quote = null;
      }
      index += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out.push(char);
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      // 行注释：吞到行尾（换行留给下一轮原样输出）。
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      // 块注释：吞到 `*/`，但**换行照抄**，行号才不乱。
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') out.push('\n');
        index += 1;
      }
      index += 2;
      continue;
    }

    out.push(char);
    index += 1;
  }

  return out.join('');
}

describe('no hand-copied tool-block regex overlaps whitespace quantifiers', () => {
  it('scans every source file, not a fixed list of scripts', () => {
    const root = resolve(process.cwd());
    const files = SCANNED_ROOTS.flatMap((dir) => listSourceFiles(resolve(root, dir)));
    // 自检：扫到的文件数不能是 0 或个位数 —— 目录改名 / 路径写错时，
    // 「没有违规」会**假通过**（这是扫描类脚本最典型的失效形态）。
    expect(files.length, '应当扫到大量源文件').toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(SCANNER_SELF)) continue;
      // ⚠️ 按**去注释后的代码**扫（保留换行 ⇒ 行号仍准），不按行首猜注释。
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const [index, line] of code.split('\n').entries()) {
        for (const pattern of OVERLAP_PATTERNS) {
          if (line.includes(pattern)) {
            offenders.push(`${file.slice(root.length + 1)}:${index + 1}  ${line.trim()}`);
            break;
          }
        }
      }
    }

    expect(
      offenders,
      `这些行把 \`\\s*\` 加在了惰性块组两侧（开标签后跟连续空白时会灾难性回溯）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('would catch the defect if it were reintroduced', () => {
    // ⚠️ 反面自检：**判据本身要能命中** —— 否则上面那条「零命中」可能只是因为
    // 字符串常量写错了（比如转义层数不对），而不是因为源码干净。
    const defectLine = '  const regex = new RegExp(`<(${names})\\\\s*([\\\\s\\\\S]*?)\\\\s*<\\\\/\\\\1>`, \'g\');';
    const matched = OVERLAP_PATTERNS.some((pattern) => defectLine.includes(pattern));
    expect(matched, '老形态的写法必须能被判据命中').toBe(true);
    // 修后的写法**不得**被命中（否则守卫会把正确代码判成违规）。
    const fixedLine = '  const regex = new RegExp(`<(${names})>([\\\\s\\\\S]*?)<\\\\/\\\\1>`, \'g\');';
    expect(
      OVERLAP_PATTERNS.some((pattern) => fixedLine.includes(pattern)),
      '修后的写法不得被判据命中',
    ).toBe(false);
  });

  it('strips comments without losing lines or eating code', () => {
    // ⚠️⚠️ **这一档守的是判据的准确性**（先前按行首猜注释，两个方向都会错）：
    // ① 块注释**续行**不写前导 `*` ⇒ 旧判据当它是代码（误报）；
    // ② 以 `*` 开头的**代码行** ⇒ 旧判据静默跳过（漏报）。
    const source = [
      '/* 块注释首行',
      '  \\s*([\\s\\S]*?)\\s*',   // 续行：旧判据会误报
      '*/',
      'const x = 1;',
      '* 以星号开头的代码行',      // 旧判据会漏报
      '// 行尾注释里的 \\s*([\\s\\S]*?)\\s* 是正当的',
      "const url = 'https://chat.z.ai/c/x'; // 串里的 // 不是注释",
    ].join('\n');

    const code = stripComments(source);
    const lines = code.split('\n');

    // 行数不变 ⇒ 报出来的行号仍指向原文件。
    expect(lines).toHaveLength(source.split('\n').length);
    // 块注释（含续行）被剥掉。
    expect(lines[1]).not.toContain('[\\s\\S]');
    // 以 `*` 开头的代码行**保留**（旧判据会漏掉它）。
    expect(lines[4]).toContain('以星号开头的代码行');
    // 行尾注释被剥掉。
    expect(lines[5]).not.toContain('[\\s\\S]');
    // 字符串里的 `//` 不被当注释 ⇒ 后面的代码不丢。
    expect(lines[6]).toContain("const url = 'https://chat.z.ai/c/x';");
  });
});
