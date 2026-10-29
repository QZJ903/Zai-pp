import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';

/**
 * `TOUCH_MEMORIES` 的载荷必须是**真实的记忆 id**，不能是常量空数组。
 *
 * ⚠️⚠️ **这条守的是接线，不是规则** —— 「哪些记忆算用过」由
 * `buildPromptAugmentation` 的 `usedMemoryIds` 算（有 `prompt-used-memory-ids.test.ts`
 * 那组行为用例守着），但**内容脚本有没有把它发出去**是另一件事。
 * 而**位置类断言（AST / 字符串扫描）永远测不到函数体里的分支** —— 被断言过「调用在这里」
 * 的函数，仍可能没有任何一条用例喂过它真实输入；同理，AST 断言本身也有已知的绕过形态
 * （把真身挪进死函数、同名重新绑定、末尾补同名壳等），只能靠「真调一次、断言副作用」
 * 的行为测试兜底。接线与规则必须分开守，缺一半就会静默。
 *
 * **为什么值得为它写一条 AST 断言**：那行曾经是
 * `payload: { ids: [] }`（硬编码），而 `ids` 一路喂到后台 `touchMemories`，
 * 更新的 `accessCount` / `lastAccessedAt` 是两件事的唯一输入：
 * ① `decayScore` 里「越常用越优先」那部分权重；
 * ② `archiveStaleMemories` 的删除判据（90 天未访问且访问次数 < 3）。
 * 传空数组时不报错、不告警、测试全绿，而**所有没 pin 的记忆会在创建 90 天后
 * 被每次启动静默删掉**。
 *
 * ⚠️ 断言查的是**对象属性的值节点形态**（是不是数组字面量、元素个数），
 * 不是「源码里有没有出现 `ids: []` 这个字符串」—— 后者注释里写一句就会满足。
 */

const CONTENT_SOURCE = 'entrypoints/zai.content.ts';

function contentProgram(): t.Program {
  return parseTypeScriptSource(CONTENT_SOURCE, readFileSync(CONTENT_SOURCE, 'utf8'));
}

/** 收集所有 `type: 'TOUCH_MEMORIES'` 的对象字面量（即命令载荷）。 */
function touchMemoriesPayloads(program: t.Program): t.ObjectExpression[] {
  const payloads: t.ObjectExpression[] = [];
  walkSourceAst(program, (node) => {
    if (!t.isObjectExpression(node)) return;
    const isTouchCommand = node.properties.some((property) => {
      if (!t.isObjectProperty(property) || !t.isIdentifier(property.key)) return false;
      if (property.key.name !== 'type') return false;
      return t.isStringLiteral(property.value) && property.value.value === 'TOUCH_MEMORIES';
    });
    if (isTouchCommand) payloads.push(node);
  });
  return payloads;
}

/** 取对象字面量里 `payload` 属性的值（要求是对象字面量）。 */
function payloadObject(command: t.ObjectExpression): t.ObjectExpression | null {
  for (const property of command.properties) {
    if (!t.isObjectProperty(property) || !t.isIdentifier(property.key)) continue;
    if (property.key.name !== 'payload') continue;
    return t.isObjectExpression(property.value) ? property.value : null;
  }
  return null;
}

/** 取 `payload` 里 `ids` 属性的值节点。 */
function idsValue(payload: t.ObjectExpression): t.Node | null {
  for (const property of payload.properties) {
    if (!t.isObjectProperty(property) || !t.isIdentifier(property.key)) continue;
    if (property.key.name === 'ids') return property.value;
  }
  return null;
}

describe('TOUCH_MEMORIES payload wiring', () => {
  it('sends the ids produced by the augmentation, never a literal empty array', () => {
    const commands = touchMemoriesPayloads(contentProgram());
    // 至少有一处发送点 —— 全删掉这条链就没人上报了，也要红。
    expect(commands.length).toBeGreaterThan(0);

    for (const command of commands) {
      const payload = payloadObject(command);
      expect(payload, 'TOUCH_MEMORIES 的 payload 必须是内联对象字面量').not.toBeNull();
      const ids = idsValue(payload!);
      expect(ids, 'TOUCH_MEMORIES 的载荷必须带 ids').not.toBeNull();

      // 判据①：不许是数组字面量（`[]` 与 `[1,2]` 都拒 —— 后者同样不是「本轮选出的」）。
      expect(t.isArrayExpression(ids!), 'TOUCH_MEMORIES.ids 不能是数组字面量').toBe(false);
      // 判据②：必须是从增广结果派生出来的成员访问（`x.usedMemoryIds`）。
      const isUsedMemoryIdsAccess = (
        t.isMemberExpression(ids!) && t.isIdentifier(ids!.property, { name: 'usedMemoryIds' })
      ) || (
        t.isOptionalMemberExpression(ids!)
        && t.isIdentifier(ids!.property, { name: 'usedMemoryIds' })
      );
      expect(isUsedMemoryIdsAccess, 'TOUCH_MEMORIES.ids 必须取 usedMemoryIds').toBe(true);
    }
  });

  it('keeps exactly one reporting path', () => {
    // ⚠️ **只有 completion 那一条** —— 首条 `chatNew` 之后紧跟的 completion 会独立
    // 再选一遍记忆并上报（同一条用户消息、同一批记忆），两处都发会让首轮每条 +2。
    // 这条钉住「别顺手在 chatNew 分支里再补一处」，否则计数会翻倍。
    expect(touchMemoriesPayloads(contentProgram())).toHaveLength(1);
  });
});