import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createChromeStorageSlot,
  createVersionedRepository,
} from '../core/persistence/versioned-repository';
import { withSyncLocalStateLock } from '../core/persistence/local-state-lock';
import {
  presetCollectionCodec,
} from '../core/preset/codec';
import { skillSourceCollectionCodec, userSkillCollectionCodec } from '../core/skill/codec';
import {
  ACTIVE_PRESET_STORAGE_KEY,
  PRESETS_STORAGE_KEY,
  getActivePreset,
  savePreset,
  setActivePresetId,
  stageDeletePresetAlreadyLocked,
} from '../core/preset/store';
import {
  SKILLS_STORAGE_KEY,
  SKILL_SOURCES_STORAGE_KEY,
  saveSkill,
  setSkillsEnabled,
  stageDeleteSkillAlreadyLocked,
  stageUpsertGitHubSkillSourceAlreadyLocked,
  updateGitHubSkillSourceLastCheckedAt,
} from '../core/skill/registry';
import {
  LEGACY_CUSTOM_SKILL,
  LEGACY_GITHUB_SKILL_SOURCE,
  LEGACY_PRESET,
  LEGACY_REMOTE_SKILL,
} from './fixtures/persistence-contract/skill-preset-history';

let storage: Record<string, unknown>;

beforeEach(() => {
  storage = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (
          Object.prototype.hasOwnProperty.call(storage, key)
            ? { [key]: structuredClone(storage[key]) }
            : {}
        )),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          storage = { ...storage, ...structuredClone(patch) };
        }),
        remove: vi.fn(async (key: string) => {
          delete storage[key];
        }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('remaining local-state stores', () => {
  it('preserves additive fields while editing released Skill and Preset records', async () => {
    storage[SKILLS_STORAGE_KEY] = [LEGACY_CUSTOM_SKILL];
    storage[PRESETS_STORAGE_KEY] = [LEGACY_PRESET];

    await saveSkill({
      ...LEGACY_CUSTOM_SKILL,
      description: 'updated',
    });
    await savePreset({
      ...LEGACY_PRESET,
      name: 'updated',
    });

    expect(storage[SKILLS_STORAGE_KEY]).toEqual([{
      ...LEGACY_CUSTOM_SKILL,
      description: 'updated',
      enabled: true,
    }]);
    expect(storage[PRESETS_STORAGE_KEY]).toEqual([{
      ...LEGACY_PRESET,
      name: 'updated',
    }]);
  });

  it('updates only the current GitHub source check timestamp instead of replaying a stale source snapshot', async () => {
    const currentSource = {
      ...LEGACY_GITHUB_SKILL_SOURCE,
      commitSha: 'concurrent-update',
      skillPaths: ['updated/SKILL.md'],
    };
    storage[SKILL_SOURCES_STORAGE_KEY] = [currentSource];

    await expect(updateGitHubSkillSourceLastCheckedAt(currentSource.id, 99)).resolves.toEqual({
      ...currentSource,
      lastCheckedAt: 99,
    });
    expect(storage[SKILL_SOURCES_STORAGE_KEY]).toEqual([{
      ...currentSource,
      lastCheckedAt: 99,
    }]);
  });

  it('rejects a GitHub update plan when its selected source paths became stale during network I/O', async () => {
    storage[SKILLS_STORAGE_KEY] = [LEGACY_REMOTE_SKILL];
    storage[SKILL_SOURCES_STORAGE_KEY] = [{
      ...LEGACY_GITHUB_SKILL_SOURCE,
      skillPaths: ['new-selection/SKILL.md'],
    }];

    await expect(stageUpsertGitHubSkillSourceAlreadyLocked(
      LEGACY_GITHUB_SKILL_SOURCE,
      [LEGACY_REMOTE_SKILL],
      LEGACY_GITHUB_SKILL_SOURCE.skillPaths,
    )).rejects.toThrow('changed while its update was loading');
    expect(storage[SKILL_SOURCES_STORAGE_KEY]).toEqual([{
      ...LEGACY_GITHUB_SKILL_SOURCE,
      skillPaths: ['new-selection/SKILL.md'],
    }]);
  });

  it('refuses to delete a name that matches multiple records instead of removing them all', async () => {
    const secondSource = {
      ...LEGACY_GITHUB_SKILL_SOURCE,
      id: 'github:owner/other:main:.',
      repo: 'other',
      repository: 'owner/other',
      url: 'https://github.com/owner/other',
      repoUrl: 'https://github.com/owner/other',
      skillPaths: ['other/SKILL.md'],
    };
    const secondSkill = {
      ...LEGACY_REMOTE_SKILL,
      remote: {
        ...LEGACY_REMOTE_SKILL.remote,
        sourceId: secondSource.id,
        path: 'other/SKILL.md',
      },
    };
    // 历史重名数据：一条 custom 与两条 remote 共用同一个名字。
    // 删除按名字匹配 ⇒ 一次会命中三条，还会把它们从各自的 source 里摘掉。
    // 正确行为是**拒绝**，把「该删哪一条」交回给人。
    storage[SKILLS_STORAGE_KEY] = [
      { ...LEGACY_CUSTOM_SKILL, name: LEGACY_REMOTE_SKILL.name },
      LEGACY_REMOTE_SKILL,
      secondSkill,
    ];
    storage[SKILL_SOURCES_STORAGE_KEY] = [LEGACY_GITHUB_SKILL_SOURCE, secondSource];

    await expect(stageDeleteSkillAlreadyLocked(LEGACY_REMOTE_SKILL.name))
      .rejects.toThrow('cannot be deleted safely');
    expect(storage[SKILLS_STORAGE_KEY]).toHaveLength(3);
    expect(storage[SKILL_SOURCES_STORAGE_KEY]).toEqual([LEGACY_GITHUB_SKILL_SOURCE, secondSource]);
  });

  it('deletes a uniquely-named Skill together with its source link', async () => {
    storage[SKILLS_STORAGE_KEY] = [LEGACY_CUSTOM_SKILL, LEGACY_REMOTE_SKILL];
    storage[SKILL_SOURCES_STORAGE_KEY] = [LEGACY_GITHUB_SKILL_SOURCE];

    const operation = await stageDeleteSkillAlreadyLocked(LEGACY_REMOTE_SKILL.name);
    await operation();

    expect(storage[SKILLS_STORAGE_KEY]).toEqual([{ ...LEGACY_CUSTOM_SKILL, enabled: true }]);
    expect(storage[SKILL_SOURCES_STORAGE_KEY]).toEqual([]);
  });

  it('rejects a self-named collision with an imported Skill instead of the ambiguous-custom path', async () => {
    const duplicateSkills = [
      { ...LEGACY_CUSTOM_SKILL, additiveField: { record: 1 } },
      { ...LEGACY_CUSTOM_SKILL, additiveField: { record: 2 } },
    ];
    storage[SKILLS_STORAGE_KEY] = duplicateSkills;

    await expect(saveSkill({
      ...LEGACY_CUSTOM_SKILL,
      description: 'ambiguous edit',
    })).rejects.toThrow('ambiguous');
    expect(storage[SKILLS_STORAGE_KEY]).toEqual(duplicateSkills);
  });

  it('rejects a custom Skill whose name an imported Skill already uses', async () => {
    storage[SKILLS_STORAGE_KEY] = [LEGACY_REMOTE_SKILL];

    await expect(saveSkill({
      ...LEGACY_CUSTOM_SKILL,
      name: LEGACY_REMOTE_SKILL.name,
    })).rejects.toThrow('Skill name is already used');
    expect(storage[SKILLS_STORAGE_KEY]).toEqual([LEGACY_REMOTE_SKILL]);
  });

  it('rejects a custom Skill whose name a built-in Skill already uses', async () => {
    storage[SKILLS_STORAGE_KEY] = [];

    await expect(saveSkill({ ...LEGACY_CUSTOM_SKILL, name: 'shell' }))
      .rejects.toThrow('Skill name is already used');
    expect(storage[SKILLS_STORAGE_KEY]).toEqual([]);
  });

  it('rejects renaming a custom Skill onto a name an imported Skill already uses', async () => {
    storage[SKILLS_STORAGE_KEY] = [LEGACY_CUSTOM_SKILL, LEGACY_REMOTE_SKILL];

    await expect(saveSkill(
      { ...LEGACY_CUSTOM_SKILL, name: LEGACY_REMOTE_SKILL.name },
      LEGACY_CUSTOM_SKILL.name,
    )).rejects.toThrow('Skill name is already used');
    expect(storage[SKILLS_STORAGE_KEY]).toEqual([LEGACY_CUSTOM_SKILL, LEGACY_REMOTE_SKILL]);
  });

  it('still lets a Skill be edited in place while keeping its own name', async () => {
    storage[SKILLS_STORAGE_KEY] = [LEGACY_CUSTOM_SKILL, LEGACY_REMOTE_SKILL];

    await saveSkill({ ...LEGACY_CUSTOM_SKILL, description: 'edited in place' }, LEGACY_CUSTOM_SKILL.name);

    expect(storage[SKILLS_STORAGE_KEY]).toEqual([
      { ...LEGACY_CUSTOM_SKILL, description: 'edited in place', enabled: true },
      LEGACY_REMOTE_SKILL,
    ]);
  });

  it('applies name-keyed enabled changes to the matching released Skill record', async () => {
    storage[SKILLS_STORAGE_KEY] = [
      { ...LEGACY_CUSTOM_SKILL, enabled: false, additiveField: { record: 1 } },
    ];

    await setSkillsEnabled([{ name: LEGACY_CUSTOM_SKILL.name, enabled: true }]);

    expect(storage[SKILLS_STORAGE_KEY]).toEqual([
      { ...LEGACY_CUSTOM_SKILL, enabled: true, additiveField: { record: 1 } },
    ]);
  });

  it('refuses to toggle a name that matches multiple records', async () => {
    const duplicates = [
      { ...LEGACY_CUSTOM_SKILL, enabled: false, additiveField: { record: 1 } },
      { ...LEGACY_CUSTOM_SKILL, enabled: false, additiveField: { record: 2 } },
    ];
    storage[SKILLS_STORAGE_KEY] = duplicates;

    // 界面上每条技能是一张独立卡片，点其中一张的开关时预期只有它变；
    // 按名字全改会让「我点了 A，B 也跟着变了」。
    await expect(setSkillsEnabled([{ name: LEGACY_CUSTOM_SKILL.name, enabled: true }]))
      .rejects.toThrow('cannot be toggled safely');
    expect(storage[SKILLS_STORAGE_KEY]).toEqual(duplicates);
  });

  it('rejects malformed enabled mutations without defaulting them into a write', async () => {
    storage[SKILLS_STORAGE_KEY] = [LEGACY_CUSTOM_SKILL];

    await expect(setSkillsEnabled([{
      name: LEGACY_CUSTOM_SKILL.name,
      enabled: undefined as unknown as boolean,
    }])).rejects.toThrow('must be a boolean');
    expect(storage[SKILLS_STORAGE_KEY]).toEqual([LEGACY_CUSTOM_SKILL]);
  });

  it('rejects ambiguous duplicate-source updates without collapsing either record', async () => {
    const duplicateSources = [
      { ...LEGACY_GITHUB_SKILL_SOURCE, additiveField: { record: 1 } },
      { ...LEGACY_GITHUB_SKILL_SOURCE, additiveField: { record: 2 } },
    ];
    storage[SKILL_SOURCES_STORAGE_KEY] = duplicateSources;

    await expect(updateGitHubSkillSourceLastCheckedAt(
      LEGACY_GITHUB_SKILL_SOURCE.id,
      99,
    )).rejects.toThrow('duplicated');
    expect(storage[SKILL_SOURCES_STORAGE_KEY]).toEqual(duplicateSources);
  });

  it('rejects ambiguous duplicate-Preset edits without collapsing either record', async () => {
    const duplicatePresets = [
      { ...LEGACY_PRESET, additiveField: { record: 1 } },
      { ...LEGACY_PRESET, additiveField: { record: 2 } },
    ];
    storage[PRESETS_STORAGE_KEY] = duplicatePresets;

    await expect(savePreset({ ...LEGACY_PRESET, name: 'ambiguous edit' }))
      .rejects.toThrow('ambiguous');
    expect(storage[PRESETS_STORAGE_KEY]).toEqual(duplicatePresets);
  });

  it('rejects malformed Preset delete ids before staging a successful no-op', async () => {
    storage[PRESETS_STORAGE_KEY] = [LEGACY_PRESET];

    await expect(stageDeletePresetAlreadyLocked(42 as unknown as string))
      .rejects.toThrow('Preset id is required');
    expect(storage[PRESETS_STORAGE_KEY]).toEqual([LEGACY_PRESET]);
  });

  it('does not overwrite future or corrupt records during ordinary writes', async () => {
    const futureSkills = { schemaVersion: 99, records: [] };
    const corruptPresets = null;
    storage[SKILLS_STORAGE_KEY] = futureSkills;
    storage[PRESETS_STORAGE_KEY] = corruptPresets;

    await expect(saveSkill(LEGACY_CUSTOM_SKILL)).rejects.toThrow();
    await expect(savePreset(LEGACY_PRESET)).rejects.toThrow();
    expect(storage[SKILLS_STORAGE_KEY]).toEqual(futureSkills);
    expect(storage[PRESETS_STORAGE_KEY]).toBeNull();
  });

  it('does not let a repository replacement overwrite unsupported local raw state', async () => {
    // 「先解码、解码过了才允许覆盖」这条不变式原来由 `*ForSyncApply` 一族承载，
    // 那族随云同步落地链删除；它现在只活在 `createVersionedRepository` 里，
    // 所以直接把被测对象换成那一层 —— 断言不变（未来态/损坏态不许被覆盖）。
    const futureSkills = { schemaVersion: 99, records: [] };
    const corruptSources = null;
    const futurePresets = { schemaVersion: 99, records: [] };
    storage[SKILLS_STORAGE_KEY] = futureSkills;
    storage[SKILL_SOURCES_STORAGE_KEY] = corruptSources;
    storage[PRESETS_STORAGE_KEY] = futurePresets;

    const skillRepo = createVersionedRepository({
      label: 'skills',
      createDefault: () => [],
      codec: userSkillCollectionCodec,
      storage: createChromeStorageSlot(SKILLS_STORAGE_KEY),
    });
    const sourceRepo = createVersionedRepository({
      label: 'skillSources',
      createDefault: () => [],
      codec: skillSourceCollectionCodec,
      storage: createChromeStorageSlot(SKILL_SOURCES_STORAGE_KEY),
    });
    const presetRepo = createVersionedRepository({
      label: 'presets',
      createDefault: () => [],
      codec: presetCollectionCodec,
      storage: createChromeStorageSlot(PRESETS_STORAGE_KEY),
    });

    await expect(withSyncLocalStateLock(
      () => skillRepo.replaceAlreadyLocked([LEGACY_CUSTOM_SKILL]),
    )).rejects.toThrow();
    await expect(withSyncLocalStateLock(
      () => sourceRepo.replaceAlreadyLocked([LEGACY_GITHUB_SKILL_SOURCE]),
    )).rejects.toThrow();
    await expect(withSyncLocalStateLock(
      () => presetRepo.replaceAlreadyLocked([LEGACY_PRESET]),
    )).rejects.toThrow();

    expect(storage[SKILLS_STORAGE_KEY]).toEqual(futureSkills);
    expect(storage[SKILL_SOURCES_STORAGE_KEY]).toBeNull();
    expect(storage[PRESETS_STORAGE_KEY]).toEqual(futurePresets);
  });

  it('rejects dangling active ids and preserves unsupported active state', async () => {
    storage[PRESETS_STORAGE_KEY] = [LEGACY_PRESET];
    storage[ACTIVE_PRESET_STORAGE_KEY] = 'historical-dangling';
    await expect(getActivePreset()).resolves.toBeNull();
    delete storage[ACTIVE_PRESET_STORAGE_KEY];

    await expect(setActivePresetId('missing')).rejects.toThrow('Preset was not found');
    expect(storage).not.toHaveProperty(ACTIVE_PRESET_STORAGE_KEY);

    const futureActive = { schemaVersion: 2, id: LEGACY_PRESET.id };
    storage[ACTIVE_PRESET_STORAGE_KEY] = futureActive;
    await expect(setActivePresetId(null)).rejects.toThrow('schemaVersion');
    expect(storage[ACTIVE_PRESET_STORAGE_KEY]).toEqual(futureActive);
  });
});
