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
   * ⚠️ **从接口派生，不手抄**（守则 B9）：手抄的第二份清单会在改接口时静默分叉，
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
