import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';

const CONTENT_SOURCE = 'entrypoints/zai.content.ts';

/**
 * 本地 Skill 目录（`activeLocalSkillDir`）**必须从激活结果一路走到授权请求体**。
 *
 * 这条链的四段，任何一段断掉都是**静默**的：
 *
 * ① 内容脚本算出 `activeLocalSkillDir`（`resolveActiveLocalSkill`）；
 * ② **建授权时把它上报**（`CREATE_TOOL_AUTHORIZATION` 的 `localSkillDir`）；
 * ③ 后台校验它确实属于某个已导入本地 Skill，写进 grant；
 * ④ 执行期 `getGrantLocalSkillDir` → `enforceLocalSkillCwd` 把 `shell_exec` /
 *    `shell_session_begin` 的初始 cwd 归一到 Skill 目录。
 *
 * ②断掉的表现：提示词里那句「Run commands with the initial cwd set to the Skill directory
 * path」**照旧在**（它由 `buildLocalSkillSystemContext` 注入），所以模型仍被告知要去那个目录，
 * 只是**没有任何强制** —— 模型给错 cwd 就会在别处执行，不报错、测试全绿。
 *
 * ⚠️ **顺序也要守**：授权要 dir、增广要授权返回的 descriptors ⇒ 激活必须在建授权**之前**。
 * 顺序反过来只会得到一份没有 dir 的 grant，同样是静默的。
 *
 * ⚠️ **续跑轮不能重跑激活**：续跑 prompt 是模板（`<original_task>` + `<tool_results>`），
 * 不是用户输入 ⇒ `parseSkillCommand` 匹配不到、隐式打分也对不上，重跑必然得到 null。
 * 所以它必须复用启动该循环那一轮记下的目录（与 `isAgentTurn` / `nativeSearchOn` 同一类状态）。
 */
function readContentProgram(): t.Program {
  return parseTypeScriptSource(CONTENT_SOURCE, readFileSync(CONTENT_SOURCE, 'utf8'));
}

function findFunction(program: t.Program, name: string): t.FunctionDeclaration {
  let found: t.FunctionDeclaration | undefined;
  walkSourceAst(program, (node) => {
    if (t.isFunctionDeclaration(node) && node.id?.name === name) found = node;
  });
  expect(found, `应当存在 ${name}`).toBeDefined();
  return found!;
}

/** 收集某函数体内所有 `name(...)` 的调用点。 */
function callsIn(body: t.Node, name: string): t.CallExpression[] {
  const found: t.CallExpression[] = [];
  walkSourceAst(body, (node) => {
    if (t.isCallExpression(node) && t.isIdentifier(node.callee) && node.callee.name === name) {
      found.push(node);
    }
  });
  return found;
}

/** 取调用点第一参（对象字面量）里某个键的**值节点**。 */
function argumentValue(call: t.CallExpression, key: string): t.Node | undefined {
  const options = call.arguments[0];
  if (!t.isObjectExpression(options)) return undefined;
  for (const property of options.properties) {
    if (!t.isObjectProperty(property)) continue;
    if (t.isIdentifier(property.key) && property.key.name === key) return property.value;
  }
  return undefined;
}

/**
 * 剥掉包裹层：`??` / `as` / 括号。
 * ⚠️ 必须剥 —— 生产代码写的是 `continuationLoop?.localSkillDir ?? undefined`
 * 与 `localSkillDirByRequestId.get(id) ?? null`，不剥就永远拿不到内层节点（假红）。
 */
function unwrap(node: t.Node | undefined): t.Node | undefined {
  let current = node;
  while (current) {
    if (t.isLogicalExpression(current)) {
      current = current.left;
      continue;
    }
    if (t.isTSAsExpression(current) || t.isTSNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (t.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
  return current;
}

/**
 * 取 `X.<property>` 形态的根标识符名（含可选链 `X?.<property>`）。
 * 支持 `X.a.b.<property>` —— 根仍是 `X`。
 */
function memberRoot(node: t.Node | undefined, property: string): string | null {
  let current = unwrap(node);
  if (!current) return null;
  if (!t.isMemberExpression(current) && !t.isOptionalMemberExpression(current)) return null;
  if (!t.isIdentifier(current.property) || current.property.name !== property) return null;
  let object: t.Node = current.object;
  while (t.isMemberExpression(object) || t.isOptionalMemberExpression(object)) object = object.object;
  return t.isIdentifier(object) ? object.name : null;
}

describe('local skill dir reaches the tool authorization', () => {
  it('resolves the active local skill before creating the authorization', () => {
    // ⚠️ 判据是**源码位置**（授权要 dir、增广要授权返回的 descriptors ⇒ 顺序不可换），
    // 不是「这些字符串出现过」—— 后者把两步对调也照样为真。
    const program = readContentProgram();
    const handler = findFunction(program, 'handleAugmentRequestBody');
    const start = handler.start ?? 0;
    const end = handler.end ?? 0;
    const body = readFileSync(CONTENT_SOURCE, 'utf8').slice(start, end);

    const resolveIndex = body.indexOf('resolveActiveLocalSkill(');
    expect(resolveIndex, '应当调用 resolveActiveLocalSkill').toBeGreaterThanOrEqual(0);

    const createIndexes: number[] = [];
    let cursor = body.indexOf('createToolAuthorization({');
    while (cursor !== -1) {
      createIndexes.push(cursor);
      cursor = body.indexOf('createToolAuthorization({', cursor + 1);
    }
    expect(createIndexes.length, '应当有若干处建授权').toBeGreaterThanOrEqual(3);

    // 第一处建授权（chatNew）之前就必须已经算出激活结果。
    expect(createIndexes[0], 'resolveActiveLocalSkill 必须早于第一处建授权').toBeGreaterThan(resolveIndex);
  });

  it('passes the activated directory to every authorization it creates directly', () => {
    // ⚠️ 只断言**接线**：值必须是 `skillActivation.activeLocalSkillDir`，不能是别的来源
    // （写死字符串、从 body 抄、或干脆不传）。四类断言缺一条都有绕过路径：
    // ① 键存在；② 值是该成员访问；③ 根标识符绑定到 `resolveActiveLocalSkill` 的结果；
    // ④ 该根标识符在本文件里不是别的东西（它是 const 解构，不是模块状态）。
    const handler = findFunction(readContentProgram(), 'handleAugmentRequestBody');
    const calls = callsIn(handler, 'createToolAuthorization');
    expect(calls.length, '应当有若干处直接建授权').toBeGreaterThanOrEqual(3);

    // 续跑那处的 `localSkillDir` 刻意来自 continuationLoop（见下一条），先记下它。
    const fromLoop: number[] = [];
    const fromActivation: number[] = [];
    const other: string[] = [];
    for (const call of calls) {
      const value = argumentValue(call, 'localSkillDir');
      if (!value) {
        other.push('<缺 localSkillDir>');
        continue;
      }
      if (memberRoot(value, 'activeLocalSkillDir')) {
        fromActivation.push(call.loc?.start.line ?? -1);
        continue;
      }
      if (memberRoot(value, 'localSkillDir') === 'continuationLoop') {
        fromLoop.push(call.loc?.start.line ?? -1);
        continue;
      }
      other.push(`line ${call.loc?.start.line ?? -1}`);
    }

    // chatNew + completion 两处必须来自本轮激活结果；续跑一处来自循环状态。
    expect(fromActivation.length, 'chatNew / completion 两处应当上报本轮激活的目录').toBe(2);
    expect(fromLoop.length, '续跑轮应当复用循环上记下的目录').toBe(1);
    expect(other, `这些建授权调用点的 localSkillDir 来源不对：${other.join(', ')}`).toEqual([]);
  });

  it('binds the activation result to a variable that comes from resolveActiveLocalSkill', () => {
    // ⚠️ 上一条只断言「值是 `X.activeLocalSkillDir`」—— 若把 `X` 换成模块状态
    // （例如新加一个 `let currentLocalSkillDir`），断言照样为真。这里钉住那个根标识符
    // **必须是 `resolveActiveLocalSkill(...)` 的返回值**。
    const handler = findFunction(readContentProgram(), 'handleAugmentRequestBody');
    const calls = callsIn(handler, 'createToolAuthorization');

    const roots = new Set<string>();
    for (const call of calls) {
      const root = memberRoot(argumentValue(call, 'localSkillDir'), 'activeLocalSkillDir');
      if (root) roots.add(root);
    }
    expect(roots.size, '应当有一个承载激活结果的变量').toBeGreaterThan(0);

    // 这些根标识符必须绑定到 `resolveActiveLocalSkill(...)` 的调用结果。
    const boundToActivation = new Set<string>();
    walkSourceAst(handler, (node) => {
      if (!t.isVariableDeclarator(node) || !node.init) return;
      const init = t.isAwaitExpression(node.init) ? node.init.argument : node.init;
      if (!t.isCallExpression(init) || !t.isIdentifier(init.callee)) return;
      if (init.callee.name !== 'resolveActiveLocalSkill') return;
      if (t.isIdentifier(node.id)) boundToActivation.add(node.id.name);
    });
    expect(boundToActivation.size, '应当把激活结果绑到变量上').toBeGreaterThan(0);

    for (const root of roots) {
      expect(
        boundToActivation.has(root),
        `localSkillDir 的载体 ${root} 必须来自 resolveActiveLocalSkill 的返回值，不能是模块状态`,
      ).toBe(true);
    }
  });

  it('carries the directory into the continuation loop and reuses it on continuation turns', () => {
    // 续跑 prompt 是模板 ⇒ 重跑激活必然得到 null。所以启动循环时要把它记到 loop 上。
    const program = readContentProgram();
    const handler = findFunction(program, 'handleResponseComplete');

    // ① 循环初始化里 `localSkillDir:` 的值必须是 `localSkillDirByRequestId.get(<本轮 requestId>)`
    //    —— 即「按启动该循环的那一轮取」，不是读某个模块级字符串。
    let loopInitValue: t.Node | undefined;
    walkSourceAst(handler, (node) => {
      if (!t.isObjectProperty(node)) return;
      if (!t.isIdentifier(node.key) || node.key.name !== 'localSkillDir') return;
      loopInitValue = node.value;
    });
    expect(loopInitValue, 'continuationLoop 初始化里应当带 localSkillDir').toBeDefined();

    const init = unwrap(loopInitValue);
    expect(t.isCallExpression(init), 'localSkillDir 应当由一次 .get(...) 取出').toBe(true);
    if (!t.isCallExpression(init)) throw new Error('unreachable');
    const callee = init.callee;
    expect(
      t.isMemberExpression(callee) && t.isIdentifier(callee.object) && t.isIdentifier(callee.property)
        && callee.object.name === 'localSkillDirByRequestId' && callee.property.name === 'get',
      'localSkillDir 必须按「启动该循环的那一轮」的 requestId 从 localSkillDirByRequestId 取',
    ).toBe(true);
    // 而且键必须是**本轮**的 requestId（`complete.requestId`），不是别的。
    const key = init.arguments[0];
    expect(
      memberRoot(key, 'requestId') !== null,
      'localSkillDir 的取值键必须是本轮的 requestId',
    ).toBe(true);

    // ② 续跑分支里不得重新跑一次激活。
    // ⚠️ 切片走 **AST 的 `start`/`end`**，不用注释字符串定位 —— 靠
    // `indexOf('// 先建授权（toolIntent')` 那种写法依赖一句注释存在，注释一动切片就静默错位
    // （第一版就是这样把 completion 段的调用圈了进来、判成假红）。
    // ⚠️ 判据也走 **AST 调用点**，不用 `source.includes(...)` —— 后者只要有人在这段里
    // 写一句提到 `resolveActiveLocalSkill(` 的注释就会假红（判据只会朝误报方向出错）。
    const handler2 = findFunction(program, 'handleAugmentRequestBody');
    let continuationBranch: t.IfStatement | undefined;
    walkSourceAst(handler2, (node) => {
      if (!t.isIfStatement(node)) return;
      const test = node.test;
      if (!t.isCallExpression(test) || !t.isIdentifier(test.callee)) return;
      if (test.callee.name !== 'isContinuationRequest') return;
      continuationBranch = node;
    });
    expect(continuationBranch, '应当有 `if (isContinuationRequest(...))` 分支').toBeDefined();
    const reactivations = callsIn(continuationBranch!, 'resolveActiveLocalSkill');
    expect(
      reactivations.length,
      '续跑分支不得重跑 Skill 激活（prompt 是模板，重跑必然拿到 null）',
    ).toBe(0);
  });

  it('releases the per-request directory map alongside the other request-scoped state', () => {
    // 漏了释放 ⇒ 按 requestId 无界增长，而不会有任何测试变红。
    const body = findFunction(readContentProgram(), 'releaseRequestState').body;
    let released = false;
    walkSourceAst(body, (node) => {
      if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
      if (t.isIdentifier(node.callee.object) && node.callee.object.name === 'localSkillDirByRequestId') {
        released = true;
      }
    });
    expect(released, 'localSkillDirByRequestId 必须在 releaseRequestState 里释放').toBe(true);
  });
});
