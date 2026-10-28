import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  formatMemoriesBlock,
  getMemoryBudget,
  selectMemories,
} from '../core/memory/selector';
import { MEMORY_CONTENT_MAX_CHARS } from '../core/constants';
import type { Memory } from '../core/types';

/**
 * 记忆注入预算与单条截断。
 *
 * ⚠️ **这组守的是「budget 真的是上限」** —— 早先的循环是
 * `if (remaining - cost < 0 && selected.length > 0) break;`，那个附加条件让
 * **第一条永不因超预算被拒**，而正文此前没有长度上限 ⇒ 一条 4 万字的记忆能把注入
 * 撑到预算的 16 倍，之后每一轮都要多付这些 token。
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
    accessCount: 1,
    lastAccessedAt: now,
    ...overrides,
  };
}

/** 把选中的记忆渲染成注入块（与 `augmentPrompt` 的用法一致）。 */
function render(prompt: string, memories: Memory[], budget: number): string {
  return formatMemoriesBlock(selectMemories(prompt, memories, { budget }), 'zh-CN');
}

describe('selectMemories budget', () => {
  it('keeps the injected block within the budget for a huge first memory', () => {
    // 4 万字的记忆：旧实现会整条注入（约 24000 token，预算 1500）。
    const huge = memory({ id: 1, content: '字'.repeat(40000), pinned: true });
    const block = render('随便问一句', [huge], getMemoryBudget(500));

    expect(estimateTokens(block)).toBeLessThanOrEqual(getMemoryBudget(500));
    expect(block).toContain('已截断');
  });

  it('keeps the budget for every content size around the limit', () => {
    const budget = getMemoryBudget(500);
    for (const size of [10, 300, 1000, 3000, MEMORY_CONTENT_MAX_CHARS]) {
      const block = render('随便问一句', [memory({ content: '字'.repeat(size) })], budget);
      expect(estimateTokens(block), `size=${size}`).toBeLessThanOrEqual(budget);
    }
  });

  it('does not add the truncation marker when nothing was cut', () => {
    const block = render('问', [memory({ content: '短内容' })], 1500);
    expect(block).not.toContain('已截断');
    expect(block).toBe('- #1 [topic] memory: 短内容');
  });

  it('returns an empty block when not even the marker fits', () => {
    const block = render('问', [memory({ content: '字'.repeat(5000) })], 1);
    expect(block).toBe('(暂无记忆)');
  });

  it('stops adding further memories once the budget is used up', () => {
    // ⚠️ 用 CJK 正文（0.6 token/字）而不是 ASCII（0.3）—— 三条 1000 字的 ASCII
    // 合计只有约 900 token，塞得进 1500 的预算，断言「少于 3 条」会假红。
    const memories = [
      memory({ id: 1, content: '字'.repeat(1000), pinned: true }),
      memory({ id: 2, content: '字'.repeat(1000) }),
      memory({ id: 3, content: '字'.repeat(1000) }),
    ];
    const selected = selectMemories('问', memories, { budget: 1500 });
    const block = formatMemoriesBlock(selected, 'zh-CN');
    expect(estimateTokens(block)).toBeLessThanOrEqual(1500);
    expect(selected.length).toBeLessThan(3);
  });

  it('never cuts a surrogate pair in half', () => {
    // ⚠️ 这条守的是**结果**，不是某个防护函数 —— `estimateTokenUnits` 按码点迭代，
    // 孤立高代理与完整 emoji 代价相同 ⇒ 二分取「最大合法 mid」时必然落在码点边界上。
    // 所以它现在恒真；留着是因为「换成按 code-unit 计价」或「改成按比例估」都会
    // 立刻破坏这个性质，那时这条会红。
    const emoji = memory({ content: 'a' + '😀'.repeat(3000), pinned: true });
    for (const budget of [15, 17, 20, 40, 100, 400]) {
      const [selected] = selectMemories('问', [emoji], { budget });
      expect(selected, `budget=${budget}`).toBeDefined();
      const last = selected!.content.charCodeAt(selected!.content.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff, `budget=${budget} 末尾是孤立的高代理字符`).toBe(false);
    }
  });

  it('does not mutate the stored memory content', () => {
    const original = '字'.repeat(5000);
    const huge = memory({ content: original, pinned: true });
    selectMemories('问', [huge], { budget: 1500 });
    expect(huge.content).toBe(original);
  });
});
