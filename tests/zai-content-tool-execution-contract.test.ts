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

      // 该函数体里 `filterZaiModelFacingToolDescriptors(第一个参数, …)` 的**根标识符**。
      // 两种写法都要认：`descriptors`（解构）与 `loopState.descriptors`（整体持有）。
      const receivers: string[] = [];
      walkSourceAst(body!, (node) => {
        if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
        if (node.callee.name !== 'filterZaiModelFacingToolDescriptors') return;
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
        if (node.callee.name !== 'filterZaiModelFacingToolDescriptors') return;
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
    const countPush = (node: t.Node) => {
      // ⚠️ `diag.failures?.push(...)` 在 Babel 里是 `OptionalCallExpression`
      // （callee 是 `OptionalMemberExpression`），只认 `CallExpression` 会漏掉它。
      if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
      const callee = node.callee;
      if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return;
      if (t.isIdentifier(callee.property) && callee.property.name === 'push') reported += 1;
    };
    for (const clause of catchClausesOf(body)) walkSourceAst(clause, countPush);
    expect(reported, 'catch 里要记一条诊断 —— 不抛就只剩它可见').toBeGreaterThan(0);
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
  it('returns this request\'s authorized descriptor names in the augment result', () => {
    const program = readContentProgram();
    let body: t.BlockStatement | undefined;
    walkSourceAst(program, (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === 'handleAugmentRequestBody') body = node.body;
    });
    expect(body, '应当存在 handleAugmentRequestBody').toBeDefined();

    // 收集所有 `toolDescriptorNames:` 的值，断言它们都是 `catalogNamesFor(<某>.descriptors)`，
    // 没有一处回落到 `currentCatalogNames`。
    const sources: string[] = [];
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
        if (t.isMemberExpression(arg) && t.isIdentifier(arg.property)
          && arg.property.name === 'descriptors') {
          sources.push('descriptors');
          return;
        }
      }
      sources.push('<非预期来源>');
    });

    expect(sources.length, '应当有多处回传 toolDescriptorNames（chatNew / 续跑 / completion）').toBeGreaterThanOrEqual(3);
    expect(sources.every((s) => s === 'descriptors'), `toolDescriptorNames 必须来自本请求的 descriptors，实际：${sources.join(', ')}`).toBe(true);
    expect(usesGlobalCatalogNames, '不得回传全局 currentCatalogNames（那是上次同步，会与提示词分叉）').toBe(false);
  });

  it('parses fallback tool XML with the per-request descriptors, not the global snapshot', () => {
    const program = readContentProgram();
    // 所有 `parseToolXml(<text>, <第二参>)` 调用点，收集第二参是不是**裸** `currentToolDescriptors`。
    const bareGlobalArgs: number[] = [];
    const callLines: number[] = [];
    walkSourceAst(program, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      if (node.callee.name !== 'parseToolXml') return;
      callLines.push(node.loc?.start.line ?? -1);
      const second = node.arguments[1];
      if (t.isIdentifier(second) && second.name === 'currentToolDescriptors') {
        bareGlobalArgs.push(node.loc?.start.line ?? -1);
      }
    });
    expect(callLines.length, '应当有 parseToolXml 调用点').toBeGreaterThan(0);
    // 不得有任何一处把裸 `currentToolDescriptors` 当目录 —— 那正是要消除的分叉。
    expect(bareGlobalArgs, `这些行的 parseToolXml 用了裸 currentToolDescriptors（会与提示词分叉）：${bareGlobalArgs.join(', ')}`).toEqual([]);

    // 且必须真的用到了按请求的 Map（要么直接、要么经 `const descriptors = … ?? currentToolDescriptors`）。
    const source = readFileSync(CONTENT_SOURCE, 'utf8');
    // ⚠️ **写入点恰好 3 个**（续跑 / completion / 懒建）—— **chatNew 刻意不写**：它没有终态
    // 事件（`fetch-hook` 只在 completion 路由发 `onRequestTerminal`），与随后的 completion 是
    // 两个不同 requestId ⇒ 写了既**无人释放**（孤儿泄漏）、也**无人读**（Map 的读点读的都是
    // completion 的 requestId）。这条钉住「别把 chatNew 那行加回来」。
    const setCalls = source.match(/requestToolDescriptorsByRequestId\.set\(/g) ?? [];
    expect(setCalls.length, '写入点必须恰好 3 个（chatNew 刻意不写，见注释）').toBe(3);
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
});

