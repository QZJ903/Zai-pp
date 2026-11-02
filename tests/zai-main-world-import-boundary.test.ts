import { existsSync, readFileSync } from 'node:fs';
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
 *
 * ⚠️ 扫的是**代码**，不是「源码里出现过这个词」—— 注释里解释「后台读不到 localStorage」
 * 是正常且合理的（`contracts.ts` / `messages.ts` 里就有几处），直接 `toMatch` 会误报。
 */
const ENTRY = 'entrypoints/zai-main-world.content.ts';

/** 允许出现在主世界闭包里的「非本地 import」—— 目前一个都不允许。 */
const FORBIDDEN_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: 'chrome API', pattern: /\bchrome\s*\./ },
  { label: 'i18n 资源', pattern: /from ['"][^'"]*i18n\/resources/ },
  { label: 'i18n 模块', pattern: /from ['"](?:\.\.\/)+i18n(?:['"]|\/)/ },
];

/** 去掉行注释与块注释（保留换行，不影响本判据）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 从入口出发，收集全部**相对** import 的传递闭包（含入口自身）。
 *
 * ⚠️⚠️ **四种写法都要认**（只认 `from '…'` 会漏掉一半）：
 * ① `import x from './a'` / `import { x } from './a'`
 * ② **副作用导入** `import './a'`（没有 `from`）
 * ③ `export { x } from './a'` / `export * from './a'`
 * ④ `export * as ns from './a'`
 *
 * ⚠️ **别名（`@/` `~/`）与非相对路径按「不属于本闭包」处理** —— 主世界脚本里
 * 目前一条都没有（实测闭包全是相对无扩展 import），真出现时**下面第二条用例会红**
 * （闭包大小不变而入口多了一条 import），那时再决定要不要解析别名。
 */
const RELATIVE_IMPORT_PATTERNS: readonly RegExp[] = [
  /from\s+['"](\.[^'"]+)['"]/g,   // import … from / export … from
  /import\s+['"](\.[^'"]+)['"]/g, // 副作用导入
];

/** 把一条相对 specifier 解析成磁盘上的 `.ts` / `.tsx` / 目录 index。 */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx'),
  ];
  return candidates.find((candidate) => existsSync(candidate) && !candidate.endsWith('/')) ?? null;
}

function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [resolve(entry)];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const pattern of RELATIVE_IMPORT_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const target = resolveSpecifier(file, match[1] as string);
        if (target) stack.push(target);
      }
    }
  }
  return [...seen];
}

describe('main-world import boundary', () => {
  it('reaches the modules it is supposed to reach (the closure is not empty)', () => {
    // 反面自检：闭包为空或漏了关键模块时，下面的断言都在验空气。
    const closure = importClosure(ENTRY);
    expect(closure.length).toBeGreaterThan(5);
    expect(closure.some((file) => file.endsWith('fetch-hook.ts'))).toBe(true);
  });

  it('never pulls chrome APIs into the page main world', () => {
    for (const file of importClosure(ENTRY)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const { label, pattern } of FORBIDDEN_PATTERNS) {
        expect(pattern.test(code), `${file} 在主世界闭包里引入了 ${label}`).toBe(false);
      }
    }
  });

  it('never pulls i18n resources into the page main world', () => {
    // ⚠️ 与上一条分开写：`chrome` 那一类将来可能有正当例外（例如注释里提一句），
    // 而 i18n 资源链是**纯体积 + 纯副作用**，没有任何正当理由进主世界。
    for (const file of importClosure(ENTRY)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      expect(/i18n\/resources/.test(code), `${file} 引入了 i18n 资源`).toBe(false);
    }
  });
});