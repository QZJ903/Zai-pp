import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeRuntimeResponse } from '../core/messaging/runtime-response';
import { decodeActivePreset } from '../core/preset/codec';
import { LEGACY_PRESET } from './fixtures/persistence-contract/skill-preset-history';

const presetPage = readFileSync('entrypoints/sidepanel/pages/PresetPage.tsx', 'utf8');
const skillPage = readFileSync('entrypoints/sidepanel/pages/SkillPage.tsx', 'utf8');

describe('remaining local-state receiving boundaries', () => {
  it('keeps Side Panel state behind strict response and domain-codec boundaries', () => {
    expect(presetPage).toContain('decodeRuntimeResponse(');
    expect(presetPage).toContain("decodePresetCollection(");
    expect(presetPage).toContain("decodeActivePreset(");
    expect(presetPage).not.toContain('setPresets(list ?? [])');

    expect(skillPage).toContain("decodeSkillLibrary(");
    expect(skillPage).toContain("decodeSkillSourceCollection(");
    expect(skillPage).not.toContain('setSkills(list ?? [])');
    expect(skillPage).not.toContain('setSkillSources(sources ?? [])');
    expect(skillPage).not.toContain('key={source.id}');
    expect(skillPage).toContain('key={`${source.id}:${index}`}');
  });

  it('decodes a valid active Preset before interpreting its additive ok field as a runtime envelope', () => {
    const preset = { ...LEGACY_PRESET, ok: false, error: 'additive data' };

    expect(decodeRuntimeResponse(
      preset,
      (value) => decodeActivePreset(value, 'activePresetResponse'),
      'missing',
    )).toEqual(preset);
    expect(() => decodeRuntimeResponse(
      { ok: false, error: 'backend failed' },
      (value) => decodeActivePreset(value, 'activePresetResponse'),
      'missing',
    )).toThrow('backend failed');
  });
});
