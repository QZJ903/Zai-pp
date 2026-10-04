import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';

const FETCH_HOOK_SOURCE = 'core/zai/fetch-hook.ts';
const MAIN_WORLD_SOURCE = 'entrypoints/zai-main-world.content.ts';

/**
 * 主世界**识别工具 XML 标签**时用的名单，必须是「本请求注入提示词的那一份」，
 * 而不是全局 `hookState.toolDescriptorNames`（「最后一次同步」）。
 *
 * **为什么**：隔离世界在建授权时从后台拿到**实时**的工具目录（`auth.descriptors`），
 * 并把它随增广结果回传（`ZaiRequestBodyModification.toolDescriptorNames`）。主世界若忽略它、
 * 改用全局快照，用户刚加 MCP 工具、`TOOL_DESCRIPTORS_UPDATED` 广播还没落地时两者会分叉
 * —— 提示词列了 A、识别器不认 A，模型调它**静默不执行**（不报错、不失败）。
 *
 * ⚠️ **全局快照只作「未增广请求」的兜底**（增广失败时主世界放行原始 body，拿不到本请求名单）。
 *
 * ⚠️ 这些是**源码级接线断言**：`extractAndNotifyToolCalls` 是 fetch-hook 的私有函数、
 * 装上 hook 才能跑，行为测试代价过高；而「删掉本请求名单的优先级」这种缺陷**不会让任何
 * 行为测试变红**（实测过）。所以按本仓既有风格用 AST 钉住接线。
 */
function readFetchHookProgram(): t.Program {
  return parseTypeScriptSource(FETCH_HOOK_SOURCE, readFileSync(FETCH_HOOK_SOURCE, 'utf8'));
}

function findFunctionBody(program: t.Program, name: string): t.BlockStatement | undefined {
  let body: t.BlockStatement | undefined;
  walkSourceAst(program, (node) => {
    if (t.isFunctionDeclaration(node) && node.id?.name === name) body = node.body;
  });
  return body;
}

describe('tool tag recognition prefers the per-request descriptor names', () => {
  it('extractAndNotifyToolCalls takes a requestToolNames parameter', () => {
    const body = findFunctionBody(readFetchHookProgram(), 'extractAndNotifyToolCalls');
    expect(body, '应当存在 extractAndNotifyToolCalls').toBeDefined();
    // 函数签名要有第三个参数（`requestToolNames`）。
    const program = readFetchHookProgram();
    let paramCount = -1;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'extractAndNotifyToolCalls') {
        paramCount = node.params.length;
      }
    });
    expect(paramCount, 'extractAndNotifyToolCalls 必须接收本请求的工具名单（第三个参数）').toBeGreaterThanOrEqual(3);
  });

  it('derives `names` from requestToolNames first, falling back to hookState', () => {
    const body = findFunctionBody(readFetchHookProgram(), 'extractAndNotifyToolCalls');
    expect(body).toBeDefined();

    // 找 `const names = …` 的初始化表达式。
    let namesInit: t.Expression | undefined;
    walkSourceAst(body!, (node) => {
      if (!t.isVariableDeclarator(node)) return;
      if (!t.isIdentifier(node.id) || node.id.name !== 'names') return;
      if (node.init && t.isExpression(node.init)) namesInit = node.init;
    });
    expect(namesInit, '应当有 `const names = …`').toBeDefined();

    // 必须是三元表达式：`requestToolNames … ? new Set(requestToolNames) : hookState.toolDescriptorNames`。
    expect(t.isConditionalExpression(namesInit!), 'names 的初始化必须是三元（本请求优先、全局兜底）').toBe(true);
    const cond = namesInit as t.ConditionalExpression;

    const mentions = (node: t.Node, name: string): boolean => {
      let found = false;
      walkSourceAst(node, (n) => {
        if (t.isIdentifier(n) && n.name === name) found = true;
      });
      return found;
    };

    expect(mentions(cond.test, 'requestToolNames'), '三元条件里必须判本请求名单').toBe(true);
    expect(mentions(cond.consequent, 'requestToolNames'), '命中时用本请求名单').toBe(true);
    expect(mentions(cond.alternate, 'hookState'), '未命中时才退回全局 hookState（兜底）').toBe(true);

    // ⚠️ **判据必须是「是不是 undefined」，不能是「长度是否 > 0」** —— 后者会把
    // 「增广成功但目录为空」（`[]`）也判成「未增广」而回落全局快照 ⇒ 识别出本请求提示词里
    // 根本没列的标签并执行。这里钉住三元条件是 `requestToolNames !== undefined` 形态。
    const test = cond.test;
    expect(
      t.isBinaryExpression(test) && test.operator === '!=='
      && t.isIdentifier(test.left, { name: 'requestToolNames' })
      && t.isIdentifier(test.right, { name: 'undefined' }),
      '判据必须是 `requestToolNames !== undefined`（不是 `.length > 0`）',
    ).toBe(true);
  });

  it('threads the per-request names from the call site into the response interceptor', () => {
    const program = readFetchHookProgram();

    // ① `interceptCompletionResponse(…)` 必须把 `prepared.toolNames` 当第三个实参传进去。
    let passesToolNames = false;
    walkSourceAst(program, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      if (node.callee.name !== 'interceptCompletionResponse') return;
      const third = node.arguments[2];
      if (third && t.isMemberExpression(third) && t.isIdentifier(third.property)
        && third.property.name === 'toolNames') {
        passesToolNames = true;
      }
    });
    expect(passesToolNames, 'interceptCompletionResponse 的第三参必须来自 `prepared.toolNames`').toBe(true);

    // ② 拦截器内部把那个参数转交给 extractAndNotifyToolCalls。
    const body = findFunctionBody(program, 'interceptCompletionResponse');
    expect(body).toBeDefined();
    let forwards = false;
    walkSourceAst(body!, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      if (node.callee.name !== 'extractAndNotifyToolCalls') return;
      if (node.arguments.length >= 3) forwards = true;
    });
    expect(forwards, '拦截器必须把本请求名单转交给 extractAndNotifyToolCalls（第三个实参）').toBe(true);
  });

  it('the main world forwards the augment result names into the hook state', () => {
    // 桥消息 `AUGMENT_REQUEST_BODY_RESULT` 的 `toolDescriptorNames` 必须被
    // `decodeAugmentResult` 解出、并经 `prepareRequest` 变成 `prepared.toolNames`
    // （fetch-hook 的 `ZaiRequestBodyModification`）。这条守的是跨世界那一跳的接线。
    const source = readFileSync(MAIN_WORLD_SOURCE, 'utf8');
    expect(source.includes('toolDescriptorNames'), '主世界必须解析 toolDescriptorNames').toBe(true);
    const hookSource = readFileSync(FETCH_HOOK_SOURCE, 'utf8');
    expect(hookSource.includes('toolDescriptorNames'), 'fetch-hook 必须消费 toolDescriptorNames').toBe(true);
  });
});
