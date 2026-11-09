import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { walkSourceAst } from './helpers/typescript-source';
import {
  directObjectMembers,
  findCallWithSourceObject,
  findFunctionBody,
  isMethodCallTo,
  isNamedKey,
  isRawValueExpression,
  collectMessageCaseBodies,
  countReachableMethodCalls,
  readContentProgram,
  walkReachable,
} from './helpers/content-source-ast';

const CONTENT_SOURCE = 'entrypoints/zai.content.ts';

/**
 * 工具执行**故意不再留在串行队列里** —— 它跑十几秒（`web_fetch` 上界 15 秒），
 * 留在队列里会把后面的 `RESPONSE_COMPLETE` / `REQUEST_TERMINAL` 一起堵住，
 * 而「是否用户手动停止」的判定只有 4 秒宽限窗口 ⇒ 慢工具被误判成手动停止。
 *
 * ⚠️⚠️ **代价是「终态不需要等在飞执行」这条老前提没了**，取而代之的是两条新不变式：
 * ① **执行入口只有一个**（`startDetectedToolCall`，登记计数后挂到本请求的执行链上）；
 * ② **终态收尾必须等**（`tryFinalizeRequest` 先判 `pendingExecutions` / `response`，
 *    两条判据都在实际动作之前）—— 那条断言在下面 `every finished turn` 一节里。
 *
 * ⚠️ **仍然不允许「有人顺手把 `await executeDetected` 改成裸调用」** —— 那两处调用点
 * （兜底路径 + `executeDetectedFromDetected` 内）本来就在队列内、串行、耗时可控，
 * 改成并发只会让签名去重与面板状态进入竞态。所以这里继续钉住「必须 await」。
 *
 * ⚠️ **断言查的是调用点的语法位置（父节点是不是 `AwaitExpression`），不是源码里
 * 有没有出现函数名** —— 后者用 `includes` 就能过，删掉 await 照样为 true。
 */
const AWAITED_FUNCTIONS = [
  'executeDetected',
  'handleResponseComplete',
] as const;

interface CallSite {
  name: string;
  line: number;
  awaited: boolean;
}

/** 收集目标函数的全部调用点，并判定各自是否被 await。 */
function collectCallSites(program: t.Program): CallSite[] {
  const parents = new Map<t.Node, t.Node>();
  walkSourceAst(program, (node) => {
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      const children = Array.isArray(child) ? child : [child];
      for (const item of children) {
        if (item && typeof item === 'object' && 'type' in item) {
          parents.set(item as t.Node, node);
        }
      }
    }
  });

  const sites: CallSite[] = [];
  walkSourceAst(program, (node) => {
    if (!t.isCallExpression(node)) return;
    if (!t.isIdentifier(node.callee)) return;
    const name = node.callee.name;
    if (!(AWAITED_FUNCTIONS as readonly string[]).includes(name)) return;
    sites.push({
      name,
      line: node.loc?.start.line ?? -1,
      awaited: t.isAwaitExpression(parents.get(node)),
    });
  });
  return sites;
}

describe('tool execution call sites are awaited', () => {
  it('finds every call site of the guarded functions', () => {
    // 先确认这份清单不是空的 —— 全被改名/搬走时，「没有不 await 的调用点」会假通过。
    const sites = collectCallSites(readContentProgram());
    const byName = new Map<string, number>();
    for (const site of sites) byName.set(site.name, (byName.get(site.name) ?? 0) + 1);

    for (const name of AWAITED_FUNCTIONS) {
      expect(byName.get(name) ?? 0, `${name} 的调用点数量`).toBeGreaterThan(0);
    }
  });

  it('awaits every remaining call, so the in-queue paths stay serial', () => {
    const unawaited = collectCallSites(readContentProgram())
      .filter((site) => !site.awaited)
      .map((site) => `${site.name} (line ${site.line})`);

    expect(unawaited, '这些调用点没有 await，会让队列内的执行进入并发').toEqual([]);
  });

  it('launches tool execution from one entry that counts the in-flight work first', () => {
    // ⚠️⚠️ **这是「执行离开队列」之后唯一还兜住续跑判定的东西。**
    // `RESPONSE_COMPLETE` 紧随 `TOOL_CALL` 之后排在队列里；若执行入口没有**同步**
    // 把计数加上，会合点会以为「执行已齐」而提前消费响应
    // ⇒ `handleResponseComplete` 读到空的 `executionsByRequest` ⇒ 续跑当场收尾。
    //
    // 判据四条：① 入口内有 `beginToolCall`（那行「执行中」仍画在这里，不在兜底路径）；
    // ② `pendingExecutions` 有 +1 与 -1 各一处；③ +1 是**同步语句**（不在 `await` /
    // `.then` / `.catch` 里 —— 后两者都要等一个 tick 才跑）；④ 启动执行没被 await。
    const program = readContentProgram();
    const body = findFunctionBody(program, 'startDetectedToolCall');

    expect(countReachableMethodCalls(body, 'toolPanel', 'beginToolCall'), '必须调一次 beginToolCall').toBe(1);

    let increments = 0;
    let decrements = 0;
    // ⚠️⚠️ **+1 必须走 `walkReachable`（跳过嵌套函数体）** —— 判据是「它在入口函数体的
    // **顶层**同步执行」。用 `walkSourceAst` 收的话，把 +1 挪进 `.then(...)` 回调里
    // （那里也会晚一个 tick，同样让会合点提前消费响应）**照样能被收到 ⇒ 假绿**（实测踩过）。
    walkReachable(body, (node) => {
      if (!t.isAssignmentExpression(node)) return;
      if (!t.isMemberExpression(node.left) || !t.isIdentifier(node.left.object, { name: 'state' })) return;
      if (!t.isIdentifier(node.left.property, { name: 'pendingExecutions' })) return;
      if (node.operator === '+=') increments += 1;
    });
    // -1 刻意在异步链的末尾（`walkReachable` 收不到它），所以这里必须用全量遍历。
    walkSourceAst(body, (node) => {
      if (!t.isAssignmentExpression(node) || node.operator !== '-=') return;
      if (!t.isMemberExpression(node.left) || !t.isIdentifier(node.left.object, { name: 'state' })) return;
      if (t.isIdentifier(node.left.property, { name: 'pendingExecutions' })) decrements += 1;
    });
    expect(increments, '执行入口必须在顶层同步给在飞计数 +1（挪进回调会晚一个 tick）').toBe(1);
    expect(decrements, '执行结束后必须给在飞计数 -1').toBe(1);

    // ⚠️⚠️ **-1 必须落在 `finally` 里** —— 只在成功分支减的话，一次执行抛错就会让计数
    // 永久 > 0 ⇒ 终态收尾永不执行 ⇒ 授权与请求级状态一起泄漏，而**表现是静默的**。
    // 判据：那条赋值语句的父链上有 `TryStatement`，且它就在 `finalizer` 块里。
    const parents = new Map<t.Node, t.Node>();
    walkSourceAst(body, (node) => {
      for (const key of t.VISITOR_KEYS[node.type] ?? []) {
        const child = (node as unknown as Record<string, unknown>)[key];
        const children = Array.isArray(child) ? child : [child];
        for (const item of children) {
          if (item && typeof item === 'object' && 'type' in item) parents.set(item as t.Node, node);
        }
      }
    });
    let decrementInFinally = false;
    walkSourceAst(body, (node) => {
      if (!t.isAssignmentExpression(node) || node.operator !== '-=') return;
      if (!t.isMemberExpression(node.left) || !t.isIdentifier(node.left.property, { name: 'pendingExecutions' })) return;
      // 判据：最近的那个「回调函数」（`.then/.catch/.finally` 的实参）必须是
      // **`.finally(...)` 的回调** —— 落在 `.then` / `.catch` 里都会漏掉抛错那条路。
      let cursor: t.Node | undefined = node;
      while (cursor) {
        const parent: t.Node | undefined = parents.get(cursor);
        if (parent && (t.isArrowFunctionExpression(parent) || t.isFunctionExpression(parent))) {
          const call = parents.get(parent);
          if (t.isCallExpression(call) && t.isMemberExpression(call.callee)
            && t.isIdentifier(call.callee.property, { name: 'finally' })) {
            decrementInFinally = true;
          }
          break;
        }
        cursor = parent;
      }
    });
    expect(decrementInFinally, '在飞计数必须在 `.finally(...)` 里减（只减成功分支会让一次抛错永久卡死收尾）')
      .toBe(true);

    // 执行启动不能是 `await executeDetectedFromDetected(...)`。
    // ⚠️ 单独走一遍全程序 AST：那个函数**不在** `AWAITED_FUNCTIONS` 里（它本来就不该 await），
    // 所以 `collectCallSites` 收不到它。
    let awaitedLaunch = false;
    walkSourceAst(program, (node) => {
      if (!t.isAwaitExpression(node)) return;
      const arg = node.argument;
      if (t.isCallExpression(arg) && t.isIdentifier(arg.callee)
        && arg.callee.name === 'executeDetectedFromDetected') {
        awaitedLaunch = true;
      }
    });
    expect(awaitedLaunch, '执行入口不得 await 执行（那正是把队列堵住的原因）').toBe(false);

    // ⑤ **执行必须挂在本请求的执行串行链上** —— 现状里同一回复的多个工具由队列**逐条
    //    await**、天然串行；踢出队列后若各自起跑就会并发，改变「同文件两次写、两次 shell
    //    命令」这类组合的既有行为。判据：赋值右侧的子树里出现了 `state.executionChain`
    //    （链条是 `.then().catch().then()`，根部必然是对它的成员访问）。
    let chainedFromPrevious = false;
    walkSourceAst(body, (node) => {
      if (!t.isAssignmentExpression(node) || node.operator !== '=') return;
      if (!t.isMemberExpression(node.left)) return;
      if (!t.isIdentifier(node.left.property, { name: 'executionChain' })) return;
      walkSourceAst(node.right, (inner) => {
        if (!t.isMemberExpression(inner)) return;
        if (t.isIdentifier(inner.object, { name: 'state' })
          && t.isIdentifier(inner.property, { name: 'executionChain' })) {
          chainedFromPrevious = true;
        }
      });
    });
    expect(chainedFromPrevious, '执行必须接在上一个执行之后（并发会改变多工具回复的既有行为）')
      .toBe(true);
  });

  it('binds the authorization retry to the descriptors from this call, not to module state', () => {
    // 授权重试（`unknown_tool_authorization_descriptor`）在串行队列内，它要的是
    // 「**我这次**同步回来的那份清单」—— 模块状态按「最新一次同步生效」落地，
    // 本次同步可能被一条更新的同步顶掉，那时读模块状态会拿到别的东西，
    // 重试白做且静默（第二次照样报同一个错）。所以断言它用的是同步的返回值。
    //
    // ⚠️ **不断言「同步了几次」** —— 那是实现细节：将来在这个 catch 里合理地再刷一次
    // （例如重试仍失败时）是允许的，锁死次数会让测试因为一个无关的理由变红，
    // 而失败信息（「应当同步一次」）会指向与真实意图不符的地方。
    // 这里只断言**意图**：最后一次同步的解构结果被用于 `descriptorIds`。
    const program = readContentProgram();
    // ⚠️⚠️ **走共享实现**（只认 `program.body` 的顶层声明）—— 本地 `walkSourceAst` 版本
    // 会被一个**嵌套在同名可达函数体内**的诱饵顶替（实测：诱饵版能让这条断言照绿，
    // 而真身里的 `descriptorIds` 已经改回读模块状态）。
    const retryBody = findFunctionBody(program, 'requestToolAuthorization');
    const tryStatement = retryBody.body.find((statement) => t.isTryStatement(statement));
    const catchBody = tryStatement && t.isTryStatement(tryStatement)
      ? tryStatement.handler?.body
      : undefined;
    expect(catchBody, 'requestToolAuthorization 里应当有 catch 分支').toBeDefined();

    // 收集 catch 里每一处 `const { … } = await loadAndSyncRuntimeState();` 的解构名，
    // 取**最后一次**（若将来加了第二次同步，生效的是最后一次）。
    const destructuredRuns: string[][] = [];
    walkSourceAst(catchBody!, (node) => {
      if (!t.isVariableDeclarator(node) || !node.init) return;
      // `await` 包一层：init 是 AwaitExpression，调用在它的 argument 里。
      const init = t.isAwaitExpression(node.init) ? node.init.argument : node.init;
      if (!t.isCallExpression(init) || !t.isIdentifier(init.callee)) return;
      if (init.callee.name !== 'loadAndSyncRuntimeState') return;
      if (!t.isObjectPattern(node.id)) return;
      const names: string[] = [];
      for (const property of node.id.properties) {
        if (t.isObjectProperty(property) && t.isIdentifier(property.value)) {
          names.push(property.value.name);
        }
      }
      destructuredRuns.push(names);
    });
    expect(destructuredRuns.length, '重试前应当同步运行时状态并解构出结果').toBeGreaterThan(0);
    // 取**最后一次含 `descriptors` 的**解构 —— 若将来在它之后再补一次只取别的字段的同步
    // （例如只为了刷新联网开关），生效的仍然是含 `descriptors` 的那次，不该因此变红。
    const withDescriptors = destructuredRuns.filter((names) => names.includes('descriptors'));
    expect(withDescriptors.length, '应当有一次解构取出了 descriptors').toBeGreaterThan(0);
    const boundNames = withDescriptors[withDescriptors.length - 1]!;

    // 重试那次 `createToolAuthorization` 的 `descriptorIds` 用的必须是解构出来的那个变量。
    let retryDescriptorIds: t.Node | undefined;
    walkSourceAst(retryBody!, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      if (node.callee.name !== 'createToolAuthorization') return;
      const options = node.arguments[0];
      if (!t.isObjectExpression(options)) return;
      for (const property of options.properties) {
        if (!t.isObjectProperty(property) || !t.isIdentifier(property.key)) continue;
        if (property.key.name === 'descriptorIds') retryDescriptorIds = property.value;
      }
    });
    expect(retryDescriptorIds, '重试调用里应当有 descriptorIds').toBeDefined();
    // 形如 `descriptors.map((d) => d.id)`：接收者必须是上面解构出来的那个标识符。
    expect(t.isCallExpression(retryDescriptorIds), 'descriptorIds 应当由本次同步的清单算出').toBe(true);
    const receiver = (retryDescriptorIds as t.CallExpression).callee;
    expect(t.isMemberExpression(receiver) && t.isIdentifier(receiver.object)).toBe(true);
    const receiverName = ((receiver as t.MemberExpression).object as t.Identifier).name;
    expect(
      boundNames,
      `descriptorIds 的接收者是 ${receiverName}，它必须来自本次同步的返回值`,
    ).toContain(receiverName);
  });

  it('binds the continuation and nudge tool catalogs to this call, not to module state', () => {
    // 续跑轮（`advanceContinuationLoop`）与 nudge 轮同样先 `await loadAndSyncRuntimeState()`
    // 再构造「可用工具清单」。它们**也必须用返回值** —— 理由与授权重试完全相同：
    // 模块状态可能被一条更新的同步顶掉，那时读到的是更旧的目录，
    // 表现是「这一轮注入的工具清单比实际少/旧」，且不报错。
    //
    // ⚠️ 改造闸门时容易只改授权重试那一处、漏掉这两个调用点。
    const program = readContentProgram();
    for (const fnName of ['advanceContinuationLoop', 'handleResponseComplete'] as const) {
      // ⚠️ **走共享实现**（只认 `program.body` 的顶层声明）—— 本地 `walkSourceAst` 版本
      // 会被一个**嵌套在同名可达函数体内**的诱饵顶替。
      const body = findFunctionBody(program, fnName);

      // 该函数体里 `modelFacingDescriptorsFor(第一个参数, …)` 的**根标识符**。
      // 两种写法都要认：`descriptors`（解构）与 `loopState.descriptors`（整体持有）。
      const receivers: string[] = [];
      walkSourceAst(body!, (node) => {
        if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
        if (node.callee.name !== 'modelFacingDescriptorsFor') return;
        const first = node.arguments[0];
        if (t.isIdentifier(first)) receivers.push(first.name);
        else if (t.isMemberExpression(first) && t.isIdentifier(first.object)) {
          receivers.push(first.object.name);
        }
      });
      expect(receivers.length, `${fnName} 里应当有一处工具目录裁剪`).toBeGreaterThan(0);

      // 这些根标识符必须绑定到 `loadAndSyncRuntimeState()` 的返回值 —— 两种绑定形式都认：
      // `const s = await loadAndSyncRuntimeState()` / `const { descriptors } = await …`。
      const boundToSync = new Set<string>();
      walkSourceAst(body!, (node) => {
        if (!t.isVariableDeclarator(node) || !node.init) return;
        const init = t.isAwaitExpression(node.init) ? node.init.argument : node.init;
        if (!t.isCallExpression(init) || !t.isIdentifier(init.callee)) return;
        if (init.callee.name !== 'loadAndSyncRuntimeState') return;
        if (t.isIdentifier(node.id)) {
          boundToSync.add(node.id.name);
          return;
        }
        if (!t.isObjectPattern(node.id)) return;
        for (const property of node.id.properties) {
          if (t.isObjectProperty(property) && t.isIdentifier(property.value)) {
            boundToSync.add(property.value.name);
          }
        }
      });
      expect(boundToSync.size, `${fnName} 应当把本次同步的结果绑到变量上`).toBeGreaterThan(0);
      for (const name of receivers) {
        expect(
          boundToSync.has(name),
          `${fnName} 里的工具目录来源 ${name} 必须绑定到本次同步的返回值，不能读模块状态`,
        ).toBe(true);
      }

    }
  });
});

describe('runtime state sync is gated by the latest attempt', () => {
  /** 找出 `loadAndSyncRuntimeState` 的函数体。 */
  function findSyncBody(program: t.Program): t.BlockStatement {
    // ⚠️ **走共享实现**（只认 `program.body` 的顶层声明）—— 本地 `walkSourceAst` 版本
    // 会被一个**嵌套在同名可达函数体内**的诱饵顶替（实测：诱饵版能让全部断言照绿）。
    return findFunctionBody(program, 'loadAndSyncRuntimeState');
  }

  it('lands module state through the gate, so an older sync cannot overwrite a newer one', () => {
    // 这条守的是**接线**：`createLatestSyncGate` 的单元测试已经证明闸门本身对，
    // 但没人保证 `loadAndSyncRuntimeState` 真的走了它 —— 而「没用闸门」的失效形态
    // 是静默的（旧目录盖新目录、过期的失败清掉更新的成功），没有任何现有测试会红。
    //
    // ⚠️ 断言必须落在 `commit(...)` 的**回调参数里**：只断言函数体出现过 `commit`
    // 是不够的（`begin()` 的结果赋值给它自己也算出现）。
    const body = findSyncBody(readContentProgram());

    let commitCalls = 0;
    let beginCalls = 0;
    const assignmentTargets: string[] = [];
    walkSourceAst(body, (node) => {
      if (t.isCallExpression(node) && t.isMemberExpression(node.callee)
        && t.isIdentifier(node.callee.property)) {
        if (node.callee.property.name === 'commit') commitCalls += 1;
        if (node.callee.property.name === 'begin') beginCalls += 1;
      }
      // 模块状态的写入点：`currentX = ...`，全部必须发生在 commit 回调内。
      if (t.isAssignmentExpression(node) && t.isIdentifier(node.left)
        && node.left.name.startsWith('current')) {
        assignmentTargets.push(node.left.name);
      }
    });

    expect(beginCalls, '每次同步都要 begin()（推进 epoch）').toBe(1);
    expect(commitCalls, '同步结果必须经 commit() 落地').toBe(1);
    expect(assignmentTargets.length, '应当有若干模块状态写入').toBeGreaterThan(0);

    // 把 commit 回调里的赋值点收集出来，与全部赋值点比对 —— 两者必须一致。
    let insideCommit: string[] = [];
    walkSourceAst(body, (node) => {
      if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
      if (!t.isIdentifier(node.callee.property) || node.callee.property.name !== 'commit') return;
      const callback = node.arguments[0];
      if (!callback) return;
      const names: string[] = [];
      walkSourceAst(callback, (inner) => {
        if (t.isAssignmentExpression(inner) && t.isIdentifier(inner.left)
          && inner.left.name.startsWith('current')) {
          names.push(inner.left.name);
        }
      });
      insideCommit = names;
    });

    expect(
      insideCommit.slice().sort(),
      '模块状态赋值必须全部发生在 commit 回调内（回调外赋值 = 绕开闸门）',
    ).toEqual(assignmentTargets.slice().sort());
  });
});

describe('request-scoped state is released once per request', () => {
  /** 找出 `releaseRequestState` 的函数体。 */
  function findReleaseBody(program: t.Program): t.BlockStatement {
    // ⚠️ **走共享实现**（只认 `program.body` 的顶层声明）—— 本地 `walkSourceAst` 版本
    // 会被一个**嵌套在同名可达函数体内**的诱饵顶替（实测：诱饵版能让全部断言照绿）。
    return findFunctionBody(program, 'releaseRequestState');
  }

  it('releases every request-scoped container except the one with a delayed reader', () => {
    // 漏掉一个容器 = 那一项继续无界增长，而**不会有任何测试变红**；
    // 多清一个 `respondedRequestIds` = 手动停止检测会把已完成的请求重新当成待挂窗口。
    const released: string[] = [];
    walkSourceAst(findReleaseBody(readContentProgram()), (node) => {
      if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
      if (!t.isIdentifier(node.callee.object) || !t.isIdentifier(node.callee.property)) return;
      if (node.callee.property.name !== 'delete') return;
      released.push(node.callee.object.name);
    });

    expect(released.sort()).toEqual([
      'chatSessionIdByRequestId',
      'executedToolCallSignatures',
      'executionsByRequest',
      'localSkillDirByRequestId',
      'requestToolDescriptorsByRequestId',
    ]);
    expect(released, 'respondedRequestIds 有延迟读者，不能按 requestId 释放')
      .not.toContain('respondedRequestIds');
  });

  it('releases request state from the terminal finalizer, not from the case body', () => {
    // ⚠️ 不能只断言「源码里出现过 releaseRequestState」—— 函数定义体本身就含这个标识符，
    // 删掉调用点那种断言照样为 true。
    //
    // ⚠️⚠️ **释放搬进了 `tryFinalizeRequest`**（终态分支与会合点两处共用、最后满足条件的那个做），
    // 所以判据拆成两条：① 终态分支**必须**调那个收尾函数；② 收尾函数体内**恰好**释放一次。
    // 少任何一条，要么收尾永远不会被触发（授权永不关），要么释放点被搬走后无人覆盖。
    const program = readContentProgram();
    // ⚠️⚠️ **必须收「那一个 `switch (data.type)`」的分支** —— 全程序扫 `SwitchCase`
    // 是 last-wins，而 TS 允许重复 case ⇒ 在真分支后面补一个同名、内容合规但
    // **不可达**的 case 就能让这条断言照绿（实测：全量 1659 条全绿而真分支已被掏空）。
    const caseBodies = collectMessageCaseBodies(program);
    const terminal = caseBodies.get('REQUEST_TERMINAL');
    expect(terminal, '应当有 REQUEST_TERMINAL 分支').toBeDefined();

    let calledInTerminal = 0;
    for (const statement of terminal!) {
      walkSourceAst(statement, (node) => {
        if (t.isCallExpression(node) && t.isIdentifier(node.callee)
          && node.callee.name === 'tryFinalizeRequest') {
          calledInTerminal += 1;
        }
      });
    }
    expect(calledInTerminal, 'REQUEST_TERMINAL 分支必须触发一次终态收尾').toBe(1);

    let releasedInFinalizer = 0;
    walkSourceAst(findFunctionBody(program, 'tryFinalizeRequest'), (node) => {
      if (t.isCallExpression(node) && t.isIdentifier(node.callee)
        && node.callee.name === 'releaseRequestState') {
        releasedInFinalizer += 1;
      }
    });
    expect(releasedInFinalizer, '终态收尾函数里必须恰好释放一次请求级状态').toBe(1);
  });

  it('waits for in-flight executions before closing the grant and releasing state', () => {
    // ⚠️⚠️ **这是「执行可以离开串行队列」之后唯一还成立的安全依据。**
    // 执行踢出队列后，`REQUEST_TERMINAL` 可能赶在执行前面跑完 —— 若在那里就关授权，
    // 在飞的工具执行会拿不到 grant、落到 `executeDetected` 的**懒建授权**兜底
    // （那等价于「在内容脚本里给自己发许可」）；同理 `releaseRequestState` 会清掉
    // `executionsByRequest`，而它的最后一个读者在 `handleResponseComplete` 里。
    // ⇒ 收尾函数必须**两条前置判据都有**，且都在动作之前。
    const program = readContentProgram();
    const body = findFunctionBody(program, 'tryFinalizeRequest');

    // ⚠️ 判据收窄到「`if` 的 test 子树里访问了 `state.<属性>`」——
    // 只看 `test` 是不是 `MemberExpression` 会漏掉 `state.pendingExecutions > 0`
    // （BinaryExpression）与 `state.response || …`（LogicalExpression）两种真实形态。
    const guardProps = new Set<string>();
    walkSourceAst(body, (node) => {
      if (!t.isIfStatement(node)) return;
      walkSourceAst(node.test, (inner) => {
        const isStateMember = (t.isMemberExpression(inner) || t.isOptionalMemberExpression(inner))
          && t.isIdentifier(inner.object, { name: 'state' })
          && t.isIdentifier(inner.property);
        if (isStateMember) guardProps.add((inner.property as t.Identifier).name);
      });
    });
    expect(guardProps, '收尾函数必须先判「执行是否还在飞」').toContain('pendingExecutions');
    expect(guardProps, '收尾函数必须先判「响应是否还没消费掉」').toContain('response');
    expect(guardProps, '收尾函数必须先判「终态是否已到」').toContain('terminalSeen');

    // ⚠️ **关授权这个动作本身也要在** —— 少一条「必须先等」的判据是过度提前，
    // 整个动作消失则是grant 泄漏（后台 `MAX_ACTIVE_GRANTS = 32`，满了之后
    // **之后所有轮次**的建授权都会抛 `tool_authorization_grant_limit`）。
    //
    // ⚠️⚠️ **动作拆成了两半，两半都要在**（拆的理由见 `tryFinalizeRequest` 的注释：
    // 关后台是一次**无超时的往返**，原来 `await` 它 ⇒ 它不回来收尾就不往下走，
    // 而 `toolTurnStates` 已经先删了 ⇒ 这个请求再没人收尾）。
    // 判据必须分开断 —— 只断 `closeToolAuthorizationInBackground` 会漏掉「本地登记没摘」
    // 那一半（那是 `activeToolAuthorizations` 泄漏的形态）；
    // 只断 `detachToolAuthorization` 会漏掉「后台那份 grant 没人关」那一半。
    const finalizerSource = readFileSync(CONTENT_SOURCE, 'utf8').slice(body.start!, body.end!);
    expect(
      /detachToolAuthorization\(/.test(finalizerSource),
      '收尾函数必须同步摘掉本地 grant 登记',
    ).toBe(true);
    expect(
      /closeToolAuthorizationInBackground\(/.test(finalizerSource),
      '收尾函数必须真的去关后台那份 grant',
    ).toBe(true);
    // ⚠️ **反向自检：不许再 await 关授权** —— 那正是这条用例守的那个缺陷形态。
    expect(
      /await\s+closeToolAuthorization(InBackground)?\(/.test(finalizerSource),
      '收尾函数不得 await 关授权（那会让一次后台往返决定收尾做不做）',
    ).toBe(false);

    // 且必须先于释放（用源码偏移判前后）。
    const source = finalizerSource;
    const firstGuard = Math.min(
      source.indexOf('state.pendingExecutions'),
      source.indexOf('state.response'),
    );
    const actionOffsets = ['detachToolAuthorization(', 'releaseRequestState(']
      .map((a) => source.indexOf(a))
      .filter((i) => i >= 0);
    expect(actionOffsets.length, '收尾函数里应当有关授权与释放两个动作').toBeGreaterThan(0);
    expect(firstGuard, '前置判据必须在实际动作之前').toBeLessThan(Math.min(...actionOffsets));
  });
});

/**
 * **每一轮结束时都要把这一轮的块收起来**（`toolPanel.sealTurn`）。
 *
 * ⚠️⚠️ **这一条守的是接线，不是行为** —— `sealTurn` 漏调**不会**让任何东西变红：
 * `tsc` 绿（它是个可选调用、不是必需参数）、面板用例绿（它们直接调控制器）。
 * 而后果是可见的：一轮跑完那一大块一直摊着，**跑 N 轮就是 N 大块全展开**
 * （真机截图实测过 3 轮 3 大块），而正确形态是 N 行块头。
 *
 * ⚠️ **两个收尾点都必须收**：
 * ① `RESPONSE_COMPLETE` 分支（续跑轮 + 原生轮共用）—— 它后面还有两条早返回
 *    （推进下一轮 / nudge），所以**不能只放在 run 收尾**；
 * ② `REQUEST_TERMINAL` 分支 —— 流被 abort（用户点 Stop）的轮次只走这条路，
 *    不收的话那一大块永远摊着。
 *
 * ⚠️ **顺序也承重：`finalizePending` 在前、`sealTurn` 在后** —— 前者可能重发一次
 * 记录（把「执行中」换成失败），那次重发带着 `live: true` 会把块重新画成展开。
 */
describe('every finished turn seals its tool block', () => {
  /** 在 `source` 子树里数某个 `对象.方法(...)` 调用。 */
  function countCalls(source: t.Node, objectName: string, methodName: string): number {
    let count = 0;
    walkSourceAst(source, (node) => {
      if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
      if (!t.isIdentifier(node.callee.object) || !t.isIdentifier(node.callee.property)) return;
      if (node.callee.object.name === objectName && node.callee.property.name === methodName) count += 1;
    });
    return count;
  }

  /** 找出 `handleResponseComplete` 的函数体。 */
  function findCompletionBody(program: t.Program): t.BlockStatement {
    // ⚠️ **走共享实现**（只认 `program.body` 的顶层声明）—— 本地 `walkSourceAst` 版本
    // 会被一个**嵌套在同名可达函数体内**的诱饵顶替（实测：诱饵版能让全部断言照绿）。
    return findFunctionBody(program, 'handleResponseComplete');
  }

  it('seals the turn in the completion handler', () => {
    const body = findCompletionBody(readContentProgram());
    // ⚠️ **两处**：续跑轮一处、原生轮一处（两条分支各自收尾）。
    expect(countCalls(body, 'toolPanel', 'sealTurn')).toBe(2);
  });

  it('seals the turn from the terminal finalizer too', () => {
    // ⚠️ 流被 abort 的轮次**不走 RESPONSE_COMPLETE**，只走终态这条路（经收尾函数）。
    // 收尾动作搬进 `tryFinalizeRequest` 之后，judged 的对象也随之搬家 —— 但**触发点仍必须是
    // 终态分支**：只判「收尾函数里 sealTurn 恰好一次」的话，把那个函数接到别处去也照样绿。
    const program = readContentProgram();
    // ⚠️⚠️ **必须收「那一个 `switch (data.type)`」的分支** —— 全程序扫 `SwitchCase`
    // 是 last-wins，而 TS 允许重复 case ⇒ 在真分支后面补一个同名、内容合规但
    // **不可达**的 case 就能让这条断言照绿（实测：全量 1659 条全绿而真分支已被掏空）。
    const caseBodies = collectMessageCaseBodies(program);
    const terminal = caseBodies.get('REQUEST_TERMINAL');
    expect(terminal, '应当有 REQUEST_TERMINAL 分支').toBeDefined();
    let triggersFinalizer = 0;
    for (const statement of terminal!) {
      walkSourceAst(statement, (node) => {
        if (t.isCallExpression(node) && t.isIdentifier(node.callee)
          && node.callee.name === 'tryFinalizeRequest') {
          triggersFinalizer += 1;
        }
      });
    }
    expect(triggersFinalizer, '终态分支必须触发收尾').toBe(1);

    const body = findFunctionBody(program, 'tryFinalizeRequest');
    expect(countCalls(body, 'toolPanel', 'sealTurn'), '收尾函数里必须收一次').toBe(1);
    // ⚠️ **顺序：先 `finalizePending` 再 `sealTurn`** —— 前者可能重发一次记录
    // （把「执行中」换成失败），那次重发带着 `live: true` 会把块重新画成展开。
    // 这条路径（流被 abort）尤其要收 —— 否则那一大块会一直摊在页面上。
    const order: string[] = [];
    walkSourceAst(body, (node) => {
      if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
      if (!t.isIdentifier(node.callee.object) || !t.isIdentifier(node.callee.property)) return;
      if (node.callee.object.name !== 'toolPanel') return;
      if (node.callee.property.name !== 'finalizePending' && node.callee.property.name !== 'sealTurn') return;
      order.push(node.callee.property.name);
    });
    expect(order, '收尾函数里必须先 finalize 再 seal').toEqual(['finalizePending', 'sealTurn']);
  });

  it('finalizes the pending rows before sealing', () => {
    // ⚠️⚠️ **顺序反了收尾就被顶掉**：`finalizePending` 会把「执行中」换成失败并
    // 重发一次记录（带 `live: true`），那次重发会把块重新画成展开。
    const body = findCompletionBody(readContentProgram());
    const order: string[] = [];
    walkSourceAst(body, (node) => {
      if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
      if (!t.isIdentifier(node.callee.object) || !t.isIdentifier(node.callee.property)) return;
      if (node.callee.object.name !== 'toolPanel') return;
      if (node.callee.property.name !== 'finalizePending' && node.callee.property.name !== 'sealTurn') return;
      order.push(node.callee.property.name);
    });

    expect(order).toEqual(['finalizePending', 'sealTurn', 'finalizePending', 'sealTurn']);
  });

  it('registers the tool call raw from the execution path', () => {
    // ⚠️⚠️ **这条守的是接线，删掉不会让任何东西变红**（实测：去掉那行调用点，
    // 当时全量 1626 条用例 + `tsc` 全绿）。而后果是真缺陷 —— 原生轮的**兜底执行路径**
    // 刻意不调 `beginToolCall`（避免稍纵即逝的「执行中」行），而 `raw` 只有它会登记
    // ⇒ 那条路上实时腿的签名恒为「工具名 + 空串」、**与历史腿永远配不上**
    // ⇒ 同一轮画两块面板（一块有结果、一块没有）。
    //
    // 判据：`toolPanel.noteToolCallRaw(...)` 必须出现在 `executeDetected` 里。
    const program = readContentProgram();
    const executeBody = findFunctionBody(program, 'executeDetected');
    expect(countCalls(executeBody!, 'toolPanel', 'noteToolCallRaw')).toBe(1);
  });
  it('passes the raw itself, not an empty placeholder, into noteToolCallRaw', () => {
    // ⚠️⚠️ **只数「调用出现过几次」挡不住这一格**（实测：把实参改成
    // `{ callId: stableCallId }`、或把 `raw` 写成空串，当时全量 1629 条用例 + `tsc`
    // **全绿**）—— 而 `raw` 是合流签名的一半，写空等于把上面那条修好的缺陷
    // （同一轮画两块面板）原样放回来，失败方向静默。
    //
    // 判据：那次调用的**第二个实参**必须是一个对象字面量，且它的 `raw` 属性
    // 通过 `isRawValueExpression`（**与 `beginToolCall` 那处共用同一份判据** ——
    // 同一个语义在两个文件里各写一遍时，一处认 `??` 兜底、一处只认裸成员表达式，
    // 实测确实漂过）。
    const program = readContentProgram();
    const executeBody = findFunctionBody(program, 'executeDetected');

    const rawValues: t.Node[] = [];
    walkReachable(executeBody!, (node) => {
      if (!isMethodCallTo(node, 'toolPanel', 'noteToolCallRaw')) return;
      const options = node.arguments[1];
      if (!t.isObjectExpression(options)) return;
      for (const property of directObjectMembers(options)) {
        if (!isNamedKey(property.key, 'raw')) continue;
        rawValues.push(property.value);
      }
    });

    expect(rawValues, 'noteToolCallRaw 的实参里必须有 raw 键').toHaveLength(1);
    expect(
      isRawValueExpression(rawValues[0]),
      'raw 必须取到原始 XML（形如 `call.raw` / `call.raw ?? ""`）—— '
      + '取成别的字段、写成空串字面量、或用 `&&` 兜底（值恒空）都不算',
    ).toBe(true);
  });

    it('logs dropped tool history records at log level from the content script', () => {
    // ⚠️⚠️ **丢弃信号必须打在内容脚本里，因为后台的 `console` 用户看不见**：
    // `history.ts` 跑在 service worker，它的 log 只出现在 `chrome://extensions` 的
    // SW 控制台；而**用户按 F12 看到的是页面控制台**。所以「丢了几条」这个数要从
    // 后台带过边界、由 `loadToolHistory` 打出来。
    //
    // 判据两条，缺一不可：
    // ① 那个函数体里有 `console.log`；
    // ② **不能有 `console.error`** —— 丢弃坏记录是**自愈动作**（下次写入会清掉它们），
    //    打成 error 会让扩展错误面板长期挂红。
    //
    // ⚠️ `loadToolHistory` 是**传给 `createToolPanelController` 的对象字面量属性**
    // （不是模块顶层函数声明）⇒ 不能用 `findFunctionBody`，要按属性名找。
    const program = readContentProgram();
    let body: t.Node | undefined;
    walkReachable(program as unknown as t.Node, (node) => {
      if (!t.isObjectProperty(node) || !isNamedKey(node.key, 'loadToolHistory')) return;
      const value = node.value;
      if (t.isArrowFunctionExpression(value) && t.isBlockStatement(value.body)) body = value.body;
      if (t.isFunctionExpression(value) && t.isBlockStatement(value.body)) body = value.body;
    });
    expect(body, '应当能按属性名找到 loadToolHistory 的函数体').toBeDefined();

    const consoleMethods: string[] = [];
    walkReachable(body!, (node) => {
      if (!t.isMemberExpression(node)) return;
      if (!t.isIdentifier(node.object, { name: 'console' })) return;
      if (!t.isIdentifier(node.property)) return;
      consoleMethods.push(node.property.name);
    });

    expect(consoleMethods, '必须有 console.log 打丢弃信号').toContain('log');
    expect(consoleMethods, '丢弃是可自愈的降级，不许打成 error').not.toContain('error');
  });

  it('writes the assistant message anchor into the tool call source', () => {
    // ⚠️⚠️ **存储腿自带锚点这条链路的唯一发送点，此前零覆盖**（实测：删掉那行展开，
    // 当时全量 1629 条用例 + `tsc` **全绿**）。它的字段是 `string | null` 的可选字段，
    // 缺省**合法** ⇒ `isToolCallSource` 照样放过记录，只是那条记录退回「靠签名合流」
    // —— 静默降级，正是这条链路当初要消掉的那一格。
    //
    // 判据两条，缺一不可：
    // ① `executeDetected` 体内必须调 `readCurrentAssistantMessageId()`（值从 DOM 读）；
    // ② 那个值必须被写进 **`callWithSource` 的 `source: { … }` 里**。
    //
    // ⚠️⚠️ **② 必须锚在 `source` 那个对象字面量上**，不能全函数扫 `assistantMessageId`
    // 属性 —— 把它挪到 `ToolCall` 顶层（`callWithSource` 的兄弟属性）时**全函数扫描照样绿**
    // 且 `tsc` 也绿（对象展开不触发多余属性检查），而下游读的是
    // `item.call?.source?.assistantMessageId` ⇒ 锚点**永久为 null**、静默退回签名合流。
    const program = readContentProgram();
    const executeBody = findFunctionBody(program, 'executeDetected');

    let readsAnchor = 0;
    const anchorNames = new Set<string>();
    walkSourceAst(executeBody!, (node) => {
      if (t.isCallExpression(node) && t.isIdentifier(node.callee)
        && node.callee.name === 'readCurrentAssistantMessageId') {
        readsAnchor += 1;
      }
      // `const assistantMessageId = readCurrentAssistantMessageId();`
      if (t.isVariableDeclarator(node) && t.isIdentifier(node.id) && node.init) {
        const init = t.isAwaitExpression(node.init) ? node.init.argument : node.init;
        if (t.isCallExpression(init) && t.isIdentifier(init.callee)
          && init.callee.name === 'readCurrentAssistantMessageId') {
          anchorNames.add(node.id.name);
        }
      }
    });
    expect(readsAnchor, 'executeDetected 里应当读一次当前助手消息锚点').toBe(1);
    expect(anchorNames.size, '读到的锚点应当绑定到一个标识符上').toBe(1);
    const anchorName = [...anchorNames][0]!;

    // ② `callWithSource` 的 `source` 对象字面量。
    const sourceObject = findCallWithSourceObject(executeBody!);
    expect(sourceObject, '应当能定位 callWithSource 的 source 对象字面量').toBeDefined();

    // ⚠️⚠️ **判据必须是「`source` 的*直接*成员」**，两个方向都踩过：
    // - 用 `walkSourceAst` 扫子树 ⇒ `source: { meta: { assistantMessageId } }` 那种
    //   **嵌套一层**的写法会被算成「写进了 source」，而下游多一层就读不到（假绿）；
    // - 只遍历 `sourceObject.properties` 的 `ObjectProperty` ⇒ 当前的条件展开
    //   `...(assistantMessageId ? { assistantMessageId } : {})` **一个都收不到**（假红）。
    // ⇒ 用 `directObjectMembers`（直接属性 + **展开里那一层**的属性，且只跟一层）。
    const sourceWrites = directObjectMembers(sourceObject!)
      .filter((property) => isNamedKey(property.key, 'assistantMessageId'));
    expect(
      sourceWrites.length,
      'source 里应当写入 assistantMessageId（写错层 ⇒ 下游读 item.call.source.assistantMessageId 永远拿到 null）',
    ).toBe(1);

    // ⚠️⚠️ **必须直接判「值」，不能扫属性子树** —— `assistantMessageId` 这个**键名**
    // 与绑定变量同名，扫子树时它自己就把断言满足了 ⇒ 值写成字面量 / 别的变量都绿
    // （实测：`assistantMessageId: 'deadbeef'` 与 `assistantMessageId: chatSessionId`
    // 两种写法下，扫子树版全绿）。
    expect(
      t.isIdentifier(sourceWrites[0]!.value, { name: anchorName }),
      `写入 source 的 assistantMessageId 的值必须直接是 ${anchorName}（字面量 / 别的变量都不算接线）`,
    ).toBe(true);
  });

  // ⚠️ **「切会话时丢掉旧记录」那条守卫已移到 `zai-content-startup-wiring-contract.test.ts`。**
  // 它在这里曾有一份「全程序扫 `onZaiSessionChange` 回调」的弱版本，与那边那条
  // **是同一件事的两个消费者** —— 两处各写一遍时口径必然漂（弱的那版连
  // 「订阅被挪进死函数」都拦不住，却看着像有防护）。同一判据只留一个入口。
});

/**
 * 状态同步**失败时不能中断主流程，也不能清空工具目录**。
 *
 * ⚠️⚠️ **这个 catch 当前静态不可达** —— `Promise.all` 八条腿里唯一可能 reject 的
 * `getResolvedLocaleState` 已收敛为**永不 reject**（读失败吞成默认值、超时只 resolve），
 * 其余七条走 `sendRuntimeMessage`（自带 try/catch 成 `undefined`），两个 `normalize*` 都是纯函数。
 * **所以这三条断言测的是「万一将来某条腿会抛」时的兜底行为，不是活路径** ——
 * 它们会在这个死分支上照样绿，别把它当成「这条路径被验证过」。
 *
 * 两条断言各守一个后果，都是静默的：
 * - **往外抛** ⇒ `advanceContinuationLoop` 在取数之后还有「注入下一轮 / 收尾」，
 *   中断会让 `continuationLoop` 停在 `running`，只能等后台 180s 执行租约兜底；
 * - **commit 空目录** ⇒ `currentCatalogNames` 被清空并推到主世界，而 fetch hook 的
 *   `extractAndNotifyToolCalls` 在名字集合为空时**直接 return、一个工具都不识别**。
 */
describe('runtime state sync failure keeps the flow and the catalog', () => {
  function findSyncBody(program: t.Program): t.BlockStatement {
    // ⚠️ **走共享实现**（只认 `program.body` 的顶层声明）—— 本地 `walkSourceAst` 版本
    // 会被一个**嵌套在同名可达函数体内**的诱饵顶替（实测：诱饵版能让全部断言照绿）。
    return findFunctionBody(program, 'loadAndSyncRuntimeState');
  }

  function catchClausesOf(body: t.BlockStatement): t.CatchClause[] {
    const found: t.CatchClause[] = [];
    walkSourceAst(body, (node) => {
      if (t.isCatchClause(node)) found.push(node);
    });
    return found;
  }

  it('catches the sync failure instead of letting it escape', () => {
    const catches = catchClausesOf(findSyncBody(readContentProgram()));
    expect(catches.length, '取数必须包在 try/catch 里').toBeGreaterThan(0);
  });

  it('does not commit a fallback snapshot when the sync fails', () => {
    const body = findSyncBody(readContentProgram());
    for (const clause of catchClausesOf(body)) {
      // ⚠️ catch 里既不能 `throw`（中断调用方主流程），也不能调 `commit`
      // （清空 `currentCatalogNames` 会连带关掉工具标签识别）。
      let throws = 0;
      let commits = 0;
      walkSourceAst(clause, (node) => {
        if (t.isThrowStatement(node)) throws += 1;
        if (t.isCallExpression(node) && t.isMemberExpression(node.callee)
          && t.isIdentifier(node.callee.property) && node.callee.property.name === 'commit') {
          commits += 1;
        }
      });
      expect(throws, 'catch 里不能重新抛出（会让续跑循环停在 running、等 180s 租约）').toBe(0);
      expect(commits, 'catch 里不能 commit（会清空工具目录并关掉标签识别）').toBe(0);
    }
  });

  it('reports the failure so it is not silent', () => {
    const body = findSyncBody(readContentProgram());
    let reported = 0;
    const countReport = (node: t.Node) => {
      // catch 里的上报必须是 `console.error(...)` —— 不抛、不 commit 之后，
      // 那是这次失败**唯一**的可见面。删掉它，这条路径就彻底静默了。
      if (!t.isCallExpression(node)) return;
      const callee = node.callee;
      if (!t.isMemberExpression(callee)) return;
      if (!t.isIdentifier(callee.object) || callee.object.name !== 'console') return;
      if (t.isIdentifier(callee.property) && callee.property.name === 'error') reported += 1;
    };
    for (const clause of catchClausesOf(body)) walkSourceAst(clause, countReport);
    expect(reported, 'catch 里要 console.error 报一次 —— 不抛就只剩它可见').toBeGreaterThan(0);
  });
});

/**
 * 授权重试**必须只在拿到新目录时才重发**。
 *
 * 它进 catch 分支的唯一原因是 `unknown_tool_authorization_descriptor`（我们这份目录过期了），
 * 所以它要的是**新目录**。取数失败时 `loadAndSyncRuntimeState` 返回的是沿用值（旧目录），
 * 再发一遍只会拿到同一个错 —— 或者更糟：后台按 id 过滤，
 * `descriptors.length === requestedDescriptorIds.size` **判不出「少了新增的工具」**，
 * 于是安静地建成一个不含新工具的 grant，模型调用它时才失败。
 *
 * ⚠️ **`fresh` 的判据是「取数没抛错 **且** 目录非空」** —— 只看「没抛错」不够：
 * `GET_TOOL_DESCRIPTORS` 失败会被 `.then(v => Array.isArray(v) ? v : [])` **收敛成空数组**，
 * 那条路上不会抛，空目录会被当成新目录 ⇒ 建出一个**不含任何工具**的 grant，正是要挡的事。
 */
describe('authorization retry only resends a freshly synced catalog', () => {
  /** 找出 `loadAndSyncRuntimeState` 的函数体。 */
  function findSyncBody(program: t.Program): t.BlockStatement {
    // ⚠️ **走共享实现**（只认 `program.body` 的顶层声明）—— 本地 `walkSourceAst` 版本
    // 会被一个**嵌套在同名可达函数体内**的诱饵顶替（实测：诱饵版能让全部断言照绿）。
    return findFunctionBody(program, 'loadAndSyncRuntimeState');
  }

  it('bails out when the sync did not produce fresh data', () => {
    const program = readContentProgram();
    // ⚠️ **走共享实现**（只认 `program.body` 的顶层声明）。
    const retryBody = findFunctionBody(program, 'requestToolAuthorization');

    // catch 分支里必须先判 `fresh`，且判为假时抛出。
    let guardsFresh = false;
    walkSourceAst(retryBody!, (node) => {
      if (!t.isIfStatement(node)) return;
      if (!t.isUnaryExpression(node.test) || node.test.operator !== '!') return;
      if (!t.isIdentifier(node.test.argument) || node.test.argument.name !== 'fresh') return;
      if (!t.isThrowStatement(node.consequent)) return;
      guardsFresh = true;
    });
    expect(guardsFresh, 'catch 里必须有 `if (!fresh) throw error;`').toBe(true);
  });

  it('derives fresh from a non-empty catalog, not from "the fetch did not throw"', () => {
    // ⚠️ 写死 `fresh: true` 是最容易犯的错，而且**看不出来**：`GET_TOOL_DESCRIPTORS`
    // 失败时 `sendRuntimeMessage` 返回 `undefined`、被 `.then(v => Array.isArray(v) ? v : [])`
    // 收敛成空数组 —— 那条路上不抛，于是「没抛错」与「拿到了目录」被混为一谈，
    // 授权重试会带 `descriptorIds: []` 重发并建成空 grant。
    const body = findSyncBody(readContentProgram());
    const freshValues: t.Expression[] = [];
    walkSourceAst(body, (node) => {
      if (!t.isObjectProperty(node)) return;
      if (!t.isIdentifier(node.key) || node.key.name !== 'fresh') return;
      if (t.isExpression(node.value)) freshValues.push(node.value);
    });
    expect(freshValues.length, '应当有两处返回 fresh（成功路径 + catch 兜底）').toBe(2);

    // 成功路径那处必须是 `descriptors.length > 0` 形态，不能是字面量 `true`。
    const derived = freshValues.some((value) => (
      t.isBinaryExpression(value)
      && ['>', '!=='].includes(value.operator)
      && t.isMemberExpression(value.left)
      && t.isIdentifier(value.left.object)
      && value.left.object.name === 'descriptors'
    ));
    expect(derived, '成功路径的 fresh 必须由 descriptors 长度派生（`descriptors.length > 0`）').toBe(true);
  });
});

describe('tool tag recognition uses the descriptors injected into this request', () => {
  /** `handleAugmentRequestBody` 的 `handleAugmentRequestBody` 函数体。 */
  function findAugmentBody(): t.BlockStatement {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'handleAugmentRequestBody');
    return body!;
  }

  /**
   * 识别 XML 标签用的名单必须**与提示词同源** —— 即本请求授权返回的 `descriptors`，
   * 而不是全局 `currentCatalogNames` / `currentToolDescriptors`（那是「上次同步」）。
   *
   * **为什么**：提示词里的工具清单来自 `createToolAuthorization` 的后台**实时**投影。
   * 用户刚加 MCP 工具、`TOOL_DESCRIPTORS_UPDATED` 广播还没落地时，全局快照与提示词会分叉
   * —— 提示词列了 A、识别器不认 A，模型调它**静默不执行**（不报错、不失败）。
   *
   * 修法（B）：把授权返回的 `descriptors` 随增广结果回传，主世界识别与内容脚本兜底
   * `parseToolXml` 都用它；全局快照降级为「未增广请求」的兜底。
   *
   * ⚠️ **只断言接线**（回传值来自 `descriptors`、兜底解析读 `requestToolDescriptorsByRequestId`），
   * 不断言具体函数名 —— 后者用 `includes` 就能过。
   */
  it('returns this request\'s model-facing descriptor names in the augment result', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'handleAugmentRequestBody');

    // ⚠️⚠️ **回传的必须是「模型可见目录」，不是「授权目录」。**
    // 这两者曾经混用：提示词用过滤后的、识别用未过滤的 ⇒ 用户在侧边栏关掉的 web 工具
    // 仍会被识别并执行（表现是「关了搜索它还在搜」，静默）。所以这里断言：
    // ① 每处 `toolDescriptorNames` 都是 `catalogNamesFor(<标识符>)`（**不是** `<某>.descriptors`
    //    那种成员表达式 —— 那正是「未过滤的授权目录」的形态）；
    // ② 那个标识符在本函数内**由 `modelFacingDescriptorsFor(...)` 绑定**；
    // ③ 没有一处回落到全局 `currentCatalogNames`。
    const namesArgs: string[] = [];
    let usesGlobalCatalogNames = false;
    walkSourceAst(body!, (node) => {
      if (!t.isObjectProperty(node)) return;
      if (!t.isIdentifier(node.key) || node.key.name !== 'toolDescriptorNames') return;
      const value = node.value;
      if (t.isIdentifier(value) && value.name === 'currentCatalogNames') {
        usesGlobalCatalogNames = true;
        return;
      }
      if (t.isCallExpression(value) && t.isIdentifier(value.callee)
        && value.callee.name === 'catalogNamesFor') {
        const arg = value.arguments[0];
        if (t.isIdentifier(arg)) {
          namesArgs.push(arg.name);
          return;
        }
        // `<某>.descriptors` 是「授权目录」的形态 —— 明确拒绝。
        namesArgs.push(t.isMemberExpression(arg) ? `<成员表达式 ${'…'}>` : '<非预期来源>');
        return;
      }
      namesArgs.push('<非预期来源>');
    });

    expect(namesArgs.length, '应当有多处回传 toolDescriptorNames（chatNew / 续跑 / completion）').toBeGreaterThanOrEqual(3);
    expect(
      namesArgs.every((name) => /^[A-Za-z_$][\w$]*$/.test(name)),
      `toolDescriptorNames 必须来自一个「模型可见目录」标识符，不能是授权目录的成员表达式。实际：${namesArgs.join(', ')}`,
    ).toBe(true);
    expect(usesGlobalCatalogNames, '不得回传全局 currentCatalogNames（那是上次同步，会与提示词分叉）').toBe(false);

    // ② 那些标识符必须由过滤助手绑定 —— 否则「改个变量名继续用未过滤目录」就能绕过。
    const boundByFilter = new Set<string>();
    walkSourceAst(body!, (node) => {
      if (!t.isVariableDeclarator(node) || !t.isIdentifier(node.id)) return;
      const init = node.init;
      if (!init) return;
      const call = t.isAwaitExpression(init) ? init.argument : init;
      if (t.isCallExpression(call) && t.isIdentifier(call.callee)
        && call.callee.name === 'modelFacingDescriptorsFor') {
        boundByFilter.add(node.id.name);
      }
    });
    for (const name of new Set(namesArgs)) {
      expect(
        boundByFilter.has(name),
        `回传用的 \`${name}\` 必须由 modelFacingDescriptorsFor(...) 绑定（否则可能带回未过滤目录）`,
      ).toBe(true);
    }
  });

  it('parses fallback tool XML with the model-facing catalog, not the global snapshot', () => {
    const program = readContentProgram();
    // 所有 `parseToolXml(<text>, <第二参>)` 调用点，逐个判定第二参。
    const bareGlobalArgs: number[] = [];
    const notFilteredArgs: number[] = [];
    const callLines: number[] = [];
    walkSourceAst(program, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      if (node.callee.name !== 'parseToolXml') return;
      const line = node.loc?.start.line ?? -1;
      callLines.push(line);
      const second = node.arguments[1];
      if (t.isIdentifier(second) && second.name === 'currentToolDescriptors') {
        bareGlobalArgs.push(line);
        return;
      }
      // ⚠️⚠️ **必须是 `modelFacingForRequest(requestId)`** —— 只断言「不是裸全局目录」不够：
      // 传 `requestToolDescriptorsByRequestId.get(id) ?? currentToolDescriptors` 也满足那条，
      // 而那个 Map 里存的是**未过滤**的授权目录（懒建路径刻意存原样），于是「关掉的工具
      // 仍被兜底解析认出来并执行」这个缺陷原封不动。
      const isFilteredCall = t.isCallExpression(second)
        && t.isIdentifier(second.callee)
        && second.callee.name === 'modelFacingForRequest';
      if (!isFilteredCall) notFilteredArgs.push(line);
    });
    expect(callLines.length, '应当有 parseToolXml 调用点').toBeGreaterThan(0);
    // 不得有任何一处把裸 `currentToolDescriptors` 当目录 —— 那正是要消除的分叉。
    expect(bareGlobalArgs, `这些行的 parseToolXml 用了裸 currentToolDescriptors（会与提示词分叉）：${bareGlobalArgs.join(', ')}`).toEqual([]);
    // 且每一处都必须过模型可见过滤。
    expect(
      notFilteredArgs,
      `这些行的 parseToolXml 第二参不是 modelFacingForRequest(...)（会拿到未过滤的授权目录）：${notFilteredArgs.join(', ')}`,
    ).toEqual([]);

    // ⚠️ **写入点恰好 3 个**（续跑 / completion / 懒建）—— **chatNew 刻意不写**：它没有终态
    // 事件（`fetch-hook` 只在 completion 路由发 `onRequestTerminal`），与随后的 completion 是
    // 两个不同 requestId ⇒ 写了既**无人释放**（孤儿泄漏）、也**无人读**（Map 的读点读的都是
    // completion 的 requestId）。这条钉住「别把 chatNew 那行加回来」。
    // ⚠️ 判据走 AST 而不是正则数字面量：`?.set(` 与 `.set(` 语义等价，按字面形状数会把
    // 一次无害的可选链改写判成「少了一个写入点」。
    // ⚠️ 用 `walkSourceAst`（**全深度**）而不是 `countReachableMethodCalls` —— 后者把
    // 函数声明当遍历边界，而三个写入点全在函数体内，用它数出来是 0。
    let setCalls = 0;
    walkSourceAst(program, (node) => {
      if (isMethodCallTo(node, 'requestToolDescriptorsByRequestId', 'set')) setCalls += 1;
    });
    expect(setCalls, '写入点必须恰好 3 个（chatNew 刻意不写，见注释）').toBe(3);
  });

  /**
   * ⚠️⚠️ **「模型可见目录」在 `handleAugmentRequestBody` 里必须只有一个计算入口。**
   *
   * 缺陷形态：过滤结果只喂提示词，识别与解析各拿一份未过滤的授权目录 —— 用户关掉的
   * web 工具仍被识别并执行（「关了搜索它还在搜」，静默）。
   * 所以这里断言：该函数体内 `modelFacingDescriptorsFor(...)` 的调用点**都绑定到标识符**、
   * 且**没有一处**再出现「直接读 `xxx.descriptors` 交给 catalogNamesFor」的旧形态。
   */
  it('binds every model-facing catalog to a single filtered computation', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'handleAugmentRequestBody');

    let filterCalls = 0;
    walkSourceAst(body!, (node) => {
      if (t.isCallExpression(node) && t.isIdentifier(node.callee)
        && node.callee.name === 'modelFacingDescriptorsFor') {
        filterCalls += 1;
      }
    });
    // 三个分支（chatNew / 续跑 / completion）各一次 —— 每处都要有自己的口径。
    expect(filterCalls, 'chatNew / 续跑 / completion 三个分支都该算出自己的模型可见目录').toBe(3);

  });

  it('releases the per-request descriptor map alongside the other request-scoped state', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'releaseRequestState');

    let released = false;
    walkSourceAst(body!, (node) => {
      if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
      const object = node.callee.object;
      if (t.isIdentifier(object) && object.name === 'requestToolDescriptorsByRequestId') {
        released = true;
      }
    });
    expect(released, 'requestToolDescriptorsByRequestId 必须在 releaseRequestState 里释放（否则按 requestId 增长）').toBe(true);
  });

});

/**
 * **chatNew 分支不得往任何「只在 `REQUEST_TERMINAL` 释放」的容器里写东西。**
 *
 * chatNew 请求收不到 `REQUEST_TERMINAL`（`fetch-hook` 只在 completion 路由发
 * `onRequestTerminal`），而它与随后的 completion 是**两次独立 fetch、两个不同 requestId**
 * ⇒ 写进去就是**永不释放的孤儿**，且没有任何现有测试会因此变红。
 *
 * 它的 grant 仍然**必须建**（增广要用 `authorization.descriptors`），所以收口方式不是「别建」，
 * 而是「建完**显式关掉**」—— 走 `closeToolAuthorizationGrant`（只关后台、不碰 Map）。
 * 后台的 grant 名额是 `MAX_ACTIVE_GRANTS = 32`，满了会让**之后所有**建授权抛
 * `tool_authorization_grant_limit`（静默降级：工具全部不可用）。
 */
describe('the arrival registration happens outside the serial queue', () => {
  it('records the arrival in the synchronous probe, not inside the queued handler', () => {
    // ⚠️⚠️ **这条抓的是一个「全绿但功能不通」的缺陷，且它曾经真的存在于生产代码里。**
    // 「响应已到达」的登记（`respondedRequestIds` / 清手动停止 timer）是
    // **「是否用户手动停止」的判据**，而那个判定只有 4 秒宽限窗口；
    // `RESPONSE_COMPLETE` 却排在一段十几秒的工具执行之后（`TOOL_CALL` 分支曾 await
    // 整条执行链，`web_fetch` 上界 15 秒）—— 登记留在队列内 ⇒ 慢工具被误判成手动停止，
    // 并连带摘掉 taskId、回收续跑循环。
    //
    // 判据两条一起：① 登记出现在**队列外**那个函数（`dispatchMainWorldMessage`）里；
    // ② 队列内的消费函数（`handleResponseComplete`）里**不再**登记。
    // 少任何一条都拦不住「有人顺手把它挪回去」。
    const program = readContentProgram();

    const probe = findFunctionBody(program, 'dispatchMainWorldMessage');
    const recordsArrival = (scope: t.Node): number => {
      let count = 0;
      walkSourceAst(scope, (node) => {
        if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
        if (!t.isIdentifier(node.callee.object, { name: 'respondedRequestIds' })) return;
        if (!t.isIdentifier(node.callee.property, { name: 'add' })) return;
        count += 1;
      });
      return count;
    };
    expect(recordsArrival(probe), '响应到达的登记必须在串行队列之外完成').toBe(1);
    expect(
      recordsArrival(findFunctionBody(program, 'handleResponseComplete')),
      'handleResponseComplete 排在队列里，在那里登记会让慢工具被误判成手动停止',
    ).toBe(0);
    expect(
      recordsArrival(findFunctionBody(program, 'tryFinalizeRequest')),
      '收尾不是「响应到达」那一刻，不得在那里登记',
    ).toBe(0);
  });
});

describe('the tool-turn rendezvous consumes each response exactly once', () => {
  it('guards the settle task with a scheduled flag cleared inside the task', () => {
    // ⚠️ **多工具回复会让 `finally` 触发多次会合**（每个工具一次），加上响应到达那一次
    // ——不去重就会让 `handleResponseComplete` 被调两次，续跑被注入两轮。
    // ⚠️ **标志位必须在任务体内清**（不是同步清）：同步清会让下一页任务误以为「没有在排队的
    // 会合」，而实际那个任务还没跑；反过来若只在任务体内清、却不在同步路径上设位，
    // 两次触发会各自排一个任务。
    const body = findFunctionBody(readContentProgram(), 'settleToolTurn');

    let setTrue = 0;
    let setFalse = 0;
    walkSourceAst(body, (node) => {
      if (!t.isAssignmentExpression(node) || node.operator !== '=') return;
      if (!t.isMemberExpression(node.left)) return;
      if (!t.isIdentifier(node.left.object, { name: 'state' })) return;
      if (!t.isIdentifier(node.left.property, { name: 'settleScheduled' })) return;
      if (node.right.type === 'BooleanLiteral' && (node.right as t.BooleanLiteral).value) setTrue += 1;
      if (node.right.type === 'BooleanLiteral' && !(node.right as t.BooleanLiteral).value) setFalse += 1;
    });
    expect(setTrue, '会合点必须同步置位（否则两条触发路会各排一个任务）').toBe(1);
    expect(setFalse, '会合点必须在任务体内清位').toBe(1);

    // ⚠️⚠️ **光有标志位不够 —— 它必须真的被用作「提前返回」的判据。**
    // 只数赋值次数的话，把 `|| state.settleScheduled` 从守卫里删掉照样绿（实测踩过），
    // 而那时两条触发路会各排一个任务、`handleResponseComplete` 被调两次。
    let guardReadsScheduled = false;
    walkSourceAst(body, (node) => {
      if (!t.isIfStatement(node) || !t.isReturnStatement(node.consequent)) return;
      walkSourceAst(node.test, (inner) => {
        if ((t.isMemberExpression(inner) || t.isOptionalMemberExpression(inner))
          && t.isIdentifier(inner.object, { name: 'state' })
          && t.isIdentifier(inner.property, { name: 'settleScheduled' })) {
          guardReadsScheduled = true;
        }
      });
    });
    expect(guardReadsScheduled, 'settleScheduled 必须参与「提前返回」的判据，不能只是被赋值')
      .toBe(true);

    // ⚠️ 唯一性还依赖「会不会重复消费」：`response` 必须被读出后立刻置空，
    // 且读出发生在任务体内（同步路径只看它、不清它）。
    let clearsResponse = 0;
    walkSourceAst(body, (node) => {
      if (!t.isAssignmentExpression(node) || node.operator !== '=') return;
      if (!t.isMemberExpression(node.left)) return;
      if (!t.isIdentifier(node.left.object, { name: 'state' })) return;
      if (!t.isIdentifier(node.left.property, { name: 'response' })) return;
      if (t.isNullLiteral(node.right)) clearsResponse += 1;
    });
    expect(clearsResponse, '会合点必须消费后清空 response（防重复消费）').toBe(1);
  });

  it('settles on both wake-up sources: response arrival and execution landing', () => {
    // ⚠️ **两个唤醒源缺一不可**：只有响应到达那个 → 执行先落地的轮次永远不推进；
    // 只有执行落地那个 → 没有工具、或工具先跑完的轮次永远不推进（续跑就此停住）。
    const program = readContentProgram();

    // 唤醒源 ①：响应到达（`RESPONSE_COMPLETE` 分支）。
    const caseBodies = collectMessageCaseBodies(program);
    const completeBranch = caseBodies.get('RESPONSE_COMPLETE');
    expect(completeBranch, '应当有 RESPONSE_COMPLETE 分支').toBeDefined();
    let settlesFromResponse = 0;
    for (const statement of completeBranch!) {
      walkSourceAst(statement, (node) => {
        if (t.isCallExpression(node) && t.isIdentifier(node.callee)
          && node.callee.name === 'settleToolTurn') {
          settlesFromResponse += 1;
        }
      });
    }
    expect(settlesFromResponse, 'RESPONSE_COMPLETE 分支必须触发一次会合').toBe(1);

    // 唤醒源 ②：执行落地（`startDetectedToolCall` 的执行链末尾）。
    const startBody = findFunctionBody(program, 'startDetectedToolCall');
    let settlesFromExecution = 0;
    walkSourceAst(startBody, (node) => {
      if (t.isCallExpression(node) && t.isIdentifier(node.callee)
        && node.callee.name === 'settleToolTurn') {
        settlesFromExecution += 1;
      }
    });
    expect(settlesFromExecution, '执行落地必须触发一次会合').toBe(1);

    // ⚠️ 且必须**排在减计数之后** —— 反了会让会合点看到「还在飞」而拒绝推进，
    // 而这时已经没有任何后续唤醒了（那条轮次永久卡住）。
    const source = readFileSync(CONTENT_SOURCE, 'utf8').slice(startBody.start!, startBody.end!);
    const decrementAt = source.indexOf('pendingExecutions -= 1');
    const settleAt = source.indexOf('settleToolTurn(');
    expect(decrementAt, '执行链末尾应当先减在飞计数').toBeGreaterThanOrEqual(0);
    expect(settleAt, '执行链末尾应当触发会合').toBeGreaterThanOrEqual(0);
    expect(decrementAt, '必须先减计数、再触发会合').toBeLessThan(settleAt);
  });

  it('creates one rendezvous entry before launching, even for tool-less requests', () => {
    // ⚠️⚠️ **无工具的请求也必须建条目** —— 否则终态收尾会在「找不到状态」处直接返回，
    // 收尾整块不执行（授权永不关、请求级状态永不释放），而**失败是静默的**。
    const program = readContentProgram();

    // ① 执行入口在建状态之后才写计数（顺序用偏移判）。
    const startBody = findFunctionBody(program, 'startDetectedToolCall');
    const startSource = readFileSync(CONTENT_SOURCE, 'utf8').slice(startBody.start!, startBody.end!);
    const ensureAt = startSource.indexOf('ensureToolTurnState(');
    const incrementAt = startSource.indexOf('pendingExecutions += 1');
    expect(ensureAt, '执行入口必须先取/建会合状态').toBeGreaterThanOrEqual(0);
    expect(incrementAt, '执行入口必须给计数 +1').toBeGreaterThanOrEqual(0);
    expect(ensureAt, '先建状态、再加计数').toBeLessThan(incrementAt);

    // ② 终态分支也建条目（那是「一条工具都没跑」的请求唯一的建条目时机）。
    const caseBodies = collectMessageCaseBodies(program);
    const terminal = caseBodies.get('REQUEST_TERMINAL');
    expect(terminal, '应当有 REQUEST_TERMINAL 分支').toBeDefined();
    let ensuredInTerminal = 0;
    for (const statement of terminal!) {
      walkSourceAst(statement, (node) => {
        if (t.isCallExpression(node) && t.isIdentifier(node.callee)
          && node.callee.name === 'ensureToolTurnState') {
          ensuredInTerminal += 1;
        }
      });
    }
    expect(ensuredInTerminal, '终态分支必须建条目（无工具请求没有别的地方会建）').toBe(1);
  });

  it('keeps the request-scoped tool-turn state off the chatNew route', () => {
    // ⚠️ **`toolTurnStates` 不归 `releaseRequestState` 管**（它由 `tryFinalizeRequest`
    // 删），所以上面那条「从 releaseRequestState 反向枚举」的通则**覆盖不到它**。
    // chatNew 请求收不到 `REQUEST_TERMINAL` ⇒ 写进去就是永不释放的孤儿。在这里单独钉一条。
    const program = readContentProgram();
    const body = findFunctionBody(program, 'handleAugmentRequestBody');
    const branches: t.IfStatement[] = [];
    walkSourceAst(body!, (node) => {
      if (!t.isIfStatement(node)) return;
      const test = node.test;
      if (!t.isBinaryExpression(test) || test.operator !== '===') return;
      if (!t.isIdentifier(test.left, { name: 'route' })) return;
      if (!t.isStringLiteral(test.right, { value: 'chatNew' })) return;
      branches.push(node);
    });
    expect(branches.length, '应当恰好有一个 `route === \'chatNew\'` 分支').toBe(1);

    // ⚠️⚠️ **两条都要收** —— 直接写 `toolTurnStates.set(...)` 是一种，经
    // `ensureToolTurnState(...)` 间接建条目是另一种（那才是实际会发生的写法）。
    // 只收前者会让后者**静默漏过**（实测踩过）。
    let writes = 0;
    walkSourceAst(branches[0], (node) => {
      if (!t.isCallExpression(node)) return;
      if (t.isIdentifier(node.callee, { name: 'ensureToolTurnState' })) writes += 1;
      if (t.isMemberExpression(node.callee)
        && t.isIdentifier(node.callee.object, { name: 'toolTurnStates' })
        && t.isIdentifier(node.callee.property, { name: 'set' })) writes += 1;
    });
    expect(writes, 'chatNew 分支不得写 toolTurnStates（收不到 REQUEST_TERMINAL，永不释放）').toBe(0);
  });
});

describe('chatNew does not write request-scoped state it can never release', () => {
  /** `handleAugmentRequestBody` 里 `route === 'chatNew'` 那个 if 节点。 */
  function findChatNewBranch(): t.IfStatement {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'handleAugmentRequestBody');

    const branches: t.IfStatement[] = [];
    walkSourceAst(body!, (node) => {
      if (!t.isIfStatement(node)) return;
      const test = node.test;
      if (!t.isBinaryExpression(test) || test.operator !== '===') return;
      if (!t.isIdentifier(test.left) || test.left.name !== 'route') return;
      if (!t.isStringLiteral(test.right) || test.right.value !== 'chatNew') return;
      branches.push(node);
    });
    expect(branches.length, '应当恰好有一个 `route === \'chatNew\'` 分支').toBe(1);
    return branches[0];
  }

  /** 取该分支节点的**源码切片**（按 AST 的 `start`/`end`，不靠注释字符串定位）。 */
  function branchSource(node: t.IfStatement): string {
    expect(node.start, '分支节点应当带位置信息').not.toBeNull();
    expect(node.end, '分支节点应当带位置信息').not.toBeNull();
    return readFileSync(CONTENT_SOURCE, 'utf8').slice(node.start!, node.end!);
  }

  /** 收集该分支里对指定 Map 的 `.set(...)` 调用。 */
  function setCallsOn(branch: t.IfStatement, container: string): number {
    let count = 0;
    walkSourceAst(branch, (node) => {
      if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
      if (!t.isIdentifier(node.callee.object) || node.callee.object.name !== container) return;
      if (!t.isIdentifier(node.callee.property) || node.callee.property.name !== 'set') return;
      count += 1;
    });
    return count;
  }

  it('does not register the chatNew request in the chat-session map', () => {
    // ⚠️ 这条钉的是**写入点的位置**，不是「源码里出现过这个 Map」—— 后者在
    // completion 段里天然为真，用 `includes` 就能过。
    expect(
      setCallsOn(findChatNewBranch(), 'chatSessionIdByRequestId'),
      'chatNew 分支不得写 chatSessionIdByRequestId（收不到 REQUEST_TERMINAL，写进去永不释放）',
    ).toBe(0);
  });

  it('does not register the chatNew grant in the active-authorizations map', () => {
    expect(
      setCallsOn(findChatNewBranch(), 'activeToolAuthorizations'),
      'chatNew 分支不得写 activeToolAuthorizations（同上；grant 走 closeToolAuthorizationGrant 显式关）',
    ).toBe(0);
  });

  it('does not write any request-scoped map that releaseRequestState owns', () => {
    // ⚠️ **这条是通则，不是「再补一个容器名」** —— 上面两条守的是同一件事的两个具体实例，
    // 而新增请求级容器时很容易只记得加 `releaseRequestState` 的 delete、忘了这里。
    // 所以**从 `releaseRequestState` 反向枚举容器名**，逐个断言 chatNew 分支不写它们。
    //
    // ⚠️ 判据是「`releaseRequestState` 里 delete 了哪些容器」而不是手抄清单 ——
    // 手抄的第二份清单必然分叉，而这里的分叉形态是静默的：新容器没人守，
    // chatNew 一旦写了它就成了永不释放的孤儿，且不会有任何测试变红。
    const program = readContentProgram();
    // ⚠️ **走共享实现**（只认 `program.body` 的顶层声明）—— 本地 `walkSourceAst` 版本
    // 会被一个嵌套在同名可达函数体内的诱饵顶替（实测：诱饵版能让全部断言照绿）。
    const releaseBody = findFunctionBody(program, 'releaseRequestState');

    const owned = new Set<string>();
    walkSourceAst(releaseBody!, (node) => {
      if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
      if (!t.isIdentifier(node.callee.object) || !t.isIdentifier(node.callee.property)) return;
      if (node.callee.property.name !== 'delete') return;
      owned.add(node.callee.object.name);
    });
    // 先确认枚举不是空的 —— 全被改名/搬走时，「没有违规」会假通过。
    expect(owned.size, 'releaseRequestState 应当释放若干容器').toBeGreaterThanOrEqual(5);

    const branch = findChatNewBranch();
    const offenders = [...owned].filter((container) => setCallsOn(branch, container) > 0);
    expect(
      offenders,
      `chatNew 分支不得写这些容器（收不到 REQUEST_TERMINAL，写进去永不释放）：${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('still writes the chat-session map on the completion route', () => {
    // 反面守卫：把写入点挪走时不能顺手删掉 —— 那条路径的读点（executeDetected）依赖它。
    const source = readFileSync(CONTENT_SOURCE, 'utf8');
    const setCalls = source.match(/chatSessionIdByRequestId\.set\(/g) ?? [];
    expect(setCalls.length, 'chatSessionIdByRequestId 必须恰好有一个写入点（completion 段）').toBe(1);
  });

  it('closes the chatNew grant through the map-free path', () => {
    // ⚠️ 必须走 `closeToolAuthorizationGrant`（只关后台）而不是 `closeToolAuthorization`
    // （按 requestId 从 Map 里取）—— chatNew 没进过 Map，后者会**静默 return、grant 永不关**。
    //
    // ⚠️ **切片用 AST 节点的 `start`/`end`，不用注释字符串定位** —— 靠
    // `indexOf('// completion 路由')` 那种写法依赖一句**纯注释**存在，注释一旦被删，
    // 切片会静默扩到下一个同前缀注释、两个断言**仍然为真**，保护力度无声下降。
    const source = branchSource(findChatNewBranch());
    expect(
      /closeToolAuthorizationGrant\(authorization\.id\)/.test(source),
      'chatNew 分支必须在回传结果后关掉它的 grant（否则占满后台 32 个名额）',
    ).toBe(true);
    expect(
      /closeToolAuthorization\(requestId\)/.test(source),
      'chatNew 不得用按 requestId 取 Map 的那个关闭函数（它没进 Map，会静默 return）',
    ).toBe(false);
  });
});


/**
 * **授权失败码必须能被重试判据认出来** —— 传输层的 `RuntimeCommandError` 要归一成
 * `ToolAuthorizationRequestError`。
 *
 * ## 它修的是什么
 *
 * 后台的领域失败（含 `unknown_tool_authorization_descriptor`）走 `sendRuntimeMessageStrict`
 * 会变成 `RuntimeCommandError`，而 `requestToolAuthorization` 的 catch 判的是
 * `instanceof ToolAuthorizationRequestError` ⇒ **不归一就恒 false**，整条
 * 「刷新目录再重试一次」的链是死代码，且失败方向是静默的（只打一行 console.error）。
 *
 * ⚠️ 判据只能落在这里（AST）—— `createToolAuthorization` 在内容脚本里、不可 import。
 * 但它问的是**结构事实**：「抛出的那个类名是不是判据要认的那个」，不是「某个名字出现过」。
 */
describe('authorization failures are normalized to the semantic error type', () => {
  it('createToolAuthorization converts RuntimeCommandError before rethrowing', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'createToolAuthorization');

    // 找 `if (error instanceof RuntimeCommandError) { throw new ToolAuthorizationRequestError(...) }`
    // ⚠️ **consequent 是 `BlockStatement`**（带花括号），不是裸的 `ThrowStatement` ——
    // 直接判 `isThrowStatement(consequent)` 会永远为 false（第一版就是这么写错的，
    // 而 `/tmp` 上用字符串匹配「模拟」判据时看不出来）。所以先拆一层块。
    let normalized = false;
    walkSourceAst(body!, (node) => {
      if (!t.isIfStatement(node)) return;
      const test = node.test;
      if (!t.isBinaryExpression(test) || test.operator !== 'instanceof') return;
      if (!t.isIdentifier(test.right, { name: 'RuntimeCommandError' })) return;
      const consequent = node.consequent;
      const statements = t.isBlockStatement(consequent) ? consequent.body : [consequent];
      const throws = statements.find((statement) => t.isThrowStatement(statement));
      if (!throws || !t.isThrowStatement(throws)) return;
      const arg = throws.argument;
      if (!t.isNewExpression(arg)) return;
      if (!t.isIdentifier(arg.callee, { name: 'ToolAuthorizationRequestError' })) return;
      normalized = true;
    });
    expect(
      normalized,
      'createToolAuthorization 必须把 RuntimeCommandError 转成 ToolAuthorizationRequestError —— '
      + '不转的话 requestToolAuthorization 的重试判据恒 false，整条重试链是死代码',
    ).toBe(true);
  });

  it('the retry guard still keys on the semantic type', () => {
    // 反面守卫：别「修」成在 retry 那边也认 RuntimeCommandError —— 那样两处判据会各写一份，
    // 而归一化的责任应该在**产生错误的那一侧**。
    const program = readContentProgram();
    const body = findFunctionBody(program, 'requestToolAuthorization');
    const source = readFileSync(CONTENT_SOURCE, 'utf8').slice(body!.start ?? 0, body!.end ?? 0);
    expect(
      source.includes('instanceof ToolAuthorizationRequestError'),
      'requestToolAuthorization 应当继续判 ToolAuthorizationRequestError',
    ).toBe(true);
  });
});

/**
 * **chatNew 的 grant 必须在异常路径上也被还掉**。
 *
 * 它刻意不进任何请求级 Map（chatNew 没有终态事件），只能显式关；而增广 / 重写 / 回传
 * 那几步一旦抛错会落到最外层 catch，grant 就漏了 ⇒ 占后台 32 个名额之一到 30 分钟 TTL。
 * 判据：`closeToolAuthorizationGrant` 必须落在覆盖「建授权之后那段」的 `finally` 里。
 */
describe('the chatNew grant is released on the error path too', () => {
  it('closes the grant inside a finally that covers the augmentation', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'handleAugmentRequestBody');

    let covered = false;
    walkSourceAst(body!, (node) => {
      if (!t.isTryStatement(node) || !node.finalizer) return;
      const block = node.block;
      const inTry = (name: string) => {
        let found = false;
        walkSourceAst(block, (inner) => {
          if (t.isCallExpression(inner) && t.isIdentifier(inner.callee, { name })) found = true;
        });
        return found;
      };
      if (!inTry('augmentPrompt') || !inTry('rewriteZaiChatNewUserMessages')) return;
      let closes = false;
      walkSourceAst(node.finalizer, (inner) => {
        if (t.isCallExpression(inner) && t.isIdentifier(inner.callee, { name: 'closeToolAuthorizationGrant' })) {
          closes = true;
        }
      });
      if (closes) covered = true;
    });
    expect(
      covered,
      'chatNew 的增广段必须包在 try/finally 里，且 finally 里关掉 grant —— '
      + '否则增广抛错时 grant 没人还，占满 32 个名额后所有工具静默不可用',
    ).toBe(true);
  });
});

/**
 * **两条「没有终态事件」的路径也要把 grant 还回去。**
 *
 * ⚠️⚠️ 这一组守的是同一个后果，两个不同成因：
 * ① `tryFinalizeRequest` 里那次后台往返可能**不回来**（真机撞见过：`toolTurnStates` 空、
 *    `activeToolAuthorizations` 留着一条跨 400 秒没消失的条目）—— 修法是**不再 await 它**；
 * ② 挑战页那一轮**永远不会有终态**（`fetch-hook` 在 `text/html` 分支读完 headers 就
 *    `return`，不发 `RESPONSE_COMPLETE` / `REQUEST_TERMINAL`）⇒ `tryFinalizeRequest`
 *    第一句就返回，这条请求再没人收尾。
 *
 * 两者都不清的话，后台那份 grant 只能等 30 分钟 TTL；`MAX_ACTIVE_GRANTS` 是 32，
 * 满了之后**之后所有轮次的建授权全部抛 `tool_authorization_grant_limit`**，
 * 表现是工具静默全部不可用。
 *
 * ⚠️ **为什么用源码断言**：这两处都是 `zai.content.ts` 里的模块私有函数，
 * 没有测试入口；而判据是「结构上有没有这条清理」—— 属于接线，不是行为。
 */
describe('grant cleanup covers the two paths that never see a terminal event', () => {
  it('does not await the background round-trip inside the finalizer', () => {
    // ⚠️ 这条与上面 `waits for in-flight executions …` 里那条反向自检重复，
    // 但**故意分开**：那条跟着「前置判据」一起验，这条单独钉「同步」这个性质，
    // 改坏时失败信息能直接指出来是哪个性质丢了。
    const body = findFunctionBody(readContentProgram(), 'tryFinalizeRequest');
    expect(body, '应当有 tryFinalizeRequest').toBeDefined();

    // 判据一：函数**不是 async**（签名就是承诺 —— 同步就写不出 await）。
    let isAsync = false;
    walkSourceAst(readContentProgram(), (node) => {
      if (!t.isFunctionDeclaration(node)) return;
      if (!t.isIdentifier(node.id, { name: 'tryFinalizeRequest' })) return;
      isAsync = node.async === true;
    });
    expect(isAsync, '收尾函数必须是同步的 —— 一旦 async，就又能夹进无超时的后台往返').toBe(false);

    // 判据二：函数体里没有 await。
    let awaits = 0;
    walkSourceAst(body!, (node) => {
      if (t.isAwaitExpression(node)) awaits += 1;
    });
    expect(awaits, '收尾函数体里不得有 await').toBe(0);
  });

  it('releases the challenge-page grant outside the claimed branch', () => {
    // ⚠️⚠️ **必须在 `if (claimed)` 外面** —— 实测 `claimed: false` 的挑战页请求
    // 同样留了 grant（原生轮、或循环已收尾那一档）。只清认领那一档等于漏一半。
    const caseBodies = collectMessageCaseBodies(readContentProgram());
    const challenge = caseBodies.get('HTML_CHALLENGE');
    expect(challenge, '应当有 HTML_CHALLENGE 分支').toBeDefined();

    // ① 分支里必须有「摘本地登记 + 关后台」两个动作。
    let detaches = 0;
    let closes = 0;
    for (const statement of challenge!) {
      walkSourceAst(statement, (node) => {
        if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
        if (node.callee.name === 'detachToolAuthorization') detaches += 1;
        if (node.callee.name === 'closeToolAuthorizationInBackground') closes += 1;
      });
    }
    expect(detaches, '挑战页分支必须摘掉本地 grant 登记').toBe(1);
    expect(closes, '挑战页分支必须去关后台那份 grant').toBe(1);

    // ② 两个动作都**不在**任何「认领判据」里面。
    //    ⚠️ 判据收窄到「`test` 子树里出现 `continuationLoop`」—— 认领条件就是它。
    //    ⚠️ **会匹配到两个**：外层那个 `if (continuationLoop?.status === 'running' && …)`
    //    与 `setTimeout` 里那条延迟复检 `if (continuationLoop !== expectedLoop || …)`。
    //    两个都算「认领判据」，两个里面都不许出现清理。
    const claimedBranches: t.IfStatement[] = [];
    for (const statement of challenge!) {
      walkSourceAst(statement, (node) => {
        if (!t.isIfStatement(node)) return;
        let mentionsLoop = false;
        walkSourceAst(node.test, (inner) => {
          if (t.isIdentifier(inner, { name: 'continuationLoop' })) mentionsLoop = true;
        });
        if (mentionsLoop) claimedBranches.push(node);
      });
    }
    // 反面自检：一个都找不到说明判据写错了（那时下面那条恒真）。
    expect(claimedBranches.length, '应当找得到认领判据').toBeGreaterThan(0);
    let insideClaimed = 0;
    for (const branch of claimedBranches) {
      walkSourceAst(branch, (node) => {
        if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
        if (node.callee.name === 'detachToolAuthorization'
          || node.callee.name === 'closeToolAuthorizationInBackground') {
          insideClaimed += 1;
        }
      });
    }
    expect(
      insideClaimed,
      '清理必须在认领判据之外 —— 未认领的挑战页请求同样会留 grant',
    ).toBe(0);
  });
});
