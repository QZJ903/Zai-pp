import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { parseTypeScriptSource, walkSourceAst } from './typescript-source';

/**
 * 内容脚本（`entrypoints/zai.content.ts`）的 AST 判据工具箱。
 *
 * ## 为什么单独成文件
 *
 * 这个文件里的判据被**多个测试文件**共用（工具执行契约 / 启动接线残留 / 项目面板等），
 * 而它们此前各写一份，于是**同一件事的口径在两个文件里漂了** —— 最典型的是
 * `findFunctionBody`：一处认「恰好一个同名声明」，另一处只认「最后一个」，
 * 导致同一个变异在一个文件里红、在另一个文件里绿。
 * ⇒ **口径只能有一份**，与生产代码「同一判据不许两个消费者各算一遍」是同一条规则。
 *
 * ## ⚠️⚠️ 先读这一条：能行为化就别用这里的东西
 *
 * 本文件是「**按名字找源码**」这一手段的兜底。它只能问「源码里有没有出现这个名字」，
 * 问不出「它到底跑没跑到」，因此**天生有绕过面**。实测被下面这些写法逐一绕过
 * （每一种都 `tsc` 干净、全量用例全绿）：
 * - 把调用挪进一个永不执行的嵌套函数 / 死类 / 死箭头函数；
 * - 在目标函数里再声明一个同名标识符（`const` / 解构 / `catch` 参数 / 形参）顶掉真身；
 * - 把真身改名、在文件末尾补一个同名函数靠**声明提升**接管调用点（→ `findOrphanFunctions`）；
 * - 把 import 换成同名的本地 stub；
 * - 在同名可达函数体内塞一个**诱饵**同名函数，让「按名字找声明」落到它身上。
 *
 * ⇒ **凡是能被「真调一次、断言副作用」覆盖的接线，都不要用本文件** ——
 * 2026-10-14 启动链的 22 条守卫就是这么被整体替换掉的（见
 * `tests/zai-capability-install.test.ts`）。留在本文件里的只有三类：
 * ① **全局死代码检测**（`findOrphanFunctions` —— 没有正向行为可测）；
 * ② 依赖面太大、行为化不划算的投递点（工具面板那几条）；
 * ③ 上面两类共用的基础件（遍历器 / 定位 / 形态判定）。
 *
 * ## 两条贯穿全部判据的原则
 *
 * ⚠️ **① 判据必须问「是不是生产真的会走到的那一个」**（而不是「名字出现过吗」）。
 * ⚠️ **② 「扫得宽」与「扫得窄」都会出错** —— 宽了把不可达代码算成可达（假绿），
 * 窄了把合法写法判成违规（假红）。改动前先看清那一段的 ⚠️ 说明。
 */

/** 读内容脚本源码并解析（调用方各自缓存，别在这里缓存 —— 变异测试要能读到新内容）。 */
export function readContentProgram(path = 'entrypoints/zai.content.ts'): t.Program {
  return parseTypeScriptSource(path, readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// 遍历器
// ---------------------------------------------------------------------------

/** 全深度遍历（**会**进嵌套函数体）。 */
function walkAll(node: t.Node, visit: (node: t.Node) => void): void {
  walkSourceAst(node, visit);
}

/**
 * 只走「**会执行到**」的节点 —— 不进任何**函数体**。
 *
 * ⚠️⚠️ **不能换成 `walkAll`**：后者会钻进嵌套函数体 ⇒ 「把调用挪进一个永不调用的
 * 箭头函数」这种写法照样被算作「接线在」。
 *
 * ⚠️ **它只排除函数边界，不排除控制流块** —— `if` / `try` / `for` / `switch` / `&&`
 * 右侧的代码照走，因为那些块里的代码是可达的（「包在 `if (cond)` 里」不构成绕过）。
 *
 * ### 边界名单（**两个方向都踩过坑，改前必读**）
 *
 * **排除**（函数体，调用时才执行）：
 * `FunctionDeclaration` / `FunctionExpression` / `ArrowFunctionExpression` /
 * `ObjectMethod` / `ClassMethod` / **`ClassPrivateMethod`** /
 * 非 static 的 `ClassProperty` / `ClassPrivateProperty`。
 * ⚠️ `ClassPrivateMethod` 是**独立节点类型**（不是 `ClassMethod` 的子类），
 * 只列后者时 `class _Dead { #m() { installX(); } }` 会被算成可达 —— 实测过。
 *
 * **保留**（真的会执行，别顺手排除）：
 * `StaticBlock` 与 **static** 的类字段初始化器（类求值时就跑）、
 * `TSAsExpression` / `TSNonNullExpression` / `TSSatisfiesExpression` 等**包装层**
 * （包着的代码照样执行）。
 *
 * **两条已知口径**（都不影响当前判据，写清楚免得被当成 bug）：
 * ① **装饰器表达式不在此列** —— 本项目的解析器只开 `typescript` 插件，
 *    `@dec(f()) class C {}` 直接解析失败 ⇒ 这一格目前不可达。
 * ② **计算方法名不遍历** —— `class C { [f()]() {} }` / `const o = { [f()]() {} }`
 *    里的 `f()` 确实在类/对象求值时执行，但本遍历器不会走到它的 key。
 *    当前守的都是 `installX()` / `toolPanel.x()`，写不进方法名 ⇒ 不可达。
 *    ⚠️ `ClassAccessorProperty`（`accessor a = f()`）同样未列入名单 ——
 *    需要 `decoratorAutoAccessors` 插件，今天解析不了。
 *
 * **已知代价**：把某处调用合法地抽成一个 helper 函数会让对应断言变红。
 * 那是有意的 —— 这些调用点的位置本身就是契约的一部分（哪个函数负责投递哪条数据），
 * 真抽了 helper 就顺手把这里的目标函数名改掉。
 */
export function walkReachable(node: t.Node, visit: (node: t.Node) => void): void {
  visit(node);
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const child = (node as unknown as Record<string, unknown>)[key];
    const children = Array.isArray(child) ? child : [child];
    for (const item of children) {
      if (!item || typeof item !== 'object' || !('type' in item)) continue;
      const candidate = item as t.Node;
      if (isFunctionBodyBoundary(candidate)) continue;
      walkReachable(candidate, visit);
    }
  }
}

/** 这个节点是不是「函数体 / 延迟求值的初始化器」——`walkReachable` 到此为止。 */
function isFunctionBodyBoundary(node: t.Node): boolean {
  if (
    t.isFunctionDeclaration(node)
    || t.isFunctionExpression(node)
    || t.isArrowFunctionExpression(node)
    || t.isObjectMethod(node)
    || t.isClassMethod(node)
    // ⚠️ 独立节点类型：`class X { #m() {} }`。漏了它 = 死类里的调用被算成可达。
    || t.isClassPrivateMethod(node)
  ) {
    return true;
  }
  // 非 static 的字段初始化器只在实例化时求值；static 的会在类求值时执行 ⇒ 保留。
  if (t.isClassProperty(node) || t.isClassPrivateProperty(node)) {
    return node.static !== true;
  }
  return false;
}

/** 建立「子节点 → 父节点」索引（判父链形态用）。 */
function buildParents(root: t.Node): Map<t.Node, t.Node> {
  const parents = new Map<t.Node, t.Node>();
  walkAll(root, (node) => {
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      const children = Array.isArray(child) ? child : [child];
      for (const item of children) {
        if (item && typeof item === 'object' && 'type' in item) parents.set(item as t.Node, node);
      }
    }
  });
  return parents;
}

// ---------------------------------------------------------------------------
// 定位：main / 具名函数
// ---------------------------------------------------------------------------

/**
 * `defineContentScript({ …, async main(ctx) { … } })` 里那个 `main` 的函数体。
 *
 * ⚠️ **判据锚在「选项对象里那个 `main` 属性」上**，不是「名字叫 main 的函数」——
 * 后者在别处出现一个同名的就假绿。
 *
 * ⚠️ **认两种写法**：`async main() {}` 解析出来是 **`ObjectMethod`**（不是
 * `ObjectProperty` + FunctionExpression）；`main: async (ctx) => { … }` 是
 * `ObjectProperty` + ArrowFunctionExpression。
 *
 * ⚠️ **表达式体箭头（`main: (ctx) => bootAll(ctx)`）不认** —— 它没有
 * `BlockStatement`，所有基于「函数体」的判据都无处落点。这是**已知代价**：
 * 真这么写会红，那时要么改成块体，要么把判据改成从 `CallExpression` 出发。
 */
function findMainBody(program: t.Program): t.BlockStatement {
  let body: t.BlockStatement | undefined;
  walkAll(program, (node) => {
    if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
    if (node.callee.name !== 'defineContentScript') return;
    const options = node.arguments[0];
    if (!t.isObjectExpression(options)) return;
    for (const property of options.properties) {
      if (t.isObjectMethod(property)) {
        if (t.isIdentifier(property.key) && property.key.name === 'main') body = property.body;
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
  if (!body) {
    throw new Error('应当能在 defineContentScript 的选项里找到 main 的函数体（块体形态）');
  }
  return body;
}

/** 模块顶层的全部**函数声明**（名字 → 节点）。 */
function collectTopLevelFunctions(program: t.Program): Map<string, t.FunctionDeclaration> {
  const functions = new Map<string, t.FunctionDeclaration>();
  for (const statement of program.body) {
    const declaration = t.isExportNamedDeclaration(statement) ? statement.declaration : statement;
    if (t.isFunctionDeclaration(declaration) && declaration.id) {
      functions.set(declaration.id.name, declaration);
    }
  }
  return functions;
}

/**
 * 找出某个具名函数声明的函数体 —— 并确认**它就是生产里被调的那一个**。
 *
 * ⚠️⚠️ **三条判据都要，缺一条就有绕过路径**：
 * ① **恰好一个同名顶层声明** —— 有两个时只取「最后一个」会让断言落在死函数上；
 * ② **至少有一处调用点**；
 * ③ ⚠️ **这个函数不得是孤儿** —— ①+② 组合挡不住「把真身改名、在文件末尾补一个
 *    同名函数靠**声明提升**接管调用点」：那时旧名只剩末尾那一份（① 满足）、
 *    原调用点还在（② 满足），而**真正被执行的函数体已经没有任何检查覆盖**。
 *    ⇒ 用 `findOrphanFunctions` 求「从 `main` 出发不可达的顶层函数」，
 *    这里断言目标**不在**孤儿集合里。
 *
 * ⚠️⚠️ **③ 的强度取决于调用图的边口径** —— 边若把「裸提及」（`void f;`）也算上，
 * 一次提及就能让真身重回可达集、③ 形同虚设。见 `buildFunctionGraph` 的说明。
 *
 * ⚠️ **`matches.length > 1` 实际上不可达** —— Babel 对顶层重名声明直接抛
 * `Identifier 'x' has already been declared`（实测：`function f(){} function f(){}`、
 * `function f(){} var f=1`、`function f(){} class f{}` 全部解析失败），
 * 而 `collectTopLevelFunctions` 收的是 `Map`。留着这一支只为「解析器放宽了」的将来。
 */
export function findFunctionBody(program: t.Program, name: string): t.BlockStatement {
  const functions = collectTopLevelFunctions(program);
  const matches = [...functions.entries()].filter(([key]) => key === name);
  if (matches.length === 0) {
    throw new Error(`模块顶层没有 ${name} 的函数声明 —— 它被改名或搬走了`);
  }
  if (matches.length > 1) {
    throw new Error(
      `模块顶层有 ${matches.length} 个叫 ${name} 的函数声明（Babel 正常会直接拒绝这种重名，`
      + '走到这里说明解析器行为变了）',
    );
  }

  let callSites = 0;
  walkAll(program, (node) => {
    if (isCallTo(node, name)) callSites += 1;
  });
  if (callSites === 0) {
    throw new Error(`${name} 零调用点 —— 断言检查的不是生产路径`);
  }

  const orphans = findOrphanFunctions(program);
  if (orphans.has(name)) {
    throw new Error(
      `${name} 从 main() 出发不可达（孤儿函数）—— 被检查的这个函数体在生产里根本不会执行，`
      + '通常意味着真身已被改名、同名空壳靠声明提升接管了调用点',
    );
  }
  return matches[0]![1].body;
}

// ---------------------------------------------------------------------------
// 调用图：从 main 出发的可达集
// ---------------------------------------------------------------------------

/**
 * 顶层函数之间的调用图。
 *
 * **边的口径是「子树里对某个顶层函数名的**真实引用**」** —— 调用、作为实参传出、
 * 赋值、作判据都算；**「裸提及」不算**（见 `isBareMention`）。
 * 这样能一并覆盖「作为回调传出去」（`onZaiSessionChange(notifySessionChange)`）
 * 与「被赋给变量」这两种同样算接线的写法。
 *
 * ⚠️⚠️ **「裸提及」必须排除** —— 否则一条 `installX;` / `void installX;` 就能让
 * 一个**已经被改名、再也没人调用**的真身重新进入可达集，于是
 * `findOrphanFunctions` 失效、`findFunctionBody` 的第 ③ 条形同虚设。
 * 这是「真身改名 + 文件末尾补同名壳靠声明提升接管」那一类半成品形态的
 * **常见伴生写法**（`void f;` 正是压 unused 警告的惯用手法）。
 *
 * ⚠️ **边的搜索范围含嵌套函数体**（用 `walkAll`）—— 这里问的是「这个函数有没有
 * 可能用到那个函数」，抽成嵌套闭包同样算用到。
 *
 * ⚠️ **已知残余**：把真身赋给一个变量再 `void` 掉（`const x = impl; void x;`）
 * 仍会被算成可达 —— 那需要数据流分析（「这个绑定有没有被真正使用」），
 * 超出本工具的范围。实测那种写法比裸提及**少见得多**，且需要刻意构造。
 *
 * ⚠️ **刻意不导出**：调用图是本文件内部的实现手段，对外只暴露
 * `findOrphanFunctions` 这一个结论型 API —— 导出中间结构会诱使调用方
 * 各自再算一遍可达性（那就又变成「同一判据两个消费者」了）。
 */
function buildFunctionGraph(
  program: t.Program,
  functions: Map<string, t.FunctionDeclaration>,
): Map<string, Set<string>> {
  const names = new Set(functions.keys());
  const graph = new Map<string, Set<string>>();
  for (const [name, declaration] of functions) {
    graph.set(name, collectRealReferences(declaration.body, names));
  }
  return graph;
}

/** `main()` 里引用到的顶层函数名。 */
function mainReferences(program: t.Program, names: ReadonlySet<string>): Set<string> {
  return collectRealReferences(findMainBody(program), names);
}

/** 子树里对 `names` 的**真实引用**（排除裸提及）。 */
function collectRealReferences(scope: t.Node, names: ReadonlySet<string>): Set<string> {
  const parents = buildParents(scope);
  const referenced = new Set<string>();
  walkAll(scope, (node) => {
    if (!t.isIdentifier(node) || !names.has(node.name)) return;
    if (isBareMention(node, parents)) return;
    referenced.add(node.name);
  });
  return referenced;
}

/**
 * 这个标识符是不是**纯提及**（它的值最终被丢掉，不产生任何行为）？
 *
 * ⚠️⚠️ **判据是「值有没有去处」，不是「穿过了哪几种节点」** ——
 * 黑名单式写法（「穿过 void / typeof / as 就算提及」）挡不住穷举，实测这一族
 * 全部 tsc-clean 且都能把守卫关掉：`void [f];`、`void \`${f}\`;`、`void ({x: f});`、
 * `(<any>f);`、`typeof f !== 'undefined'`、`f, 0;`。
 *
 * ⇒ 改成**沿父链上行**：只要当前节点所处的槽位「只是把值继续往上传」
 * （括号 / `as` / `!` / `<any>` 断言 / `void` / `typeof` / 数组元素 / 对象属性 /
 * 模板串插值 / 序列表达式 / 逻辑与三元的分支），就把当前节点换成父节点继续走；
 * 一旦落到**真正用掉这个值的槽位**（被调用 / 实参 / `new` / 赋值右侧 / 变量初始化 /
 * `return` 的值 / 表达式体箭头 / 成员访问的对象 / 标签模板的 tag / `export { f }`）
 * 就判**真实引用**；走到 `ExpressionStatement` 或认不出的槽位 ⇒ **提及**。
 *
 * ⚠️ **方向是 fail-closed**：认不出的位置一律按提及处理 ——
 * 宁可多报一个孤儿（假红，人一眼能看出是误报），也不要把死代码说成接线（假绿，静默）。
 *
 * ⚠️ **已知残余**：`const x = f; void x;` 会被算成真实引用（值先进了变量，
 * 再判「那个变量有没有被用」需要数据流分析）。要刻意构造才写得出。
 */
function isBareMention(identifier: t.Node, parents: Map<t.Node, t.Node>): boolean {
  let current: t.Node = identifier;
  for (let depth = 0; depth < 20; depth += 1) {
    const parent: t.Node | undefined = parents.get(current);
    if (!parent) return true;
    if (isPropagatingSlot(current, parent)) {
      current = parent;
      continue;
    }
    return !isTerminatingUse(current, parent);
  }
  // ⚠️ **超出深度上限按提及处理**（fail-closed）—— 上限是防病态输入把遍历挂死，
  // 不是「超过就当真实引用」（那样一条够长的 `as any` 链就能关掉守卫）。
  return true;
}

/** 这个槽位是不是「只是把值继续往上传」（不消费、也不丢弃）。 */
function isPropagatingSlot(current: t.Node, parent: t.Node): boolean {
  if (t.isParenthesizedExpression(parent)
    || t.isTSAsExpression(parent)
    || t.isTSNonNullExpression(parent)
    || t.isTSSatisfiesExpression(parent)
    // ⚠️ `(<any>f)` 是 **`TSTypeAssertion`**（与 `as` 的 `TSAsExpression` 是两个节点）。
    || t.isTSTypeAssertion(parent)
    // `void` / `typeof` / `!` / `-` —— 值被丢掉，但**丢弃发生在这一层**，
    // 所以继续往上走：外层若把它当值用（`g(void f)`），那也算真实引用。
    || t.isUnaryExpression(parent)
    || t.isAwaitExpression(parent)) {
    return true;
  }
  if (t.isArrayExpression(parent)) return parent.elements.includes(current as t.Expression);
  if (t.isObjectExpression(parent)) {
    return parent.properties.includes(current as t.ObjectProperty | t.SpreadElement);
  }
  if (t.isObjectProperty(parent)) return parent.value === current;
  if (t.isSpreadElement(parent)) return parent.argument === current;
  if (t.isTemplateLiteral(parent)) return parent.expressions.includes(current as t.Expression);
  if (t.isSequenceExpression(parent)) return parent.expressions.includes(current as t.Expression);
  if (t.isLogicalExpression(parent)) return parent.left === current || parent.right === current;
  if (t.isConditionalExpression(parent)) {
    return parent.consequent === current || parent.alternate === current;
  }
  return false;
}

/** 这个槽位是不是「真的用掉了这个值」。 */
function isTerminatingUse(current: t.Node, parent: t.Node): boolean {
  if (t.isCallExpression(parent) || t.isOptionalCallExpression(parent)) {
    return parent.callee === current || parent.arguments.includes(current as t.Expression);
  }
  if (t.isNewExpression(parent)) {
    return parent.callee === current || parent.arguments?.includes(current as t.Expression) === true;
  }
  if (t.isTaggedTemplateExpression(parent)) return parent.tag === current;
  if (t.isAssignmentExpression(parent)) return parent.right === current;
  if (t.isVariableDeclarator(parent)) return parent.init === current;
  if (t.isReturnStatement(parent)) return parent.argument === current;
  if (t.isArrowFunctionExpression(parent)) return parent.body === current;
  // `f.x` —— 访问它的属性算用到它（`installX.y` 这种命名空间用法）。
  if (t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) {
    return parent.object === current;
  }
  if (t.isExportSpecifier(parent)) return parent.local === current;
  return false;
}

/**
 * 从 `main()` 出发可达的顶层函数集合（**内部实现**，对外走 `findOrphanFunctions`）。
 *
 * ⚠️ **它是「这个函数会不会真的被跑到」的近似判据**，不是精确的静态分析 ——
 * 但对付「改名 + 末尾补同名空壳」这类形态足够了：那份空壳只被文件末尾的
 * 死代码引用，进不了可达集。
 */
function reachableFromMain(program: t.Program): Set<string> {
  const functions = collectTopLevelFunctions(program);
  const graph = buildFunctionGraph(program, functions);
  const reachable = new Set<string>();
  const stack = [...mainReferences(program, new Set(functions.keys()))];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    for (const next of graph.get(name) ?? []) stack.push(next);
  }
  return reachable;
}

/**
 * 顶层函数里的**孤儿**（从 `main()` 出发不可达的那些）。
 *
 * ⚠️⚠️ **这是本工具箱里唯一能抓住「真身改名 + 末尾补同名函数」的判据** ——
 * 那种写法下，被改名的那份真身再也没人引用 ⇒ 必然落进孤儿集合。
 * 而**合法重构不会**：helper 被调用 ⇒ 可达 ⇒ 不是孤儿。
 * 所以它的误报面比「按名字找调用点」小得多。
 *
 * ⚠️ **两条已知口径**（实测，写清楚免得被当成 bug）：
 * ① 抽 helper 必须抽成**顶层函数声明**（`function boot() {…}`）。抽成
 *    顶层 `const boot = () => {…}` 或对象方法时，它内部的调用**不算可达** ⇒
 *    被它调的那些 install 会被报成孤儿。改法就是写成函数声明。
 * ② 只在**字符串 / 类型位置 / export 列表**里出现的引用（`window['f']`、
 *    `export { f }`、`type X = typeof f`）不算边 ⇒ 那种函数会被报成孤儿。
 *    当前生产没有这种写法。
 */
export function findOrphanFunctions(program: t.Program): Set<string> {
  const functions = collectTopLevelFunctions(program);
  const reachable = reachableFromMain(program);
  const orphans = new Set<string>();
  for (const name of functions.keys()) {
    if (!reachable.has(name)) orphans.add(name);
  }
  return orphans;
}

// ---------------------------------------------------------------------------
// 名字与绑定
// ---------------------------------------------------------------------------

/**
 * 模块顶层可见的名字 —— **含 import 进来的**、**含 `export function` / `export const`**。
 *
 * ⚠️ 漏掉 import 会让启动链上那几个 `import { installX } from '…'` 全被判成
 * 「不是顶层声明」（第一版就是这么假红的）；漏掉 `export` 会让将来某个
 * `export function installX()` 假红。
 */
export function topLevelNames(program: t.Program): Set<string> {
  const names = new Set<string>();
  for (const statement of program.body) {
    const inner = t.isExportNamedDeclaration(statement) ? statement.declaration : statement;
    if (t.isFunctionDeclaration(inner) && inner.id) names.add(inner.id.name);
    if (t.isClassDeclaration(inner) && inner.id) names.add(inner.id.name);
    if (t.isVariableDeclaration(inner)) {
      for (const declarator of inner.declarations) collectPatternNames(declarator.id, names);
    }
    if (t.isImportDeclaration(statement)) {
      for (const specifier of statement.specifiers) names.add(specifier.local.name);
    }
  }
  return names;
}


/** 把绑定模式（标识符 / 解构 / rest）里的名字收进集合。 */
function collectPatternNames(pattern: t.Node, out: Set<string>): void {
  if (t.isIdentifier(pattern)) {
    out.add(pattern.name);
    return;
  }
  if (t.isObjectPattern(pattern)) {
    for (const property of pattern.properties) {
      if (t.isObjectProperty(property)) collectPatternNames(property.value as t.Node, out);
      else if (t.isRestElement(property)) collectPatternNames(property.argument, out);
    }
    return;
  }
  if (t.isArrayPattern(pattern)) {
    for (const element of pattern.elements) {
      if (element) collectPatternNames(element, out);
    }
    return;
  }
  if (t.isAssignmentPattern(pattern)) collectPatternNames(pattern.left, out);
  if (t.isRestElement(pattern)) collectPatternNames(pattern.argument, out);
}

/** 对象字面量里某个键是不是 `name`（**标识符键与字符串字面量键都认**）。 */
export function isNamedKey(key: t.Node, name: string): boolean {
  if (t.isIdentifier(key)) return key.name === name;
  if (t.isStringLiteral(key)) return key.value === name;
  return false;
}

/**
 * 这处调用是不是在调 `name` —— **普通调用与可选调用都认**。
 *
 * ⚠️ `a?.()` 是 **`OptionalCallExpression`**（不是 `CallExpression`），
 * 只认后者时 `stopSkillPopup?.()` 会被判成「没接线」⇒ 假红。
 * ⚠️ **签名写成类型谓词**，这样调用方 `if (isCallTo(node, x))` 之后
 * `node.arguments` 才是可访问的（否则 `tsc` 报「Node 上没有 arguments」）。
 */
function isCallTo(node: t.Node, name: string): node is t.CallExpression | t.OptionalCallExpression {
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return false;
  return t.isIdentifier(node.callee) && node.callee.name === name;
}

/** 这处调用是不是 `对象.方法(...)` —— **可选链的两种形态都认**（同样是类型谓词）。 */
export function isMethodCallTo(
  node: t.Node,
  objectName: string,
  methodName: string,
): node is t.CallExpression | t.OptionalCallExpression {
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return false;
  const callee = node.callee;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return false;
  return t.isIdentifier(callee.object, { name: objectName })
    && t.isIdentifier(callee.property, { name: methodName });
}


// ---------------------------------------------------------------------------
// 计数与形态判定
// ---------------------------------------------------------------------------

/** 在**可达**范围内数 `对象.方法(...)` 调用。 */
export function countReachableMethodCalls(scope: t.Node, objectName: string, methodName: string): number {
  let count = 0;
  walkReachable(scope, (node) => {
    if (isMethodCallTo(node, objectName, methodName)) count += 1;
  });
  return count;
}


/**
 * 这个表达式能不能取到**工具调用的原始 XML**（`raw` 的合法取值形态）？
 *
 * 合法形态两种：
 * ① 成员访问且属性名是 `raw`（`call.raw` / `call?.raw`）；
 * ② `??` / `||` 兜底（`call.raw ?? ''`、`call.raw || ''`）—— 左侧同样是 ①。
 *
 * ⚠️⚠️ **`&&` 必须拒绝** —— `call.raw && ''` 的**值恒为空串**，而它左侧正是
 * `call.raw`；只剥一层取 `left` 的写法会被它骗过（实测：那种写法下全绿）。
 *
 * ⚠️⚠️ **属性名也必须判** —— 只判「是个成员表达式」时 `detected.name` /
 * `call.name ?? ''` 同样通过，而那样实时腿的签名变成「工具名 + 工具名」、
 * 与历史腿永远配不上（实测：两种写法下断言全绿）。
 *
 * ⚠️ **同一个语义在 `beginToolCall` 与 `noteToolCallRaw` 两处都有** ⇒ 判据只能有一份
 * （两处各写一遍时，一处认 `??` 兜底、一处只认裸成员表达式，实测确实漂过）。
 */
export function isRawValueExpression(value: t.Node | null | undefined): boolean {
  if (!value) return false;
  const memberLike = (node: t.Node): boolean => (
    (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
    && (t.isIdentifier((node as t.MemberExpression).property, { name: 'raw' })
      || t.isStringLiteral((node as t.MemberExpression).property, { value: 'raw' }))
  );

  if (memberLike(value)) return true;
  if (t.isLogicalExpression(value)) {
    if (!['??', '||'].includes(value.operator)) return false;
    return memberLike(value.left);
  }
  return false;
}


/**
 * 收集某个 `switch (…)` 里各 `case` 分支的语句列表。
 *
 * ⚠️⚠️ **必须收「那一个 switch」的分支，不能全程序扫 `SwitchCase`** ——
 * 全程序扫时后出现的同名 `case` 会**顶替**先出现的那个（`Map.set` last-wins），
 * 而 TypeScript **允许重复 case** ⇒ 在真分支后面补一个同名、内容合规但**不可达**的
 * case，就能让「`releaseRequestState` 必须出现在 REQUEST_TERMINAL 分支里」这类断言
 * 照绿（实测：那种写法下全量 1659 条全绿，而真分支里那行已被删掉）。
 *
 * ⚠️ **只认 `switch (data.type)` 那一个**（本文件是主世界消息的分发点，全仓唯一）。
 * 找不到时抛错 —— 静默返回空 Map 会让调用方的 `expect(...).toBeDefined()` 报出
 * 一个指错方向的错（「没有 REQUEST_TERMINAL 分支」而不是「没找到那个 switch」）。
 */
export function collectMessageCaseBodies(program: t.Program): Map<string, t.Node[]> {
  const switches: t.SwitchStatement[] = [];
  walkAll(program, (node) => {
    if (!t.isSwitchStatement(node)) return;
    const discriminant = node.discriminant;
    if (t.isMemberExpression(discriminant)
      && t.isIdentifier(discriminant.object, { name: 'data' })
      && t.isIdentifier(discriminant.property, { name: 'type' })) {
      switches.push(node);
    }
  });
  if (switches.length !== 1) {
    throw new Error(
      `应当恰好有一个 \`switch (data.type)\` 的消息分发点，实际 ${switches.length} 个`,
    );
  }

  const bodies = new Map<string, t.Node[]>();
  for (const switchCase of switches[0]!.cases) {
    if (!t.isStringLiteral(switchCase.test)) continue;
    if (bodies.has(switchCase.test.value)) {
      throw new Error(`\`${switchCase.test.value}\` 这个 case 出现了两次（后者会顶替前者）`);
    }
    bodies.set(switchCase.test.value, switchCase.consequent);
  }
  return bodies;
}


/**
 * `executeDetected` 里 `const callWithSource … = { …, source: { … } }` 的
 * **那个 `source` 对象字面量**。
 *
 * ⚠️⚠️ **为什么必须锚到这里**：这条链路的契约是「锚点写进 `ToolCall.source`」，
 * 而下游读的是 `item.call?.source?.assistantMessageId`。全函数扫
 * `assistantMessageId` 属性时，把它挪到 `ToolCall` 顶层（`callWithSource` 的兄弟属性）
 * **照样绿、`tsc` 也绿**（对象展开不触发多余属性检查）⇒ 锚点永久为 null。
 *
 * ⚠️ **已知代价**：把 `source` 抽成外部常量（`const source = {…}; const callWithSource = { source }`）
 * 或写成 `const callWithSource = { … } satisfies ToolCall`（`init` 变成
 * `TSSatisfiesExpression`）时会找不到 ⇒ 假红。真这么重构时，
 * 把这里改成「沿标识符定义回溯一层」。
 */
export function findCallWithSourceObject(executeBody: t.BlockStatement): t.ObjectExpression | undefined {
  let found: t.ObjectExpression | undefined;
  walkAll(executeBody, (node) => {
    if (!t.isVariableDeclarator(node) || !t.isIdentifier(node.id)) return;
    if (node.id.name !== 'callWithSource') return;
    if (!node.init || !t.isObjectExpression(node.init)) return;
    for (const property of node.init.properties) {
      if (!t.isObjectProperty(property)) continue;
      if (!isNamedKey(property.key, 'source')) continue;
      if (t.isObjectExpression(property.value)) found = property.value;
    }
  });
  return found;
}

/**
 * 一个对象字面量的「**直接成员**」—— 直接属性 + **展开表达式里那一层**的属性。
 *
 * ⚠️⚠️ **不能直接用 `walkAll` 扫子树**：`source: { meta: { assistantMessageId } }`
 * 那种**属性嵌套**写法会被算成「写进了 source」，而下游多一层就读不到（假绿）。
 *
 * ⚠️ **「只跟一层」指的是*属性*嵌套** —— 展开表达式（`...x`）是**递归跟到底**的：
 * `...(a ? {x} : (b ? {x} : {}))` 的两支、`&&` / `||` 的右侧都会被收进来。
 * 这不是漏洞而是必需 —— 当前生产形态就是条件展开
 * `...(assistantMessageId ? { assistantMessageId } : {})`，不跟展开时
 * **一个属性都收不到**（第一版就是这么假红的）。
 */
export function directObjectMembers(object: t.ObjectExpression): t.ObjectProperty[] {
  const properties: t.ObjectProperty[] = [];
  const collect = (candidate: t.Node | null | undefined): void => {
    if (!candidate) return;
    if (t.isObjectProperty(candidate)) {
      properties.push(candidate);
      return;
    }
    if (t.isSpreadElement(candidate)) {
      collectSpread(candidate.argument, collect);
      return;
    }
  };
  for (const property of object.properties) collect(property as t.Node);
  return properties;
}

/** 展开表达式里的对象（含 `cond ? {…} : {…}` 两支与 `&&` / `||` 的右侧）。 */
function collectSpread(argument: t.Node, visit: (node: t.Node) => void): void {
  if (t.isObjectExpression(argument)) {
    for (const property of argument.properties) visit(property as t.Node);
    return;
  }
  if (t.isConditionalExpression(argument)) {
    collectSpread(argument.consequent, visit);
    collectSpread(argument.alternate, visit);
    return;
  }
  if (t.isLogicalExpression(argument)) {
    collectSpread(argument.right, visit);
    collectSpread(argument.left, visit);
    return;
  }
  if (t.isParenthesizedExpression(argument)) collectSpread(argument.expression, visit);
}
