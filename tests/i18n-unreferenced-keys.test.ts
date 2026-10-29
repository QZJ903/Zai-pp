import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { getLocaleStringKeys } from '../core/i18n';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';

/**
 * **反方向**的 i18n 校验：资源里存在、但生产代码一个都没引用的键。
 *
 * ⚠️⚠️ **现有两道门禁都查不到这一档**：
 *  - `verify:i18n` 的 locale-check 比的是 zh 与 en 的**键集合是否相等**（两边同时少一个照样绿）；
 *  - `i18n-asserted-keys.test.ts` 查的是「代码引用的键在资源里**存不存在**」。
 * 两道都是「代码 → 资源」方向，**没有一道查「资源 → 代码」**。
 * ⇒ 删功能时留下的孤儿文案会一直攒着，而**没有任何东西会红**。
 *
 * **实测代价**：`common.remove` 跨了两次删功能都没被发现 —— 一次是清 45 个零引用键的批量清理，
 * 一次是删「项目」功能整链（它唯一的消费者 `ProjectsPage.tsx` 就在那次被删）。
 * 两次都动过 `common.ts`，两次都漏了它。**人肉列举不可靠，这条门禁就是为了替掉它。**
 *
 * ## 判据
 *
 * 一个键算「被引用」当且仅当它出现在**生产源码**的下面两种形态之一：
 *  ① 字符串字面量：`t('sidepanel.settings.title')`；
 *  ② 可静态求值的模板串：`t(`${setupKey}.ready`)`，其中 `setupKey` 在同文件里绑到字符串字面量。
 *
 * ⚠️⚠️ **`tests/` 不算引用** —— 「只有测试在断言这个键」说明生产侧已经没人用了
 * （实测有 `sidepanel.mcpPage.shellSetup.ready` 这种形态：生产侧靠模板串引用、测试里也写了一遍字面量，
 * 若把 `tests/` 算进来，生产侧那处真被删掉时这条门禁反而不会红）。
 *
 * ⚠️ **求值不出来的模板串不许静默放过** —— 若某个 `t(`…`)` 的模板串里含有非字符串常量的插值、
 * 且它的字面前缀落在 i18n 段名下（`sidepanel.` / `common.` …），就**显式失败**并要求改成可静态解析的写法。
 * 理由：静默放行等于给这条门禁开一个「谁都能绕过去」的口子，而绕过去的后果是
 * **它把一整个前缀下的键都判成零引用**（下一节说的假阳性反过来变成假阴性）。
 */

/** 资源段的顶层名 —— 用来识别「这条模板串是不是在拼 i18n 键」。 */
const LOCALE_SEGMENTS = ['sidepanel', 'app', 'common', 'content', 'prompt', 'tool', 'background'] as const;

const SCAN_ROOTS = ['core', 'entrypoints'] as const;
/** 资源文件自己不算「引用」—— 它们就是被查的那一侧。 */
const RESOURCE_PREFIX = join('core', 'i18n', 'resources');

describe('i18n keys are referenced by production code', () => {
  it('every locale key is used somewhere in core/ or entrypoints/', () => {
    const usage = collectKeyUsage();

    // ⚠️ **反面自检：扫描本身必须是活的。**
    // 一个文件都没扫到 / 一个键都没认出来时，下面的 `toEqual([])` 会**恒绿**，
    // 而那是「门禁坏了」而不是「没有零引用键」。这两条先于主断言，拿得到有用的错误信息。
    expect(usage.fileCount, '没扫到任何生产源文件 —— 扫描根目录写错了').toBeGreaterThan(200);
    expect(
      usage.referenced.has('common.save'),
      '没认出 `common.save` —— 字面量收集那一段已失效',
    ).toBe(true);

    // ⚠️ **求值不出来的 i18n 形态模板串要显式失败，不能当「前缀」放行。**
    expect(
      usage.opaqueI18nPrefixes,
      '这些 `t(`…`)` 的模板串无法静态求值，且字面前缀落在 i18n 段名下。'
        + '请把前缀改成字符串字面量常量（同文件 `const X = \'sidepanel.…\'`），'
        + '否则本门禁无法判断该前缀下的键有没有人用：',
    ).toEqual([]);

    const unreferenced = getLocaleStringKeys('zh-CN')
      .filter((key) => !usage.referenced.has(key))
      .sort();

    expect(
      unreferenced,
      '这些文案键在资源里存在、但 core/ 与 entrypoints/ 里一个引用都没有。'
        + '它们要么是删功能时漏清的孤儿，要么是本该接上却没接上的文案 —— '
        + '两种情况都要处置，不能留着：',
    ).toEqual([]);
  });
});

interface KeyUsage {
  /** 生产源码里能静态确定的全部字符串（含求值成功的模板串）。 */
  referenced: Set<string>;
  /** 求值失败、且字面前缀像 i18n 键的模板串（应当为空）。 */
  opaqueI18nPrefixes: string[];
  fileCount: number;
}

function collectKeyUsage(): KeyUsage {
  const referenced = new Set<string>();
  const opaqueI18nPrefixes: string[] = [];
  let fileCount = 0;

  for (const file of listProductionSourceFiles()) {
    fileCount += 1;
    const source = readFileSync(file, 'utf8');
    // 快速跳过：既没有引号也没有反引号的文件不可能贡献任何键。
    if (!source.includes("'") && !source.includes('"') && !source.includes('`')) continue;

    const program = parseTypeScriptSource(file, source);
    // ⚠️ **常量表按文件建**：动态拼 key 的前缀几乎都是函数体内的局部 const，
    // 跨文件共享同名常量会把两处不同的值混成一个。
    const constants = collectStringConstants(program);

    walkSourceAst(program, (node) => {
      if (t.isStringLiteral(node)) {
        referenced.add(node.value);
        return;
      }
      if (!t.isTemplateLiteral(node)) return;
      const resolved = resolveTemplateLiteral(node, constants);
      if (resolved !== null) {
        referenced.add(resolved);
        return;
      }
      const literalHead = node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? '';
      if (isLocaleShaped(literalHead)) {
        opaqueI18nPrefixes.push(`${file}: ${JSON.stringify(literalHead)}…`);
      }
    });
  }

  return { referenced, opaqueI18nPrefixes, fileCount };
}

/** 字面前缀是不是 i18n 键的形态（`sidepanel.` / `common.` …）。 */
function isLocaleShaped(value: string): boolean {
  return LOCALE_SEGMENTS.some((segment) => value.startsWith(`${segment}.`));
}

/**
 * 把一个模板串求值成字符串；**任何一个插值求不出来就返回 `null`**（不猜）。
 *
 * 与 `i18n-asserted-keys.test.ts` 的 `resolveAssertedKey` 是同一条判据，
 * 但那一处只认 `as LocaleMessageKey` 的形态，**普通 `t('literal')` 与不带断言的模板串它都不收** ——
 * 本门禁要覆盖的是「资源里的键有没有人用」，所以得把两种形态都算上。
 */
function resolveTemplateLiteral(
  node: t.TemplateLiteral,
  constants: ReadonlyMap<string, string | null>,
): string | null {
  if (node.expressions.length !== node.quasis.length - 1) return null;
  let result = '';
  for (let index = 0; index < node.quasis.length; index += 1) {
    result += node.quasis[index].value.cooked ?? node.quasis[index].value.raw;
    if (index >= node.expressions.length) continue;
    const placeholder = node.expressions[index];
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
 * ⚠️ **必须扫全文件，不能只看 `program.body`** —— 动态拼 key 的前缀几乎都是函数体内的局部 const
 * （`McpPage.tsx` 的 `setupKey` 就在函数里），只看顶层会一个都收不到。
 * ⚠️ **同名绑到不同值 ⇒ 记为歧义（故意让它求值失败）**，不猜。
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

function listProductionSourceFiles(): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        // 资源目录是被查的那一侧，不是引用方。
        // ⚠️ **归一成 `/` 再比** —— `join` 在 Windows 上给出反斜杠，而模板里拼的是正斜杠
        // ⇒ 不归一的话 `startsWith` 恒 false（`path === RESOURCE_PREFIX` 那条还能兜住，
        // 但只兜第一层；将来从更深处起遍历就静默失效）。
        if (toPosixPath(path) === toPosixPath(RESOURCE_PREFIX)) continue;
        if (toPosixPath(path).startsWith(`${toPosixPath(RESOURCE_PREFIX)}/`)) continue;
        visit(path);
        continue;
      }
      if (name.endsWith('.ts') || name.endsWith('.tsx')) files.push(path);
    }
  };
  for (const root of SCAN_ROOTS) visit(root);
  return files;
}

/** 把 Windows 反斜杠归一成正斜杠，路径比较前一律先过它。 */
function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}
