import { describe, expect, it } from 'vitest';
import { buildPromptAugmentation } from '../core/prompt';
import type { Memory } from '../core/types';

/**
 * `usedMemoryIds` 是**记忆访问计数的唯一来源**。
 *
 * ⚠️⚠️ 它一路喂到后台 `touchMemories`，更新 `accessCount` / `lastAccessedAt`；
 * 而这两个字段是
 * ① `decayScore`（记忆排序里「越常用越优先」那部分权重）与
 * ② `archiveStaleMemories`（90 天未访问且访问次数 < 3 就删）
 * 的唯一输入。
 *
 * 所以它一旦为空，后果不是「少记一个数」：
 * 记忆检索退化成纯关键词匹配，且**所有没 pin 的记忆会在创建 90 天后被每次启动静默删掉**。
 * 本项目踩过这个坑 —— 内容脚本那侧发的是 `TOUCH_MEMORIES { ids: [] }`（硬编码），
 * 修之前 `accessCount` 从 2026-09-18 起就没变过。
 */

function memory(overrides: Partial<Memory> = {}): Memory {
  const now = Date.now();
  return {
    id: 1,
    type: 'topic',
    name: 'memory',
    content: 'content',
    description: 'memory',
    tags: [],
    pinned: false,
    syncId: 'sync-1',
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    lastAccessedAt: now,
    ...overrides,
  };
}

function usedIds(memories: Memory[], prompt = '随便问一句'): number[] {
  return buildPromptAugmentation(prompt, {
    memories,
    toolDescriptors: [],
    locale: 'zh-CN',
  }).usedMemoryIds;
}

describe('buildPromptAugmentation usedMemoryIds', () => {
  it('reports the ids of every injected memory', () => {
    const ids = usedIds([
      memory({ id: 11, content: '短内容' }),
      memory({ id: 22, content: '另一条' }),
    ]);
    expect(ids.sort()).toEqual([11, 22]);
  });

  it('reports a truncated memory too — it did reach the prompt', () => {
    // ⚠️ 截断的那条**仍然算「用过」**：它确实进了提示词（只是不完整），
    // 不报它会让「一条长记忆撑满预算」这种最常见的场景变成「永远不计访问次数」，
    // 于是它照样在 90 天后被删。
    const huge = memory({ id: 33, content: '字'.repeat(40_000), pinned: true });
    expect(usedIds([huge])).toEqual([33]);
  });

  it('reports nothing when memory injection is disabled', () => {
    const ids = buildPromptAugmentation('随便问一句', {
      memories: [memory({ id: 44 })],
      toolDescriptors: [],
      locale: 'zh-CN',
      memoryEnabled: false,
    }).usedMemoryIds;
    expect(ids).toEqual([]);
  });

  it('drops entries without an id instead of reporting undefined', () => {
    // `filter(Boolean)` 那一步：id 为 undefined 的记忆还没落库（或来自同步快照），
    // 报出去会让 `touchMemories` 的 `targetIds.has(undefined)` 永远不命中。
    const ids = usedIds([memory({ id: undefined, content: '未落库' })]);
    expect(ids).toEqual([]);
  });
});