import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **主世界脚本的 import 闭包里不能出现 chrome API 与 i18n 资源。**
 *
 * ⚠️⚠️ 为什么这条需要单独的守卫：`entrypoints/zai-main-world.content.ts` 跑在**页面主世界**
 * （`world: 'MAIN'`），那里**没有 `chrome` 对象**，也**没有扩展的 i18n 资源**。
 * 一旦它的 import 闭包里混进一个用 `chrome.runtime` 或 `i18n/resources` 的模块，
 * 后果是**运行期在页面里抛 `chrome is not defined`** ——
 * 而 `tsc` 不会红（`@types/chrome` 让类型检查通过）、单测也不会红（测试环境有桩）。
 * 失败方向是「整个主世界脚本装不上」：增广、工具识别、流式剥离、历史清洗**一起失效**。
 *
 * ⚠️ 这条约束以前只写在注释里（`core/zai/tool-name-match.ts` 顶部、
 * `core/zai/history-cleanup.ts` 顶部、`fetch-hook.ts` 的 import 说明），**零自动化守卫**。
 *
 * ⚠️ 判据是**闭包**，不是单文件：`fetch-hook` → `history-cleanup` → `prompt/visible-user-prompt`
 * 这条链上任何一跳引到 chrome 都会连带整条失效。
 */
const ENTRY = 'entrypoints/zai-main-world.content.ts';

/**
 * 从源码里去掉**注释**，按需再去掉**字符串 / 模板串字面量的内容**。
 *
 * ⚠️⚠️ **必须是有状态扫描，不能一串正则** —— 三处最容易被误判：
 * ① 注释里提一句（`// 后台读不到 localStorage`）—— 不是引用；
 * ② **字符串里**写 `'chrome.runtime.lastError'`（错误码文案）—— 不是引用；
 * ③ **模板串里**的 `//`（`` `https://x` ``）—— 按行剥注释会把它之后**整行真代码**一起删掉，
 *    方向是**假阳性**（本该报的漏报）。
 * 正则做不到 ③（它无法跟踪引号配对状态），所以这里逐字符走。
 *
 * ⚠️ **`keepStrings` 是个真实的开关，不是可选参数**：
 * - **扫描 import 时必须保留字符串** —— specifier 就写在引号里，抹掉内容等于把闭包清空
 *   （第一版就是这么写的，`closure.length` 直接掉到 1）。
 * - **判「代码有没有引用 chrome」时必须抹掉字符串** —— 否则文案里的
 *   `'chrome.runtime.lastError'` 会假红。
 *
 * ⚠️ **模板串的 `${…}` 插值按代码处理**（不是当字符串吃掉）—— 那是真会执行的表达式，
 * `` `${chrome.runtime.id}` `` 与裸写 `chrome.runtime.id` 一样是引用。见下面那个分支的说明。
 *
 * ⚠️ **仍不追求完整词法分析**：不识别**正则字面量**。`/https?:\/\//` 里的 `//` 会被当成
 * 行注释起点，把同一行后面的代码一起删掉（**假阴性**）。**当前可达性为零** ——
 * 主世界闭包 18 个文件里含 `//` 的正则一条都没有（含 `\/` 的那两条在 `stream-codec.ts`，
 * 是 `/<\/details\s*>/` 这种，不带 `//` 也不带引号）。修它要引入一个正则字面量状态机
 * （要排除除号、`//`、`/*` 三种情形），**风险大于收益，登记不修**。
 */
function scanSource(source: string, options: { keepStrings: boolean }): string {
  const out: string[] = [];
  const length = source.length;
  let i = 0;

  while (i < length) {
    const char = source[i] as string;
    const next = source[i + 1];

    // 行注释
    if (char === '/' && next === '/') {
      while (i < length && source[i] !== '\n') i += 1;
      continue;
    }
    // 块注释
    if (char === '/' && next === '*') {
      i += 2;
      while (i < length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // 字符串 / 模板串
    if (char === '\'' || char === '"' || char === '`') {
      const quote = char;
      const start = i;
      i += 1;
      const inner: string[] = [];
      while (i < length) {
        if (source[i] === '\\') {
          inner.push(source.slice(i, i + 2));
          i += 2;
          continue;
        }
        if (source[i] === quote) { i += 1; break; }
        /**
         * ⚠️⚠️ **模板串的 `${…}` 插值里是真代码，不是字符串内容。**
         *
         * 原来这一整段（含插值）都被当字符串吃掉，`keepStrings: false` 时整段擦除
         * ⇒ `` `${chrome.runtime.id}` `` 会被判「没引用 chrome」，**静默放行**。
         * 实测（修之前）：
         *   `const id = \`${chrome.runtime.id}\`;` → 剥后 `const id = \`\`;` → 命中 false
         *   对照 `const p = chrome.storage;`              → 命中 true
         *
         * ⚠️ **只处理模板串**：普通引号里没有插值。⚠️ **插值要递归扫**（里面可能还有
         * 字符串、注释、嵌套模板串）⇒ 调 `scanSource` 自己，而不是手写一层括号配对。
         */
        if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
          const exprStart = i + 2;
          let j = exprStart;
          let depth = 1;
          while (j < length && depth > 0) {
            if (source[j] === '{') depth += 1;
            else if (source[j] === '}') depth -= 1;
            if (depth === 0) break;
            j += 1;
          }
          const expr = source.slice(exprStart, j);
          // 插值按代码处理，**不受 `keepStrings` 影响**。
          inner.push(`\${${scanSource(expr, options)}}`);
          i = j + 1;
          continue;
        }
        // ⚠️ **字面部分只在 `keepStrings` 时保留** —— 否则文案里的 `chrome.` 会假红。
        if (options.keepStrings) inner.push(source[i] as string);
        i += 1;
      }
      if (options.keepStrings) {
        out.push(source.slice(start, i));
      } else {
        out.push(`${quote}${inner.join('')}${quote}`);
      }
      continue;
    }

    out.push(char);
    i += 1;
  }

  return out.join('');
}

/** 去掉注释、**保留**字符串 —— 用来扫 import 与「from '…i18n/resources'」这类形状。 */
function stripComments(source: string): string {
  return scanSource(source, { keepStrings: true });
}

/** 去掉注释**和**字符串内容 —— 用来判「这段代码真的引用 chrome 了吗」。 */
function stripStringsAndComments(source: string): string {
  return scanSource(source, { keepStrings: false });
}

const FORBIDDEN_PATTERNS: readonly {
  label: string;
  pattern: RegExp;
  /** `true` = 先抹掉字符串再判（引用类）；`false` = 保留字符串（import 形状类）。 */
  codeOnly: boolean;
}[] = [
  {
    label: 'chrome API',
    // ⚠️ **三种形态都算**：`chrome.storage` / `chrome?.storage` / `chrome['storage']`。
    // 只写 `chrome\s*\.` 会漏掉后两种 —— 而可选链正是「防御式取值」时最自然的写法。
    pattern: /\bchrome\s*(?:\?\.|\.|\[)/,
    codeOnly: true,
  },
  { label: 'i18n 资源', pattern: /from\s+['"][^'"]*i18n\/resources/, codeOnly: false },
  { label: 'i18n 模块', pattern: /from\s+['"](?:\.\.\/)+i18n(?:['"]|\/)/, codeOnly: false },
];

/**
 * 从入口出发，收集全部 import 的传递闭包（含入口自身）。
 *
 * ⚠️⚠️ **四种写法都要认**（只认 `from '…'` 会漏掉一半）：
 * ① `import x from './a'` / `import { x } from './a'`
 * ② **副作用导入** `import './a'`（没有 `from`）
 * ③ `export { x } from './a'` / `export * from './a'`
 * ④ `export * as ns from './a'`
 *
 * ⚠️⚠️ **别名（`@/` `~/` `@@/` `~~/`）必须解析，不能当「不属于本闭包」跳过** ——
 * `tsconfig` 把它们都映射到仓库根（`.wxt/tsconfig.json` 的 `paths`），
 * 所以 `@/core/memory/store` 就是 `core/memory/store`。**跳过等于给这条守卫留后门**：
 * 主世界一旦接一条别名导入到带 chrome 的模块，闭包里看不到它、守卫静默放行
 * （2026-11-03 实测：注入 `import { getAllMemories } from '@/core/memory/store'`
 * 到入口，旧版守卫**全绿**）。
 */
const TS_PATH_ALIASES: readonly { prefix: string; replacement: string }[] = [
  { prefix: '@@/', replacement: '' },
  { prefix: '~~/', replacement: '' },
  { prefix: '@/', replacement: '' },
  { prefix: '~/', replacement: '' },
];

/** 这条 specifier 是不是「本仓库内、必须跟进」的那一类（相对 或 别名）。 */
function isRepoLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith('.')
    || TS_PATH_ALIASES.some((alias) => specifier.startsWith(alias.prefix));
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let target: string;
  if (specifier.startsWith('.')) {
    target = resolve(dirname(fromFile), specifier);
  } else {
    const alias = TS_PATH_ALIASES.find((item) => specifier.startsWith(item.prefix));
    if (!alias) return null; // 裸包名（`node:fs` / 第三方）—— 不属于本闭包。
    target = resolve(alias.replacement, specifier.slice(alias.prefix.length));
  }

  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    resolve(target, 'index.ts'),
    resolve(target, 'index.tsx'),
  ];
  // ⚠️ **目录本身不算命中** —— 否则 `resolveSpecifier('.')` 会返回一个目录，
  // 后面 `readFileSync` 直接抛 EISDIR。
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

const IMPORT_PATTERNS: readonly RegExp[] = [
  /from\s+['"]([^'"]+)['"]/g,   // import … from / export … from
  /import\s+['"]([^'"]+)['"]/g, // 副作用导入
];

interface ClosureResult {
  files: string[];
  /**
   * 看着像本地 / 别名、但解析不出来的 specifier。
   *
   * ⚠️ **这类必须报出来，不能静默跳过** —— 解析不出来意味着那个模块**不在闭包里**，
   * 后面两条对它完全失明。这正是 B1 的成因。
   */
  unresolved: { from: string; specifier: string }[];
}

function importClosure(entry: string): ClosureResult {
  const seen = new Set<string>();
  const unresolved: ClosureResult['unresolved'] = [];
  const stack = [resolve(entry)];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const pattern of IMPORT_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1] as string;
        const target = resolveSpecifier(file, specifier);
        if (target) {
          stack.push(target);
        } else if (isRepoLocalSpecifier(specifier)) {
          unresolved.push({ from: file, specifier });
        }
      }
    }
  }
  return { files: [...seen], unresolved };
}

/**
 * ⚠️⚠️ **这一组用自带夹具直接测三个判据函数** —— 上面那组跑的是真实闭包，
 * 它的判别力取决于「生产代码此刻长什么样」；这三条不依赖那个前提。
 * 每个夹具都对应一次实测出来的盲区（2026-11-03），撤掉修法会立刻红。
 */
describe('boundary scanner: the three blind spots', () => {
  it('B1 · resolves the tsconfig path aliases instead of skipping them', () => {
    // `@/` `~/` `@@/` `~~/` 在 `.wxt/tsconfig.json` 里都映射到仓库根。
    // ⚠️ 旧实现把它们当「不属于本闭包」直接跳过 ⇒ 主世界接一条别名导入到带 chrome 的
    // 模块时，那个模块根本不在闭包里，守卫静默放行（实测全绿）。
    expect(isRepoLocalSpecifier('@/core/memory/store')).toBe(true);
    expect(isRepoLocalSpecifier('~/core/memory/store')).toBe(true);
    expect(isRepoLocalSpecifier('@@/core/memory/store')).toBe(true);
    expect(isRepoLocalSpecifier('~~/core/memory/store')).toBe(true);
    expect(isRepoLocalSpecifier('./sibling')).toBe(true);
    // 裸包名不属于本闭包 —— 不能因为解析失败就报。
    expect(isRepoLocalSpecifier('node:fs')).toBe(false);
    expect(isRepoLocalSpecifier('vitest')).toBe(false);

    const entry = resolve(ENTRY);
    const aliased = resolveSpecifier(entry, '@/core/memory/store');
    expect(aliased, '别名必须解析到真实文件').not.toBeNull();
    expect(aliased!.endsWith('store.ts') || aliased!.endsWith('store/index.ts')).toBe(true);
  });

  it('B2 · catches optional-chained and bracket-accessed chrome', () => {
    // ⚠️ 旧的正则 `\bchrome\s*\.` 只认 `chrome.storage`；可选链与下标访问都漏。
    const chromePattern = FORBIDDEN_PATTERNS.find((item) => item.label === 'chrome API')!.pattern;
    for (const form of ['chrome.storage', 'chrome?.storage', "chrome['storage']", 'chrome?.["x"]']) {
      expect(chromePattern.test(form), `${form} 必须命中`).toBe(true);
    }
  });

  it('B3 · does not treat // inside a template literal as a comment start', () => {
    // ⚠️⚠️ 按行剥注释会把模板串里 `//` 之后的**整行真代码**一起删掉 ⇒ 漏报。
    // 夹具：模板串先出现，真 chrome 引用在它后面、同一行。
    const source = "const url = `https://cdn//x`; const probe = () => chrome.storage.local.get('k');";
    const code = stripStringsAndComments(source);
    expect(
      FORBIDDEN_PATTERNS.find((item) => item.label === 'chrome API')!.pattern.test(code),
      '模板串里的 // 之后仍有 chrome 引用，必须命中',
    ).toBe(true);
  });

  it('B3 · still ignores chrome mentioned in comments and in string literals', () => {
    // 反向：注释与字符串里的 `chrome.` 都不是引用，不能假红。
    const source = [
      '// 主世界没有 chrome.storage',
      "const message = 'chrome.runtime.lastError is not available here';",
      'const value = 1;',
    ].join('\n');
    const code = stripStringsAndComments(source);
    expect(FORBIDDEN_PATTERNS.find((item) => item.label === 'chrome API')!.pattern.test(code)).toBe(false);
  });

  it('B4 · sees chrome referenced inside a template interpolation', () => {
    // ⚠️⚠️ **插值里是真代码，不是字符串内容。**
    // 原来整段（含 `${…}`）被当字符串吃掉，`keepStrings: false` 时整段擦除 ⇒
    // `` `${chrome.runtime.id}` `` 判「没引用 chrome」，静默放行。
    // 实测（修之前）：命中=false，剥后剩下 `` const id = ``; ``
    const chromePattern = FORBIDDEN_PATTERNS.find((item) => item.label === 'chrome API')!.pattern;
    const cases = [
      'const id = `${chrome.runtime.id}`;',
      'const k = `zai:${chrome.storage.local}`;',
      // 嵌套：插值里还有一层模板串，那层里再引用
      'const deep = `${ `inner ${chrome.runtime.id}` }`;',
      // 插值里还有普通字符串 —— 那个字符串里的 chrome 仍然不算引用
      'const mixed = `a${"chrome.storage"}${chrome.runtime.id}`;',
    ];
    for (const source of cases) {
      const code = stripStringsAndComments(source);
      expect(chromePattern.test(code), `${source} 必须命中`).toBe(true);
    }
  });

  it('B4 · still ignores chrome that only appears in the surrounding literal text', () => {
    // 反向：模板串的**字面部分**里的 `chrome.` 不是引用，不能假红。
    // 与上一条成对 —— 少了这条，把整个模板串原样留下也能通过（那就等于不剥字符串了）。
    const chromePattern = FORBIDDEN_PATTERNS.find((item) => item.label === 'chrome API')!.pattern;
    const source = 'const hint = `主世界里没有 chrome.storage`;';
    expect(chromePattern.test(stripStringsAndComments(source))).toBe(false);
  });
});

describe('main-world import boundary', () => {
  it('reaches the modules it is supposed to reach (the closure is not empty)', () => {
    // 反面自检：闭包为空或漏了关键模块时，下面的断言都在验空气。
    const { files } = importClosure(ENTRY);
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((file) => file.endsWith('fetch-hook.ts'))).toBe(true);
  });

  it('resolves every relative and aliased import (no silent gaps in the closure)', () => {
    // ⚠️⚠️ **这是 B1 的判据** —— 别名 / 相对 specifier 解析不出来时，那个模块就
    // **不在闭包里**，后面两条对它完全失明。旧版把别名当「不属于本闭包」直接跳过，
    // 于是 `import { x } from '@/core/memory/store'` 加进主世界也能全绿。
    const { unresolved } = importClosure(ENTRY);
    expect(
      unresolved.map(({ from, specifier }) => `${specifier} (from ${from.replace(process.cwd(), '')})`),
    ).toEqual([]);
  });

  it('never pulls chrome APIs into the page main world', () => {
    for (const file of importClosure(ENTRY).files) {
      const source = readFileSync(file, 'utf8');
      for (const { label, pattern, codeOnly } of FORBIDDEN_PATTERNS) {
        const code = codeOnly ? stripStringsAndComments(source) : stripComments(source);
        expect(pattern.test(code), `${file} 在主世界闭包里引入了 ${label}`).toBe(false);
      }
    }
  });

  it('never pulls i18n resources into the page main world', () => {
    // ⚠️ 与上一条分开写：`chrome` 那一类将来可能有正当例外，而 i18n 资源链是
    // **纯体积 + 纯副作用**，没有任何正当理由进主世界。
    for (const file of importClosure(ENTRY).files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      expect(/i18n\/resources/.test(code), `${file} 引入了 i18n 资源`).toBe(false);
    }
  });
});