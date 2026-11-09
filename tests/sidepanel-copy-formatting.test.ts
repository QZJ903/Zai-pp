// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../core/i18n';
import { boundedTimeoutMs } from '../entrypoints/sidepanel/pages/McpPage';
import { formatUpdateMessage } from '../entrypoints/sidepanel/pages/SkillPage';
import type { GitHubSkillUpdatePreview } from '../core/types';

/**
 * 两处「界面上的一句话」的判据 —— 都只能靠喂真实输入才测得到。
 */

const zh = createTranslator('zh-CN').t as never;
const en = createTranslator('en').t as never;

describe('boundedTimeoutMs', () => {
  it('accepts the full documented range and rejects outside it', () => {
    expect(boundedTimeoutMs('1000', '请求 ms', zh)).toBe(1_000);
    expect(boundedTimeoutMs('1800000', '请求 ms', zh)).toBe(1_800_000);
    expect(boundedTimeoutMs('60000', '请求 ms', zh)).toBe(60_000);

    expect(boundedTimeoutMs('999', '请求 ms', zh)).toBeTypeOf('string');
    expect(boundedTimeoutMs('1800001', '请求 ms', zh)).toBeTypeOf('string');
  });

  it('rejects the int32 overflow range with a range message, not "must be positive"', () => {
    // ⚠️⚠️ 这是本条存在的理由：`setTimeout` 的 delay 按 signed 32-bit 存储，
    // 2**31 会溢出成「立刻触发」⇒ 每次请求刚发出就超时。
    // 而它**确实是个正整数** —— 回「必须是正整数」等于什么都没解释。
    const message = boundedTimeoutMs('3000000000', '请求 ms', zh);
    expect(message).toBeTypeOf('string');
    expect(message).toContain('必须在');
    expect(message).not.toContain('必须是正整数');
    expect(message).toContain('1000');
    expect(message).toContain('1800000');
  });

  it('keeps the plain positive-integer message for non-integers', () => {
    expect(boundedTimeoutMs('0', '请求 ms', zh)).toContain('必须是正整数');
    expect(boundedTimeoutMs('1.5', '请求 ms', zh)).toContain('必须是正整数');
    expect(boundedTimeoutMs('abc', '请求 ms', zh)).toContain('必须是正整数');
  });
});

describe('formatUpdateMessage', () => {
  const update = (overrides: Partial<GitHubSkillUpdatePreview>): GitHubSkillUpdatePreview => ({
    source: {} as never,
    latestCommitSha: 'sha',
    changedPaths: [],
    newPaths: [],
    missingPaths: [],
    hasUpdates: true,
    warnings: [],
    checkedAt: 1,
    ...overrides,
  });

  it('joins the three parts with a separator that follows the UI language', () => {
    const preview = update({
      changedPaths: ['a', 'b'],
      newPaths: ['c'],
      missingPaths: ['d'],
    });

    // ⚠️⚠️ 英文界面里出现中文全角逗号是能看出来的，而两道 i18n 门禁都不查标点
    // （`i18n-coverage-audit` 只按汉字脚本属性判，全角逗号不带汉字属性）。
    const zhText = formatUpdateMessage(preview, zh);
    const enText = formatUpdateMessage(preview, en);

    expect(zhText).toContain('，');
    expect(enText).not.toContain('，');
    expect(enText).toContain(', ');
  });

  it('falls back to the "updates found" line when no part applies', () => {
    expect(formatUpdateMessage(update({}), zh)).toBe(createTranslator('zh-CN').t(
      'sidepanel.skillPage.updatesFound',
    ));
  });
});
