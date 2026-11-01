import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as t from '@babel/types';
import { ZAI_CAPABILITY_DEP_KEYS } from '../core/zai/capability-install';
import { walkSourceAst } from './helpers/typescript-source';
import {
  countReachableMethodCalls,
  directObjectMembers,
  findFunctionBody,
  findOrphanFunctions,
  isMethodCallTo,
  isNamedKey,
  isRawValueExpression,
  readContentProgram,
  topLevelNames,
  walkReachable,
} from './helpers/content-source-ast';

/**
 * **内容脚本里「按名字找调用点」的那几条守卫** —— 只剩下「行为化不划算」的部分。
 *
 * ## 这里为什么还留着 AST 断言
 *
 * 曾经这里有一整套（22 条）接线守卫，守的是「启动链的安装有没有接上」「补全注入了
 * 哪些原语」「地址观察有没有通知」。它们**全部**被换成了行为测试
 * （`tests/zai-capability-install.test.ts`）—— 因为那一族只能问「源码里有没有这个名字」，
 * 而实测被下面这些写法逐一绕过（每一种都 `tsc` 干净、全量全绿）：
 * 挪进死函数 / 死类 / 死箭头；用 `const`、解构、`catch` 参数、形参重新绑定同名标识符；
 * 真身改名 + 末尾补同名壳靠**声明提升**接管；import 换同名 stub；
 * 在同名可达函数体内塞**诱饵**同名函数。
 *
 * **留下的是三条**，各自因为「行为化不划算」：
 * ① **孤儿检测** —— 它是**全局死代码检测**，没有对应的行为可测（「这段代码永不执行」
 *    本身就是负向事实）。行为化的替代品是覆盖率，而覆盖率不进 CI。
 * ② **工具面板的四个投递点** —— 它们在 `dispatchMainWorldMessageInner` /
 *    `startDetectedToolCall` / `handleResponseComplete` 里，要行为化得把整个
 *    消息分发器与续跑状态机都做成可注入的，依赖面太大、收益不抵风险。
 * ③ **`REQUEST_TERMINAL` 分支里的收尾** —— 同上（`caseBodies`）。
 *
 * ⚠️ **②③ 的判据已经收到最紧**：`findFunctionBody` 只认 `program.body` 的顶层声明
 * （免疫嵌套诱饵）、`collectMessageCaseBodies` 只认那一个 `switch (data.type)`
 * 且重复 case 直接抛错（免疫重复 case 诱饵）。
 */
/**
 * **`main()` 传给编排层的依赖必须是真东西** —— 这是 A 方案之后唯一留在 AST 层的
 * 「启动链」判据，补的是行为测试够不到的那一格。
 *
 * ⚠️⚠️ **为什么还需要它**：行为测试（`tests/zai-capability-install.test.ts`）验的是
 * 「**给一套依赖，编排层会不会正确调用它们**」。而 `main()` 那边传进去的
 * 是不是真函数（还是一个同名空壳），它看不见 —— 实测：把
 * `installInjectedThemeWatch,` 改成 `installInjectedThemeWatch: () => {},`
 * 之后，编排层测试照绿（它拿的是自己造的桩），只有本文件这条会红。
 *
 * ⚠️ **判据是「值的根标识符与键同名」** —— 认 shorthand（`installX,`）与
 * 具名（`installX: installX,`）两种写法，但**拒绝任何不是同名标识符的值**
 * （箭头 / 字面量 / 别的名字）。这比「键存在」硬：键存在只证明「有个字段」。
 */
describe('content script main(): the dependency object holds the real functions', () => {
  /** 从 `main()` 里取出 `installZaiCapabilities({ … })` 的实参对象。 */
  function findCapabilityDepObject(): t.ObjectExpression {
    const program = readContentProgram();
    let found: t.ObjectExpression | undefined;
    walkReachable(findMainBodyOf(program), (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      if (node.callee.name !== 'installZaiCapabilities') return;
      const [options] = node.arguments;
      if (t.isObjectExpression(options)) found = options;
    });
    expect(found, 'main() 里应当调 installZaiCapabilities({ … })').toBeDefined();
    return found!;
  }

  /**
   * `ZaiCapabilityDeps` 里**标了 `?` 的**键 —— 即「允许不传」的那几个。
   *
   * ⚠️ **从接口派生，不手抄**：手抄的第二份清单会在改接口时静默分叉，
   * 而这里的分叉形态是「本该允许不传的键被判成漏传」⇒ 假红。
   */
  function optionalCapabilityDepKeys(): Set<string> {
    const program = readContentProgram('core/zai/capability-install.ts');
    const optional = new Set<string>();
    walkSourceAst(program, (node) => {
      if (!t.isTSInterfaceDeclaration(node)) return;
      if (!t.isIdentifier(node.id, { name: 'ZaiCapabilityDeps' })) return;
      for (const member of node.body.body) {
        if (!t.isTSPropertySignature(member) || member.optional !== true) continue;
        if (t.isIdentifier(member.key)) optional.add(member.key.name);
      }
    });
    // 先确认这份派生不是空的 —— 接口被改名 / 搬走时，「没有可选键」会让下面的
    // 「允许不传」整条失效（本该红的漏传变成绿的）。
    expect(optional.size, '应当从接口里派生出至少一个可选键').toBeGreaterThan(0);
    return optional;
  }

  it.each(ZAI_CAPABILITY_DEP_KEYS)('passes a real `%s`', (key) => {
    const object = findCapabilityDepObject();
    const matching = object.properties.filter((property): property is t.ObjectProperty => (
      t.isObjectProperty(property)
      && ((t.isIdentifier(property.key) && property.key.name === key)
        || (t.isStringLiteral(property.key) && property.key.value === key))
    ));
    // ⚠️ **「最多一次」要排在「允许不传」之前** —— 反过来的话，可选键那一格
    // 重复出现时会被静默放过（重复的键里只有最后一个生效，等于有一项被悄悄丢掉）。
    expect(matching.length, `\`${key}\` 在依赖对象里最多出现一次`).toBeLessThanOrEqual(1);
    // 可选的几个允许不传 —— 但传了就必须是真东西。
    // ⚠️ **「可选」的判据是接口上的 `?`**，不是一份手抄名单：它现在有真实消费者
    // （`onContinuationBubblesHidden` 的接线已按「不把诊断摆给用户看」去掉）。
    if (matching.length === 0) {
      expect(
        optionalCapabilityDepKeys().has(key),
        `\`${key}\` 在接口上是必填的，main() 的依赖对象里不能少它`,
      ).toBe(true);
      return;
    }

    const value = matching[0]!.value;

    // 形态一：裸标识符 —— **必须是模块顶层的东西**（真函数声明或 import）。
    // ⚠️ 判据不能写成「与键同名」：有三处是**有意的别名**
    //（`onSessionChange: onZaiSessionChange` / `refreshAuth: refreshZaiAuth` /
    // `syncRuntimeState: loadAndSyncRuntimeState`）—— 按同名判会把它们全判成假红。
    // ⚠️ 也不能只判「是个标识符」：在 `main()` 里写
    // `const installStopObserver = () => {}` 然后 shorthand 传进去，同样是个标识符。
    // ⇒ **判据是「它解析到模块顶层的绑定」** —— 局部 stub 不在那个集合里。
    if (t.isIdentifier(value)) {
      const program = readContentProgram();
      expect(
        topLevelNames(program).has(value.name),
        `\`${key}\` 传的 \`${value.name}\` 不是模块顶层的声明 / import —— `
        + '它很可能是 main() 里的一个局部 stub（那样编排层拿到的是空壳）',
      ).toBe(true);
      return;
    }

    // 形态二：适配器（箭头 / 函数表达式）—— 接口要求无参、而真函数需要参数时必需
    //（例如 `installSessionWatch: () => installSessionWatch(ctx)`）。
    // ⚠️ **判据是「体里至少有一次调用」** —— 空壳 `() => {}` 会被抓住。
    // ⚠️ **残余**：`() => someOtherThing()` 这种「有调用但不是那一件事」过不了这一条；
    // 它由**孤儿检测**兜底（真函数没人调 ⇒ 落进孤儿集合 ⇒ 另一条断言红）。
    if (t.isArrowFunctionExpression(value) || t.isFunctionExpression(value)) {
      let calls = 0;
      walkReachable(value.body, (node) => {
        if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) calls += 1;
      });
      expect(
        calls,
        `\`${key}\` 传的是一个**空**适配器（体里没有任何调用）—— 编排层拿到它等于什么都没装`,
      ).toBeGreaterThan(0);
      return;
    }

    throw new Error(
      `\`${key}\` 的值既不是标识符也不是函数（是 ${value.type}）—— `
      + '传字面量 / 别的表达式时，编排层拿到的不是那个真函数',
    );
  });

  it.each([
    ['installSessionWatch', 'installSessionWatch'],
    // ⚠️ 面板那处的适配器调的是**成员方法**（`toolPanel.install()`），
    // 所以这里认的是属性名。
    ['installToolPanel', 'install'],
  ])('wraps `%s` around the real `%s` instead of a stub', (key, realName) => {
    // ⚠️⚠️ 上面那条只要求「适配器体里有调用」，挡不住 `() => someOtherThing()`。
    // 这条把「适配器里被调的那个名字」钉死 —— 两者合起来才等于「传的是真东西」。
    const object = findCapabilityDepObject();
    const property = object.properties.find((entry): entry is t.ObjectProperty => (
      t.isObjectProperty(entry) && t.isIdentifier(entry.key, { name: key })
    ));
    expect(property, `依赖对象里应当有 \`${key}\``).toBeDefined();

    const value = property!.value;
    if (!t.isArrowFunctionExpression(value) && !t.isFunctionExpression(value)) return;
    const calledNames: string[] = [];
    walkReachable(value.body, (node) => {
      if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
      // 自由调用取函数名；成员调用取属性名（`toolPanel.install()` → `install`）。
      if (t.isIdentifier(node.callee)) calledNames.push(node.callee.name);
      else if ((t.isMemberExpression(node.callee) || t.isOptionalMemberExpression(node.callee))
        && t.isIdentifier(node.callee.property)) {
        calledNames.push(node.callee.property.name);
      }
    });
    expect(
      calledNames,
      `\`${key}\` 的适配器必须调到真正的 \`${realName}\``,
    ).toContain(realName);
  });

  it('names every dependency it passes (no typo keys)', () => {
    // 反向：依赖对象里不得出现接口上没有的键（拼错的名字会让那一项静默失效）。
    const known = new Set<string>(ZAI_CAPABILITY_DEP_KEYS);
    const object = findCapabilityDepObject();
    const unknown = object.properties
      .filter((property): property is t.ObjectProperty => t.isObjectProperty(property))
      .map((property) => (t.isIdentifier(property.key) ? property.key.name
        : (t.isStringLiteral(property.key) ? property.key.value : '<computed>')))
      .filter((key) => !known.has(key));
    expect(unknown, `这些键不在 ZaiCapabilityDeps 上（拼错了会让那一项静默失效）`).toEqual([]);
  });
});

/** `defineContentScript({ …, main() { … } })` 里那个 `main` 的函数体。 */
function findMainBodyOf(program: t.Program): t.BlockStatement {
  let body: t.BlockStatement | undefined;
  walkReachable(program, (node) => {
    if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
    if (node.callee.name !== 'defineContentScript') return;
    const options = node.arguments[0];
    if (!t.isObjectExpression(options)) return;
    for (const property of options.properties) {
      if (t.isObjectMethod(property)) {
        if (t.isIdentifier(property.key, { name: 'main' })) body = property.body;
        continue;
      }
      if (!t.isObjectProperty(property) || !t.isIdentifier(property.key)) continue;
      if (property.key.name !== 'main') continue;
      const value = property.value;
      if ((t.isFunctionExpression(value) || t.isArrowFunctionExpression(value))
        && t.isBlockStatement(value.body)) {
        body = value.body;
      }
    }
  });
  expect(body, '应当能在 defineContentScript 的选项里找到 main 的函数体').toBeDefined();
  return body!;
}

describe('no orphan top-level functions in the content script', () => {
  /**
   * 白名单：**当前确实零调用点**的顶层函数。
   *
   * ⚠️ **加进来必须写清「为什么留着」** —— 这份名单是唯一的例外出口，
   * 一行不加说明的条目会让下一个人以为「孤儿是被允许的」。
   */
  const ORPHAN_ALLOWLIST = new Map<string, string>([]);

  it('has no unexpected orphans', () => {
    // ⚠️⚠️ **这是唯一能抓住「真身改名 + 末尾补同名函数」的判据** —— 那种写法下
    // 被改名的真身再也没人引用 ⇒ 必然落进孤儿集合。
    // ⚠️ **「裸提及」不算引用**（`void f;` / `f, 0;` / `(<any>f);` 都不算）——
    // 否则一行压 unused 的提及就能把真身放回可达集、这条判据失效。
    const orphans = [...findOrphanFunctions(readContentProgram())].sort();
    expect(
      orphans,
      '这些顶层函数从 main() 出发不可达 —— 要么是「真身改名后忘了删旧实现」，'
      + '要么是新写的死代码。确属有意保留请加进 ORPHAN_ALLOWLIST 并写明理由。',
    ).toEqual([...ORPHAN_ALLOWLIST.keys()].sort());
  });

  it('keeps the allowlist entries actually orphaned', () => {
    // 反面守卫：白名单里的函数**真的**是孤儿时才准留在名单上 ——
    // 将来有人把它接回生产后，这条会红，提醒把名单项删掉。
    const orphans = findOrphanFunctions(readContentProgram());
    for (const name of ORPHAN_ALLOWLIST.keys()) {
      expect(orphans.has(name), `${name} 已经接回生产了 ⇒ 把它从 ORPHAN_ALLOWLIST 里删掉`).toBe(true);
    }
  });
});

/**
 * **工具面板三条腿的投递点** —— 每个投递点都是那一条腿的入口。
 *
 * ⚠️⚠️ 这些调用点**全部零覆盖**：删掉任何一个，全量用例 + `tsc` **全绿**
 * （实测，逐个删过）。它们的失效形态各不相同、且都静默：
 * - `rememberHistoryRecords` 是**历史腿整条链的入口**（删了面板拿不到锚点）；
 * - `beginToolCall` 是**实时腿**（删了不画「执行中」、也不登记 raw）；
 * - `completeToolCall` 决定「执行中」那一行会不会被换成真结果；
 * - `rememberExecutions` 是 `TOOL_CALL` 通道没来时的**唯一补偿**（两处，两条分支各一）。
 */
describe('tool panel: every delivery point is wired to its handler', () => {
  it('delivers history records from the main-world message handler', () => {
    // 判据两条一起：调用在 `dispatchMainWorldMessageInner` 的可达范围里，
    // **且两个实参都是解构出来的那个 decoder 结果**（传错一个字段会静默丢会话归属）。
    const program = readContentProgram();
    const body = findFunctionBody(program, 'dispatchMainWorldMessageInner');

    const calls = countReachableMethodCalls(body, 'toolPanel', 'rememberHistoryRecords');
    expect(calls, '历史腿的投递点必须恰好一处').toBe(1);

    const rawCalls: t.CallExpression[] = [];
    walkReachable(body, (node) => {
      if (t.isCallExpression(node) && isMethodCallTo(node, 'toolPanel', 'rememberHistoryRecords')) {
        rawCalls.push(node);
      }
    });
    const args = rawCalls[0]!.arguments;
    expect(args, 'rememberHistoryRecords 必须收到两个实参').toHaveLength(2);
    const [recordsArg, sessionArg] = args;
    expect(
      t.isMemberExpression(recordsArg) && t.isIdentifier(recordsArg.property, { name: 'records' }),
      '第一个实参必须是 decoder 结果上的 records（传数组会让 isPlainRecord 判否、整批丢弃）',
    ).toBe(true);
    expect(
      t.isMemberExpression(sessionArg) && t.isIdentifier(sessionArg.property, { name: 'chatSessionId' }),
      '第二个实参必须是 decoder 结果上的 chatSessionId（传 null 会让兜底腿失去会话闸门）',
    ).toBe(true);
  });

  it('draws the running row from the detected-tool-call path, with the raw attached', () => {
    // ⚠️ **位置是契约的一部分**：它必须在「检测到工具调用」的那个入口里而不是
    // `executeDetected` 里 —— 后者也会从兜底路径被调，那条路刻意不画「执行中」。
    // ⚠️ 那个入口同时承担「登记在飞执行计数」的职责，名字是 `startDetectedToolCall`。
    const program = readContentProgram();
    const body = findFunctionBody(program, 'startDetectedToolCall');

    expect(countReachableMethodCalls(body, 'toolPanel', 'beginToolCall'), '必须调一次 beginToolCall').toBe(1);
    expect(
      countReachableMethodCalls(findFunctionBody(program, 'executeDetected'), 'toolPanel', 'beginToolCall'),
      'executeDetected 里不得再画一次「执行中」（兜底路径会因此闪一下）',
    ).toBe(0);

    // ⚠️⚠️ **`raw` 是合流签名的一半**，判据见 `isRawValueExpression`（与
    // `noteToolCallRaw` 那处**共用同一份**）—— 它同时拒绝「属性名取错」
    // （`detected.name`）与「`&&` 兜底」（`call.raw && ''`，值恒空串）。
    let rawValues: t.Node[] = [];
    walkReachable(body, (node) => {
      if (!t.isCallExpression(node) || !isMethodCallTo(node, 'toolPanel', 'beginToolCall')) return;
      const options = node.arguments[1];
      if (!t.isObjectExpression(options)) return;
      rawValues = directObjectMembers(options)
        .filter((property) => isNamedKey(property.key, 'raw'))
        .map((property) => property.value);
    });
    expect(rawValues, 'beginToolCall 的第二个实参里必须有 raw').toHaveLength(1);
    expect(
      isRawValueExpression(rawValues[0]),
      'raw 必须取到原始 XML（形如 `detected.raw` 或 `detected.raw ?? ""`）—— '
      + '取成 `detected.name` 或写成 `&& ""` 都会让签名与历史腿配不上',
    ).toBe(true);
  });

  it('replaces the running row and records the result from the execution path', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'executeDetected');
    expect(countReachableMethodCalls(body, 'toolPanel', 'completeToolCall'), '必须把真实结果投回去').toBe(1);
    expect(
      countReachableMethodCalls(body, 'toolPanel', 'noteToolCallRaw'),
      '必须登记 raw（兜底路径不调 beginToolCall，这是它唯一的登记点）',
    ).toBe(1);
  });

  it('records the whole turn from both completion branches', () => {
    // ⚠️ **两处**：续跑轮一处、原生轮一处（`handleResponseComplete` 里两条分支各自收尾）。
    // 少一处 ⇒ 那条分支上「`TOOL_CALL` 通道没来」时结果永远补不上。
    const body = findFunctionBody(readContentProgram(), 'handleResponseComplete');
    expect(countReachableMethodCalls(body, 'toolPanel', 'rememberExecutions'), '两条分支各投一次').toBe(2);
  });
});

/**
 * **标签保活只在「发送链」那一段要，而且进出必须成对。**
 *
 * ⚠️⚠️ 挂上 debugger 会让 Chrome 在**所有窗口**顶部画「Zai++ started debugging this browser」
 * （`ShowGlobally`，不是只画在被调试的那个窗口）⇒ 挂的窗口越长，用户看到横幅的时间越长。
 * 而真正会被节流掐断的只有发送链那几条 80–150ms 短轮询（4 秒 / 5 秒预算）；
 * **等响应是网络事件驱动的、不吃定时器** ⇒ 发完就能卸。
 *
 * ⚠️ 这三条调用点**零覆盖**：删掉任何一条，全量用例 + `tsc` 都绿（实测过）。
 */
describe('tab keepalive: wanted only around the send window', () => {
  it('wants and releases inside submitContinuationViaPage (one place covers all three injection chains)', () => {
    // ⚠️ 续跑推进 / 普通 nudge / 误用纠错都经过这个函数 ⇒ 一处覆盖三条链。
    const program = readContentProgram();
    const body = findFunctionBody(program, 'submitContinuationViaPage');

    const wants: t.CallExpression[] = [];
    const releases: t.CallExpression[] = [];
    walkSourceAst(body, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      if (node.callee.name === 'wantTabKeepAlive') wants.push(node);
      if (node.callee.name === 'releaseTabKeepAlive') releases.push(node);
    });

    expect(wants, '发送前要 want 一次').toHaveLength(1);
    // ⚠️ **必须是 finally 里那一次** —— 中间任何一处抛错（注入原语 / 证据等待）都不能
    // 把横幅留在那儿。判据：release 的调用点在某个 TryStatement 的 finalizer 里。
    expect(releases, '发送后要 release 一次').toHaveLength(1);
    let inFinally = false;
    walkSourceAst(body, (node) => {
      if (!t.isTryStatement(node) || !node.finalizer) return;
      walkSourceAst(node.finalizer, (inner) => {
        if (inner === releases[0]) inFinally = true;
      });
    });
    expect(inFinally, 'release 必须在 finally 里 —— 抛错路径也要卸').toBe(true);
  });

  it('does not keep the session attached for the whole continuation loop', () => {
    // ⚠️⚠️ **常驻挂着是本轮要修掉的那件事**：整轮续跑都挂 ⇒ 横幅一直显示在用户眼前。
    // 这两个函数里都不该再有 want —— 保护由发送链按需给。
    const program = readContentProgram();
    for (const name of ['advanceContinuationLoop', 'handleResponseComplete', 'startMisuseCorrectionLoop']) {
      const body = findFunctionBody(program, name);
      const wants: t.CallExpression[] = [];
      walkSourceAst(body, (node) => {
        if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: 'wantTabKeepAlive' })) {
          wants.push(node);
        }
      });
      expect(wants, `${name} 不该常驻挂保活`).toHaveLength(0);
    }
  });

  it('stops the keepalive when a fresh page starts (clears the previous page orphan)', () => {
    // ⚠️⚠️ 保活活在 SW 里（按标签记），内容脚本是每页一份。页面一刷新，旧页面那条
    // 循环连同它的收尾一起消失，而 SW 里那条 CDP 会话还在 ⇒ 横幅永久滞留。
    // 新页面启动时必然没有循环 ⇒ 该标签上任何保活意图都是孤儿。
    const program = readContentProgram();
    const body = findMainBodyOf(program);
    const calls: t.CallExpression[] = [];
    walkSourceAst(body, (node) => {
      if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: 'releaseTabKeepAlive' })) {
        calls.push(node);
      }
    });
    expect(calls, '内容脚本启动时要清掉上一页留在后台的保活会话').toHaveLength(1);
  });
});

/**
 * **两条建循环的路径都必须先收掉在跑的旧循环。**
 *
 * ⚠️⚠️ 首轮误用纠错那条（`startMisuseCorrectionLoop`）比原生轮那段守卫**更早返回**，
 * 而它自己无条件覆盖 `continuationLoop`。漏掉这次 supersede 的后果是**旧循环归属的后台任务
 * 永远收不到终态**（一直显示「运行中」到 180s 租约超时）—— 与原生轮那段注释描述的是同一个
 * 失效形态，且**全量用例 + tsc 全绿**（实测，删掉它不红）。
 *
 * ⚠️ 判据两条一起：**恰好调一次** + **早于 `continuationLoop = {` 赋值**。
 * 只判「调用过」挡不住「放在赋值之后」（那样旧循环已经被顶掉了，收尾时 `continuationLoop !== loop`）。
 */
describe('continuation loop: every creation path supersedes the running one first', () => {
  function callsInOrder(body: t.Node, name: string): t.CallExpression[] {
    const calls: t.CallExpression[] = [];
    walkSourceAst(body, (node) => {
      if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name })) calls.push(node);
    });
    return calls;
  }

  function assignmentStart(body: t.Node): number {
    let start = Number.POSITIVE_INFINITY;
    walkSourceAst(body, (node) => {
      if (!t.isAssignmentExpression(node)) return;
      if (!t.isIdentifier(node.left, { name: 'continuationLoop' })) return;
      start = Math.min(start, node.start ?? Number.POSITIVE_INFINITY);
    });
    return start;
  }

  it('the misuse correction path supersedes before creating its loop', () => {
    const body = findFunctionBody(readContentProgram(), 'startMisuseCorrectionLoop');
    const supersedes = callsInOrder(body, 'supersedeRunningLoop');
    expect(supersedes, '建循环前必须先收起在跑的旧循环').toHaveLength(1);
    expect(
      supersedes[0]!.start ?? 0,
      'supersede 必须早于 `continuationLoop = { … }` —— 放后面等于旧循环已经被顶掉',
    ).toBeLessThan(assignmentStart(body));
  });

  it('the native-turn path still supersedes before creating its loop', () => {
    const body = findFunctionBody(readContentProgram(), 'handleResponseComplete');
    expect(callsInOrder(body, 'supersedeRunningLoop'), '原生轮那条路径也必须先收').toHaveLength(1);
  });
});

/**
 * **切会话必须收掉续跑循环。**
 *
 * ⚠️⚠️ 不收的后果不是「横幅挂着」那一点：循环停在 `running`，而 `runDomTask` 的 busy
 * 判据读的正是它 ⇒ **之后这个标签页上每一次自动化都被静默拒掉**（`busy` 不在
 * `RETRYABLE_PRE_SEND_ERRORS` 里、后台不重试、不打日志）。长窗口也因此永不解除。
 */
describe('session change: reclaim the continuation loop', () => {
  const RECLAIM_FN = 'reclaimLoopOnSessionChange';

  /** 子树里所有 `name(...)` 调用（按位置排序）。 */
  function callsInOrder(node: t.Node, name: string): t.CallExpression[] {
    const found: t.CallExpression[] = [];
    walkSourceAst(node, (child) => {
      if (t.isCallExpression(child) && t.isIdentifier(child.callee, { name })) found.push(child);
    });
    return found.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  }

  it('收尾走 failContinuationLoop，不是 finishContinuationLoop', () => {
    // ⚠️⚠️ `finishContinuationLoop` 在 `loop.taskId` 存在时**无条件回 `DOM_TASK_COMPLETE`**
    // （= 成功），而这里的事实是「任务被掐断」。回 COMPLETE 会让自动化显示成功、
    // 正文却是空的 —— 协调器按 `ok: true` 收、scheduler 记 `succeeded`。
    const body = findFunctionBody(readContentProgram(), RECLAIM_FN);
    expect(callsInOrder(body, 'failContinuationLoop')).toHaveLength(1);
    expect(callsInOrder(body, 'finishContinuationLoop')).toHaveLength(0);
  });

  it('判据是地址栏会话，且「假会话变化」那一档由类型挡住', () => {
    // ⚠️⚠️ 这一档原先靠 `if (!loop.chatSessionId) return;` 守 —— 而那条守卫**恒不生效**：
    // 两条建循环路径都在建之前判过非空，所以 `loop.chatSessionId` 从来不是 null/空。
    // 现在把它**收窄成 `string`**，语义从「运行时判空」升级成「类型层不可能为空」：
    // 启动时那次假变化里 `current` 是 null、`loop.chatSessionId` 非空
    // ⇒ `current === loop.chatSessionId` 为假 ⇒ 照常「不等就收」，守卫本来就是多余的。
    const program = readContentProgram();
    const source = readFileSync('entrypoints/zai.content.ts', 'utf8');
    const body = findFunctionBody(program, RECLAIM_FN);

    expect(callsInOrder(body, 'getCurrentChatSessionId').length, '必须读当前会话')
      .toBeGreaterThan(0);

    const guards = body.body.filter((node): node is t.IfStatement => t.isIfStatement(node));
    const tests = guards.map((node) => source.slice(node.test.start ?? 0, node.test.end ?? 0));
    // ⚠️ **那条恒不生效的非空守卫不该回来** —— 它给人「这里已经防住了」的错觉，
    // 而真正的防线是类型（`ContinuationLoop.chatSessionId: string`）。
    expect(
      tests.some((text) => text.includes('!loop.chatSessionId')),
      '不该再有 `if (!loop.chatSessionId) return;` —— 它恒不生效，防线已经移到类型上',
    ).toBe(false);
    expect(
      tests.some((text) => text.includes('current') && text.includes('loop.chatSessionId')),
      '必须比较「当前会话」与「循环的会话」',
    ).toBe(true);
    // ⚠️⚠️ **比较式必须是「不等就收」，不许给 null 留放行** ——
    // 首页 / 新会话页（`https://zchat.z.ai/`）pathname 是 `/`，读不到会话 id；
    // 放行 null 会让续跑 prompt 被提进一个全新对话。
    expect(
      tests.some((text) => text.includes('current === loop.chatSessionId')),
      '判据必须是 `current === loop.chatSessionId` 的正向相等（取反即「不等就收」）',
    ).toBe(true);
    expect(
      tests.some((text) => text.includes('!current')),
      '不許有 `!current` 这类「读不到就放行」的短路',
    ).toBe(false);
  });

  it('ContinuationLoop.chatSessionId 在类型上是非空的 `string`', () => {
    // ⚠️⚠️ **上面那条「守卫不该回来」的前提就是这条** —— 如果哪天有人把类型改回
    // `string | null`，那条被删掉的非空守卫就必须回来。两条断言互为锁：
    // 判据是「两者恰好成立一个」，不是各自为真。
    const source = readFileSync('entrypoints/zai.content.ts', 'utf8');
    const declaration = source.match(/interface ContinuationLoop \{[\s\S]*?\n\}/);
    expect(declaration, '应当能定位 ContinuationLoop').not.toBeNull();
    const text = declaration![0];
    expect(text, 'chatSessionId 必须声明成非空 string').toMatch(/\n\s*chatSessionId: string;/);
    expect(text, '不该再是 string | null').not.toMatch(/chatSessionId: string \| null;/);
  });

  it('isSessionStillCurrent 也不给 null 留放行', () => {
    // ⚠️ 同一条不变式在发送原语那侧：那里原本是 `!current || current === expected`，
    // 首页（无会话 id）同样会放行。
    const program = readContentProgram();
    const source = readFileSync('entrypoints/zai.content.ts', 'utf8');
    const body = findFunctionBody(program, 'isSessionStillCurrent');
    const text = source.slice(body.start ?? 0, body.end ?? 0);
    expect(text, '必须直接与 expect 相等比较').toContain('getCurrentChatSessionId() === expectedSessionId');
    expect(text, '不许 `!current` 放行').not.toContain('!current');
  });

  it('接线在 handleSessionChange 里，且排在面板换记录之前', () => {
    const program = readContentProgram();
    const object = (() => {
      let found: t.ObjectExpression | undefined;
      walkReachable(findMainBodyOf(program), (node) => {
        if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
        if (node.callee.name !== 'installZaiCapabilities') return;
        const [options] = node.arguments;
        if (t.isObjectExpression(options)) found = options;
      });
      expect(found, 'main() 里应当调 installZaiCapabilities({ … })').toBeDefined();
      return found!;
    })();

    const property = object.properties.find((entry): entry is t.ObjectProperty => (
      t.isObjectProperty(entry) && t.isIdentifier(entry.key, { name: 'handleSessionChange' })
    ));
    expect(property, '依赖对象里应当有 handleSessionChange').toBeDefined();

    const value = property!.value;
    expect(
      t.isArrowFunctionExpression(value) || t.isFunctionExpression(value),
      'handleSessionChange 必须是适配器（要先收循环再换面板记录）',
    ).toBe(true);

    let reclaimAt: number | null = null;
    let panelAt: number | null = null;
    walkReachable((value as t.ArrowFunctionExpression).body, (node) => {
      if (!t.isCallExpression(node)) return;
      if (t.isIdentifier(node.callee, { name: RECLAIM_FN })) reclaimAt = node.start ?? null;
      if (t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.property, { name: 'handleSessionChange' })) {
        panelAt = node.start ?? null;
      }
    });
    expect(reclaimAt, `handleSessionChange 里必须调 ${RECLAIM_FN}`).not.toBeNull();
    expect(panelAt, 'handleSessionChange 里应当仍然调面板那处').not.toBeNull();
    expect(reclaimAt!, '先收循环、再换面板记录').toBeLessThan(panelAt!);
  });

  it('切会话时把预设注入的轮数计数器归零', () => {
    // ⚠️ **为什么必须守这一条**：`currentRequestMessageCount` 是「预设注入频率」判据里的
    // `messageCount`（`default` 档靠 `messageCount % 10` 决定注不注入），而它只在
    // `augmentPrompt` 里递增、**从不重置**。不归零时，切到新会话后第一轮会带着上一个
    // 会话的累计值 ⇒ 注入频率整体错位，而**表现是静默的**（只是某一轮该注入没注入）。
    //
    // ⚠️ 这是**接线**，`zai.content.ts` 加载即执行 `defineContentScript`、不能 import
    // ⇒ 行为测试够不到，只能在这里做源码级断言。
    const program = readContentProgram();
    const mainBody = findMainBodyOf(program);
    expect(mainBody, 'main() 不该消失').toBeDefined();

    let handleBody: t.Node | undefined;
    walkReachable(mainBody, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      if (node.callee.name !== 'installZaiCapabilities') return;
      const [options] = node.arguments;
      if (!t.isObjectExpression(options)) return;
      const property = options.properties.find((entry): entry is t.ObjectProperty => (
        t.isObjectProperty(entry) && t.isIdentifier(entry.key, { name: 'handleSessionChange' })
      ));
      const value = property?.value;
      if (t.isArrowFunctionExpression(value) || t.isFunctionExpression(value)) {
        handleBody = value.body;
      }
    });
    expect(handleBody, '没找到 handleSessionChange 的函数体').toBeDefined();

    // 判据是「函数体里有 `currentRequestMessageCount = 0` 这个赋值」，
    // 不是「源码里出现过这个标识符」—— 后者在声明与读取处都恒真。
    let zeroed = false;
    walkReachable(handleBody!, (node) => {
      if (!t.isAssignmentExpression(node) || node.operator !== '=') return;
      const { left, right } = node;
      if (!t.isIdentifier(left, { name: 'currentRequestMessageCount' })) return;
      if (t.isNumericLiteral(right) && right.value === 0) zeroed = true;
    });
    expect(zeroed, '切会话时必须把 currentRequestMessageCount 归零').toBe(true);
  });
});

/**
 * **保活的 release 必须带所有权**。
 *
 * ⚠️⚠️ 缺陷形态：一条循环被顶替时，旧那条的 `submitContinuationViaPage` 可能还挂在
 * await 上（最长 5 秒证据等待），它的 `finally` 会调 release。没有所有权判据的话，
 * 那次 release 会把**新循环**刚挂上的会话摘掉（新循环还没跑满 3 分钟 ⇒
 * `sustainedKeepAlive` 仍是 false，长窗口那道早退拦不住），而保活失效是**静默**的
 * ⇒ 新循环的发送落在被节流的窗口里 ⇒ 判 `unsent` ⇒ 收尾。
 */
describe('tab keepalive: release carries an ownership token', () => {
  it('发送链的 want / release 都带 `loop.loopId`', () => {
    const program = readContentProgram();
    const body = findFunctionBody(program, 'submitContinuationViaPage');
    const calls: { name: string; args: number; first?: string }[] = [];
    walkSourceAst(body, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      if (node.callee.name !== 'wantTabKeepAlive' && node.callee.name !== 'releaseTabKeepAlive') return;
      const [first] = node.arguments;
      calls.push({
        name: node.callee.name,
        args: node.arguments.length,
        first: t.isMemberExpression(first) && t.isIdentifier(first.property)
          ? first.property.name
          : undefined,
      });
    });
    expect(calls, '发送链里各一次').toHaveLength(2);
    for (const call of calls) {
      expect(call.args, `${call.name} 必须带所有权参数`).toBe(1);
      expect(call.first, `${call.name} 的所有权必须是 loop.loopId`).toBe('loopId');
    }
  });

  it('releaseTabKeepAlive 里有「所有权换人就早退」这道判据', () => {
    const program = readContentProgram();
    const source = readFileSync('entrypoints/zai.content.ts', 'utf8');
    const body = findFunctionBody(program, 'releaseTabKeepAlive');
    const guards = body.body.filter((node): node is t.IfStatement => t.isIfStatement(node));
    const tests = guards.map((node) => source.slice(node.test.start ?? 0, node.test.end ?? 0));
    // ⚠️⚠️ **判据里不许再出现 `keepAliveOwner !== null`** —— 顶替场景把 owner
    // 交还成 null 之后，旧循环还在 await 上的那次 release 会因此通过判据、照发 STOP，
    // 而它与新循环的 START 没有顺序保证 ⇒ 正是这个 token 当初要挡的那件事。
    const earlyExit = tests.find((text) => text.includes('keepAliveOwner') && text.includes('owner'));
    expect(earlyExit, '必须有「所有权已经换人 ⇒ 不卸」的判据').toBeDefined();
    expect(earlyExit, '早退判据不许要求 owner 非空（那样交还后拦不住）')
      .not.toContain('keepAliveOwner !== null');
  });

  it('releaseTabKeepAlive 的所有出口都复位所有权', () => {
    // ⚠️ 强制 release（`owner === null`）也要复位 —— 否则正常收尾后
    // `keepAliveOwner` 停在一个已死循环的 loopId 上，与「null = 没有任何循环在要」冲突。
    const program = readContentProgram();
    const body = findFunctionBody(program, 'releaseTabKeepAlive');
    let unconditional = false;
    walkSourceAst(body, (node) => {
      if (!t.isExpressionStatement(node) || !t.isAssignmentExpression(node.expression)) return;
      const { left, right } = node.expression;
      if (t.isIdentifier(left, { name: 'keepAliveOwner' }) && t.isNullLiteral(right)) {
        unconditional = true;
      }
    });
    expect(unconditional, '必须有裸的 `keepAliveOwner = null;`（不受 owner 是否为空影响）').toBe(true);
  });

  it('wantTabKeepAlive 会登记所有权', () => {
    const program = readContentProgram();
    const source = readFileSync('entrypoints/zai.content.ts', 'utf8');
    const body = findFunctionBody(program, 'wantTabKeepAlive');
    expect(source.slice(body.start ?? 0, body.end ?? 0), 'want 必须写 keepAliveOwner')
      .toContain('keepAliveOwner = owner');
  });

  it('顶替场景交还所有权但不发 STOP', () => {
    // ⚠️ 顶替时新循环马上要 `want`；这里若发 STOP，与它的 START 没有顺序保证，
    // STOP 后到会把新循环的会话摘掉 —— 这正是 `preserveKeepAlive` 当初要治的那件事，
    // 只是当时只处理了「长窗口」那一半。
    const program = readContentProgram();
    const source = readFileSync('entrypoints/zai.content.ts', 'utf8');
    const body = findFunctionBody(program, 'finishContinuationLoop');
    // ⚠️ 同一个函数里有**两处** `!options?.preserveKeepAlive` 判据（长窗口那处在前），
    // 要挑「带 alternate 的那一处」—— 只有它是「顶替时交还所有权」这条。
    const branch = body.body.filter((node): node is t.IfStatement => t.isIfStatement(node))
      .find((node) => source.slice(node.test.start ?? 0, node.test.end ?? 0)
        .includes('preserveKeepAlive') && node.alternate != null);
    expect(branch, '应当有 `preserveKeepAlive` 那条带 else 的分支').toBeDefined();
    const alternate = source.slice(branch!.alternate?.start ?? 0, branch!.alternate?.end ?? 0);
    expect(alternate, '顶替分支里必须交还所有权').toContain('keepAliveOwner');
    expect(alternate, '顶替分支里不许发 STOP').not.toContain('releaseTabKeepAlive');
  });
});

/**
 * **`signature_prompt` 必须直接写用户原文，不许从增广文本反推。**
 *
 * ⚠️⚠️ 缺陷形态：原来那行是
 * `extractVisibleUserPrompt(augmented.text) ?? originalPrompt`，而那个函数从 START 标记
 * 切到**第一个** END 标记 ⇒ 用户原文里若恰好含 `<!-- zai-visible-user-prompt:end -->`
 * 字面量（比如他在问这个标记是什么意思），切点会落在那个假的 END 上、
 * **服务端权威 prompt 被截断**（实测 `请解释 <!-- …:end --> 这个字符串` → `请解释 `）。
 *
 * ⚠️ **为什么用源码断言而不是行为测试**：`zai.content.ts` 加载即执行
 * `defineContentScript`、不能被 import；而这个 bug 的等价性又是结构性的
 * （三个增广分支都把 `originalPrompt` 原样写进标记对 / metadata 行）——
 * 行为测试够不到、只能在这儿钉住「那一行没退回去」。
 *
 * ⚠️ **判据是「没有调用」，不是「出现过这个名字」** —— 文件里有一处注释提到它
 * （解释这段历史），所以 `not.toContain('extractVisibleUserPrompt')` 会假红。
 * 只查带括号的调用形态。
 */
describe('signature_prompt is taken from the user text, not reverse-engineered', () => {
  it('never calls extractVisibleUserPrompt on the augmented text', () => {
    const source = readFileSync(resolve(process.cwd(), 'entrypoints/zai.content.ts'), 'utf8');
    expect(source).not.toContain('extractVisibleUserPrompt(');
    // 正面判据：那一行直接写 `originalPrompt`。
    expect(source).toContain('signature_prompt = originalPrompt');
  });
});
