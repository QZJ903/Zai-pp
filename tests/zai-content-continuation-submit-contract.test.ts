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
 * ⚠️⚠️ **它们都是队列外判据，这条约束不能破** —— 等它们的时候我们正占着串行队列，
 * 队列内的一切此刻都读不到；把自增挪进队列内会让它**永远看不到**（自锁）。
 *
 * ⚠️ **两个计数器都受这条约束**：`continuationRequestSeq`（续跑模板）与
 * `observedAugRequestCount`（桥消息总数）。后者原先在 `handleAugmentRequestBody` 里自增，
 * 而那个函数跑在队列内 —— 续跑链只能靠前者兜住，后者在续跑路径上恒为 0，
 * 于是「桥通了但 body 不是模板」这一档永远落不到 `sent`。下面第一组断言钉住两者。
 */

const CONTENT_SOURCE = 'entrypoints/zai.content.ts';
const PEEK_FN = 'dispatchMainWorldMessage';
const SUBMIT_FN = 'submitContinuationViaPage';
/** 等「这一发确实发出去了」的证据（两个请求计数分三态；Stop 只作诊断、不参与分档）。 */
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
function referencesAnyIdentifier(node: t.Node, names: readonly string[]): boolean {
  const wanted = new Set(names);
  let found = false;
  t.traverseFast(node, (child) => {
    if (t.isIdentifier(child) && wanted.has(child.name)) found = true;
  });
  return found;
}

/** 函数体里所有三元表达式。 */
function conditionalExpressions(node: t.Node): t.ConditionalExpression[] {
  const found: t.ConditionalExpression[] = [];
  t.traverseFast(node, (child) => {
    if (t.isConditionalExpression(child)) found.push(child);
  });
  return found;
}

/** 子树里有没有**任何** `return`（不管返回什么）。 */
function containsAnyReturn(node: t.Node): boolean {
  let found = false;
  t.traverseFast(node, (child) => {
    if (t.isReturnStatement(child)) found = true;
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

  it('⚠️ 主判据说「不是模板」之后，粗判不能再翻案', () => {
    // ⚠️⚠️ **这条守的是「用户消息不能消失」** —— 粗判拿的是**整个 body 串**，
    // 而 body 里含**整段 messages**。会话历史里只要留着上一轮的续跑模板，
    // 整串里就有模板的标签与开场话术 ⇒ 用户这一条普通提问也会被判成续跑。
    // 后果链：历史清洗把这条消息换成不可见占位符 → 气泡隐藏给它 display:none
    // → 这一轮不增广、`isContinuationTurn` 走 orphan 分支直接 return。
    // **用户的消息从对话里消失，且没有任何东西会报错。**
    const template = buildZaiContinuationPrompt('任务', [execution()], ['shell_exec']);
    const withHistory = JSON.stringify({
      model: 'glm-5.3',
      messages: [
        { role: 'user', content: '原始任务' },
        { role: 'assistant', content: '…' },
        { role: 'user', content: template },   // ← 历史里留着的旧模板
        { role: 'assistant', content: '…' },
        { role: 'user', content: '再帮我总结一下刚才的结果' },   // ← 这一条才是本轮
      ],
    });
    expect(
      isZaiContinuationRequestBody(withHistory),
      '最后一条 user 是普通提问 ⇒ 主判据给出「不是模板」，粗判不许翻案',
    ).toBe(false);
  });

  it('⚠️ 用户正文提到两个标签也不算（主判据 + 严格档两层都要挡住）', () => {
    // 两层判据各挡一类：严格档挡「只提标签不提我们的话术」，主判据挡「历史里有真模板」。
    expect(isZaiContinuationRequestBody(
      completionBody('请解释 <original_task> 和 <tool_results> 这两个标签'),
    )).toBe(false);
  });

  it('⚠️ `/chats/new` 路由：历史含旧模板时同样不能翻案（主判据的第二条腿）', () => {
    // ⚠️⚠️ **这条是 ZCode 评审「需实测-2」的回归用例** —— 两个路由的 body 形状完全不同
    // （[[zai-site]] §2.2 真机抓包）：completion 的 user 消息在**顶层 `messages[]`**，
    // 而 `/chats/new` **顶层只有 `chat`**、消息在 `chat.history.messages.<id>.content`。
    // ⇒ 只写 completion 那条腿的话，`readZaiLastUserMessageText` 对 chatNew 恒返回 `''`
    // ⇒ 恒落粗判 ⇒ **历史里有旧模板时照样误判成续跑**（实测过：旧代码答 true）。
    const template = buildZaiContinuationPrompt('任务', [execution()], ['shell_exec']);
    const chatNewBody = JSON.stringify({
      chat: {
        type: 'general_agent',
        flags: ['general_agent'],
        models: ['glm-5.2'],
        history: {
          messages: {
            m1: { content: '原始任务' },
            m2: { content: template },            // ← 历史里留着的旧模板
            m3: { content: '再帮我总结一下刚才的结果' },  // ← 这一条才是本轮
          },
          currentId: 'm3',
        },
      },
    });
    expect(
      isZaiContinuationRequestBody(chatNewBody),
      'chatNew 路由的最后一条 user 是普通提问 ⇒ 主判据必须给出「不是模板」',
    ).toBe(false);

    // 反面：chatNew 那一发**本身**就是模板（自动化首条注入形似续跑文本时）仍要认得出
    const chatNewIsTemplate = JSON.stringify({
      chat: { history: { messages: { m1: { content: template } }, currentId: 'm1' } },
    });
    expect(isZaiContinuationRequestBody(chatNewIsTemplate)).toBe(true);
  });
});

describe('continuation request peek: 必须在串行队列之外', () => {
  it('记账调用落在串行队列之外，且账本规则来自共用模块', () => {
    const { program } = context();
    const body = findFunctionBody(program, PEEK_FN);

    // ⚠️⚠️ **这条守的是「接线」，不是「规则」** —— 规则本身（两个计数器怎么组合、
    // body 不是字符串时记不记账）已经抽进 `core/zai/send-evidence.ts`，
    // 由 `tests/zai-send-evidence.test.ts` 用真输入喂满。
    //
    // 为什么接线只能这样守：`waitForSendEvidence` 本身跑在串行队列里
    // （`settleToolTurn` → `handleResponseComplete` → `advanceContinuationLoop` → 发送链），
    // 它占着队列等这两个计数器变大；**记账若发生在队列内，那次记账永远排不到** ⇒
    // 自锁，只能等满 5 秒窗口再判成「没证据」。
    //
    // ⚠️ **残余绕过面（已知、接受）**：把这次调用包进一个声明在前、调用在队列内的
    // 嵌套函数，位置断言仍会通过。要根治只能换介质（行为测试），而这条链不可 import。
    // 抽出规则模块已经把「逻辑错」那一半的风险降下来了 —— 剩下这一半只有接线。

    // ① 记账必须由共用模块驱动，不是就地另写一份判断。
    expect(
      callsTo(body, 'classifyAugmentRequest'),
      '记账必须走 `classifyAugmentRequest`（规则在 core/zai/send-evidence.ts）',
    ).toHaveLength(1);

    // ② 调用必须早于 `await mainWorldQueue.run(...)`。
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
    const recordCalls = callsTo(body, 'classifyAugmentRequest');
    expect(
      recordCalls[0]!.start ?? 0,
      '记账必须跑在串行队列之外 —— 挪进队列内会让它被自己堵住而永远看不到（自锁）',
    ).toBeLessThan(queueStart);
  });

  it('两个计数器只在那一处、按返回值累加（不许就地另算一遍）', () => {
    // ⚠️ **自增只能出现在 `classifyAugmentRequest` 的返回值上。**
    // 就地写 `continuationRequestSeq += 1` 会让「什么时候 +1」的判断绕开共用模块，
    // 而那一半已经有行为测试了 —— 绕开它等于绕开覆盖。
    const { program } = context();
    const body = findFunctionBody(program, PEEK_FN);

    const counters = ['continuationRequestSeq', 'observedAugRequestCount'];
    for (const counter of counters) {
      const direct: t.Node[] = [];
      t.traverseFast(body, (node) => {
        if (!t.isExpressionStatement(node)) return;
        const expression = node.expression;
        if (!t.isAssignmentExpression(expression) || expression.operator !== '+=') return;
        if (!t.isIdentifier(expression.left) || expression.left.name !== counter) return;
        // 允许的形态：`x += delta.<field>`；不允许：`x += 1` / `x += 任何别的表达式`
        const right = expression.right;
        const isDeltaField = t.isMemberExpression(right)
          && t.isIdentifier(right.object, { name: 'delta' });
        if (!isDeltaField) direct.push(node);
      });
      expect(
        direct.map((node) => node.loc?.start.line ?? -1),
        `${counter} 只能按 \`classifyAugmentRequest\` 的返回值累加 —— 就地另算会绕开已测的规则`,
      ).toEqual([]);
    }
  });

  it('`handleAugmentRequestBody` 里不再自增任何一个计数器', () => {
    // 反面：那两个自增曾经在 `handleAugmentRequestBody` 里，而它跑在队列**内** ⇒
    // 续跑链占着队列等它们、它们却排在队列后面 ⇒ 那一路径上恒为 0。
    const { program } = context();
    const body = findFunctionBody(program, 'handleAugmentRequestBody');
    const text = readFileSync(CONTENT_SOURCE, 'utf8').slice(body.start ?? 0, body.end ?? 0);
    expect(text).not.toContain('observedAugRequestCount +=');
    expect(text).not.toContain('continuationRequestSeq +=');
  });
});

describe('continuation submit: 发送判据是三态的，Stop 只作诊断', () => {
  it('等待函数用两个请求计数器分档，Stop 不进分档', () => {
    const { program, source } = context();
    const body = findFunctionBody(program, EVIDENCE_FN);

    // ① 恰好读一次 Stop（诊断字段用）。
    expect(callsTo(body, 'isAgentCurrentlyRunning'), '应当读一次 Stop 按钮').toHaveLength(1);

    // ② ⚠️⚠️ **Stop 不能是「提前返回」的驱动**。实测：Stop 比请求
    // 早 3–5ms 出现 —— 它是页面进入生成态的信号，**不是**「这一发发出去了」的证据。
    // 把它当证据，主判据一失效就会误判。
    // ⚠️ **判据是「那个 if 的 consequent 里有没有任何 return」** —— 现在返回的是对象字面量
    // 而不是 `return true`，只认布尔字面量会让这条守卫失效（第一版就是）。
    const returnsOnStop = ifStatements(body).filter(
      (statement) => callsTo(statement.test, 'isAgentCurrentlyRunning').length > 0
        && containsAnyReturn(statement.consequent),
    );
    expect(returnsOnStop, 'Stop 只许被记录，不许决定分档').toEqual([]);

    // ③ 两个计数器都必须参与 —— `observedAugRequestCount`（桥消息到了几次）与
    // `continuationRequestSeq`（其中几次是续跑模板）。缺了前者就分不出
    // 「桥挂了」与「桥通了但 body 不是模板」，而这两种代价完全不同。
    const bodyText = source.slice(body.start ?? 0, body.end ?? 0);
    expect(bodyText, '必须读 `observedAugRequestCount`').toContain('observedAugRequestCount');
    expect(bodyText, '必须读 `continuationRequestSeq`').toContain('continuationRequestSeq');

    // ④ ⚠️⚠️ **分档必须外派给共用模块，不许就地再写一遍。**
    // 规则本身（哪一种组合算 sent）已经由 `tests/zai-send-evidence.test.ts`
    // 用真输入喂满；在等待函数里内联一份等价逻辑，等于绕开那份覆盖 ——
    // 而两份规则一旦分叉是静默的（都「看着对」）。
    const verdictCalls = callsTo(body, 'classifySendEvidence');
    expect(verdictCalls, '分档必须走 `classifySendEvidence`').toHaveLength(1);
    // 两个实参必须就是那两个差值（不是常量、不是别的计数）。
    const verdictArgs = verdictCalls[0]!.arguments;
    expect(verdictArgs, '`classifySendEvidence` 要接收两个增量').toHaveLength(2);
    expect(
      source.slice(verdictArgs[0]!.start ?? 0, verdictArgs[0]!.end ?? 0),
      '第一个实参必须是 `observedAugRequestCount` 的增量',
    ).toContain('observedAugRequestCount');
    expect(
      source.slice(verdictArgs[1]!.start ?? 0, verdictArgs[1]!.end ?? 0),
      '第二个实参必须是 `continuationRequestSeq` 的增量',
    ).toContain('continuationRequestSeq');

    // ⑤ ⚠️ **`ambiguous` / `unsent` 这两个字面量不许出现在等待函数里。**
    // 内联分档的签名就是「自己算出非 sent 的那一档」，而这两个词只在被内联时才会出现
    // （`sent` 允许 —— 循环的跳出条件要拿它比较函数返回值，那是函数的**消费者**，
    // 不是规则的**副本**）。
    expect(bodyText, '不许出现 `ambiguous` 字面量（内联分档的签名）').not.toContain("'ambiguous'");
    expect(bodyText, '不许出现 `unsent` 字面量').not.toContain("'unsent'");

    // ⑥ ⚠️ **两个计数器不许直接进 if / 三元的判据** —— 它们唯一的合法去处是
    // `classifySendEvidence` 的实参。进了判据就说明分档规则被就地重写了一份。
    const counterTests = [
      ...ifStatements(body),
      ...conditionalExpressions(body),
    ].filter((node) => {
      return referencesAnyIdentifier(node.test, ['observedAugRequestCount', 'continuationRequestSeq']);
    });
    expect(
      counterTests.map((node) => node.loc?.start.line ?? -1),
      '计数器只能进 `classifySendEvidence` 的实参，不许直接进判据 —— 那是内联分档',
    ).toEqual([]);
  });

  it('三态里只有 `unsent` 允许触发兜底重发', () => {
    const { program, source } = context();
    const body = findFunctionBody(program, SUBMIT_FN);

    // ⚠️⚠️ `ambiguous` 重发 = 同一段 prompt 发两次（同一批工具再跑一次、
    // 用户看到两条一样的消息）⇒ 判据必须是「只有 unsent 才继续走兜底」。
    const guarded = ifStatements(body).filter(
      (statement) => source.slice(statement.test.start ?? 0, statement.test.end ?? 0)
        .includes("'unsent'"),
    );
    expect(guarded, "应当有一条 `!== 'unsent'` 这类守卫").toHaveLength(1);

    // 兜底那一步在守卫之后 —— 写成前置就等于「不管怎样都重发」。
    const fallbackCalls = callsTo(body, 'sendPromptViaDom');
    expect(fallbackCalls, '应当有一处兜底发送').toHaveLength(1);
    expect(
      (fallbackCalls[0]!.start ?? 0) > (guarded[0]!.start ?? 0),
      '兜底发送必须排在「只有 unsent 才继续」那条守卫之后',
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

/** 成员调用（`document.querySelector(...)` 这类 callee 是成员表达式，`callsTo` 收不到）。 */
function memberCallsTo(node: t.Node, property: string): t.CallExpression[] {
  const found: t.CallExpression[] = [];
  t.traverseFast(node, (child) => {
    if (
      t.isCallExpression(child)
      && t.isMemberExpression(child.callee)
      && t.isIdentifier(child.callee.property)
      && child.callee.property.name === property
    ) {
      found.push(child);
    }
  });
  return found;
}

describe('continuation send: 失败必须如实上报', () => {
  const NOT_OBSERVED_FN = 'reportContinuationSendNotObserved';
  const FAIL_FN = 'failContinuationLoop';

  /** 「没发出去」的收尾必须走失败路径，不能直接 `finishContinuationLoop`（它会回 COMPLETE）。 */
  for (const fnName of ['advanceContinuationLoop', 'submitMisuseCorrection', 'handleResponseComplete']) {
    it(`${fnName} 的 unsent 出口必须调 failContinuationLoop`, () => {
      const { program, source } = context();
      const body = findFunctionBody(program, fnName);
      const unsentBranches = ifStatements(body).filter((statement) => {
        const test = source.slice(statement.test.start ?? 0, statement.test.end ?? 0);
        return test.includes("'unsent'") && containsAnyReturn(statement.consequent);
      });
      expect(unsentBranches.length, '应当有一条 unsent 分支').toBeGreaterThan(0);
      for (const branch of unsentBranches) {
        expect(
          callsTo(branch.consequent, FAIL_FN).length,
          'unsent 分支必须走 failContinuationLoop',
        ).toBe(1);
        expect(
          callsTo(branch.consequent, 'finishContinuationLoop'),
          'unsent 分支不许直接 finish（那会回 DOM_TASK_COMPLETE = 成功）',
        ).toEqual([]);
      }
    });
  }

  it('失败码由 classifyContinuationSendFailure 决定，不许就地写三目', () => {
    const { program } = context();
    const body = findFunctionBody(program, 'advanceContinuationLoop');
    expect(callsTo(body, 'classifyContinuationSendFailure')).toHaveLength(1);
    expect(conditionalExpressions(body), '不该在调用点手写三目挑码').toEqual([]);
  });

  it('上报级别只剩 console.log（续跑失败不进扩展错误面板）', () => {
    const { program, source } = context();
    const body = findFunctionBody(program, NOT_OBSERVED_FN);
    expect(source.slice(body.start ?? 0, body.end ?? 0)).not.toContain('console.error');
  });
});

describe('continuation send: 等待之后必须重取输入框', () => {
  for (const fnName of ['trySubmitViaFormRequestSubmit', 'sendPromptPrimitive']) {
    it(`${fnName} 在等空闲之后、写值之前又取了一次 CHAT_INPUT_SELECTOR`, () => {
      // ⚠️ **等待最长 8 秒，而输入框会被页面重建**（上一轮生成结束时）——
      // 用等待之前抓的引用写值，页面收不到 ⇒ 发送按钮永不亮 ⇒ 这一发判成失败。
      // 判据必须落在「等完之后、写值之前」这一格：提交前那次重取（表单路有、DOM 路没有）
      // 不能替代它，否则写进去的仍是脱连节点。
      const { program } = context();
      const body = findFunctionBody(program, fnName);
      const idle = callsTo(body, 'waitForAgentIdle');
      expect(idle, '应当有一处等待空闲').toHaveLength(1);
      const writes = callsTo(body, 'setTextareaValue');
      expect(writes.length, '应当有写值').toBeGreaterThan(0);
      const firstWrite = Math.min(...writes.map((call) => call.start ?? 0));
      const refetch = memberCallsTo(body, 'querySelector').filter((call) => (
        t.isIdentifier(call.arguments[0])
        && call.arguments[0].name === 'CHAT_INPUT_SELECTOR'
        && (call.start ?? 0) > (idle[0]!.start ?? 0)
        && (call.start ?? 0) < firstWrite
      ));
      expect(refetch.length, '等完空闲必须重新取一次输入框再写').toBeGreaterThan(0);
    });
  }
});

describe('continuation loop: await 之后必须验身份', () => {
  /** 判据：`if (continuationLoop !== loop ...)` 必须出现在提交之前，且提交之后再有一次。 */
  function identityGuards(node: t.Node, source: string): t.IfStatement[] {
    return ifStatements(node).filter((statement) => {
      const test = source.slice(statement.test.start ?? 0, statement.test.end ?? 0);
      return test.includes('continuationLoop') && test.includes('loop')
        && (test.includes('!==') || test.includes('!='));
    });
  }

  it('advanceContinuationLoop 在 await 之后、提交之前验一次，提交之后再验一次', () => {
    const { program, source } = context();
    const body = findFunctionBody(program, 'advanceContinuationLoop');
    const submit = callsTo(body, 'submitContinuationWithRetry');
    expect(submit, '应当有一处续跑提交').toHaveLength(1);
    const guards = identityGuards(body, source);
    expect(
      guards.filter((guard) => (guard.start ?? 0) < (submit[0]!.start ?? 0)).length,
      '提交之前必须验身份（await 期间循环可能已被收掉或顶替）',
    ).toBeGreaterThan(0);
    expect(
      guards.filter((guard) => (guard.start ?? 0) > (submit[0]!.start ?? 0)).length,
      '提交之后也要验一次（发送期间同样可能被收掉）',
    ).toBeGreaterThan(0);
  });

  it('nudge 分支的 prompt 只用局部 loop，不再读模块变量拼内容', () => {
    // 旧实现在 await 之后从 `continuationLoop` 重取任务与执行列表 —— 一旦被顶替，
    // 拼出来的是「另一条循环的任务 + 这一轮的正文」。
    const { program, source } = context();
    const body = findFunctionBody(program, 'handleResponseComplete');
    const nudgePrompt = callsTo(body, 'buildZaiNudgePrompt');
    expect(nudgePrompt).toHaveLength(1);
    const args = source.slice(
      nudgePrompt[0]!.arguments[0]!.start ?? 0,
      nudgePrompt[0]!.arguments[0]!.end ?? 0,
    );
    expect(args).toContain('loop.originalTask');
    expect(args).not.toContain('continuationLoop.originalTask');
  });
});