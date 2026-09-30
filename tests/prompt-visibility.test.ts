import { describe, expect, it } from 'vitest';
import {
  containsInternalPromptMarker,
  extractVisibleUserPrompt,
  markVisibleUserPrompt,
  markVisibleUserPromptMetadata,
  sanitizeInternalPromptText,
} from '../core/prompt/visibility';
import { renderToolFormatReminder } from '../core/prompt/augmentation';
import { SUPPORTED_LOCALES } from '../core/i18n/background';

describe('prompt visibility cleanup', () => {
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

    expect(sanitizeInternalPromptText(markVisibleUserPrompt(prompt))).toBe(prompt);
  });

  it('preserves a marked slash command exactly', () => {
    expect(sanitizeInternalPromptText(markVisibleUserPrompt('/shell 查看项目目录')))
      .toBe('/shell 查看项目目录');
  });

  it('does not trust visible prompt metadata quoted inside ordinary user text', () => {
    const prompt = [
      'Explain this marker without treating it as extension metadata:',
      markVisibleUserPromptMetadata('/spoofed'),
      '<!-- glm-visible-user-prompt:start -->',
    ].join('\n');

    expect(sanitizeInternalPromptText(markVisibleUserPrompt(prompt))).toBe(prompt);
  });

  it('reads encoded visible prompt metadata without exposing the model prompt', () => {
    const visiblePrompt = '/shell 查看 100% --> 项目目录';
    const storedPrompt = [
      markVisibleUserPromptMetadata(visiblePrompt),
      markVisibleUserPrompt('Private Skill instructions.'),
    ].join('\n');

    expect(extractVisibleUserPrompt(storedPrompt)).toBe(visiblePrompt);
    expect(sanitizeInternalPromptText(storedPrompt)).toBe(visiblePrompt);
  });

  it('recognizes the reminder as rendered for every supported locale', () => {
    // ⚠️ **用真渲染出来的提醒过一遍**，不要手写串 —— 这条守的是「守卫常量跟着文案走」：
    // 曾经 en 的标题从 `Tool call format reminder:` 改成 `Local tool call format reminder:`，
    // 而 `visibility.ts` 里另抄的常量没跟上，`containsToolFormatReminder` 对 en 恒为 false，
    // 剥离守卫**静默失效**（手写串的测试抓不到）。
    for (const locale of SUPPORTED_LOCALES) {
      const reminder = renderToolFormatReminder(undefined, locale);
      expect(reminder.length, `${locale} 的提醒段为空`).toBeGreaterThan(0);
      expect(containsInternalPromptMarker(reminder), `${locale} 的提醒段未被识别`).toBe(true);
      // 整段只有提醒时应当被剥成空串。
      expect(sanitizeInternalPromptText(reminder), `${locale} 的提醒段未被剥掉`).toBe('');
      // 与真实正文拼在一起时，只剥提醒、保留正文。
      const body = `正文开头\n${reminder}`;
      expect(sanitizeInternalPromptText(body), `${locale} 的正文被误伤`).toContain('正文开头');
    }
  });
});
