import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';

const CONTENT_SOURCE = 'entrypoints/zai.content.ts';

/**
 * 工具执行的调用点**必须被 await**，且授权重试**必须绑定本次同步的返回值** ——
 * 这两条一起构成「`REQUEST_TERMINAL` 不需要等在飞执行」这条判断的前提。
 *
 * `REQUEST_TERMINAL` 关闭授权前不做任何等待（`zai.content.ts` 的对应分支里有说明），
 * 成立的前提是：`executeDetected` 的每个调用点都在 `mainWorldMessageQueue` 内被
 * **串行 await**，而 `REQUEST_TERMINAL` 排在同一条队列的 TOOL_CALL /
 * RESPONSE_COMPLETE 之后 —— 于是走到那里不可能还有在飞的执行。
 *
 * ⚠️ **一旦有人把它改成并发派发（`void executeDetected(...)` 或 `Promise.all` 里的
 * 裸调用），这个前提就没了**：工具可能在授权被关掉之后才真正执行，而表现是静默的
 * （执行失败或走懒建授权），不会报错、也不会让任何现有测试变红。所以把前提钉在这里。
 *
 * ⚠️ **断言查的是调用点的语法位置（父节点是不是 `AwaitExpression`），不是源码里
 * 有没有出现函数名** —— 后者用 `includes` 就能过，删掉 await 照样为 true。
 */
const AWAITED_FUNCTIONS = [
  'executeDetected',
  'handleDetectedToolCall',
  'handleResponseComplete',
] as const;

function readContentProgram(): t.Program {
  return parseTypeScriptSource(CONTENT_SOURCE, readFileSync(CONTENT_SOURCE, 'utf8'));
}

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

  it('awaits every call, so REQUEST_TERMINAL cannot observe an in-flight execution', () => {
    const unawaited = collectCallSites(readContentProgram())
      .filter((site) => !site.awaited)
      .map((site) => `${site.name} (line ${site.line})`);

    expect(unawaited, '这些调用点没有 await，会破坏 REQUEST_TERMINAL 的顺序保证').toEqual([]);
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
    let retryBody: t.BlockStatement | undefined;
    walkSourceAst(program, (node) => {
      if (!t.isFunctionDeclaration(node) || node.id?.name !== 'requestToolAuthorization') return;
      const tryStatement = node.body.body.find((statement) => t.isTryStatement(statement));
      if (tryStatement && t.isTryStatement(tryStatement)) {
        retryBody = tryStatement.handler?.body;
      }
    });
    expect(retryBody, 'requestToolAuthorization 里应当有 catch 分支').toBeDefined();

    // 收集 catch 里每一处 `const { … } = await loadAndSyncRuntimeState();` 的解构名，
    // 取**最后一次**（若将来加了第二次同步，生效的是最后一次）。
    const destructuredRuns: string[][] = [];
    walkSourceAst(retryBody!, (node) => {
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
    // ⚠️ 这条是评审查出的 P1：改造闸门时只改了授权重试那一处，漏了这两个调用点。
    const program = readContentProgram();
    for (const fnName of ['advanceContinuationLoop', 'handleResponseComplete'] as const) {
      let body: t.BlockStatement | undefined;
      walkSourceAst(program, (node) => {
        if (t.isFunctionDeclaration(node) && node.id?.name === fnName) body = node.body;
      });
      expect(body, `应当存在 ${fnName}`).toBeDefined();

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

      // ⚠️ **`webToolsEnabled` 也要守** —— 它同样决定 web 工具是否进模型目录，
      // 只守「目录」那一半的话，把 options 里的 `webToolsEnabled` 改回模块状态
      // （`currentWebToolsEnabled`）**不会让任何断言变红**（实测过）。
      const webFlagSources: string[] = [];
      walkSourceAst(body!, (node) => {
        if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
        if (node.callee.name !== 'modelFacingDescriptorsFor') return;
        const options = node.arguments[1];
        if (!t.isObjectExpression(options)) return;
        for (const property of options.properties) {
          if (!t.isObjectProperty(property) || !t.isIdentifier(property.key)) continue;
          if (property.key.name !== 'webToolsEnabled') continue;
          const value = property.value;
          if (t.isIdentifier(value)) webFlagSources.push(value.name);
          else if (t.isMemberExpression(value) && t.isIdentifier(value.object)) {
            webFlagSources.push(value.object.name);
          } else {
            // 既不是标识符也不是 `x.y` —— 例如写死 `true` 或内联表达式，同样是漂移。
            webFlagSources.push('<非绑定值>');
          }
        }
      });
      expect(webFlagSources.length, `${fnName} 里应当显式传 webToolsEnabled`).toBeGreaterThan(0);
      for (const source of webFlagSources) {
        expect(
          boundToSync.has(source),
          `${fnName} 里的 webToolsEnabled 来源 ${source} 必须绑定到本次同步的返回值`,
        ).toBe(true);
      }
    }
  });
});

describe('runtime state sync is gated by the latest attempt', () => {
  /** 找出 `loadAndSyncRuntimeState` 的函数体。 */
  function findSyncBody(program: t.Program): t.BlockStatement {
    let body: t.BlockStatement | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'loadAndSyncRuntimeState') body = node.body;
    });
    expect(body, '应当存在 loadAndSyncRuntimeState').toBeDefined();
    return body!;
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
    let body: t.BlockStatement | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'releaseRequestState') body = node.body;
    });
    expect(body, '应当存在 releaseRequestState').toBeDefined();
    return body!;
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
      'isAgentTurnByRequestId',
      'localSkillDirByRequestId',
      'nativeSearchOnByRequestId',
      'requestToolDescriptorsByRequestId',
    ]);
    expect(released, 'respondedRequestIds 有延迟读者，不能按 requestId 释放')
      .not.toContain('respondedRequestIds');
  });

  it('calls releaseRequestState inside the REQUEST_TERMINAL branch, not just anywhere', () => {
    // ⚠️ 不能只断言「源码里出现过 releaseRequestState」—— 函数定义体本身就含这个标识符，
    // 删掉调用点那种断言照样为 true。这里断言**调用出现在 REQUEST_TERMINAL 的 case 里**。
    const program = readContentProgram();
    const caseBodies = new Map<string, t.Node[]>();
    walkSourceAst(program, (node) => {
      if (!t.isSwitchCase(node) || !t.isStringLiteral(node.test)) return;
      caseBodies.set(node.test.value, node.consequent);
    });

    const terminal = caseBodies.get('REQUEST_TERMINAL');
    expect(terminal, '应当有 REQUEST_TERMINAL 分支').toBeDefined();

    let calledInTerminal = 0;
    for (const statement of terminal!) {
      walkSourceAst(statement, (node) => {
        if (t.isCallExpression(node) && t.isIdentifier(node.callee)
          && node.callee.name === 'releaseRequestState') {
          calledInTerminal += 1;
        }
      });
    }
    expect(calledInTerminal, 'releaseRequestState 必须在 REQUEST_TERMINAL 分支内被调用').toBe(1);
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
    let body: t.BlockStatement | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'handleResponseComplete') body = node.body;
    });
    expect(body, '应当存在 handleResponseComplete').toBeDefined();
    return body!;
  }

  it('seals the turn in the completion handler', () => {
    const body = findCompletionBody(readContentProgram());
    // ⚠️ **两处**：续跑轮一处、原生轮一处（两条分支各自收尾）。
    expect(countCalls(body, 'toolPanel', 'sealTurn')).toBe(2);
  });

  it('seals the turn in the REQUEST_TERMINAL branch too', () => {
    // ⚠️ 流被 abort 的轮次**不走 RESPONSE_COMPLETE**，只走这里。
    const program = readContentProgram();
    const caseBodies = new Map<string, t.Node[]>();
    walkSourceAst(program, (node) => {
      if (!t.isSwitchCase(node) || !t.isStringLiteral(node.test)) return;
      caseBodies.set(node.test.value, node.consequent);
    });
    const terminal = caseBodies.get('REQUEST_TERMINAL');
    expect(terminal, '应当有 REQUEST_TERMINAL 分支').toBeDefined();

    let sealed = 0;
    for (const statement of terminal!) sealed += countCalls(statement, 'toolPanel', 'sealTurn');
    expect(sealed, 'REQUEST_TERMINAL 分支里必须收一次').toBe(1);
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
    // 全量 1626 条用例 + `tsc` 全绿）。而后果是真缺陷 —— 原生轮的**兜底执行路径**
    // 刻意不调 `beginToolCall`（避免稍纵即逝的「执行中」行），而 `raw` 只有它会登记
    // ⇒ 那条路上实时腿的签名恒为「工具名 + 空串」、**与历史腿永远配不上**
    // ⇒ 同一轮画两块面板（一块有结果、一块没有）。
    //
    // 判据：`toolPanel.noteToolCallRaw(...)` 必须出现在 `executeDetected` 里。
    const program = readContentProgram();
    let executeBody: t.BlockStatement | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'executeDetected') executeBody = node.body;
    });
    expect(executeBody, '应当存在 executeDetected').toBeDefined();
    expect(countCalls(executeBody!, 'toolPanel', 'noteToolCallRaw')).toBe(1);
  });

  it('drops the old conversation records when the session changes', () => {
    // ⚠️⚠️ **这条守的是接线，删掉不会让任何东西变红**（实测：去掉这段接线，
    // 全量 1610 条用例 + `tsc` 全绿）。而后果是真缺陷 —— 切过会话之后，
    // 旧会话记录的三条定位腿在新会话全 miss，兜底腿把它挂到**新会话的消息**上
    // （真机实测：旧会话的 web_fetch / web_search / shell_status 出现在新会话里）。
    //
    // 判据：`toolPanel.handleSessionChange()` 必须出现在某个
    // **`onZaiSessionChange(...)` 的回调体**里（不能只断言「源码里出现过这个方法名」）。
    const program = readContentProgram();
    const callbacks: t.Node[] = [];
    walkSourceAst(program, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      if (node.callee.name !== 'onZaiSessionChange') return;
      const [callback] = node.arguments;
      if (callback) callbacks.push(callback);
    });
    expect(callbacks.length, '应当有 onZaiSessionChange 的订阅').toBeGreaterThan(0);

    let wired = 0;
    for (const callback of callbacks) {
      walkSourceAst(callback, (node) => {
        if (t.isCallExpression(node) && t.isMemberExpression(node.callee)
          && t.isIdentifier(node.callee.object) && t.isIdentifier(node.callee.property)
          && node.callee.object.name === 'toolPanel'
          && node.callee.property.name === 'handleSessionChange') {
          wired += 1;
        }
      });
    }
    expect(wired, 'toolPanel.handleSessionChange 必须在 onZaiSessionChange 回调里被调').toBe(1);
  });
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
    let body: t.BlockStatement | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'loadAndSyncRuntimeState') body = node.body;
    });
    expect(body, '应当存在 loadAndSyncRuntimeState').toBeDefined();
    return body!;
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
    let body: t.BlockStatement | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'loadAndSyncRuntimeState') body = node.body;
    });
    expect(body, '应当存在 loadAndSyncRuntimeState').toBeDefined();
    return body!;
  }

  it('bails out when the sync did not produce fresh data', () => {
    const program = readContentProgram();
    let retryBody: t.BlockStatement | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'requestToolAuthorization') {
        retryBody = node.body;
      }
    });
    expect(retryBody, '应当存在 requestToolAuthorization').toBeDefined();

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
    let body: t.BlockStatement | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'handleAugmentRequestBody') body = node.body;
    });
    expect(body, '应当存在 handleAugmentRequestBody').toBeDefined();
    return body!;
  }

  /** 该函数体里 `if (isContinuationRequest(...)) { … }` 那个分支。 */
  function findContinuationBranch(): t.IfStatement {
    const branches: t.IfStatement[] = [];
    walkSourceAst(findAugmentBody(), (node) => {
      if (!t.isIfStatement(node)) return;
      const test = node.test;
      if (!t.isCallExpression(test) || !t.isIdentifier(test.callee)) return;
      if (test.callee.name === 'isContinuationRequest') branches.push(node);
    });
    expect(branches.length, '应当恰好有一个 isContinuationRequest(...) 分支').toBe(1);
    return branches[0]!;
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
    let body: t.BlockStatement | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'handleAugmentRequestBody') body = node.body;
    });
    expect(body, '应当存在 handleAugmentRequestBody').toBeDefined();

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
    const source = readFileSync(CONTENT_SOURCE, 'utf8');
    const setCalls = source.match(/requestToolDescriptorsByRequestId\.set\(/g) ?? [];
    expect(setCalls.length, '写入点必须恰好 3 个（chatNew 刻意不写，见注释）').toBe(3);
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
    let body: t.BlockStatement | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'handleAugmentRequestBody') body = node.body;
    });
    expect(body, '应当存在 handleAugmentRequestBody').toBeDefined();

    let filterCalls = 0;
    walkSourceAst(body!, (node) => {
      if (t.isCallExpression(node) && t.isIdentifier(node.callee)
        && node.callee.name === 'modelFacingDescriptorsFor') {
        filterCalls += 1;
      }
    });
    // 三个分支（chatNew / 续跑 / completion）各一次 —— 每处都要有自己的口径。
    expect(filterCalls, 'chatNew / 续跑 / completion 三个分支都该算出自己的模型可见目录').toBe(3);

    // ⚠️⚠️ **续跑轮的口径必须取 `continuationLoop`，不能退化成别的来源。**
    // 理由是**时序约束**不是偏好：续跑轮的提示词**在提交之前就建好了**
    // （`advanceContinuationLoop` 用 `loop.isAgentTurn` / `loop.nativeSearchOn` 过滤出
    // toolNames 喂给 `buildZaiContinuationPrompt`，nudge 轮同理），建提示词那一刻这个请求的
    // body 还不存在。识别与解析必须与提示词同源，所以只能取快照。
    // ⚠️ 循环不在时（用户手打了一段形似续跑模板的文本）退回读 body —— 那种请求就是真实的
    // 用户请求。**不能退化成「只看归属任务」**：模板文本不在 `taskIdByPromptText` 里、
    // `matchedTask` 取不到 ⇒ 那条路恒为 false。
    //
    // 断言方式：`isAgent` 是**内联**在 options 里的，`nativeSearchOn` 是**分支内先声明**再传。
    // 两种形态都要收 —— 只认一种会在重构时假红。
    const continuationBranch = findContinuationBranch();
    /** `continuationLoop?.xxx ?? …` 形态？ */
    const isLoopBacked = (value: t.Node | null | undefined): boolean => {
      if (!value || !t.isLogicalExpression(value) || value.operator !== '??') return false;
      const left = value.left;
      // ⚠️ `a?.b` 在这个 Babel 版本下是 `OptionalMemberExpression`（见
      // `zai-content-project-scope-contract.test.ts` 的同款判定）；两种都收，
      // 免得将来 Babel 行为变了变成假红。
      return (t.isOptionalMemberExpression(left) || t.isMemberExpression(left))
        && t.isIdentifier(left.object, { name: 'continuationLoop' });
    };

    // ① 分支内声明的、由 loop 快照派生的标识符（如 `const nativeSearchOn = loop?.x ?? …`）。
    const loopDerivedNames = new Set<string>();
    walkSourceAst(continuationBranch, (node) => {
      if (!t.isVariableDeclarator(node) || !t.isIdentifier(node.id)) return;
      if (isLoopBacked(node.init)) loopDerivedNames.add(node.id.name);
    });

    // ② 传给 modelFacingDescriptorsFor 的两个值，各自算不算「loop 派生」。
    const optionKeys = new Set<string>();
    walkSourceAst(continuationBranch, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      if (node.callee.name !== 'modelFacingDescriptorsFor') return;
      const options = node.arguments[1];
      if (!t.isObjectExpression(options)) return;
      for (const property of options.properties) {
        if (!t.isObjectProperty(property) || !t.isIdentifier(property.key)) continue;
        const key = property.key.name;
        if (key !== 'isAgent' && key !== 'nativeSearchOn') continue;
        const value = property.value;
        // 内联形态，或引用分支内声明的 loop 派生标识符（含 shorthand `{ nativeSearchOn }`）。
        const backed = isLoopBacked(value)
          || (t.isIdentifier(value) && loopDerivedNames.has(value.name));
        if (backed) optionKeys.add(key);
      }
    });
    expect(
      [...optionKeys].sort(),
      '续跑轮的 isAgent / nativeSearchOn 都必须源自 `continuationLoop`（内联或经分支内声明）',
    ).toEqual(['isAgent', 'nativeSearchOn']);

    // ⚠️⚠️ **续跑轮的「关原生通道」必须与「放行 web 工具」用同一个值。**
    //
    // 真机确认过的缺陷：这两件事曾经用两个来源不同的变量算 ——
    // `searchEnabled`（只看归属任务快照）决定要不要 `disableZaiNativeWebSearch`，
    // `loop.nativeSearchOn` 决定模型可见目录。两者只在自动化下相等；**非自动化 + 用户点了地球**
    // 时前者 false、后者 true ⇒ 放行了扩展 web 工具却**没关原生通道**，两套联网并存。
    // 真机实测：地球开着时页面**每轮都重新带** `features.auto_web_search=true`，
    // 「首条写过 false」不会延续到续跑轮。
    //
    // 断言方式：同一个标识符必须**同时**被 ① 传给 `modelFacingDescriptorsFor` 的
    // `nativeSearchOn`、② 守卫 `disableZaiNativeWebSearch(...)`。
    // 只断言其中一个都会被「用两个变量」的写法绕过。
    const passedToFilter = new Set<string>();
    const guardedDisable = new Set<string>();
    walkSourceAst(continuationBranch, (node) => {
      if (t.isCallExpression(node) && t.isIdentifier(node.callee)
        && node.callee.name === 'modelFacingDescriptorsFor') {
        const options = node.arguments[1];
        if (t.isObjectExpression(options)) {
          for (const property of options.properties) {
            if (!t.isObjectProperty(property) || !t.isIdentifier(property.key)) continue;
            if (property.key.name !== 'nativeSearchOn') continue;
            if (t.isIdentifier(property.value)) passedToFilter.add(property.value.name);
          }
        }
      }
      // `if (X) disableZaiNativeWebSearch(...)` —— 取 if 的 test 里的标识符。
      // ⚠️ **只认「直接守卫」**：consequent 直接就是那条调用（`if (X) f();`）。
      // 不能用「consequent 子树里有没有这条调用」—— 那样外层 `if (parsedBody) { … }`
      // 也会被算成守卫（它子树里确实有），于是断言拿到两个标识符而假红。
      if (t.isIfStatement(node) && t.isIdentifier(node.test)
        && t.isExpressionStatement(node.consequent)
        && t.isCallExpression(node.consequent.expression)
        && t.isIdentifier(node.consequent.expression.callee)
        && node.consequent.expression.callee.name === 'disableZaiNativeWebSearch') {
        guardedDisable.add(node.test.name);
      }
    });
    expect(
      [...passedToFilter].sort(),
      '续跑分支里传给 modelFacingDescriptorsFor 的 nativeSearchOn 必须是一个标识符',
    ).toHaveLength(1);
    expect(
      [...guardedDisable].sort(),
      '续跑分支里 disableZaiNativeWebSearch 必须被一个标识符守卫',
    ).toHaveLength(1);
    expect(
      [...guardedDisable],
      `「放行 web 工具」与「关原生通道」必须用同一个变量（现在分别是 ${[...passedToFilter]} 与 ${[...guardedDisable]}）`,
    ).toEqual([...passedToFilter]);
  });

  it('releases the per-request descriptor map alongside the other request-scoped state', () => {
    const program = readContentProgram();
    let body: t.BlockStatement | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'releaseRequestState') body = node.body;
    });
    expect(body, '应当存在 releaseRequestState').toBeDefined();

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

  /**
   * ⚠️⚠️ **completion 轮的联网标记必须能带上「归属任务的 searchEnabled」。**
   *
   * 那个值的用途是双重的：既决定本轮关不关原生通道，又经
   * `isAgentTurnByRequestId` 旁的 `nativeSearchOnByRequestId` → `ContinuationLoop.nativeSearchOn`
   * 决定**续跑轮列不列 web 工具**。少一路来源的后果是有条件的、且**不报错**：
   * 「用户页面默认开着地球 + 跑一个开了搜索的自动化」时，续跑轮既不列工具、也不关原生。
   *
   * ⚠️ **曾经的形态是这里重查了一遍 `taskIdByPromptText.get(originalPrompt)`** ——
   * 那个 Map 的语义是「**待认领**的 prompt → taskId」，本请求的条目**在本函数更早处
   * 已被 delete**，所以那个三元恒不成立、任务标记从来没被并进来。**读一个已删的键
   * 不会报错、测试也不会红**，所以把「来源里必须含 task」钉在这里。
   *
   * ⚠️ 断言**只认「表达式里引用了 `X.searchEnabled`」**，不锁变量名与写法 ——
   * 内联 `matchedTask?.searchEnabled === true || …` 与先声明一个局部变量都算过。
   */
  it('derives the completion native-search flag from the assigned task, not from the pending-prompt map', () => {
    const augmentBody = findAugmentBody();

    // 收集 `X.searchEnabled` 形态的成员表达式所取的对象名。
    const taskFlagReceivers = new Set<string>();
    walkSourceAst(augmentBody, (node) => {
      if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node)) return;
      if (!t.isIdentifier(node.property) || node.property.name !== 'searchEnabled') return;
      if (t.isIdentifier(node.object)) taskFlagReceivers.add(node.object.name);
    });

    // 反面：**归属之后**不得再按 prompt 原文去查那个「待认领」映射 ——
    // 本请求的条目此刻已被 delete，读它恒 `undefined`。
    // ⚠️ **判据必须锚在「那次 delete 之后」**：归属本身当然要先 `get` 一次
    // （读到才 `delete`），把整段扫一遍会把那次合法读取也算成违规。
    const deletePositions: number[] = [];
    walkSourceAst(augmentBody, (node) => {
      if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
      if (!t.isIdentifier(node.callee.property) || node.callee.property.name !== 'delete') return;
      if (!t.isIdentifier(node.callee.object, { name: 'taskIdByPromptText' })) return;
      if (node.start !== null && node.start !== undefined) deletePositions.push(node.start);
    });
    expect(
      deletePositions.length,
      '应当有一处 `taskIdByPromptText.delete(...)`（归属时释放「待认领」映射）',
    ).toBeGreaterThan(0);
    const assignmentPosition = Math.min(...deletePositions);

    const lateReads: number[] = [];
    walkSourceAst(augmentBody, (node) => {
      if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
      if (!t.isIdentifier(node.callee.property) || node.callee.property.name !== 'get') return;
      if (!t.isIdentifier(node.callee.object, { name: 'taskIdByPromptText' })) return;
      if (node.start === null || node.start === undefined) return;
      if (node.start > assignmentPosition) lateReads.push(node.loc?.start.line ?? -1);
    });

    expect(
      lateReads,
      '归属之后不得再读 `taskIdByPromptText.get(...)` —— 本请求的条目已被 delete，'
      + `读它恒为 undefined（任务标记会被静默丢掉）。这些行违规：${lateReads.join(', ')}`,
    ).toEqual([]);
    expect(
      [...taskFlagReceivers].length,
      'completion 轮的联网标记必须由「归属任务」的 searchEnabled 派生（没有任何 `X.searchEnabled` 读取）',
    ).toBeGreaterThan(0);
    expect(
      [...taskFlagReceivers],
      `归属任务的来源只能是本函数内那次归属的结果（matchedTask），实际读了：${[...taskFlagReceivers].join(', ')}`,
    ).toContain('matchedTask');
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
describe('chatNew does not write request-scoped state it can never release', () => {
  /** `handleAugmentRequestBody` 里 `route === 'chatNew'` 那个 if 节点。 */
  function findChatNewBranch(): t.IfStatement {
    const program = readContentProgram();
    let body: t.BlockStatement | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'handleAugmentRequestBody') body = node.body;
    });
    expect(body, '应当存在 handleAugmentRequestBody').toBeDefined();

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
    // 手抄的第二份清单必然分叉（B9），而这里的分叉形态是静默的：新容器没人守，
    // chatNew 一旦写了它就成了永不释放的孤儿，且不会有任何测试变红。
    const program = readContentProgram();
    let releaseBody: t.BlockStatement | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'releaseRequestState') {
        releaseBody = node.body;
      }
    });
    expect(releaseBody, '应当存在 releaseRequestState').toBeDefined();

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

