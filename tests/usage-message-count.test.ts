import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { USAGE_MESSAGE_COUNT } from '../core/constants';
import { normalizeUsageTurnInput } from '../core/usage/input-codec';
import { decodeUsageRecords } from '../core/usage/codec';
import { toLocalDayKey } from '../core/usage/stats';

/**
 * 一条用量记录的**消息条数恒为 2（一问一答）** —— 这是本项目的既定口径。
 *
 * ⚠️⚠️ 这个数有**三个落点**，任何一处单独改都会让「总消息数」与「总轮数」不一致，
 * 而三处都不报错：
 * ① 发送侧 `entrypoints/zai.content.ts` 的 `RECORD_USAGE_TURN` 载荷；
 * ② 收侧 `core/usage/input-codec.ts`（缺省兜底）；
 * ③ 读回 `core/usage/codec.ts`（老记录没有这个字段时的兜底）。
 *
 * ⚠️ **曾试过「续跑轮记 1」，自动化下没生效、已回滚** —— 别按「更准确」的直觉改。
 * 现在三处都从 `USAGE_MESSAGE_COUNT` 派生，这条测试钉住「派生关系没有断掉」。
 */
describe('usage message count is a single source of truth', () => {
  it('keeps the constant at 2', () => {
    expect(USAGE_MESSAGE_COUNT).toBe(2);
  });

  it('falls back to the constant when the input omits messageCount', () => {
    const decoded = normalizeUsageTurnInput({
      id: 'req-1',
      source: 'glm-web',
      totalTokens: 10,
      tokenSource: 'server',
      tps: 1,
      speedSource: 'server',
      elapsedMs: 1,
    });
    expect(decoded.messageCount).toBe(USAGE_MESSAGE_COUNT);
  });

  it('falls back to the constant when a stored record omits messageCount', () => {
    const day = toLocalDayKey(Date.now());
    const decoded = decodeUsageRecords([{
      id: 'req-1',
      recordedAt: Date.now(),
      day,
      source: 'glm-web',
      chatSessionId: null,
      assistantMessageId: null,
      modelType: null,
      totalTokens: 10,
      tokenSource: 'server',
      tps: 1,
      speedSource: 'server',
      elapsedMs: 1,
    }]);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.messageCount).toBe(USAGE_MESSAGE_COUNT);
  });

  it('keeps the content-script payload derived from the constant', () => {
    // ⚠️ 发送侧是模块内私有函数里的内联字面量，纯函数测不到 ——
    // 这里用源码断言收窄到「`messageCount:` 那一行必须引用常量，不许写裸数字」。
    // 判据是**属性行**，不是「源码里有没有出现 2」——
    // 后者会被注释、无关字面量和别的字段满足。
    const source = readFileSync('entrypoints/zai.content.ts', 'utf8');
    const lines = source.split('\n');
    const assignments = lines
      .map((line, index) => ({ line: line.trim(), index: index + 1 }))
      .filter(({ line }) => line.startsWith('messageCount:'));
    expect(assignments.length).toBeGreaterThan(0);
    for (const { line, index } of assignments) {
      expect(line, `entrypoints/zai.content.ts:${index} 必须写 USAGE_MESSAGE_COUNT，不能写裸数字`)
        .toBe('messageCount: USAGE_MESSAGE_COUNT,');
    }
  });
});