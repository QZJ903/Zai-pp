import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { findFunctionBody, readContentProgram } from './helpers/content-source-ast';

/**
 * 「提交之后清空输入框」这条链的**接线与顺序**契约。
 *
 * 背景：续跑 / nudge 的 prompt 是我们拼好、写进 `#chat-input`、再让页面自己发的。
 * 页面提交后要等一阵才把输入框清空，那一段里注入的 prompt（正文就是一大段工具结果）
 * 一直挂在输入框上给用户看。修法是「提交触发之后立刻清掉」。
 *
 * ⚠️⚠️ **本文件守的是接线与顺序，不是行为** —— 「提交触发之后，页面是不是真的已经读过值」
 * 这个问题**只有真机实测能答**。当年的实测判据是：在 `requestSubmit()` 返回后的**同一个
 * 同步块**里把 value 改成「原文 + 哨兵」，看页面发出去的那条 body —— 哨兵没进去、
 * 且正文长度与原文逐字相等，才说明页面在提交事件里就同步读完值了。
 * 下面的断言一条都证明不了这件事。
 *
 * ⚠️ **顺序是承重的**：清空必须**晚于**提交触发。清空早于页面读值会把这一次发送打空，
 * 而且失败方向是静默的 —— 请求照发、请求计数照涨、自检全绿，只有正文内容是错的。
 * 所以下面第一条断言按**源码位置**判「清空在提交调用之后」，而不是判「这个名字出现过」。
 *
 * ⚠️ **点按钮那条兜底路是刻意不清空的**（它的读值时序没实测过）——
 * 第三组断言把它钉住，免得以后有人为了「对称」顺手补上。
 */

const CONTENT_SOURCE = 'entrypoints/zai.content.ts';
/** 续跑主路：写值 → 等发送按钮 → `form.requestSubmit()`。 */
const FORM_PATH_FN = 'trySubmitViaFormRequestSubmit';
/** 续跑兜底路：写值 → 点 `#send-message-button`。 */
const DOM_PATH_FN = 'sendPromptPrimitive';
const CLEAR_FN = 'clearInjectedComposerText';
/** 注入期间那层「看不见」（文字透明 + 高度冻住）。 */
const MASK_FN = 'maskComposerForInjection';
const SUBMIT_CALL = 'submitFormViaRequestSubmit';

/** 每次取用都重新解析，避免各用例之间共享可变 AST。 */
function context() {
  const program = readContentProgram(CONTENT_SOURCE);
  return { program, source: readFileSync(CONTENT_SOURCE, 'utf8') };
}

/** 子树里 `obj.prop(...)` 形态的调用点（按方法名收 —— callee 是成员表达式）。 */
function memberCallsTo(node: t.Node, propName: string): t.CallExpression[] {
  const found: t.CallExpression[] = [];
  t.traverseFast(node, (child) => {
    if (!t.isCallExpression(child)) return;
    const callee = child.callee;
    if (t.isMemberExpression(callee) && t.isIdentifier(callee.property, { name: propName })) {
      found.push(child);
    }
  });
  return found;
}

/**
 * 子树里 `name?.(...)` 形态的调用点。
 * ⚠️ **它是 `OptionalCallExpression`、不是 `CallExpression`** —— 只认后者会一个都收不到（假红）。
 */
function optionalCallsTo(node: t.Node, name: string): t.Node[] {
  const found: t.Node[] = [];
  t.traverseFast(node, (child) => {
    const isCall = t.isCallExpression(child) || t.isOptionalCallExpression(child);
    if (!isCall) return;
    const callee = (child as t.CallExpression).callee;
    if (t.isIdentifier(callee) && callee.name === name) found.push(child);
  });
  return found;
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

/** 子树里所有 `if` 语句。 */
function ifStatements(node: t.Node): t.IfStatement[] {
  const found: t.IfStatement[] = [];
  t.traverseFast(node, (child) => {
    if (t.isIfStatement(child)) found.push(child);
  });
  return found;
}

/**
 * 按**判据源码文本**定位 `if`。
 *
 * ⚠️ 取的是 test 节点的**区间文本**（不是全文搜索）—— 全文搜索会被注释里的同名字样骗到。
 */
function ifWithTest(node: t.Node, source: string, testText: string): t.IfStatement[] {
  return ifStatements(node).filter((statement) => {
    const test = statement.test;
    return source.slice(test.start ?? 0, test.end ?? 0) === testText;
  });
}

/** 位置区间包含判定（用节点自带的 start/end，不重解析）。 */
function within(inner: t.Node, outer: t.Node): boolean {
  const a = inner.start ?? -1;
  const b = inner.end ?? -1;
  const c = outer.start ?? -2;
  const d = outer.end ?? -2;
  return a >= c && b <= d;
}

/** 分支体里有没有 `return`（= 提前退出，不会走到后面的提交）。 */
function hasEarlyReturn(statement: t.IfStatement): boolean {
  let found = false;
  t.traverseFast(statement.consequent, (child) => {
    if (t.isReturnStatement(child)) found = true;
  });
  return found;
}

/**
 * 函数体里所有「提前退出」的分支。
 *
 * ⚠️⚠️ **判据的实质是「提交有没有发生过」，不是「清空在不在某个特定的 if 里」** ——
 * 提交之前允许清空，当且仅当这条路径**根本不会提交**（分支体内 `return`）。
 * 早期版本的断言把这条写成了「必须落在 `!sendButton` 那一个分支里」，
 * 于是后来新增的「会话已切走 ⇒ 不提交」出口明明同样满足实质，却被判成违规。
 * ⇒ 判据收窄到实质：**提交之前的清空必须挂在提前退出的分支上**。
 */
function earlyExitBranches(node: t.Node): t.IfStatement[] {
  return ifStatements(node).filter(hasEarlyReturn);
}

describe('composer clear: 清空必须晚于提交触发', () => {
  it('续跑主路的每一次清空，都在提交调用之后或在「不会提交」的提前退出分支里', () => {
    const { program, source } = context();
    const body = findFunctionBody(program, FORM_PATH_FN);

    const submitCalls = callsTo(body, SUBMIT_CALL);
    expect(submitCalls, `应当有 ${SUBMIT_CALL} 的调用点`).toHaveLength(1);
    const submitCall = submitCalls[0]!;

    // `if (!sendButton)` 那条分支里，提交根本没发生 ⇒ 清空没有「抢在页面读值之前」的风险。
    const guard = ifWithTest(body, source, '!sendButton');
    expect(guard.length, '应当有一条 `if (!sendButton)` 分支').toBeGreaterThan(0);

    const clears = callsTo(body, CLEAR_FN);
    expect(clears.length, `${FORM_PATH_FN} 里应当有清空调用`).toBeGreaterThan(0);

    const branches = earlyExitBranches(body);
    const violations = clears
      .filter((call) => (call.start ?? 0) < (submitCall.start ?? 0))
      .filter((call) => !branches.some((branch) => within(call, branch)))
      .map((call) => call.loc?.start.line ?? -1);
    expect(
      violations,
      '这些清空出现在提交调用之前（且不在「不会提交」的提前退出分支里）—— '
      + '页面还没读值就清空会把这次发送打空，且失败方向是静默的',
    ).toEqual([]);
  });

  it('续跑主路的两条失败出口各自都清空', () => {
    const { program, source } = context();
    const body = findFunctionBody(program, FORM_PATH_FN);

    const guard = ifWithTest(body, source, '!sendButton');
    expect(callsTo(guard[0]!, CLEAR_FN), '「没等到发送按钮」分支必须清空').toHaveLength(1);

    const failed = ifWithTest(body, source, "outcome !== 'ok'");
    expect(failed, '应当有一条 `outcome !== \'ok\'` 分支').toHaveLength(1);
    expect(callsTo(failed[0]!, CLEAR_FN), '「提交没触发」分支必须清空').toHaveLength(1);
  });
});

describe('composer clear: 点按钮那条兜底路只在失败时清空', () => {
  it('没有任何一次清空是走无条件路径的', () => {
    const { program } = context();
    const body = findFunctionBody(program, DOM_PATH_FN);

    const clears = callsTo(body, CLEAR_FN);
    expect(clears.length, `${DOM_PATH_FN} 里应当有清空调用`).toBeGreaterThan(0);

    const unconditional = clears
      .filter((call) => !ifStatements(body).some((statement) => within(call, statement)))
      .map((call) => call.loc?.start.line ?? -1);
    expect(
      unconditional,
      '这条路的读值时序没有实测过 ⇒ 清空只能出现在失败分支里；'
      + '无条件清空（含「成功也清」）会把发送打空，且失败方向是静默的',
    ).toEqual([]);
  });

  it('提交触发之后一次都不清空，点之前的清空只挂在「不会点」的提前退出分支里', () => {
    const { program, source } = context();
    const body = findFunctionBody(program, DOM_PATH_FN);

    const guard = ifWithTest(body, source, '!sendButton');
    expect(callsTo(guard[0]!, CLEAR_FN), '「没等到发送按钮」分支必须清空').toHaveLength(1);

    // ⚠️⚠️ **提交之后不再有任何清空分支** —— 三态里这个函数只能拿到 `sent` / `ambiguous`：
    // `sent` 页面自己会清；`ambiguous`（可能已发出）**不能清**，清了会把这次发送打空、
    // 失败方向静默。**`unsent` 不由 `classifySendEvidence` 产出**，它的出口
    // （无 textarea / agent 不空闲 / 点前无发送按钮 / 会话已切走）全在点击**之前**。
    //
    // ⇒ 判据是「**点下去之后一次都不清；点之前的清空必须挂在不会点的分支上**」。
    // ⚠️ 曾经的判据是「清空只能挂在只认 unsent 的条件上」，而那条 `if` 恒假 ——
    // 用例被一条**永远不会执行的**分支喂饱，看着绿、实际什么都没守。
    // **判据要对着「真实可能执行的路径」写**，不是对着「代码里写了什么」。
    const click = memberCallsTo(body, 'click');
    expect(click, '应当有一处点击').toHaveLength(1);
    const branches = earlyExitBranches(body);
    const violations = callsTo(body, CLEAR_FN)
      .filter((call) => (call.start ?? 0) > (click[0]!.start ?? 0))
      .concat(
        callsTo(body, CLEAR_FN)
          .filter((call) => (call.start ?? 0) < (click[0]!.start ?? 0))
          .filter((call) => !branches.some((branch) => within(call, branch))),
      )
      .map((call) => call.loc?.start.line ?? -1);
    expect(
      violations,
      '点击之后的任何清空都是错的（ambiguous 那一发可能已经发出去了）；'
      + '点击之前的清空必须挂在不会点击的提前退出分支里',
    ).toEqual([]);

    // 反面自检：`unsent` 这个字面量不该再以「清空条件」的形式出现。
    // 它出现即说明有人把那条恒假分支加回来了（它永远执行不到，只会误导读者）。
    const unsentGuards = ifStatements(body).filter((statement) => {
      const testText = source.slice(statement.test.start ?? 0, statement.test.end ?? 0);
      return testText.includes("'unsent'");
    });
    expect(
      unsentGuards.map((statement) => statement.loc?.start.line ?? -1),
      '`evidence` 在这个函数里永远不等于 unsent —— 别写这条分支，它执行不到',
    ).toEqual([]);
  });
});

describe('composer mask: 注入期间让输入框「看起来空着」', () => {
  it('这层遮罩只碰外观：不写 value、也不派发 input', () => {
    // ⚠️ 它**不能**退化成「把值清掉」—— 页面 `bind:value` 的反向同步会把值原样写回来
    // （实测），而且写 value 会改掉页面读到的内容。
    const { program } = context();
    const body = findFunctionBody(program, MASK_FN);
    expect(callsTo(body, 'setTextareaValue')).toEqual([]);

    const valueWrites: number[] = [];
    t.traverseFast(body, (node) => {
      if (!t.isAssignmentExpression(node)) return;
      const left = node.left;
      const touchesValue = (t.isMemberExpression(left) && t.isIdentifier(left.property, { name: 'value' }))
        || t.isIdentifier(left, { name: 'value' });
      if (touchesValue) valueWrites.push(node.loc?.start.line ?? -1);
    });
    expect(valueWrites, '这层遮罩只能动外观 —— 写 value 会改掉这一发的内容').toEqual([]);
  });

  it('它确实把文字藏起来，而且是「先存后还原」的写法', () => {
    const { program } = context();
    const body = findFunctionBody(program, MASK_FN);

    const colorCalls = memberCallsTo(body, 'setProperty')
      .filter((call) => t.isStringLiteral(call.arguments[0], { value: 'color' }));
    expect(colorCalls, '应当把 color 设成透明').toHaveLength(1);
    expect(
      t.isStringLiteral(colorCalls[0]!.arguments[1], { value: 'transparent' }),
      'color 的值必须是 transparent',
    ).toBe(true);

    // 还原要成对：读原值 + 覆盖 + 之后按需写回 / 删掉。
    expect(memberCallsTo(body, 'getPropertyValue').length, '应当先读原值').toBeGreaterThan(0);
    expect(memberCallsTo(body, 'removeProperty').length, '没有原值时要删掉自己加的').toBeGreaterThan(0);
  });

  it('两处注入都调它，且都在 finally 里撤销', () => {
    // ⚠️⚠️ **漏一次还原，用户的输入框会一直是透明的** —— 这是这条改动里唯一的重伤面。
    const { program } = context();
    for (const fn of [FORM_PATH_FN, DOM_PATH_FN]) {
      const body = findFunctionBody(program, fn);
      const masks = callsTo(body, MASK_FN);
      expect(masks, `${fn} 应当调用遮罩`).toHaveLength(1);
      const maskCall = masks[0]!;

      // ⚠️ 撤销写的是 `restoreComposerAppearance?.()` ⇒ 是 OptionalCallExpression，
      // 只认普通 CallExpression 会一个都收不到（假红）。
      const tries: t.TryStatement[] = [];
      t.traverseFast(body, (node) => {
        if (t.isTryStatement(node)) tries.push(node);
      });
      const guarded = tries.filter((node) => {
        const finalizer = node.finalizer;
        if (!finalizer) return false;
        const covers = (maskCall.start ?? 0) >= (node.start ?? 0)
          && (maskCall.end ?? 0) <= (node.end ?? 0);
        return covers && optionalCallsTo(finalizer, 'restoreComposerAppearance').length > 0;
      });
      expect(guarded.length, `${fn} 的遮罩必须有一个带撤销的 finally 兜着`).toBeGreaterThan(0);
    }
  });

  it('两处注入锁过的 disabled 也必须在 finally 里还回去', () => {
    // ⚠️⚠️ **与遮罩同性质的一条**：注入期间把 `textarea.disabled` 置真，离开时必须还原。
    // 正常出口在提交触发后就恢复了，但中间任何一处抛错（`setTextareaValue` 的
    // `dispatchEvent`、`submitFormViaRequestSubmit`、证据等待）都会跳过它 ⇒
    // **输入框永久停在 disabled**，用户只能刷新页面。
    //
    // 判据走三件事：① 函数里有一个 `lockedTextarea` 变量；② 赋值处与 finally 在同一个
    // try 里；③ finally 里对 `lockedTextarea.disabled` 有赋值。
    const { program } = context();
    for (const fn of [FORM_PATH_FN, DOM_PATH_FN]) {
      const body = findFunctionBody(program, fn);

      // ① 声明 `lockedTextarea`
      let declared = false;
      let assigned: t.Node | null = null;
      t.traverseFast(body, (node) => {
        if (!t.isVariableDeclarator(node) || !t.isIdentifier(node.id)) return;
        if (node.id.name !== 'lockedTextarea') return;
        declared = true;
      });
      expect(declared, `${fn} 应当声明 lockedTextarea`).toBe(true);

      // ② 找 `lockedTextarea = textarea` 的赋值位置
      t.traverseFast(body, (node) => {
        if (!t.isAssignmentExpression(node)) return;
        const left = node.left;
        if (t.isIdentifier(left, { name: 'lockedTextarea' })) assigned = node;
      });
      expect(assigned, `${fn} 应当把锁过的输入框记进 lockedTextarea`).toBeTruthy();

      // ③ 那个 finally 覆盖赋值点，且里面给 `lockedTextarea.disabled` 写过值
      const tries: t.TryStatement[] = [];
      t.traverseFast(body, (node) => {
        if (t.isTryStatement(node)) tries.push(node);
      });
      const guarded = tries.filter((node) => {
        if (!node.finalizer) return false;
        if (!within(assigned!, node)) return false;
        let restores = false;
        t.traverseFast(node.finalizer, (child) => {
          if (!t.isAssignmentExpression(child)) return;
          const left = child.left;
          if (!t.isMemberExpression(left)) return;
          if (t.isIdentifier(left.object, { name: 'lockedTextarea' })
            && t.isIdentifier(left.property, { name: 'disabled' })) {
            restores = true;
          }
        });
        return restores;
      });
      expect(guarded.length, `${fn} 的 lockedTextarea 必须有一个 finally 把 disabled 还回去`).toBeGreaterThan(0);
    }
  });
});

describe('composer mask: 撤得够早', () => {
  it('表单主路在把输入框交还给用户之前就必须撤掉遮罩', () => {
    // ⚠️⚠️ 表单主路清了之后立刻 `disabled = wasDisabled`（输入框归用户），
    // 而后面还有一段最长 5 秒的证据等待 ⇒ 遮罩若留到函数末尾才撤，
    // 用户在那段里打的字是**透明的、还被裁着**（字不丢，但看不见自己打了什么）。
    const { program } = context();
    const body = findFunctionBody(program, FORM_PATH_FN);

    const releases = optionalCallsTo(body, 'restoreComposerAppearance');
    expect(releases.length, '至少两处：交还之前一处 + finally 兜底一处').toBeGreaterThanOrEqual(2);

    const waits = callsTo(body, 'waitForSendEvidence');
    expect(waits, '应当有一处证据等待').toHaveLength(1);
    const releasedBeforeWait = releases.filter(
      (call) => ((call as t.Node).start ?? 0) < (waits[0]!.start ?? 0),
    );
    expect(releasedBeforeWait.length, '必须在证据等待之前撤一次').toBeGreaterThan(0);
  });

  it('那一次提前撤销必须在无条件路径上（挪进失败分支不算）', () => {
    // ⚠️ 只要求「有一处撤销在证据等待之前」是不够的：把提前撤销挪进 `if (!sendButton)`
    // 那条失败分支（位置同样在等待之前）照样绿，而成功路径就只剩 finally 那一处 ——
    // 正是这条要防的形态。所以判据要收到「清空之后、等待之前、且不在任何 if 里」。
    const { program } = context();
    const body = findFunctionBody(program, FORM_PATH_FN);
    const releases = optionalCallsTo(body, 'restoreComposerAppearance');
    const clears = callsTo(body, CLEAR_FN);
    const waits = callsTo(body, 'waitForSendEvidence');
    expect(clears.length, '应当有清空调用').toBeGreaterThan(0);
    expect(waits, '应当有一处证据等待').toHaveLength(1);

    const lastClearEnd = Math.max(...clears.map((call) => call.end ?? 0));
    const waitStart = waits[0]!.start ?? 0;
    const between = releases.filter((call) => {
      const start = (call as t.Node).start ?? 0;
      return start > lastClearEnd && start < waitStart;
    });
    expect(between.length, '清空之后、证据等待之前必须有一处撤销').toBeGreaterThan(0);

    const conditional = between.filter((call) => {
      const node = call as t.Node;
      return ifStatements(body).some((statement) => within(node, statement));
    });
    expect(
      conditional,
      '这一处撤销必须在无条件路径上 —— 挪进失败分支后，成功路径就只剩 finally 那一处',
    ).toEqual([]);
  });
});

describe('composer mask: 还原只撤我们写的那一份', () => {
  it('还原里必须先读当前值再决定撤不撤', () => {
    // ⚠️ 遮罩窗口里页面自己可能改过其中某项（切主题改 color、自动增高改 max-height）。
    // 无条件写回会把它的改动覆回我们保存的旧值 ⇒ 还原函数里必须有「读当前值 → 不一致就跳过」。
    const { program } = context();
    const body = findFunctionBody(program, MASK_FN);

    let restoreInit: t.Expression | null | undefined = null;
    t.traverseFast(body, (node) => {
      if (!t.isVariableDeclarator(node)) return;
      if (!t.isIdentifier(node.id, { name: 'restore' })) return;
      restoreInit = node.init;
    });
    expect(restoreInit, '应当有一个叫 restore 的撤销函数').not.toBeNull();
    expect(
      memberCallsTo(restoreInit as unknown as t.Node, 'getPropertyValue').length,
      '还原函数里必须先读当前值（否则会无条件覆回旧值）',
    ).toBeGreaterThan(0);
  });

  it('撤销函数要先建好、再写样式（写一半抛错不能留下永久透明）', () => {
    const { program } = context();
    const body = findFunctionBody(program, MASK_FN);

    const setCalls = memberCallsTo(body, 'setProperty');
    expect(setCalls.length).toBeGreaterThan(0);
    const firstSet = Math.min(...setCalls.map((call) => call.start ?? 0));

    let restoreStart: number | null = null;
    t.traverseFast(body, (node) => {
      if (!t.isVariableDeclarator(node)) return;
      if (!t.isIdentifier(node.id, { name: 'restore' })) return;
      restoreStart = node.start ?? null;
    });
    expect(restoreStart, '应当有一个叫 restore 的撤销函数').not.toBeNull();
    expect(restoreStart!, '撤销函数必须先于任何样式写入成型').toBeLessThan(firstSet);

    // 写样式的失败分支里必须调一次还原。
    const tries: t.TryStatement[] = [];
    t.traverseFast(body, (node) => {
      if (t.isTryStatement(node)) tries.push(node);
    });
    const guarded = tries.filter((node) => {
      const handler = node.handler;
      if (!handler) return false;
      const coversSet = setCalls.some((call) => within(call, node));
      return coversSet && callsTo(handler.body, 'restore').length > 0;
    });
    expect(guarded.length, '写样式必须包在 try 里，且 catch 要先还原').toBeGreaterThan(0);
  });
});

describe('composer clear: 清空本身的写法', () => {
  it('只把值写成空串，并走写入侧同一个原语', () => {
    const { program } = context();
    const body = findFunctionBody(program, CLEAR_FN);

    const writes = callsTo(body, 'setTextareaValue');
    expect(writes, '清空必须复用写入侧原语（直接赋 value 会让页面 bound-value 留在旧值上）')
      .toHaveLength(1);

    const text = writes[0]!.arguments[1];
    expect(t.isStringLiteral(text) && text.value === '', '清空写入的必须是空串').toBe(true);
  });

  it('`waitForComposerCleared` 不得回归', () => {
    const { program } = context();
    // 它的判据是「输入框被清空」。自己清空之后这条判据恒真，
    // 拿它当「发送成功」的依据等于没有依据 —— 已经整体删除，别再写回来。
    // ⚠️ 判据取**调用点**而不是全文搜名字：注释里提到它（比如说明为什么删）是合法的。
    expect(callsTo(program, 'waitForComposerCleared')).toEqual([]);
  });
});