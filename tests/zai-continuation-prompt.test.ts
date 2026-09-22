import { describe, expect, it } from 'vitest';
import {
  buildZaiContinuationPrompt,
  buildZaiNudgePrompt,
  isZaiContinuationPrompt,
} from '../core/zai/continuation';

const NO_EXECUTIONS = [] as const;

describe('zai continuation prompt recognition', () => {
  it('recognizes the continuation template', () => {
    const prompt = buildZaiContinuationPrompt('do the thing', NO_EXECUTIONS, ['shell_exec']);
    expect(isZaiContinuationPrompt(prompt)).toBe(true);
  });

  it('recognizes the nudge template', () => {
    const prompt = buildZaiNudgePrompt('do the thing', 'I will read the file.', NO_EXECUTIONS, 1, []);
    expect(isZaiContinuationPrompt(prompt)).toBe(true);
  });

  it('does not treat an ordinary user prompt as a continuation', () => {
    expect(isZaiContinuationPrompt('帮我读一下这个文件')).toBe(false);
    expect(isZaiContinuationPrompt('<original_task>only one tag</original_task>')).toBe(false);
    expect(isZaiContinuationPrompt('<tool_results>[]</tool_results>')).toBe(false);
  });

  it('does not treat a prompt that merely quotes the tags as a continuation', () => {
    expect(isZaiContinuationPrompt('explain the tag <tool_results> in isolation')).toBe(false);
  });
});
