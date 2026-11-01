import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as t from '@babel/types';
import { findFunctionBody, readContentProgram } from './helpers/content-source-ast';

/**
 * **失败码必须在每次发送前复位** —— 否则会把上一次任务的失败码漏给这一次。
 *
 * ## 它修的是什么
 *
 * `lastAutomationSendErrorKind` 是模块级的**单个值**，只在三种 pre-send 失败时写
 * （`no_textarea` / `form_not_connected` / `agent_not_idle`），**从不复位**。
 * 而 `submitAutomationPromptViaPage` 还有三种失败出口**不写它**：
 * ① `domSendInFlight` 早退；② 请求已发出但未归属；③ 一个请求都没发出。
 *
 * ⇒ 那三种会读到**上一次任务**留下的 kind。最坏方向：上一次失败于 `agent_not_idle`，
 * 这一次明明「请求已经发出去了」却回传 `agent_not_idle` ⇒ coordinator 判 `retrySafe`
 * ⇒ scheduler **自动重跑** ⇒ 双会话（多一条没人认领的对话 + 一次真实计费）。
 *
 * 复位后那三种退化成 `composer_inject_failed`（不重试）—— 那正是它们的正确档位。
 *
 * ⚠️ **判据只能落在 AST 上** —— `submitDomTaskPrompt` 在内容脚本里、不可 import。
 * 但它问的是**结构事实**（复位在不在、在不在第一个 await 之前），不是「某个名字出现过」。
 */
describe('automation send: 失败码每次发送前复位', () => {
  it('submitDomTaskPrompt 的第一条语句就是复位', () => {
    const body = findFunctionBody(readContentProgram(), 'submitDomTaskPrompt');
    const first = body.body[0];
    expect(first, '函数体不该是空的').toBeDefined();
    // 找 `lastAutomationSendErrorKind = null;`
    let reset: t.AssignmentExpression | null = null;
    if (t.isExpressionStatement(first) && t.isAssignmentExpression(first.expression)) {
      const assign = first.expression;
      if (
        t.isIdentifier(assign.left, { name: 'lastAutomationSendErrorKind' })
        && t.isNullLiteral(assign.right)
      ) {
        reset = assign;
      }
    }
    // 注释不会被解析成语句 ⇒ 第一条**语句**就应该是赋值。
    expect(
      reset,
      'submitDomTaskPrompt 的第一条语句必须是 `lastAutomationSendErrorKind = null;` —— '
      + '不放在最前面就会被前面的 await 拖过去，而那些出口本来就是「不等」的',
    ).not.toBeNull();
  });

  it('复位排在第一个 await 之前', () => {
    const body = findFunctionBody(readContentProgram(), 'submitDomTaskPrompt');
    let resetAt: number | null = null;
    let firstAwaitAt: number | null = null;
    for (const statement of body.body) {
      if (resetAt === null && t.isExpressionStatement(statement)
        && t.isAssignmentExpression(statement.expression)
        && t.isIdentifier(statement.expression.left, { name: 'lastAutomationSendErrorKind' })) {
        resetAt = statement.start ?? null;
      }
      if (firstAwaitAt === null && t.isExpressionStatement(statement)
        && t.isAwaitExpression(statement.expression)) {
        firstAwaitAt = statement.start ?? null;
      }
    }
    expect(resetAt, '应当有复位语句').not.toBeNull();
    expect(firstAwaitAt, '应当有 await').not.toBeNull();
    expect(resetAt!, '复位必须在第一个 await 之前 —— 否则等完那一刻失败码可能已被别的链路改过')
      .toBeLessThan(firstAwaitAt!);
  });

  it('读失败码的地方仍然只认白名单那三个码', () => {
    // 反面守卫：别「修」成把任何 kind 都放行 —— `RETRYABLE_PRE_SEND_ERRORS` 的语义是
    // 「尚未产生任何副作用」，只有那三个码能自动重跑。
    const body = findFunctionBody(readContentProgram(), 'submitDomTaskPrompt');
    let checksSet = false;
    (function walk(node: t.Node) {
      if (t.isCallExpression(node) && t.isMemberExpression(node.callee)) {
        const prop = node.callee.property;
        if (t.isIdentifier(prop, { name: 'has' })
          && t.isIdentifier(node.callee.object, { name: 'RETRYABLE_PRE_SEND_ERRORS' })) {
          checksSet = true;
        }
      }
      for (const key of t.VISITOR_KEYS[node.type] ?? []) {
        const child = (node as unknown as Record<string, unknown>)[key];
        const children = Array.isArray(child) ? child : [child];
        for (const item of children) {
          if (item && typeof item === 'object' && 'type' in item) walk(item as t.Node);
        }
      }
    })(body);
    expect(checksSet, '读失败码时必须过 RETRYABLE_PRE_SEND_ERRORS 白名单').toBe(true);
  });
});

/**
 * **两份 `RETRYABLE_PRE_SEND_ERRORS` 必须逐字相同**。
 *
 * 内容脚本用它决定回传哪个失败码、协调器用它决定 `retrySafe`。两份各自维护、
 * 没有守卫 —— 改一处忘了另一处，失败方向是静默的：内容脚本回了一个协调器**不认**的码
 * ⇒ `retrySafe=false` ⇒ 本该自动重跑的任务从此不重试（或反过来，本该不重试的被重试）。
 *
 * ⚠️ **为什么不合并成一份**：内容脚本与协调器分属不同 bundle，抽公共模块要动构建边界
 * （`core/zai/` 与 `entrypoints/` 的依赖方向是刻意的，见 U10 的装配层说明）。
 * 所以这里只加**跨文件相等断言**，不动结构。
 */
describe('两份发送失败码白名单必须同源', () => {
  const FILES = {
    内容脚本: 'entrypoints/zai.content.ts',
    协调器: 'core/zai/dom-task-coordinator.ts',
  } as const;

  function readSet(path: string): string[] {
    const source = readFileSync(path, 'utf8');
    const match = source.match(
      /const RETRYABLE_PRE_SEND_ERRORS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\);/,
    );
    expect(match, `${path} 里应当有 RETRYABLE_PRE_SEND_ERRORS 的 Set 字面量`).not.toBeNull();
    return [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
  }

  it('两个集合逐字相同（排序后比较，不比源码写法）', () => {
    const a = readSet(FILES.内容脚本);
    const b = readSet(FILES.协调器);
    expect(a, '内容脚本这份不该是空的').not.toHaveLength(0);
    expect(a, '内容脚本与协调器的白名单必须一致 —— 不一致时「要不要自动重跑」会在两侧分叉')
      .toEqual(b);
  });

  it('三个码都在（防止有人整体删成空集）', () => {
    // ⚠️ 上一条在「两边都空」时也会绿 —— 加这条兜住那个方向。
    expect(readSet(FILES.内容脚本)).toEqual(
      expect.arrayContaining(['agent_not_idle', 'form_not_connected', 'no_textarea']),
    );
  });
});
