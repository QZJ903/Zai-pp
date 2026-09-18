// 自动激活（隐式打分）开关：不变式 normalize 验证。

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SKILL_AUTO_ACTIVATION_SETTINGS,
  normalizeSkillAutoActivationSettings,
} from '../core/skill/auto-activation-settings';

describe('normalizeSkillAutoActivationSettings（联动不变式）', () => {
  it('默认：首条开、每条关', () => {
    expect(DEFAULT_SKILL_AUTO_ACTIVATION_SETTINGS).toEqual({ firstMessage: true, everyMessage: false });
  });

  it('每条消息开 ⇒ 首条必开', () => {
    expect(normalizeSkillAutoActivationSettings({ firstMessage: false, everyMessage: true }))
      .toEqual({ firstMessage: true, everyMessage: true });
  });

  it('首条关 ⇒ 每条必关', () => {
    expect(normalizeSkillAutoActivationSettings({ firstMessage: false, everyMessage: true }))
      .toEqual({ firstMessage: true, everyMessage: true });
    expect(normalizeSkillAutoActivationSettings({ firstMessage: false, everyMessage: false }))
      .toEqual({ firstMessage: false, everyMessage: false });
  });

  it('仅首条开（每条关）保持不变', () => {
    expect(normalizeSkillAutoActivationSettings({ firstMessage: true, everyMessage: false }))
      .toEqual({ firstMessage: true, everyMessage: false });
  });

  it('脏数据（非布尔 / undefined）回落到默认', () => {
    expect(normalizeSkillAutoActivationSettings(undefined)).toEqual(DEFAULT_SKILL_AUTO_ACTIVATION_SETTINGS);
    expect(normalizeSkillAutoActivationSettings({ firstMessage: 'yes' as unknown as boolean, everyMessage: 1 as unknown as boolean }))
      .toEqual({ firstMessage: false, everyMessage: false });
  });
});