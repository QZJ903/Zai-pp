import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import {
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
});
