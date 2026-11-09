import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as t from '@babel/types';
import {
  findFunctionBody,
  readContentProgram,
  walkReachable,
} from './helpers/content-source-ast';
import { walkSourceAst } from './helpers/typescript-source';

/**
 * **两个事件唤醒源必须接在正确的位置上** —— 方案一（把轮询改成事件驱动）的接线守卫。
 *
 * ## 为什么这两条只能留在 AST 层
 *
 * 等待方（`waitForNotified` / `waitForAgentIdle`）本身有行为测试
 * （`tests/zai-event-wait.test.ts`，含「定时器被压到 1000ms 时仍立即返回」那条主判据）。
 * 但**「谁在什么时候叫醒它们」这两个接线点在 `zai.content.ts` 里**，而那个文件
 * 加载即执行 `defineContentScript`、不能被 import ⇒ 行为测试够不到。
 *
 * ⚠️⚠️ **实测过：删掉任一 `notify()`，全量测试仍然全绿** —— 所以这两条断言补的是
 * 一个真实的覆盖空洞，不是为了凑数。
 *
 * ## 判据为什么这么写（接线断言必须四条同时成立，且 AST 断言有已知绕过形态）
 *
 * 光断言「源码里出现过 `x.notify()`」**一点用都没有**（把调用挪进死函数照样过）。
 * 这里钉的是三件事：
 * ① 调用落在**该函数的函数体范围内**（`findFunctionBody` 只认顶层声明 ⇒ 免疫嵌套诱饵）；
 * ② 位置关系正确（计数器那条必须**晚于**两次自增；Stop 那条必须在 observer 回调里）；
 * ③ 那个函数体里**确实还有**它要唤醒的对应写入点（删了自增就没意义了）。
 *
 * ⚠️ **残余绕过面**（已实测、已接受）：把 `notify()` 包进一个嵌套的、永不调用的函数里，
 * 位置断言照样通过。这与 `send-evidence` 那条是同一类残余，根治只能靠真机。
 */

/** 某个函数体里所有 `对象.方法(...)` 调用的**字符位置**。 */
function methodCallPositions(
  body: t.Node,
  objectName: string,
  methodName: string,
): number[] {
  const positions: number[] = [];
  // ⚠️ **用全遍历（`walkSourceAst`）而不是 `walkReachable`** —— 后者遇到函数体边界
  // 就停，而这两个被守的调用**本来就住在箭头函数里**（observer 回调 / Promise executor）。
  // 「免疫嵌套诱饵」那一半由 `findFunctionBody` 保证：它只认 `program.body` 的顶层声明。
  walkSourceAst(body, (node) => {
    if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
    const callee = node.callee;
    if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return;
    if (!t.isIdentifier(callee.object, { name: objectName })) return;
    if (!t.isIdentifier(callee.property, { name: methodName })) return;
    if (typeof node.start === 'number') positions.push(node.start);
  });
  return positions.sort((a, b) => a - b);
}

/** 某个函数体里所有「给这个标识符赋值 / 自增」的**字符位置**。 */
function writePositions(body: t.Node, name: string): number[] {
  const positions: number[] = [];
  walkSourceAst(body, (node) => {
    // `x += 1` / `x = …`
    if (t.isAssignmentExpression(node)
      && t.isIdentifier(node.left, { name })
      && typeof node.start === 'number') {
      positions.push(node.start);
      return;
    }
    // `x += 1` 的另一种 AST 形态（自增运算符不用于数值增量时少见，但收上）。
    if (t.isUpdateExpression(node)
      && t.isIdentifier(node.argument, { name })
      && typeof node.start === 'number') {
      positions.push(node.start);
    }
  });
  return positions.sort((a, b) => a - b);
}

describe('aug progress wake-up wiring', () => {
  /**
   * **计数器变了要叫醒等待者，而且必须在两个自增都做完之后。**
   *
   * 唤醒点必须在 `dispatchMainWorldMessage` 的**同步区**（串行队列之外）——
   * 等它的代码正占着队列，在队列内 notify 等于让它等自己（自锁）。
   * 这条不变式写在 `augProgressWaiters` 的注释里，这里是它的守卫。
   */
  it('notifies the aug-progress waiters after both counters advance', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'dispatchMainWorldMessage');

    const observedWrites = writePositions(body, 'observedAugRequestCount');
    const continuationWrites = writePositions(body, 'continuationRequestSeq');
    expect(observedWrites.length, '应当给 observedAugRequestCount 赋值').toBeGreaterThan(0);
    expect(continuationWrites.length, '应当给 continuationRequestSeq 赋值').toBeGreaterThan(0);

    const notifies = methodCallPositions(body, 'augProgressWaiters', 'notify');
    expect(notifies.length, 'dispatchMainWorldMessage 里必须恰好有一处 augProgressWaiters.notify()').toBe(1);

    const lastWrite = Math.max(...observedWrites, ...continuationWrites);
    expect(
      notifies[0],
      'augProgressWaiters.notify() 必须晚于两个计数器的自增（先记账、再叫醒）',
    ).toBeGreaterThan(lastWrite);
  });

  /**
   * **`notify()` 不能被挪进串行队列的任务里。**
   *
   * ⚠️ 这是上一条的补充判据：位置晚于自增还不够 —— 若整段被挪进
   * `mainWorldQueue.run(() => { … })` 的回调里，位置仍然晚于自增，但会在队列内执行
   * ⇒ 等待方占着队列等它，自锁。
   *
   * 判据：`notify()` 的位置必须**早于**该函数里第一次 `mainWorldQueue.run(` 的位置。
   */
  it('notifies before the serial queue is entered, not inside it', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'dispatchMainWorldMessage');

    const notifies = methodCallPositions(body, 'augProgressWaiters', 'notify');
    expect(notifies).toHaveLength(1);

    const queueRuns = methodCallPositions(body, 'mainWorldQueue', 'run');
    if (queueRuns.length === 0) return;   // 没有队列调用时这条判据不适用（未来重构）
    expect(
      notifies[0],
      'augProgressWaiters.notify() 必须在进入串行队列之前（队列内 notify ⇒ 等待方等自己 ⇒ 自锁）',
    ).toBeLessThan(queueRuns[0]);
  });
});

describe('stop-state wake-up wiring', () => {
  /**
   * **Stop 出现/消失要叫醒 `waitForAgentIdle` 的等待者。**
   *
   * 判据：`stopStateWaiters.notify()` 必须落在 `installStopObserver` 的函数体里，
   * 且**晚于**它对 `lastStopButtonGoneAt` 的赋值（先更新状态、再叫醒 ——
   * 反过来的话被唤醒者读到的还是旧时间戳，会再等一轮）。
   */
  it('notifies the stop-state waiters from inside the stop observer', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'installStopObserver');

    const notifies = methodCallPositions(body, 'stopStateWaiters', 'notify');
    expect(notifies.length, 'installStopObserver 里必须恰好有一处 stopStateWaiters.notify()').toBe(1);

    const goneWrites = writePositions(body, 'lastStopButtonGoneAt');
    // ⚠️ **两处赋值**：回调体内的那次 + 安装末尾的初始快照。顺序判据只在
    // 下一条（回调体内）里比 —— 在这里和 max 比会被末尾那次干扰成假红。
    expect(
      goneWrites.length,
      'lastStopButtonGoneAt 应当有「回调内记录消失」与「安装时初始快照」两处赋值',
    ).toBeGreaterThanOrEqual(2);
  });

  /**
   * **那个 notify 必须真的在 observer 的回调里，不能在函数体末尾。**
   *
   * ⚠️ 单看位置还不够：`installStopObserver` 末尾也有一句
   * `lastStopButtonGoneAt = …`（初始快照），把 notify 放到那之后位置判据照样过，
   * 但它**永远不会被执行**（那段只在装 observer 时跑一次）。
   * ⇒ 判据：notify 必须在传给 `new MutationObserver(...)` 的那个箭头函数体内。
   */
  it('the notify call lives inside the MutationObserver callback, not after it', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'installStopObserver');

    let callbackBody: t.Node | null = null;
    walkReachable(body, (node) => {
      if (!t.isNewExpression(node)) return;
      if (!t.isIdentifier(node.callee, { name: 'MutationObserver' })) return;
      const [callback] = node.arguments;
      if (t.isArrowFunctionExpression(callback) || t.isFunctionExpression(callback)) {
        callbackBody = callback.body;
      }
    });
    expect(callbackBody, 'installStopObserver 里应当 new MutationObserver(<回调>)').not.toBeNull();

    const inCallback = methodCallPositions(callbackBody!, 'stopStateWaiters', 'notify');
    expect(
      inCallback.length,
      'stopStateWaiters.notify() 必须在 MutationObserver 的回调体内（放在函数末尾永远不会执行）',
    ).toBe(1);

    // ⚠️ **先更新状态、再叫醒** —— 反过来的话被唤醒者读到的是旧时间戳，会白等一轮。
    const goneInCallback = writePositions(callbackBody!, 'lastStopButtonGoneAt');
    expect(goneInCallback.length, '回调体里应当记录 lastStopButtonGoneAt').toBeGreaterThan(0);
    expect(
      inCallback[0],
      'notify() 必须晚于回调体里对 lastStopButtonGoneAt 的赋值',
    ).toBeGreaterThan(Math.max(...goneInCallback));
  });
});

describe('the waiters themselves are still wired to the registries', () => {
  /**
   * **等待方必须把自己登记到对应的 registry 上**，否则 notify 叫不醒任何人。
   *
   * ⚠️ 这两条守的是「换个写法但漏了订阅」这类改动 —— 例如把
   * `waitForNotified(..., augProgressWaiters)` 改成别的实现、或把
   * `stopStateWaiters.add(check)` 删掉。它们与 `zai-event-wait.test.ts` 的
   * 行为测试互补：那边测「登记了就会被叫醒」，这边测「到底有没有登记」。
   */
  it('waitForNewAugRequest and waitForSendEvidence subscribe through the aug registry', () => {
    const program = readContentProgram();
    const source = readSource();

    // 两处都必须把 `augProgressWaiters` 作为第三个实参传给 `waitForNotified`。
    let subscriptions = 0;
    walkSourceAst(program, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      if (node.callee.name !== 'waitForNotified') return;
      const third = node.arguments[2];
      if (t.isIdentifier(third, { name: 'augProgressWaiters' })) subscriptions += 1;
    });
    expect(
      subscriptions,
      'waitForNotified 的两次调用都必须把 augProgressWaiters 传进去（否则等不到唤醒）',
    ).toBe(2);
    expect(source).toContain('createWaiterRegistry');
  });

  it('waitForAgentIdle subscribes to the stop registry', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'waitForAgentIdle');

    const adds = methodCallPositions(body, 'stopStateWaiters', 'add');
    expect(
      adds.length,
      'waitForAgentIdle 必须把自己登记到 stopStateWaiters（否则 Stop 变化叫不醒它）',
    ).toBe(1);

    /**
     * ⚠️⚠️ **登记之后必须能撤销** —— 漏了退订会让登记表随每次等待增长
     * （`stopStateWaiters` 是模块级 Set，只增不减就是泄漏）。
     *
     * ⚠️ 原判据是 `expect(source).toContain('unsubscribe')` —— **假绿**：
     * 把 `cleanup()` 里的 `unsubscribe();` 删掉，另一处赋值还在，测试仍绿（实测过）。
     * ⇒ 判据收窄到：`cleanup` 函数体里**必须有一条裸的 `unsubscribe();` 调用**。
     */
    let cleanupBody: t.BlockStatement | null = null;
    walkSourceAst(body, (node) => {
      if (!t.isVariableDeclarator(node)) return;
      if (!t.isIdentifier(node.id, { name: 'cleanup' })) return;
      if (node.init && t.isArrowFunctionExpression(node.init) && t.isBlockStatement(node.init.body)) {
        cleanupBody = node.init.body;
      }
    });
    expect(cleanupBody, 'waitForAgentIdle 里应当有 `const cleanup = () => { … }`').not.toBeNull();

    const unsubscribeCalls = directCallPositions(cleanupBody!, 'unsubscribe');
    expect(
      unsubscribeCalls.length,
      'cleanup 里必须有 `unsubscribe()` 调用 —— 只赋值不调用等于登记表只增不减',
    ).toBeGreaterThan(0);
  });
});

/** 读一次源码原文（个别判据只能看字符串）。 */
function readSource(): string {
  return readFileSync('entrypoints/zai.content.ts', 'utf8');
}

describe('long-window keepalive wiring', () => {
  /**
   * **长窗口期间 `releaseTabKeepAlive` 必须早退** ——
   * 每个发送轮次的 `finally` 都会调它，不拦的话长窗口会被第一个发完的轮次摘掉
   * （表现是「任务还在跑、横幅没了」）。
   *
   * ⚠️ 这条是 AST 层，因为它住在 `zai.content.ts`（不能被 import）。判据收窄到
   * 「函数体**第一条**语句就是那个早退」—— 放在中间等于有些路径仍会发 STOP。
   */
  it('releaseTabKeepAlive returns early while the sustained window is on', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'releaseTabKeepAlive');
    const [first] = body.body;

    expect(t.isIfStatement(first), 'releaseTabKeepAlive 的第一条语句必须是那个早退').toBe(true);
    if (!t.isIfStatement(first)) throw new Error('unreachable');
    expect(
      t.isIdentifier(first.test, { name: 'sustainedKeepAlive' }),
      '早退判据必须是 `if (sustainedKeepAlive) return;`',
    ).toBe(true);
    expect(t.isReturnStatement(first.consequent), '那个 if 里必须是 return').toBe(true);
  });

  /**
   * **`finishContinuationLoop` 里「先复位长窗口、再卸保活」** ——
   * 反过来的话 `releaseTabKeepAlive` 会因为 `sustainedKeepAlive` 还是 true 而直接返回，
   * 那条 debugger 会话就留在那儿（横幅永久挂着）。
   */
  it('finishContinuationLoop resets the sustained window before releasing', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'finishContinuationLoop');

    const resets = directCallPositions(body, 'stopSustainedKeepAliveWatch');
    const releases = directCallPositions(body, 'releaseTabKeepAlive');
    expect(resets.length, 'finishContinuationLoop 里应当调 stopSustainedKeepAliveWatch').toBeGreaterThan(0);
    expect(releases.length, '...也应当调 releaseTabKeepAlive').toBeGreaterThan(0);
    expect(
      Math.min(...resets),
      'stopSustainedKeepAliveWatch 必须早于 releaseTabKeepAlive（顺序反了会让会话留在那儿）',
    ).toBeLessThan(Math.min(...releases));
  });

  /**
   * **顶替路径必须传 `preserveKeepAlive: true`** ——
   * 顶替的典型成因是「用户手发一条消息」，新循环马上要发送，不该从 3 分钟重新计时；
   * 而且「先卸再挂」的两条命令没有顺序保证（STOP 后到会把 START 摘掉）。
   */
  /**
   * **`preserveKeepAlive` 必须真的改变行为，不能只是「传了」** ——
   * 实测：删掉 `finishContinuationLoop` 里那两个 `if (!options?.preserveKeepAlive)`
   * 之后，全量测试**仍然全绿**（选项变成纯装饰）。
   *
   * ⇒ 判据：那两处调用（`stopSustainedKeepAliveWatch` / `releaseTabKeepAlive`）
   * **必须各自被一个 `if (!options?.preserveKeepAlive)` 包住**，且条件形态一致。
   */
  it('finishContinuationLoop actually skips both steps when preserveKeepAlive is set', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'finishContinuationLoop');

    /** 收集「直接调用某函数」的位置，以及它是否被 preserveKeepAlive 门包着。 */
    const guardedCalls = (name: string): { positions: number[]; guarded: number[] } => {
      const positions: number[] = [];
      const guarded: number[] = [];
      walkSourceAst(body, (node) => {
        if (!t.isIfStatement(node)) return;
        // 判据形态：`!options?.preserveKeepAlive`
        const test = node.test;
        const isOurGuard = t.isUnaryExpression(test, { operator: '!' })
          && t.isOptionalMemberExpression(test.argument)
          && t.isIdentifier(test.argument.object, { name: 'options' })
          && t.isIdentifier(test.argument.property, { name: 'preserveKeepAlive' });
        if (!isOurGuard) return;
        // 门体里（consequent）如果直接调了这个函数，就算被守住了
        walkSourceAst(node.consequent, (inner) => {
          if (!t.isCallExpression(inner)) return;
          if (!t.isIdentifier(inner.callee, { name })) return;
          if (typeof inner.start === 'number') guarded.push(inner.start);
        });
      });
      positions.push(...directCallPositions(body, name));
      return { positions, guarded };
    };

    for (const name of ['stopSustainedKeepAliveWatch', 'releaseTabKeepAlive']) {
      const { positions, guarded } = guardedCalls(name);
      expect(positions.length, `finishContinuationLoop 里应当调 ${name}`).toBeGreaterThan(0);
      expect(
        guarded.length,
        `${name} 必须被 \`if (!options?.preserveKeepAlive)\` 包住 —— 否则 preserveKeepAlive 是纯装饰（实测漏过）`,
      ).toBe(positions.length);
    }
  });

  it('supersedeRunningLoop preserves the keepalive window for the next loop', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'supersedeRunningLoop');

    let preserved = false;
    walkSourceAst(body, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      if (node.callee.name !== 'finishContinuationLoop') return;
      const [, options] = node.arguments;
      if (!t.isObjectExpression(options)) return;
      for (const property of options.properties) {
        if (!t.isObjectProperty(property)) continue;
        if (!t.isIdentifier(property.key, { name: 'preserveKeepAlive' })) continue;
        if (t.isBooleanLiteral(property.value, { value: true })) preserved = true;
      }
    });
    expect(
      preserved,
      'supersedeRunningLoop 调 finishContinuationLoop 时必须传 { preserveKeepAlive: true }',
    ).toBe(true);
  });

  /**
   * **`waitForAgentIdle` 登记完必须立刻跑一次 `check()`** ——
   * 否则「已经停下、但距 `lastStopButtonGoneAt` 不足 150ms」这一格**没有任何定时器在跑**
   * （`graceTimer` 只在 `check` 里才建），只能等下一次 Stop 观察器回调或整个 deadline。
   * 而首调必然命中（`installStopObserver` 把 `lastStopButtonGoneAt` 初始化为 `Date.now()`），
   * 页面上再没有 Stop 节点增删时一次 notify 都不会来 ⇒ **白等满一个 deadline**。
   *
   * ⚠️ 变异实测：删掉那一行，**全量 2082 条测试仍然全绿** —— 所以必须有这条断言。
   */
  it('waitForAgentIdle runs check() once right after subscribing', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'waitForAgentIdle');

    const subscribes = methodCallPositions(body, 'stopStateWaiters', 'add');
    expect(subscribes.length, '应当把 check 登记进 stopStateWaiters').toBe(1);

    // ⚠️⚠️ **判据必须收窄到「裸调用语句」，不能用「`check` 这个名字出现在任何位置」** ——
    // 实测：把它改成 `setTimeout(() => check(), 0);` 全绿漏过，而后台标签里
    // `setTimeout(0)` 会被压到 1000ms ⇒ **等于把这条修复退回去**。
    // ⇒ 要求它是一条 `ExpressionStatement`，且 `expression` 恰好是 `check()`，
    //    并**不在任何函数体边界之内**（这里该用 `walkReachable`，与 `methodCallPositions` 相反）。
    // 找到 `new Promise(...)` 的 executor，只看它的**直接子语句**。
    // ⚠️ 不能用 `walkReachable(body)` —— 它在箭头函数边界就停，而 `check()` 正住在
    // executor 里，那样会假红（实测踩过）。也不能用全遍历 —— 那样
    // `setTimeout(() => { check(); }, 0)` 里的 `check();` 也会被算进来（假绿）。
    let executorBody: t.BlockStatement | null = null;
    walkSourceAst(body, (node) => {
      if (!t.isNewExpression(node)) return;
      if (!t.isIdentifier(node.callee, { name: 'Promise' })) return;
      const [executor] = node.arguments;
      if (!t.isArrowFunctionExpression(executor) && !t.isFunctionExpression(executor)) return;
      if (t.isBlockStatement(executor.body)) executorBody = executor.body;
    });
    expect(executorBody, 'waitForAgentIdle 里应当有 new Promise(<executor>)').not.toBeNull();

    const bareCalls: number[] = [];
    for (const statement of (executorBody as unknown as t.BlockStatement).body) {
      if (!t.isExpressionStatement(statement)) continue;
      const expression = statement.expression;
      if (!t.isCallExpression(expression)) continue;
      if (!t.isIdentifier(expression.callee, { name: 'check' })) continue;
      if (expression.arguments.length !== 0) continue;
      if (typeof statement.start === 'number') bareCalls.push(statement.start);
    }
    expect(
      bareCalls.length,
      'waitForAgentIdle 里必须有一条裸的 `check();` 语句（不能用 setTimeout/箭头包起来 —— 那会被后台节流压到 1000ms）',
    ).toBe(1);
    expect(
      bareCalls[0],
      'check() 必须在 `stopStateWaiters.add(check)` 之后（先登记、再首调）',
    ).toBeGreaterThan(subscribes[0]);
  });

  /**
   * **`startSustainedKeepAliveWatch` 要继承已开启的长窗口** ——
   * 新循环不该把长窗口降级回短窗口（那会有最长 3 分钟的保护缺口）。
   */
  /**
   * **两条建循环的路径都必须真的起计时** ——
   * 实测：删掉 `handleResponseComplete` 里那处调用，全量测试**仍然全绿**。
   * （`findFunctionBody` 有「零调用点即抛」的保护，但两处删一处仍剩一处 ⇒ 挡不住。）
   */
  it('both loop-creation paths start the sustained keepalive watch', () => {
    const program = readContentProgram();
    for (const fn of ['handleResponseComplete', 'startMisuseCorrectionLoop']) {
      const body = findFunctionBody(program, fn);
      const calls = directCallPositions(body, 'startSustainedKeepAliveWatch');
      expect(
        calls.length,
        `${fn} 必须调 startSustainedKeepAliveWatch（否则长任务永远不转长窗口）`,
      ).toBeGreaterThan(0);
    }
  });

  /**
   * **定时器体要真的做事** —— 只起一个 `setTimeout` 但没有回调体是没有意义的。
   * 判据：`setTimeout` 的第一个实参（回调）里既有 `sustainedKeepAlive = true` 也有 `wantTabKeepAlive()`。
   *
   * ⚠️ 以及那个「到期复检」必须在：循环可能早已收尾，回调不该给一条死循环挂保活。
   */
  it('the sustained timer body engages keepalive and re-checks the loop is alive', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'startSustainedKeepAliveWatch');

    let callback: t.Node | null = null;
    walkSourceAst(body, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee, { name: 'setTimeout' })) return;
      const [first] = node.arguments;
      if (t.isArrowFunctionExpression(first) || t.isFunctionExpression(first)) callback = first.body;
    });
    expect(callback, 'startSustainedKeepAliveWatch 里应当有一个 setTimeout 回调').not.toBeNull();

    // ① 置位长窗口
    const assigns: string[] = [];
    walkSourceAst(callback!, (node) => {
      if (!t.isAssignmentExpression(node)) return;
      if (t.isIdentifier(node.left)) assigns.push(node.left.name);
      if (t.isIdentifier(node.right, { name: 'true' })) { /* noop */ }
    });
    expect(assigns, '回调里必须 `sustainedKeepAlive = true`').toContain('sustainedKeepAlive');

    // ② 真的去挂保活
    expect(
      directCallPositions(callback!, 'wantTabKeepAlive').length,
      '回调里必须调 wantTabKeepAlive()（只置标记不挂会话等于没生效）',
    ).toBeGreaterThan(0);

    // ③ 到期复检：循环可能已经收尾
    let rechecks = false;
    walkSourceAst(callback!, (node) => {
      if (!t.isIfStatement(node)) return;
      let mentionsLoop = false;
      walkSourceAst(node.test, (inner) => {
        if (t.isIdentifier(inner, { name: 'continuationLoop' })) mentionsLoop = true;
      });
      if (mentionsLoop && t.isReturnStatement(node.consequent)) rechecks = true;
    });
    expect(
      rechecks,
      '回调开头必须复检 `continuationLoop !== loop` 并 return —— 否则会给已收尾的循环挂保活',
    ).toBe(true);

    // ④ 延迟必须是那个常量，不是别的值（改成 Infinity 就等于永不触发）
    const source = readSource();
    expect(
      source.includes('}, SUSTAINED_KEEPALIVE_AFTER_MS);'),
      'setTimeout 的延迟必须是 SUSTAINED_KEEPALIVE_AFTER_MS（改成 Infinity / 写死别的值都等于永不触发或过早触发）',
    ).toBe(true);
  });

  it('startSustainedKeepAliveWatch inherits an already-engaged window', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'startSustainedKeepAliveWatch');

    let inherits = false;
    for (const statement of body.body) {
      if (!t.isIfStatement(statement)) continue;
      if (!t.isIdentifier(statement.test, { name: 'sustainedKeepAlive' })) continue;
      inherits = t.isReturnStatement(statement.consequent)
        || (t.isBlockStatement(statement.consequent)
          && statement.consequent.body.some((inner) => t.isReturnStatement(inner)));
    }
    expect(inherits, 'startSustainedKeepAliveWatch 必须先判 `if (sustainedKeepAlive) { ... return; }`').toBe(true);
  });
});

/** 某个函数体里「直接」调某个函数的位置（不是 `对象.方法` 形态）。 */
function directCallPositions(body: t.Node, name: string): number[] {
  const positions: number[] = [];
  walkSourceAst(body, (node) => {
    if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
    if (!t.isIdentifier(node.callee, { name })) return;
    if (typeof node.start === 'number') positions.push(node.start);
  });
  return positions.sort((a, b) => a - b);
}

describe('stop observer install robustness', () => {
  /**
   * **`document.body` 为空时不能置「已安装」** ——
   * 置了之后 `installStopObserver` 永远直接 return，观察器**再也不会被装上**。
   * 本轮改动把这一格从「轮询自愈」变成「永不安装」⇒ 必须有一条断言。
   */
  it('does not mark itself installed when there is no observable root', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'installStopObserver');

    const writes = writePositions(body, 'stopObserverInstalled');
    expect(writes.length, '应当给 stopObserverInstalled 赋值').toBeGreaterThan(0);

    // ⚠️ 判据：那次赋值必须在 `if (!document.body) return;` **之后**。
    let guardPosition: number | null = null;
    for (const statement of body.body) {
      if (!t.isIfStatement(statement)) continue;
      if (!t.isUnaryExpression(statement.test, { operator: '!' })) continue;
      const argument = statement.test.argument;
      if (!t.isMemberExpression(argument)) continue;
      if (!t.isIdentifier(argument.object, { name: 'document' })) continue;
      if (!t.isIdentifier(argument.property, { name: 'body' })) continue;
      guardPosition = statement.start ?? null;
      break;
    }
    expect(guardPosition, '应当有 `if (!document.body) return;` 这道门').not.toBeNull();
    expect(
      Math.min(...writes),
      'stopObserverInstalled 必须在「document.body 存在」的检查之后才置位（否则永不重试）',
    ).toBeGreaterThan(guardPosition!);
  });

  /**
   * **上面那条不够**（已实测复现）：
   * 把置位改成 `if (!document.body) { stopObserverInstalled = true; return; }`
   * —— 那**就是原缺陷本身**，而位置比较照样绿（写在 `if` 块内，`node.start` 仍大于 `if` 的 start）。
   * 这正是源码级断言的一个通病：**位置比较只能定位到语句边界，碰不到「同一语句内部」的语义**
   * —— 判据扫得越宽（比如只比 `node.start` 的先后），越容易被同一语句里的写法骗过；
   * 反过来收得太窄又会漏掉合法写法。所以断言的目标必须收窄到**承载语义的那一行 / 那个属性**上。
   *
   * ⇒ 这条补两件事：① 门必须**恰好**是 `if (!document.body) return;`（裸 return，不许块）；
   *   ② `stopObserverInstalled` 的任何写入都**不得落在门的 start..end 区间内**。
   */
  it('the body guard is a bare return, and nothing writes the flag inside it', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'installStopObserver');

    let guard: t.IfStatement | null = null;
    for (const statement of body.body) {
      if (!t.isIfStatement(statement)) continue;
      if (!t.isUnaryExpression(statement.test, { operator: '!' })) continue;
      const argument = statement.test.argument;
      if (!t.isMemberExpression(argument)) continue;
      if (!t.isIdentifier(argument.object, { name: 'document' })) continue;
      if (!t.isIdentifier(argument.property, { name: 'body' })) continue;
      guard = statement;
      break;
    }
    expect(guard, '应当有 `if (!document.body) return;` 这道门').not.toBeNull();

    // ① 门体必须是**裸 return**（`{ ...; return; }` 这种块就是把逻辑塞进门里的入口）
    expect(
      t.isReturnStatement(guard!.consequent),
      '这道门必须是裸 `return;`，不能写成块 —— 块里可以塞任意语句（包括置位）',
    ).toBe(true);

    // ② 置位不得落在门的区间内
    const guardRange = { start: guard!.start ?? 0, end: guard!.end ?? 0 };
    const inside = writePositions(body, 'stopObserverInstalled')
      .filter((position) => position > guardRange.start && position < guardRange.end);
    expect(
      inside,
      'stopObserverInstalled 不得在「document.body 为空」那道门内部置位（那就是原缺陷）',
    ).toEqual([]);
  });

  /**
   * **观察器必须含 `attributes`** —— `isAgentCurrentlyRunning()` 判的是布局存在，
   * 而「布局消失」可以是删节点、也可以是切 class；后一种不产生 `childList`。
   * ⚠️ z.ai 到底是哪一种未验实，所以两档都要开。
   */
  it('observes only childList on the stop observer', () => {
    // ⛔ **这一档曾经加过 `attributes` + `attributeFilter`，已撤回**。
    // 依据是假的：那份「`childHits: 0` 说明不是删节点」的探针用的是**英文选择器**
    // `[aria-label="Stop"]`，而界面是中文（真实元素 `[aria-label="停止"]`）⇒
    // 从头到尾没匹配到过元素。真机重测：childList 662 : attributes 3，倾向删节点。
    //
    // ⚠️ 而 `attributes` 的实际后果是**必然的慢**：`lastStopButtonGoneAt` 会被
    // hover / 面板重画 / Svelte 收尾反复重盖章 ⇒ 150ms 稳定期永远满足不了。
    // 所以这条断言现在是**反向的**：一旦有人把它加回来，这条要红。
    const program = readContentProgram();
    const body = findFunctionBody(program, 'installStopObserver');

    let observesAttributes = false;
    let observesChildList = false;
    walkSourceAst(body, (node) => {
      if (!t.isCallExpression(node)) return;
      if (!t.isMemberExpression(node.callee)) return;
      if (!t.isIdentifier(node.callee.property, { name: 'observe' })) return;
      const [, options] = node.arguments;
      if (!t.isObjectExpression(options)) return;
      for (const property of options.properties) {
        if (!t.isObjectProperty(property)) continue;
        if (t.isIdentifier(property.key, { name: 'attributes' })
          && t.isBooleanLiteral(property.value, { value: true })) observesAttributes = true;
        if (t.isIdentifier(property.key, { name: 'childList' })
          && t.isBooleanLiteral(property.value, { value: true })) observesChildList = true;
      }
    });
    // ⚠️ **还要判「对象是 stopObserver、根是 document.body」** ——
    // 否则把 observe 挪到别的观察器 / 别的根上，前面两条照样绿。
    let targetOk = false;
    let rootOk = false;
    walkSourceAst(body, (node) => {
      if (!t.isCallExpression(node)) return;
      if (!t.isMemberExpression(node.callee)) return;
      if (!t.isIdentifier(node.callee.object, { name: 'stopObserver' })) return;
      if (!t.isIdentifier(node.callee.property, { name: 'observe' })) return;
      const [root] = node.arguments;
      if (t.isMemberExpression(root)
        && t.isIdentifier(root.object, { name: 'document' })
        && t.isIdentifier(root.property, { name: 'body' })) {
        targetOk = true;
        rootOk = true;
      }
    });
    expect(targetOk, '必须是 `stopObserver.observe(document.body, …)`（换对象或换根都不算）').toBe(true);
    expect(rootOk, '观察根必须是 document.body').toBe(true);

    expect(observesChildList, 'stopObserver.observe 必须带 childList: true').toBe(true);
    expect(
      observesAttributes,
      '不要把 attributes 加回来 —— 它会让无关属性变动反复重置 150ms 稳定期（实测：安静页 152ms vs 有 churn 时 >2s）',
    ).toBe(false);
  });
});

describe('waitForAgentIdle grace boundary', () => {
  /**
   * **稳定期判据必须是 `>=`，不是 `>`** ——
   * `graceTimer` 用的正是 `STOP_IDLE_GRACE_MS`（150ms），定时器到点时差值**恰好 150**；
   * `> 150` 为假 ⇒ 回调里判否、**而它不再重挂** ⇒ 只能等满 deadline。
   *
   * 实测（40 次）：`>` 只命中 24/40，`>=` 命中 39/40。
   * ⚠️ **只在「前台」发作**（后台定时器被压到 ≥1000ms，差值远超 150 所以为真）⇒
   * 症状是「用户盯着的时候反而卡 8 秒」，最难归因的那种。
   */
  it('compares the grace period with >= so the timer lands inside the window', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'waitForAgentIdle');

    let operator: string | null = null;
    walkSourceAst(body, (node) => {
      if (!t.isBinaryExpression(node)) return;
      // 形如 `Date.now() - goneAt >= STOP_IDLE_GRACE_MS`
      if (!t.isIdentifier(node.right, { name: 'STOP_IDLE_GRACE_MS' })) return;
      operator = node.operator;
    });
    expect(operator, '应当用 STOP_IDLE_GRACE_MS 做比较').not.toBeNull();
    expect(
      operator,
      '必须是 `>=` —— graceTimer 用的正是这个常量，`>` 会让到点那一刻判否且不重挂',
    ).toBe('>=');
  });
});
