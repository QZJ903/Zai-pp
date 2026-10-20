import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { getLocaleStringKeys } from '../core/i18n';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';

/**
 * **`as LocaleMessageKey` 是 tsc 唯一的盲区，这里给它补一道运行时对账。**
 *
 * `LocaleMessageKey = StringLeafPaths<LocaleMessages>` 是模板字面量联合，所以
 * 「引用一个不存在的键」在 tsc 这一层**绝大多数情况都能抓到**（实测：
 * `t('sidepanel.toolsPage.webSearchName')`（该键已随整段 `toolsPage` 删除）会报 TS2345）。
 *
 * ⇒ **但那是「绝大多数」**：只要有人写一句 `as LocaleMessageKey`，类型断言就把这个
 * 检查关掉了 —— 而 `as` 恰恰只出现在**必须**用它的地方：动态拼接的键
 * （`` t(`${prefix}.ready`) ``）、以及从 `.ts` 资源推导不出字面量的位置。
 * 那几处正是「手滑删键 ⇒ 运行时抛 `Missing locale key`」的唯一可乘之机。
 *
 * ⚠️ **别指望 `tests/i18n.test.ts` 的 parity 兜住它** —— parity 比的是
 * **en 与 zh-CN 两份资源的键集合是否相等**，两边同时少一个键时它是绿的。
 * 而本用例比的是**代码里断言的键 vs 资源里真实存在的键**，两个方向不同。
 *
 * ⚠️ 已有先例：`McpPage.tsx` 的 `sidepanel.mcpPage.shellSetup.*`（6 个键）就是
 * 「动态拼 + `as`」，历史上删零引用 i18n 键时**差点被当成死键删掉**（`as` 会把
 * tsc 骗过去，`verify:i18n` 的方向也测不到），当时只能靠人工跑一段反向校验脚本。
 * 这条用例把那段脚本固化成守卫。
 *
 * ⚠️ **新写 `as LocaleMessageKey` 时不用改本文件** —— 它全量扫描源码，不是白名单。
 * 只有一种情况要改：出现了本文件解析不了的新写法（见 `resolveAssertedKey` 的返回值），
 * 那时它会以「无法静态解析」显式失败，而不是静默放过。
 */

const SCAN_ROOTS = ['core', 'entrypoints'] as const;

describe('i18n asserted keys exist in both locales', () => {
  it('every `as LocaleMessageKey` key resolves in zh-CN and en', () => {
    const locales = ['zh-CN', 'en'] as const;
    const available = new Map(locales.map((locale) => [locale, new Set(getLocaleStringKeys(locale))]));
    const asserted = collectAssertedKeys();

    // 反面自检：扫描本身必须是活的。一处 `as` 都收不到说明扫描器坏了
    // （而不是「代码里没有 as」）—— 那时下面的断言会全绿，属于假绿。
    expect(asserted.length, '没有扫到任何 `as LocaleMessageKey` —— 扫描器已失效').toBeGreaterThan(0);

    // ⚠️ **这一条必须排在「扫到了哪些」之前** —— 解析不出来的键永远不会出现在
    // 后面的比对里，先报它才拿得到有用的错误信息（否则只会看到「某键没扫到」）。
    const unresolved = asserted.filter((item) => item.key === null);
    expect(
      unresolved.map((item) => `${item.file}:${item.line}`),
      '这些 `as LocaleMessageKey` 的键无法静态解析 —— 请改成字面量，或让前缀仍是字符串字面量常量',
    ).toEqual([]);

    // 再钉一处**已知存在**的用例：它是「动态拼 + as」的典型形态，
    // 这条绿说明解析链（常量收集 → 模板拼接）确实在工作。
    expect(
      asserted.some((item) => item.key === 'sidepanel.mcpPage.shellSetup.ready'),
      '没解析出 `sidepanel.mcpPage.shellSetup.ready` —— 模板拼接那一段已失效',
    ).toBe(true);

    const missing: string[] = [];
    for (const item of asserted) {
      const key = item.key as string;
      for (const locale of locales) {
        if (!available.get(locale)!.has(key)) {
          missing.push(`${item.file}:${item.line} → ${key} (missing in ${locale})`);
        }
      }
    }
    expect(missing, `这些被断言的键在资源里不存在（运行时会抛 Missing locale key）：\n${missing.join('\n')}`)
      .toEqual([]);
  });
});

interface AssertedKey {
  file: string;
  line: number;
  /** 解析不出时是 `null`（会单独报错，不静默放过）。 */
  key: string | null;
}

function collectAssertedKeys(): AssertedKey[] {
  const found: AssertedKey[] = [];
  for (const file of listSourceFiles()) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('as LocaleMessageKey')) continue;
    const program = parseTypeScriptSource(file, source);
    // 同文件内的 `const X = 'literal'` —— 动态拼接的键都靠它。
    const constants = collectStringConstants(program);
    walkSourceAst(program, (node) => {
      if (!t.isTSAsExpression(node) && !t.isTSTypeAssertion(node)) return;
      if (!isLocaleMessageKeyType(node.typeAnnotation)) return;
      found.push({
        file,
        line: node.loc?.start.line ?? -1,
        key: resolveAssertedKey(node.expression, constants),
      });
    });
  }
  return found;
}

function isLocaleMessageKeyType(node: t.Node): boolean {
  return t.isTSTypeReference(node)
    && t.isIdentifier(node.typeName)
    && node.typeName.name === 'LocaleMessageKey';
}

/**
 * 把 `as LocaleMessageKey` 的操作数解析成完整的键。
 *
 * 只支持两种形态（当前的两种，且都是静态可判的）：
 * - 字符串字面量：`'a.b.c'`
 * - 模板字符串，且每个 `${}` 都能在同文件的 `const` 里找到**字符串字面量**初值
 *
 * 其余一律返回 `null` —— 由调用方显式报「无法静态解析」，**不静默放过**。
 */
function resolveAssertedKey(
  expression: t.Node,
  constants: ReadonlyMap<string, string | null>,
): string | null {
  if (t.isStringLiteral(expression)) return expression.value;
  if (!t.isTemplateLiteral(expression)) return null;
  if (expression.expressions.length !== expression.quasis.length - 1) return null;

  let result = '';
  for (let index = 0; index < expression.quasis.length; index += 1) {
    const quasi = expression.quasis[index];
    result += quasi.value.cooked ?? quasi.value.raw;
    if (index >= expression.expressions.length) continue;
    const placeholder = expression.expressions[index];
    if (!t.isIdentifier(placeholder)) return null;
    // `null` = 同名 const 绑到了不同值（歧义）⇒ 不猜。
    const value = constants.get(placeholder.name);
    if (value === undefined || value === null) return null;
    result += value;
  }
  return result;
}

/**
 * 文件里所有 `const X = 'literal'` 的字符串初值。
 *
 * ⚠️ **要扫全文件，不能只看 `program.body`** —— 动态拼 key 的前缀几乎都是**函数体内的
 * 局部 const**（实测 `McpPage.tsx` 的 `setupKey` 就在函数里），只看顶层会一个都收不到，
 * 于是那些键全被判成「无法静态解析」。
 * ⚠️ **同名绑到不同值 ⇒ 记为歧义（故意让它解析失败）**，不猜。
 */
function collectStringConstants(program: t.Program): Map<string, string | null> {
  const constants = new Map<string, string | null>();
  walkSourceAst(program, (node) => {
    if (!t.isVariableDeclarator(node) || !t.isIdentifier(node.id)) return;
    if (!t.isStringLiteral(node.init)) return;
    const name = node.id.name;
    const existing = constants.get(name);
    if (existing === undefined) {
      constants.set(name, node.init.value);
      return;
    }
    if (existing !== node.init.value) constants.set(name, null);
  });
  return constants;
}

function listSourceFiles(): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        visit(path);
        continue;
      }
      if (name.endsWith('.ts') || name.endsWith('.tsx')) files.push(path);
    }
  };
  for (const root of SCAN_ROOTS) visit(root);
  return files;
}