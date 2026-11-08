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

  /**
   * ⚠️⚠️ **单条上限与整块预算必须配对。**
   *
   * 两个数各自都合理，配错了就出现「存得下、看不见」：一条满上限的记忆自己就超预算
   * ⇒ 它被截断，而 `selectMemories` 的 `break` 语义让后面所有记忆一条都进不来。
   * 旧组合 8000 字 + 1500 预算是 3.2 倍，这条会红。
   *
   * ⚠️ 改任一个数都要重算另一个 —— 这条用例就是那个「重算」的机器判据。
   */
  it('fits one at-limit memory inside the budget without truncating it', () => {
    const atLimit = memory({
      id: 1,
      content: '字'.repeat(MEMORY_CONTENT_MAX_CHARS),
      pinned: true,
    });
    const [selected] = selectMemories('问', [atLimit], { budget: getMemoryBudget(500) });
    expect(selected, '一条满上限的记忆应当能进').toBeDefined();
    expect(selected!.truncated, '满上限的记忆不该被截断 —— 那说明预算配小了').toBe(false);
    expect(selected!.content).toHaveLength(MEMORY_CONTENT_MAX_CHARS);
  });

  /**
   * ⚠️ 预算地板跟着预算一起抬：否则抬预算只在短 prompt 上生效，
   * 长对话里照样砍到旧地板。判据是「地板 ≥ 一条满上限记忆的成本」。
   */
  it('keeps the floor high enough for one at-limit memory', () => {
    const body = '字'.repeat(MEMORY_CONTENT_MAX_CHARS);
    const oneMemoryCost = estimateTokens(formatMemoriesBlock(
      [{ memory: memory({ content: body }), content: body, truncated: false }],
      'zh-CN',
    ));
    // 极长 prompt ⇒ 触底。
    const floor = getMemoryBudget(1_000_000);
    expect(floor, `地板 ${floor} 装不下一条满上限记忆（需 ${oneMemoryCost}）`)
      .toBeGreaterThanOrEqual(oneMemoryCost);
    // 触底之后不再继续掉。
    expect(getMemoryBudget(2_000_000)).toBe(floor);
  });

  /**
   * ⚠️ **`keywordScore` 的三档权重 20 / 15 / 5 是经验值，但它们的相对顺序是契约。**
   *
   * 判据不是「数值对不对」（没有外部规格可对照），而是「标签比名字重要、名字比正文重要」
   * —— 这条顺序反了的话，检索会开始优先挑「正文里碰巧提到这个词」的记忆，
   * 而用户给记忆打的标签才是他明确表达的归属。
   */
  it('ranks tag matches above name matches above body matches', () => {
    const prompt = '部署 约定';
    const byTag = memory({ id: 1, name: '无关', content: '无关', tags: ['部署'] });
    const byName = memory({ id: 2, name: '部署', content: '无关', tags: [] });
    const byBody = memory({ id: 3, name: '无关', content: '部署 约定', tags: [] });

    // 先确认三档都能被选中 —— 否则「排序」那半是在给一堆没命中的东西排序。
    for (const target of [byTag, byName, byBody]) {
      const selected = selectMemories(prompt, [target], { budget: 100_000 });
      expect(selected, `#${target.id} 应当被选中`).toHaveLength(1);
    }

    // 同场竞争：三者都不置顶、访问次数相同 ⇒ 排序只由关键词权重决定。
    const order = selectMemories(prompt, [byBody, byName, byTag], { budget: 100_000 })
      .map((entry) => entry.memory.id);
    expect(order, '标签命中的必须排最前、正文命中的排最后').toEqual([1, 2, 3]);
  });
});
