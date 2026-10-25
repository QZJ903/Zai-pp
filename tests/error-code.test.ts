import { describe, expect, it } from 'vitest';
import { looksLikeErrorCode } from '../core/messaging/error-code';

/**
 * 「这个串是错误码还是自然语言」——**三处共用同一份判据**（侧边栏失败提示、
 * 自动化失败卡片、工具卡片按钮）。
 *
 * ⚠️ 判据分叉的后果是静默的：同一句失败在一个页面被翻成中文、在另一个页面原样露出。
 * 这里用真输入钉住边界，尤其是「单个小写词也算码」与「英文句子必须放行」这两条。
 */
describe('error code detection', () => {
  it('treats bare snake_case and single lowercase words as codes', () => {
    expect(looksLikeErrorCode('busy')).toBe(true);
    expect(looksLikeErrorCode('automation_not_found')).toBe(true);
    expect(looksLikeErrorCode('skill_exists')).toBe(true);
    expect(looksLikeErrorCode('invalid_memories')).toBe(true);
    // 单个小写词也必须是码 —— `busy` / `cancelled` 是本仓真实存在的单码，
    // 要求「必须含下划线」会漏掉它们。
    expect(looksLikeErrorCode('cancelled')).toBe(true);
  });

  it('passes natural-language sentences through', () => {
    expect(looksLikeErrorCode('Automation run exceeded 300 seconds.')).toBe(false);
    expect(looksLikeErrorCode('Native messaging host is not configured.')).toBe(false);
    expect(looksLikeErrorCode('Skill edit is ambiguous because multiple custom Skills use the same name')).toBe(false);
    expect(looksLikeErrorCode('工具格式无效')).toBe(false);
  });

  it('rejects empty and non-code strings', () => {
    expect(looksLikeErrorCode('')).toBe(false);
    expect(looksLikeErrorCode('busy!')).toBe(false);
    expect(looksLikeErrorCode('Busy')).toBe(false);
    expect(looksLikeErrorCode('busy task')).toBe(false);
    expect(looksLikeErrorCode('busy_task ')).toBe(false);
  });
});