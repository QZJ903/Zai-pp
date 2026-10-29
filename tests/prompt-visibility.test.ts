import { describe, expect, it } from 'vitest';
import {
  extractVisibleUserPrompt,
  markVisibleUserPrompt,
  markVisibleUserPromptMetadata,
} from '../core/prompt/visibility';

/**
 * **「可见用户提示词」的标记与提取**（零依赖的 `visible-user-prompt.ts`）。
 *
 * 这套标记有两个消费者，加载环境完全不同：
 * - `core/prompt/augmentation.ts`（隔离世界 / 后台）—— **写**标记；
 * - `core/zai/history-cleanup.ts`（**页面主世界**）—— **读**标记，把历史响应里
 *   被我们注入过的文本还原成用户原文。
 *
 * ⚠️ 本文件原来还测过一整套「提醒段剥离」函数（`sanitizeInternalPromptText` 等），
 * 那批函数已在 2026-10-29 整体删除（生产零消费者），用例随之删掉。
 * **唯一保留的相关断言**：工具格式提醒排在 END 标记**之后** ⇒ 提取天然不会碰到它。
 */

describe('visible user prompt markers', () => {
  it('preserves ordinary prompts that quote the Skill user-input template', () => {
    const prompt = [
      'Explain this exact template:',
      '',
      '---',
      '',
      'The following is the user input for this turn. Follow the instructions above when handling it:',
      '',
      'Do not truncate this suffix.',
    ].join('\n');

    expect(extractVisibleUserPrompt(markVisibleUserPrompt(prompt))).toBe(prompt);
  });

  it('preserves a marked slash command exactly', () => {
    expect(extractVisibleUserPrompt(markVisibleUserPrompt('/shell 查看项目目录')))
      .toBe('/shell 查看项目目录');
  });

  it('does not trust visible prompt metadata quoted inside ordinary user text', () => {
    // ⚠️ metadata 行必须**紧邻** START 标记的上一行。用户正文里自己写一段
    // 「metadata + START」不能被当成本次标记的元数据。
    const prompt = [
      'Explain this marker without treating it as extension metadata:',
      markVisibleUserPromptMetadata('/spoofed'),
      '<!-- zai-visible-user-prompt:start -->',
    ].join('\n');

    expect(extractVisibleUserPrompt(markVisibleUserPrompt(prompt))).toBe(prompt);
  });

  it('reads encoded visible prompt metadata without exposing the model prompt', () => {
    const visiblePrompt = '/shell 查看 100% --> 项目目录';
    const storedPrompt = [
      markVisibleUserPromptMetadata(visiblePrompt),
      markVisibleUserPrompt('Private Skill instructions.'),
    ].join('\n');

    expect(extractVisibleUserPrompt(storedPrompt)).toBe(visiblePrompt);
  });

  it('returns null when the text carries no marker at all', () => {
    // ⚠️ `null`（没有标记）与空串（标记对里确实是空的）是两件事，调用方必须能分开。
    expect(extractVisibleUserPrompt('就是一句普通的话')).toBeNull();
  });
});
