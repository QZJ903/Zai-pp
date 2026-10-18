import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { findFunctionBody, readContentProgram } from './helpers/content-source-ast';
import { buildZaiContinuationPrompt, buildZaiNudgePrompt } from '../core/zai/continuation';
import { isZaiContinuationRequestBody } from '../core/zai/continuation-request';

/**
 * 「续跑注入算不算发出去了」这条判据的两端。
 *
 * 背景：续跑 prompt 是扩展写进输入框、让页面自己发的。判断「这一发到底发出去了没有」
 * 只有一个观察点：主世界在请求发出前会广播原始 body，内容脚本在**串行队列之外**
 * 同步认一次是不是续跑模板（`continuationRequestSeq`）。那个观察信号一旦没响，
 * 调用方会走兜底**把同一段 prompt 再发一遍**（重复的用户消息 ⇒ 同一批工具再跑一次）。
 *
 * ⚠️⚠️ **它是队列外判据，这条约束不能破** —— 等它的时候我们正占着串行队列，
 * 队列内的一切（`observedAugRequestCount` 那类计数、`handleResponseComplete` 那类回调）
 * 此刻都读不到；把这份判据挪进队列内会让它**永远看不到**（自锁）。下面第一组断言钉住这一点。
 */

const CONTENT_SOURCE = 'entrypoints/zai.content.ts';
const PEEK_FN = 'dispatchMainWorldMessage';
const SUBMIT_FN = 'submitContinuationViaPage';
/** 等「这一发确实发出去了」的证据（主判据计数 + 副判据 Stop）。 */
const EVIDENCE_FN = 'waitForSendEvidence';

const SHELL_PROVIDER = {
  kind: 'mcp',
  id: 'shell',
  displayName: 'Shell MCP',
  transport: 'native_messaging',
} as const;

function execution() {
  return {
    name: 'shell_exec',
    provider: SHELL_PROVIDER,
    result: { ok: true, summary: '列出 3 个文件', detail: 'a.txt\nb.txt\nc.txt' },
  } as never;
}

/** 一份 completion 请求体（续跑轮走的就是这条路由）。 */
function completionBody(text: string): string {
  return JSON.stringify({ messages: [{ role: 'user', content: text }], model: 'glm-5.3' });
}

function context() {
  return {
    program: readContentProgram(CONTENT_SOURCE),
    source: readFileSync(CONTENT_SOURCE, 'utf8'),
  };
}

/** 子树里所有 `name(...)` 的调用点。 */
function callsTo(node: t.Node, name: string): t.CallExpression[] {
  const found: t.CallExpression[] = [];
  t.traverseFast(node, (child) => {
    if (t.isCallExpression(child) && t.isIdentifier(child.callee) && child.callee.name === name) {
      found.push(child);
    }
  });
  return found;
}

function ifStatements(node: t.Node): t.IfStatement[] {
  const found: t.IfStatement[] = [];
  t.traverseFast(node, (child) => {
    if (t.isIfStatement(child)) found.push(child);
  });
  return found;
}

/** 子树里有没有出现某个标识符（不区分读/写）。 */
function referencesIdentifier(node: t.Node, name: string): boolean {
  let found = false;
  t.traverseFast(node, (child) => {
    if (t.isIdentifier(child, { name })) found = true;
  });
  return found;
}

/** 子树里有没有 `return true`。 */
function containsReturnTrue(node: t.Node): boolean {
  let found = false;
  t.traverseFast(node, (child) => {
    if (t.isReturnStatement(child) && t.isBooleanLiteral(child.argument, { value: true })) {
      found = true;
    }
  });
  return found;
}

describe('continuation request peek: 判据行为', () => {
  it('认得出真实续跑模板与 nudge 模板', () => {
    // ⚠️ 不手抄模板文案 —— 拿真渲染出来的文本去测（改模板时判据要跟着走）。
    const continuation = buildZaiContinuationPrompt('看看桌面有什么', [execution()], ['shell_exec']);
    const nudge = buildZaiNudgePrompt('看看桌面有什么', '上轮正文', [execution()], 1, ['shell_exec']);
    expect(isZaiContinuationRequestBody(completionBody(continuation))).toBe(true);
    expect(isZaiContinuationRequestBody(completionBody(nudge))).toBe(true);
  });

  it('普通用户消息不算', () => {
    expect(isZaiContinuationRequestBody(completionBody('帮我看看桌面有什么'))).toBe(false);
  });

  it('解析不出来时退回原文粗判', () => {
    // ⚠️⚠️ **这条是本次新增的那一级** —— `parseZaiBody` 失败意味着增广也会被跳过、
    // 请求按原样发出去，那一轮**仍然是正常发出的**。此时若判据跟着认不出来，
    // 「已经发出去」会被判成「没发出去」，调用方随后会把同一段 prompt 再发一遍。
    const prompt = buildZaiContinuationPrompt('任务', [execution()], ['shell_exec']);
    const brokenJson = `${completionBody(prompt)}<<<`;
    expect(isZaiContinuationRequestBody(brokenJson)).toBe(true);
  });

  it('解析不出来、也不含模板标签 → 不算', () => {
    // 反面：粗判不能宽到「任何懵掉的 body 都算」。
    const brokenJson = `${completionBody('帮我看看桌面有什么')}<<<`;
    expect(isZaiContinuationRequestBody(brokenJson)).toBe(false);
  });

  it('形状变了（取不到 user 文本）时同样退回粗判', () => {
    // 解析得出来、但最后一条 user 消息的 content 不是字符串 ⇒ 走不到第一级判据。
    const prompt = buildZaiContinuationPrompt('任务', [execution()], ['shell_exec']);
    const oddShape = JSON.stringify({
      messages: [{ role: 'user', content: { blocks: [prompt] } }],
    });
    expect(isZaiContinuationRequestBody(oddShape)).toBe(true);
  });

  it('空串与垃圾都不算', () => {
    expect(isZaiContinuationRequestBody('')).toBe(false);
    expect(isZaiContinuationRequestBody('not json at all')).toBe(false);
  });
});

describe('continuation request peek: 必须在串行队列之外', () => {
  it('那一处计数增量排在队列 run 之前，且用的是共用判据', () => {
    const { program } = context();
    const body = findFunctionBody(program, PEEK_FN);

    // ① 恰好一处增量 —— 多一处会让「只统计一次」的前提失效，也会让位置断言失焦。
    const increments: t.Node[] = [];
    t.traverseFast(body, (node) => {
      if (!t.isExpressionStatement(node)) return;
      const expression = node.expression;
      if (!t.isAssignmentExpression(expression) || expression.operator !== '+=') return;
      if (t.isIdentifier(expression.left) && expression.left.name === 'continuationRequestSeq') {
        increments.push(node);
      }
    });
    expect(increments, '应当恰好一处 `continuationRequestSeq += 1`').toHaveLength(1);

    // ② 它必须早于 `await mainWorldQueue.run(...)`。
    // ⚠️ 判据要按**成员表达式**收，不能用 `callsTo(body, 'run')` ——
    // 那条只认 `callee` 是标识符的形态，会一个都收不到（第一版就是这么假红的）。
    const queueRuns: t.CallExpression[] = [];
    t.traverseFast(body, (node) => {
      if (!t.isCallExpression(node)) return;
      const callee = node.callee;
      if (t.isMemberExpression(callee)
        && t.isIdentifier(callee.object, { name: 'mainWorldQueue' })
        && t.isIdentifier(callee.property, { name: 'run' })) {
        queueRuns.push(node);
      }
    });
    expect(queueRuns.length, '应当能定位到 `mainWorldQueue.run(...)`').toBeGreaterThan(0);

    const queueStart = Math.min(...queueRuns.map((call) => call.start ?? 0));
    expect(
      increments[0]!.start ?? 0,
      '这份判据必须跑在串行队列之外 —— 挪进队列内会因为它被自己堵住而永远看不到（自锁）',
    ).toBeLessThan(queueStart);

    // ③ 增量由共用判据驱动（不是就地另写一份名字判断）。
    expect(
      callsTo(body, 'isZaiContinuationRequestBody'),
      '增量必须由 `isZaiContinuationRequestBody` 驱动',
    ).toHaveLength(1);
  });
});

describe('continuation submit: 「页面在生成」只记录、不参与等待', () => {
  it('等待函数把 Stop 记成标志位，而不是拿它提前返回', () => {
    const { program } = context();
    const body = findFunctionBody(program, EVIDENCE_FN);

    // ① 恰好读一次 Stop。
    expect(callsTo(body, 'isAgentCurrentlyRunning'), '应当读一次 Stop 按钮').toHaveLength(1);

    // ② ⚠️⚠️ **它不能是「提前返回」的驱动** —— Stop 出现的时刻没有实测过，
    // 若它早于页面自己清空输入框，提前返回会让调用方把用户草稿恢复得过早、
    // 随后被页面那次清空抹掉（就是那条「草稿恢复的时机」）。
    const returnsOnStop = ifStatements(body).filter(
      (statement) => callsTo(statement.test, 'isAgentCurrentlyRunning').length > 0
        && containsReturnTrue(statement.consequent),
    );
    expect(
      returnsOnStop,
      'Stop 只许被记录，不许决定什么时候返回',
    ).toEqual([]);

    // ③ 主判据（请求计数）必须还在，而且就是那个提前返回。
    const countReturns = ifStatements(body).filter(
      (statement) => referencesIdentifier(statement.test, 'continuationRequestSeq')
        && containsReturnTrue(statement.consequent),
    );
    expect(countReturns, '应当有一条「计数涨了 ⇒ return true」').toHaveLength(1);

    // ④ 超时之后返回的是那个标志位 —— 写成 `return false` 等于把副判据丢掉。
    const last = body.body[body.body.length - 1];
    expect(t.isReturnStatement(last), '函数最后一个语句应当是 return').toBe(true);
    expect(
      t.isIdentifier((last as t.ReturnStatement).argument),
      '超时后必须回看那个标志位，不能直接 return false',
    ).toBe(true);
  });

  it('回落重发那一层不许再看 Stop', () => {
    // ⚠️⚠️ **这一条防的是一个真实存在的假阳性**：那一层拿不到「提交已经触发过」这个前提 ——
    // 主路的提前返回里有一档是「上一轮没答完」（`waitForAgentIdle` 超时），
    // 那时页面正在生成、而我们**根本没注入**；在那里看 Stop 会把它误判成已发出
    // ⇒ 续跑等一个不会来的响应 ⇒ 只能等 180s 租约。
    const { program } = context();
    const body = findFunctionBody(program, SUBMIT_FN);
    expect(callsTo(body, 'isAgentCurrentlyRunning')).toEqual([]);
  });
});