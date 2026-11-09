import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import {
  ZAI_BRIDGE_PAYLOAD_DECODERS,
  ZAI_BRIDGE_PAYLOAD_DECODER_EXEMPTIONS,
  ZAI_CONTENT_TO_MAIN_TYPES,
  ZAI_MAIN_TO_CONTENT_TYPES,
} from '../core/zai/messages';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';

/**
 * 桥协议清单必须与两侧的实际收发点一致。
 *
 * `core/zai/messages.ts` 的两个类型清单是**声明**，运行时不做任何校验 ——
 * 加类型时忘了在发送点或接收点接上，清单就会与实际漂移，而**漂移没有任何报错**：
 * 消息照样发、照样收，只是「清单里写的」和「真在跑的」不是同一套。
 *
 * 曾经漂移过两处（都已修）：
 * - `EXECUTE_TOOL_CALL` 被列进「隔离世界 → 主世界」，实际它走 `chrome.runtime`
 *   发给后台，**根本不过桥**；
 * - `TITLE_LOOKUP` 走桥，但两个清单里都没有它（该类型已随诊断链整体删除）。
 *
 * ⚠️ **断言用 AST 取调用点，不扫源码字符串** —— 类型名在导入语句、注释、
 * 清单定义里都会出现，`includes` 型断言删掉调用点照样为真。
 */

const MAIN_WORLD_SOURCE = 'entrypoints/zai-main-world.content.ts';
const CONTENT_SOURCE = 'entrypoints/zai.content.ts';
const MESSAGES_SOURCE = 'core/zai/messages.ts';

function readProgram(path: string): t.Program {
  return parseTypeScriptSource(path, readFileSync(path, 'utf8'));
}

/** 收集「以某个函数调用发出的消息类型」（取第一个参数对象里的 `type` 字面量）。 */
function collectPostedTypes(program: t.Program, calleeName: string): Set<string> {
  const types = new Set<string>();
  walkSourceAst(program, (node) => {
    if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
    if (node.callee.name !== calleeName) return;
    const options = node.arguments[0];
    if (!t.isObjectExpression(options)) return;
    for (const property of options.properties) {
      if (!t.isObjectProperty(property) || !t.isIdentifier(property.key)) continue;
      if (property.key.name !== 'type') continue;
      if (t.isStringLiteral(property.value)) types.add(property.value.value);
    }
  });
  return types;
}

/**
 * 收集「以某个函数调用发出的消息类型」→ 该类型在信封上**平铺的载荷字段名**。
 *
 * ⚠️ **这是从发送点派生的，不是手抄的第二份清单**。它的用途是：
 * 判断接收侧该把**整条信封**还是**信封里的某个字段**交给 decoder。
 */
function collectPostedPayloadKeys(program: t.Program, calleeName: string): Map<string, Set<string>> {
  const byType = new Map<string, Set<string>>();
  walkSourceAst(program, (node) => {
    if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
    if (node.callee.name !== calleeName) return;
    const options = node.arguments[0];
    if (!t.isObjectExpression(options)) return;

    let type: string | null = null;
    const keys = new Set<string>();
    for (const property of options.properties) {
      if (!t.isObjectProperty(property) || !t.isIdentifier(property.key)) continue;
      if (property.key.name === 'type') {
        if (t.isStringLiteral(property.value)) type = property.value.value;
        continue;
      }
      keys.add(property.key.name);
    }
    if (type) byType.set(type, keys);
  });
  return byType;
}

/** 某个接收块里，把某个 decoder 的**实参**取出来（`decode(<arg>)` 的那个 `<arg>`）。 */
function collectDecoderArguments(  program: t.Program,
  type: string,
  decoderName: string,
): string[] {
  const args: string[] = [];
  for (const block of findReceiverBlocks(program, type)) {
    walkSourceAst(block, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      if (node.callee.name !== decoderName) return;
      const arg = node.arguments[0];
      if (t.isIdentifier(arg)) {
        args.push(arg.name);
        return;
      }
      if (t.isMemberExpression(arg) && t.isIdentifier(arg.object) && t.isIdentifier(arg.property)) {
        args.push(`${arg.object.name}.${arg.property.name}`);
        return;
      }
      args.push('<其它表达式>');
    });
  }
  return args;
}

/**
 * 某个 decoder 函数体里读了哪些**信封字段**（`value.<键>`）。
 *
 * ⚠️ **只收函数体，不收签名** —— 参数名本身不是字段。
 * ⚠️ **`value.records[0].calls` 这种链式访问只取第一段**（`records`）——
 * 后面的是载荷内部的键，与信封无关。
 * ⚠️ **用正则而不是 AST**：这里要的是「读到了哪些键」这个字面事实，
 * 而 decoder 的写法统一（都是 `value.<键>`）；用 AST 还得处理解构与可选链，
 * 换来的精度对这条判据没有意义。
 */
function collectReadEnvelopeKeys(program: t.Program, decoderName: string): Set<string> {
  const keys = new Set<string>();
  let body: string | null = null;
  walkSourceAst(program, (node) => {
    if (!t.isFunctionDeclaration(node) || node.id?.name !== decoderName || !node.body) return;
    const start = node.body.start;
    const end = node.body.end;
    if (typeof start !== 'number' || typeof end !== 'number') return;
    body = sourceSlice(start, end);
  });
  if (!body) return keys;
  for (const match of (body as string).matchAll(/\bvalue\.([A-Za-z_$][\w$]*)/g)) {
    keys.add(match[1]);
  }
  return keys;
}

/** 按字符偏移从 `core/zai/messages.ts` 的源码里取一段（`collectReadEnvelopeKeys` 用）。 */
function sourceSlice(start: number, end: number): string {
  return readFileSync(MESSAGES_SOURCE, 'utf8').slice(start, end);
}

/** 收集 switch 分支里接收的消息类型。
 *
 * 只看 `switch (data.type)` 这种形状 —— 拿全文件所有 `case '<大写串>'` 会把
 * `chrome.runtime` 消息、`route` 分支等无关的 case 一起收进来。
 */
function collectReceivedTypes(program: t.Program, discriminant: string): Set<string> {
  const types = new Set<string>();
  walkSourceAst(program, (node) => {
    if (!t.isSwitchStatement(node)) return;
    const test = node.discriminant;
    const matches = t.isMemberExpression(test)
      && t.isIdentifier(test.object, { name: discriminant })
      && t.isIdentifier(test.property, { name: 'type' });
    if (!matches) return;
    for (const switchCase of node.cases) {
      if (t.isStringLiteral(switchCase.test)) types.add(switchCase.test.value);
    }
  });
  return types;
}

/** 收集 `data.type === 'X'` 形式的接收点（主世界用的是 if 链而不是 switch）。 */
function collectComparedTypes(program: t.Program, objectName: string): Set<string> {
  const types = new Set<string>();
  walkSourceAst(program, (node) => {
    if (!t.isBinaryExpression(node) || node.operator !== '===') return;
    const sides = [node.left, node.right];
    const member = sides.find((side): side is t.MemberExpression => (
      t.isMemberExpression(side)
      && t.isIdentifier(side.object, { name: objectName })
      && t.isIdentifier(side.property, { name: 'type' })
    ));
    if (!member) return;
    const literal = sides.find((side) => t.isStringLiteral(side));
    if (literal && t.isStringLiteral(literal)) types.add(literal.value);
  });
  return types;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/** 收集文件里**被调用**的具名函数（CallExpression 的 callee 是 Identifier）。 */
function collectCalledIdentifiers(program: t.Program): Set<string> {
  const names = new Set<string>();
  walkSourceAst(program, (node) => {
    if (!t.isCallExpression(node)) return;
    if (t.isIdentifier(node.callee)) names.add(node.callee.name);
  });
  return names;
}

/** 建立「节点 → 父节点」映射，供「调用结果被绑到哪儿」的判断用。 */
function buildParentMap(program: t.Program): Map<t.Node, t.Node> {
  const parents = new Map<t.Node, t.Node>();
  walkSourceAst(program, (node) => {
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && 'type' in item) {
            parents.set(item as t.Node, node);
          }
        }
        continue;
      }
      if (child && typeof child === 'object' && 'type' in child) {
        parents.set(child as t.Node, node);
      }
    }
  });
  return parents;
}

/** 该类型在本文件里的**接收块**（内容脚本是 switch case，主世界是 if 链）。 */
function findReceiverBlocks(program: t.Program, type: string): t.Node[] {
  const blocks: t.Node[] = [];
  walkSourceAst(program, (node) => {
    if (t.isSwitchCase(node) && t.isStringLiteral(node.test) && node.test.value === type) {
      blocks.push(...node.consequent);
      return;
    }
    if (!t.isIfStatement(node)) return;
    const test = node.test;
    if (!t.isBinaryExpression(test) || test.operator !== '===') return;
    const matches = [test.left, test.right].some((side) => (
      t.isMemberExpression(side)
      && t.isIdentifier(side.object, { name: 'data' })
      && t.isIdentifier(side.property, { name: 'type' })
    ));
    const literal = [test.left, test.right].find((side) => t.isStringLiteral(side));
    if (!matches || !literal || !t.isStringLiteral(literal)) return;
    if (literal.value !== type) return;
    blocks.push(node.consequent);
  });
  return blocks;
}

/** 某个函数名的调用点里，**结果被直接绑定**的那些（变量初始化 / if 判据）。 */
function collectBoundCallIdentifiers(program: t.Program): Set<string> {
  const parents = buildParentMap(program);
  const bound = new Set<string>();
  walkSourceAst(program, (node) => {
    if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
    const parent = parents.get(node);
    if (t.isVariableDeclarator(parent) && parent.init === node) {
      bound.add(node.callee.name);
      return;
    }
    if (t.isIfStatement(parent) && parent.test === node) {
      bound.add(node.callee.name);
    }
  });
  return bound;
}

/** 文件里从指定模块 import 进来的名字。 */
function collectImportedNames(program: t.Program, from: string): Set<string> {
  const names = new Set<string>();
  for (const statement of program.body) {
    if (!t.isImportDeclaration(statement)) continue;
    if (statement.source.value !== from) continue;
    for (const specifier of statement.specifiers) {
      if (t.isImportSpecifier(specifier)) names.add(specifier.local.name);
    }
  }
  return names;
}

/** 文件里**顶层函数声明**的名字（用来发现 shadow 掉 import 的同名函数）。 */
function collectFunctionDeclarationNames(program: t.Program): Set<string> {
  const names = new Set<string>();
  walkSourceAst(program, (node) => {
    if (t.isFunctionDeclaration(node) && node.id) names.add(node.id.name);
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)
      && (t.isFunctionExpression(node.init) || t.isArrowFunctionExpression(node.init))) {
      names.add(node.id.name);
    }
  });
  return names;
}

describe('bridge protocol contract', () => {
  it('matches every main→content type against the sender and the receiver', () => {
    const declared = sorted(ZAI_MAIN_TO_CONTENT_TYPES);
    const sent = collectPostedTypes(readProgram(MAIN_WORLD_SOURCE), 'postToContent');
    const received = collectReceivedTypes(readProgram(CONTENT_SOURCE), 'data');

    expect(sorted(sent), '主世界发出的类型必须与清单一致').toEqual(declared);
    expect(sorted(received), '隔离世界接收的类型必须与清单一致').toEqual(declared);
  });

  it('matches every content→main type against the sender and the receiver', () => {
    const declared = sorted(ZAI_CONTENT_TO_MAIN_TYPES);
    const sent = collectPostedTypes(readProgram(CONTENT_SOURCE), 'postToMainWorld');
    const received = collectComparedTypes(readProgram(MAIN_WORLD_SOURCE), 'data');

    expect(sorted(sent), '隔离世界发出的类型必须与清单一致').toEqual(declared);
    expect(sorted(received), '主世界接收的类型必须与清单一致').toEqual(declared);
  });

  it('keeps runtime-command names out of the bridge lists', () => {
    // `EXECUTE_TOOL_CALL` 这类名字听起来像桥消息，实际走 chrome.runtime。
    // 它一旦被列进清单，下一个人就会以为桥上有这条链路。
    const bridgeTypes = new Set<string>([
      ...ZAI_MAIN_TO_CONTENT_TYPES,
      ...ZAI_CONTENT_TO_MAIN_TYPES,
    ]);
    for (const runtimeCommand of ['EXECUTE_TOOL_CALL', 'CREATE_TOOL_AUTHORIZATION', 'GET_MEMORIES']) {
      expect(bridgeTypes.has(runtimeCommand), `${runtimeCommand} 不是桥消息类型`).toBe(false);
    }
  });

  it('covers every declared type with exactly one of decoder or exemption', () => {
    // ⚠️ 这条守的是「加桥消息时必须显式决定载荷怎么办」。
    // 不守的后果是静默的：新消息只有信封校验，载荷靠 `as` 断言过 ——
    // 类型看着对、运行时没有任何保证，非法载荷一路走到深处才炸。
    const decoded = new Set(Object.keys(ZAI_BRIDGE_PAYLOAD_DECODERS));
    const exempted = new Set(Object.keys(ZAI_BRIDGE_PAYLOAD_DECODER_EXEMPTIONS));
    // 显式标成 string[]：清单是 `as const` 的字面量联合，直接 includes(string) 会报窄化错。
    const declared: string[] = [...ZAI_MAIN_TO_CONTENT_TYPES, ...ZAI_CONTENT_TO_MAIN_TYPES];

    const uncovered = declared.filter((type) => !decoded.has(type) && !exempted.has(type));
    expect(uncovered, '每个桥消息类型都要有 decoder 或写明豁免理由').toEqual([]);

    // ⚠️ **两张表必须互斥** —— 同时出现在两边时，`uncovered` 与 `stale` 都是空的，
    // 覆盖率看着满、实际是「以为有豁免、其实有 decoder」的认知混乱。
    const both = declared.filter((type) => decoded.has(type) && exempted.has(type));
    expect(both, '同一个类型不能既有 decoder 又列进豁免表').toEqual([]);

    // 表里不能有「已从清单删掉、却留在表里」的死条目 —— 那会让覆盖率看着满、实际有洞。
    const stale = [...decoded, ...exempted].filter((type) => !declared.includes(type));
    expect(stale, 'decoder / 豁免表里不能有清单外的类型').toEqual([]);
  });

  it('gives every exemption a non-empty reason and wires its named decoder', () => {
    // 空理由等于没写理由 —— 豁免必须能自证「为什么这条不需要 decoder」。
    for (const [type, exemption] of Object.entries(ZAI_BRIDGE_PAYLOAD_DECODER_EXEMPTIONS)) {
      expect(typeof exemption.reason, `${type} 的豁免理由必须是字符串`).toBe('string');
      expect(exemption.reason.trim().length, `${type} 的豁免理由不能为空`).toBeGreaterThan(0);
    }

    // ⚠️ 豁免里写「有专门的 decoder」时，那个 decoder **必须真的在接收文件里被调用** ——
    // 否则它只是一句注释，哪天调用点被删掉不会有任何东西变红。
    // （`decodeAugmentResult` 正是注释里点名的那种「写明了却没人真调」的形态。）
    // ⚠️ 这两个 decoder 各自住在**它自己的模块里**（一个是主世界的局部函数、一个在
    // `core/zai/stream-metrics.ts`），所以这里只断言「被调用」，不要求 import 来源。
    for (const [type, exemption] of Object.entries(ZAI_BRIDGE_PAYLOAD_DECODER_EXEMPTIONS)) {
      const named = 'decoder' in exemption ? exemption.decoder : undefined;
      if (!named) continue;
      const called = collectCalledIdentifiers(readProgram(named.file));
      expect(called.has(named.name), `${type} 声称有 ${named.name}，但它没在 ${named.file} 里被调用`)
        .toBe(true);
    }
  });

  it('calls each payload decoder inside its receiver block, with the result bound', () => {
    // ⚠️⚠️ 三条独立的坑，缺一条这条断言就形同虚设：
    // ① 「名字作为 CallExpression.callee 出现过」不等于「接收点真的在校验」——
    //    在文件末尾加个永不调用的函数喂断言即可骗过；
    // ② 结果必须**被绑定**（`const x = decode(...)` 或 `if (!decode(...))`）——
    //    `decode(x) ?? (x as T)` 这种「回退到裸载荷」的写法，decoder 被调用了但校验等于没有；
    // ③ 调用点必须落在**该类型的接收块内**，不能是别处顺手调一次。
    const mainToContent = new Set<string>(ZAI_MAIN_TO_CONTENT_TYPES);

    const contentProgram = readProgram(CONTENT_SOURCE);
    const mainWorldProgram = readProgram(MAIN_WORLD_SOURCE);

    const importedIntoContent = collectImportedNames(contentProgram, '../core/zai/messages');
    const importedIntoMainWorld = collectImportedNames(mainWorldProgram, '../core/zai/messages');

    for (const [type, decoder] of Object.entries(ZAI_BRIDGE_PAYLOAD_DECODERS)) {
      const isMainToContent = mainToContent.has(type);
      const program = isMainToContent ? contentProgram : mainWorldProgram;
      const file = isMainToContent ? CONTENT_SOURCE : MAIN_WORLD_SOURCE;

      // 必须是具名函数：匿名函数取不到名字，这条断言就无从谈起。
      expect(decoder.name, `${type} 的 decoder 必须是具名函数`).not.toBe('');

      // 必须从桥模块 import 进来（排除同文件里自己定义一个同名的假 decoder）。
      const imported = isMainToContent ? importedIntoContent : importedIntoMainWorld;
      expect(imported.has(decoder.name), `${type} 的 ${decoder.name} 必须从 core/zai/messages 导入`)
        .toBe(true);
      const declaredHere = collectFunctionDeclarationNames(program);
      expect(declaredHere.has(decoder.name), `${file} 里不能自己定义同名的 ${decoder.name}`)
        .toBe(false);

      // 结果必须被绑定（变量初始化或 if 判据）。
      const bound = collectBoundCallIdentifiers(program);
      expect(bound.has(decoder.name), `${type} 的 ${decoder.name} 的返回值必须被绑定后再用`)
        .toBe(true);

      // 且必须落在该类型的接收块内。
      const blocks = findReceiverBlocks(program, type);
      expect(blocks.length, `${file} 里应当有 ${type} 的接收块`).toBeGreaterThan(0);
      let callsInBlock = 0;
      for (const block of blocks) {
        walkSourceAst(block, (node) => {
          if (t.isCallExpression(node) && t.isIdentifier(node.callee)
            && node.callee.name === decoder.name) {
            callsInBlock += 1;
          }
        });
      }
      expect(callsInBlock, `${type} 的 ${decoder.name} 必须出现在它的接收块里`).toBeGreaterThan(0);
    }
  });

  it('keeps every decoder referenced by the table free of duplicate definitions in entrypoints', () => {
    // 反向：桥模块里的 decoder 只应定义一次（在 core/zai/messages.ts），
    // 两个 entrypoint 只许 import。这条挡的是「复制一份改改」这种分叉。
    const messagesProgram = readProgram(MESSAGES_SOURCE);
    const declaredInMessages = collectFunctionDeclarationNames(messagesProgram);
    for (const decoder of Object.values(ZAI_BRIDGE_PAYLOAD_DECODERS)) {
      expect(declaredInMessages.has(decoder.name), `${decoder.name} 应当在 core/zai/messages.ts 定义`)
        .toBe(true);
    }
  });

  it('hands each decoder the layer its payload actually lives on', () => {
    // ⚠️⚠️ **这条是本轮补的，它抓的是一个「全绿但功能不通」的缺陷。**
    // 接收侧对 decoder 的实参有两种合法形状：**整条信封**（`data`）或**信封里的某个字段**
    // （`data.payload` / `data.data`）。选错时 `isPlainRecord` 判否 ⇒ **整条消息被静默丢弃**
    // （有 `console.error`，但**没有任何测试会红**）—— 实测「接收侧传 `data.records`」
    // 这个变异，全量 1581 条用例**全绿**。
    //
    // 判据**从发送点派生**（不手抄）：主世界 `postToContent({ type, records })` 把载荷
    // **平铺**在信封上 ⇒ 接收侧该传 `data`；而 `postToContent({ type, payload })` 是
    // **嵌套**的 ⇒ 该传 `data.payload`。
    // ⚠️ **两个发送函数都要收**：`postToContent` 是主世界发的（主→隔），
    // `postToMainWorld` 是隔离世界发的（隔→主）—— 只收前者会漏掉 `SYNC_HOOK_STATE`。
    const posted = new Map([
      ...collectPostedPayloadKeys(readProgram(MAIN_WORLD_SOURCE), 'postToContent'),
      ...collectPostedPayloadKeys(readProgram(CONTENT_SOURCE), 'postToMainWorld'),
    ]);
    const contentProgram = readProgram(CONTENT_SOURCE);
    const mainWorldProgram = readProgram(MAIN_WORLD_SOURCE);
    const mainToContent = new Set<string>(ZAI_MAIN_TO_CONTENT_TYPES);

    for (const [type, decoder] of Object.entries(ZAI_BRIDGE_PAYLOAD_DECODERS)) {
      const keys = posted.get(type);
      expect(keys, `${type} 必须在主世界有发送点（否则这条判据无从派生）`).toBeDefined();
      const isMainToContent = mainToContent.has(type);
      const program = isMainToContent ? contentProgram : mainWorldProgram;
      const args = collectDecoderArguments(program, type, decoder.name);
      expect(args.length, `${type} 的接收块里应当有一次 ${decoder.name} 调用`).toBeGreaterThan(0);

      // 平铺：载荷字段直接挂在信封上（`records` / `toolDescriptorNames`）⇒ 传 `data`。
      // 嵌套：只有一个 `payload` / `data` 字段 ⇒ 传 `data.payload` / `data.data`。
      const payloadKey = keys!.has('payload') ? 'payload' : (keys!.has('data') ? 'data' : null);
      const expected = payloadKey === null ? 'data' : `data.${payloadKey}`;
      expect(args, `${type} 的 decoder 实参应当是 ${expected}（按发送点的载荷层次派生）`)
        .toEqual([expected]);
    }
  });

  it('posts every envelope field its decoder reads', () => {
    // ⚠️⚠️ **这条补的是上面那条挡不住的一类**：接收侧传对了层次（`data`），
    // 但**发送点漏掉了某个字段** ⇒ decoder 读到 `undefined`、按缺省处理
    // ⇒ **静默降级**（不报错、不丢消息，只是那条信息永远为空）。
    // 实测：把 `postToContent({ type, records, chatSessionId })` 改成
    // `{ type, records }`，全量 1609 条用例**全绿**、`tsc` 也绿
    // （字段是 `string | null`，缺省是合法的）—— 只有这条能抓住它。
    //
    // 判据**从两侧分别派生**：发送点 post 了哪些键（`collectPostedPayloadKeys`）
    // × decoder 函数体里读了哪些 `value.<键>`（`collectReadEnvelopeKeys`）。
    const posted = new Map([
      ...collectPostedPayloadKeys(readProgram(MAIN_WORLD_SOURCE), 'postToContent'),
      ...collectPostedPayloadKeys(readProgram(CONTENT_SOURCE), 'postToMainWorld'),
    ]);
    const messagesProgram = readProgram(MESSAGES_SOURCE);

    for (const [type, decoder] of Object.entries(ZAI_BRIDGE_PAYLOAD_DECODERS)) {
      const keys = posted.get(type);
      expect(keys, `${type} 必须在主世界有发送点`).toBeDefined();
      // ⚠️⚠️ **只对「平铺」载荷成立**：嵌套那几条（`payload` / `data`）的 decoder
      // 参数是**信封里的那个字段**，它读的 `value.name` / `value.requestId` 是
      // **内层载荷的字段**、不是信封字段 ⇒ 拿信封键去要求它们会造出假红。
      // 嵌套那几条的层次由上面那条用例守（实参必须是 `data.payload`）。
      if (keys!.has('payload') || keys!.has('data')) continue;

      const read = collectReadEnvelopeKeys(messagesProgram, decoder.name);
      for (const key of read) {
        expect(
          keys!.has(key),
          `${type} 的 ${decoder.name} 读了信封字段 ${key}，但发送点没 post 它`,
        ).toBe(true);
      }
    }
  });
});
