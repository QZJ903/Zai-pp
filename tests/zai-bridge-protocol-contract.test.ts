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
 * - `TITLE_LOOKUP` 走桥，但两个清单里都没有它。
 *
 * ⚠️ **断言用 AST 取调用点，不扫源码字符串** —— 类型名在导入语句、注释、
 * 清单定义里都会出现，`includes` 型断言删掉调用点照样为真。
 */

const MAIN_WORLD_SOURCE = 'entrypoints/zai-main-world.content.ts';
const CONTENT_SOURCE = 'entrypoints/zai.content.ts';

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
 * 收集 switch 分支里接收的消息类型。
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
    // （`decodeAugmentResult` 正是注释里点名的「2.15.15 已踩过一次」的那条。）
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
    const messagesProgram = readProgram('core/zai/messages.ts');
    const declaredInMessages = collectFunctionDeclarationNames(messagesProgram);
    for (const decoder of Object.values(ZAI_BRIDGE_PAYLOAD_DECODERS)) {
      expect(declaredInMessages.has(decoder.name), `${decoder.name} 应当在 core/zai/messages.ts 定义`)
        .toBe(true);
    }
  });
});
