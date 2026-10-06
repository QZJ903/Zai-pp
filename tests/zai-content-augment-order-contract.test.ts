import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';

/**
 * `handleAugmentRequestBody` 的**顺序不变式**：先把 body 解出来，再决定要不要放行。
 *
 * **为什么守这条**：这个函数是「请求增广」的总入口，它内部既有**特权操作**
 * （建工具授权、查项目上下文、登记任务归属），也有**放行路径**（body 解析不出来时原样放行）。
 * 顺序错了会出两类静默问题：
 * ① **先建授权后判放行** ⇒ 给一个**根本不会被增广**的请求建了 grant，
 *    而那条路径**没有终态事件**去关它（孤儿 grant 占着 `MAX_ACTIVE_GRANTS = 32` 的名额）；
 * ② **先登记任务归属后判放行** ⇒ 任务被绑到一个不会执行的请求上。
 *
 * ⚠️ **判据是「解析动作必须早于特权动作」**，不是「这些字符串出现过」——
 * 所以下面按**源码位置**比较，而不是 `toContain`。
 *
 * ⚠️ 上游对应 `tests/request-augmentation-boundary.test.ts`（1 条），但上游那条的
 * 具体锚点（`isDeepSeekAugmentableWebRoute` / `decodeAugmentableDeepSeekRequest` /
 * `resolveRegenerateAuthorizationScopeForRequest`）**本项目都没有**（我们无 regenerate 路由、
 * 也没有那套 route 判定）⇒ 这里按**本项目的实际锚点**重写等价契约。
 */
const CONTENT_SOURCE = 'entrypoints/zai.content.ts';

function readContentProgram(): t.Program {
  return parseTypeScriptSource(CONTENT_SOURCE, readFileSync(CONTENT_SOURCE, 'utf8'));
}

describe('content request augmentation boundary', () => {
  it('decodes the body before any privileged work begins', () => {
    const source = readFileSync(CONTENT_SOURCE, 'utf8');
    const program = readContentProgram();

    let handler: t.FunctionDeclaration | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'handleAugmentRequestBody') {
        handler = node;
      }
    });
    expect(handler, '应当存在 handleAugmentRequestBody').toBeDefined();

    const start = handler!.start ?? 0;
    const end = handler!.end ?? 0;
    const body = source.slice(start, end);

    // ① body 解析（`parseZaiBody`）必须出现，且**早于**任何特权动作。
    const parseIndex = body.indexOf('parseZaiBody(bodyStr)');
    expect(parseIndex, '应当调用 parseZaiBody(bodyStr)').toBeGreaterThanOrEqual(0);

    for (const privileged of [
      'createToolAuthorization({',
      'resolveProjectContextForRequest(',
      'resolvePendingProjectContextForFirstMessage(',
      'activeToolAuthorizations.set(',
      'requestToolDescriptorsByRequestId.set(',
    ]) {
      const index = body.indexOf(privileged);
      expect(index, `应当调用 ${privileged}`).toBeGreaterThanOrEqual(0);
      expect(index, `${privileged} 必须晚于 body 解析`).toBeGreaterThan(parseIndex);
    }
  });

  it('passes the request through when the body cannot be decoded', () => {
    // ⚠️ 这条守的是「解析失败必须放行、不能继续往下走特权动作」。
    // 判据是**结构**：解析失败的那两个提前 return 分支里都发了 passthrough 结果。
    const source = readFileSync(CONTENT_SOURCE, 'utf8');
    const program = readContentProgram();

    let handler: t.FunctionDeclaration | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'handleAugmentRequestBody') {
        handler = node;
      }
    });
    expect(handler).toBeDefined();

    // 收集 `const body = parseZaiBody(bodyStr)` 之后、下一个特权动作之前的全部提前 return。
    const body = source.slice(handler!.start ?? 0, handler!.end ?? 0);
    const parseIndex = body.indexOf('parseZaiBody(bodyStr)');
    const firstPrivileged = body.indexOf('createToolAuthorization({');
    const between = body.slice(parseIndex, firstPrivileged);

    // 那一段里至少要有一次 passthrough（`result: null` 的增广结果回传）。
    expect(between, '解析与建授权之间应当有放行分支').toContain('result: null');
  });

  it('keeps the passthrough result shape stable', () => {
    // ⚠️ 放行消息的形状是**主世界的判据**（`ok: true` + `result: null` ⇒ 原样放行）。
    // 改成 `ok: false` 会让主世界走拒绝分支 —— 那是**行为改变**，不是等价重构。
    // ⚠️ 实际写法是**单行内联对象字面量**（`postToMainWorld({ ... })`），所以按单行匹配。
    const source = readFileSync(CONTENT_SOURCE, 'utf8');
    const matches = [
      ...source.matchAll(/postToMainWorld\(\{ type: 'AUGMENT_REQUEST_BODY_RESULT', id, ok: true, result: null \}\)/g),
    ];
    expect(matches.length, '至少应有一处放行回传').toBeGreaterThan(0);
  });
});
