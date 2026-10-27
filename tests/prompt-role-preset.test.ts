import { describe, expect, it } from 'vitest';
import { buildPromptAugmentation } from '../core/prompt';
import { shouldInjectPresetForTurn } from '../core/prompt/settings';
import { translate } from '../core/i18n';

/**
 * **系统提示词预设替换 `## 角色` 的正文**（不是叠加）。
 *
 * ⚠️⚠️ 两条性质必须同时成立：
 * ① **没有预设时输出与改造前逐字节相同**（黄金文件 `zh-chat-no-tools.txt` 守着）；
 * ② 预设生效时，`## 角色` 下面是**预设原文**，默认那段**不再出现**。
 *
 * ⚠️ 「预设注入频率」对角色段照常生效 —— 是否生效由 `shouldInjectPresetForTurn`
 * 决定，`buildPromptAugmentation` 只认传进来的 `presetContent` 是否为 null。
 */

const PRESET = '你是代号「铁匠」的工程助手，只回答技术问题。';

function augment(presetContent: string | null, systemPromptEnabled = true): string {
  return buildPromptAugmentation('列出当前目录。', {
    memories: [],
    presetContent,
    toolDescriptors: [],
    locale: 'zh-CN',
    systemPromptEnabled,
  }).augmented;
}

describe('role section is owned by the system-prompt preset', () => {
  it('falls back to the built-in role text when no preset is active', () => {
    const text = augment(null);
    expect(text).toContain(translate('zh-CN', 'prompt.defaultRole'));
    expect(text).not.toContain(PRESET);
  });

  it('replaces the role body with the preset instead of prefixing it', () => {
    const text = augment(PRESET);
    // 预设原文必须落在 `## 角色` 之后、`## 已有记忆` 之前。
    const roleAt = text.indexOf('## 角色');
    const presetAt = text.indexOf(PRESET);
    const memoriesAt = text.indexOf('## 已有记忆');
    expect(roleAt).toBeGreaterThan(-1);
    expect(presetAt, '预设必须出现在角色段里').toBeGreaterThan(roleAt);
    expect(presetAt).toBeLessThan(memoriesAt);

    // ⚠️ 默认那段**不能再出现** —— 出现就说明还在叠加（旧行为）。
    expect(text).not.toContain(translate('zh-CN', 'prompt.defaultRole'));
    // ⚠️ 也不该再有「预设 + 分隔线 + 系统提示词」那种前置拼法。
    expect(text.startsWith(PRESET)).toBe(false);
  });

  it('treats a blank preset as "no preset" and falls back to the default role', () => {
    // ⚠️⚠️ **存储契约只要求 `content` 是字符串**（`core/preset/codec.ts` 的
    // `stringValue`），「非空」只是 UI 约定 ⇒ 一条空预设会让 `## 角色` 变成空段。
    for (const blank of ['', '   ', '\n\t ']) {
      const text = augment(blank);
      expect(text, `空白预设 ${JSON.stringify(blank)} 应回落到默认文案`)
        .toContain(translate('zh-CN', 'prompt.defaultRole'));
      expect(text.startsWith(PRESET)).toBe(false);
    }
  });

  it('keeps the rest of the system prompt intact under a preset', () => {
    const text = augment(PRESET);
    // 角色以外的段落一个都不能少（预设只换角色正文）。
    for (const header of ['## 已有记忆', '## 本地工具', '## 记忆保存规则']) {
      expect(text, `${header} 不该因为预设而消失`).toContain(header);
    }
  });

  it('still injects the preset when the system prompt switch is off', () => {
    // ⚠️ 总开关关掉时 `systemChat` 整段不注入，`{role}` 就没有落脚点 ——
    // 若不兜这一档，用户关掉系统提示词之后预设会**静默失效**。
    const text = augment(PRESET, false);
    expect(text).toContain(PRESET);
    expect(text).not.toContain('## 角色');
  });
});

describe('preset cadence governs the role section', () => {
  it('only hands the preset over on the turns the cadence fires', () => {
    // ⚠️ 这条守的是**接线**：`buildPromptAugmentation` 只认 `presetContent` 是否为空，
    // 真正的频率判据在 `shouldInjectPresetForTurn`。两者必须配合，
    // 否则「预设注入频率」这一项对角色段就形同虚设。
    const defaultCadence = (messageCount: number) => shouldInjectPresetForTurn({
      hasActivePreset: true,
      isFirstMessage: messageCount === 1,
      messageCount,
      cadence: 'default',
    });

    expect(defaultCadence(1), '首条必须注入').toBe(true);
    expect(defaultCadence(2), '第 2 条不该注入').toBe(false);
    expect(defaultCadence(10), '第 10 条命中重注间隔').toBe(true);

    // 未命中频率的轮次拿到的是 null ⇒ 角色段回到默认文案。
    const skipped = augment(defaultCadence(2) ? PRESET : null);
    expect(skipped).toContain(translate('zh-CN', 'prompt.defaultRole'));

    const fired = augment(defaultCadence(10) ? PRESET : null);
    expect(fired).toContain(PRESET);
    expect(fired).not.toContain(translate('zh-CN', 'prompt.defaultRole'));
  });

  it('never injects when the cadence is off', () => {
    const off = shouldInjectPresetForTurn({
      hasActivePreset: true,
      isFirstMessage: true,
      messageCount: 1,
      cadence: 'off',
    });
    expect(off).toBe(false);
    expect(augment(off ? PRESET : null)).toContain(translate('zh-CN', 'prompt.defaultRole'));
  });
});
