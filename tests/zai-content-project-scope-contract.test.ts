import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';

const CONTENT_SOURCE = 'entrypoints/zai.content.ts';

/**
 * 项目上下文（`projectId` / `projectContext`）**必须只由调用方显式传入**，
 * 不能有模块级兜底。
 *
 * 有兜底时，「调用方明确传 `null`」与「调用方没传」在 `??` 下是同一件事 ——
 * 首条建会话（`/chats/new`）传的 `null` 会被吃掉、回落到上一个会话所在的项目，
 * 于是新会话继承了不属于它的项目指令与项目记忆。表现是静默的：请求照发、不报错。
 *
 * 三条各守一段：
 * - 第 1 条守「模块级状态不存在」（`currentProjectId` 这类换名也拦得住）；
 * - 第 2 条守「函数内的兜底只剩 `null` 一级」—— 出现第二级就是又读回了模块状态；
 * - 第 3 条守「调用点都显式传值」—— 这是前两条的前提，删掉兜底之所以安全，
 *   全靠两个调用点各自拿得到正确的源（首条读待绑项目、completion 读会话归属）。
 */
const PROJECT_SCOPE_SUFFIX = /[Pp]roject(Id|Context)$/;

function readContentProgram(): t.Program {
  return parseTypeScriptSource(CONTENT_SOURCE, readFileSync(CONTENT_SOURCE, 'utf8'));
}

function findFunctionDeclaration(program: t.Program, name: string): t.FunctionDeclaration {
  let found: t.FunctionDeclaration | undefined;
  walkSourceAst(program, (node) => {
    if (t.isFunctionDeclaration(node) && node.id?.name === name) found = node;
  });
  if (!found) throw new Error(`${name} not found in ${CONTENT_SOURCE}`);
  return found;
}

/** 断言 + 收窄：`expect` 不参与类型收窄，所以显式收一次。 */
function asLogicalExpression(node: t.Node | null | undefined, label: string): t.LogicalExpression {
  expect(t.isLogicalExpression(node), label).toBe(true);
  if (!t.isLogicalExpression(node)) throw new Error(`${label} is not a logical expression`);
  return node;
}

function asOptionalMemberExpression(
  node: t.Node | null | undefined,
  label: string,
): t.OptionalMemberExpression {
  expect(t.isOptionalMemberExpression(node), label).toBe(true);
  if (!t.isOptionalMemberExpression(node)) throw new Error(`${label} is not an optional member`);
  return node;
}

describe('content script project scope contract', () => {
  it('keeps no module-level project scope state', () => {
    const offenders: string[] = [];

    for (const statement of readContentProgram().body) {
      if (!t.isVariableDeclaration(statement)) continue;
      for (const declarator of statement.declarations) {
        if (t.isIdentifier(declarator.id) && PROJECT_SCOPE_SUFFIX.test(declarator.id.name)) {
          offenders.push(declarator.id.name);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('resolves project scope from options with no module-level fallback', () => {
    const declaration = findFunctionDeclaration(readContentProgram(), 'augmentPrompt');
    const initializers = new Map<string, t.Expression | null | undefined>();

    walkSourceAst(declaration, (node) => {
      if (!t.isVariableDeclarator(node) || !t.isIdentifier(node.id)) return;
      if (PROJECT_SCOPE_SUFFIX.test(node.id.name)) initializers.set(node.id.name, node.init);
    });

    expect([...initializers.keys()].sort()).toEqual(['projectContext', 'projectId']);

    for (const [name, init] of initializers) {
      const fallback = asLogicalExpression(init, name);
      expect(fallback.operator, name).toBe('??');
      // 兜底只有 `null` 一级：右边一旦是标识符，就是又读回了模块级状态。
      expect(t.isNullLiteral(fallback.right), name).toBe(true);
      const source = asOptionalMemberExpression(fallback.left, name);
      expect(t.isIdentifier(source.object, { name: 'options' }), name).toBe(true);
    }
  });

  it('passes project scope explicitly at every augmentPrompt call site', () => {
    const calls: t.CallExpression[] = [];
    walkSourceAst(readContentProgram(), (node) => {
      if (
        t.isCallExpression(node)
        && t.isIdentifier(node.callee)
        && node.callee.name === 'augmentPrompt'
      ) {
        calls.push(node);
      }
    });

    // 两个调用点：首条建会话与 completion。新增调用点而漏传，会让它回落到 `undefined`，
    // 即「没有项目上下文」—— 与「明确没有项目」在此处等价，但会静默丢掉该有的项目归属。
    expect(calls).toHaveLength(2);

    for (const call of calls) {
      const [, options] = call.arguments;
      expect(t.isObjectExpression(options)).toBe(true);
      if (!t.isObjectExpression(options)) continue;
      const keys = options.properties
        .filter((property): property is t.ObjectProperty => t.isObjectProperty(property))
        .map((property) => (t.isIdentifier(property.key) ? property.key.name : null));
      expect(keys).toContain('projectId');
      expect(keys).toContain('projectContext');
    }
  });
});
