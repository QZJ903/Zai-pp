import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ⚠️⚠️ **「扫 `<标签>块</标签>`」的正则必须在别处也不回溯 —— 所以扫全仓源码，不点名文件。**
 *
 * **为什么需要它**：仓库里曾有多处手抄的「扫工具块」正则，它们不受任何单点测试保护。
 * 实测老形态（`\s*` 与 `[\s\S]*?` 量词重叠）在 4,000 空白时 6.4s、8,000 空白 50s，
 * 而**没有任何测试会红**。
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
