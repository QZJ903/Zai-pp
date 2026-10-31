import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeMessageContext } from '../core/messaging/runtime-boundary';
import { PERSISTENCE_RUNTIME_PAYLOAD_DECODERS } from '../core/messaging/persistence-runtime-request-codec';
import { RUNTIME_COMMAND_CONTRACTS } from '../core/messaging/runtime-command-contracts';
import {
  createRuntimeCommandRegistry,
  definePayloadlessRuntimeCommandHandler,
  getRuntimeCommandOwner,
  TYPED_RUNTIME_COMMAND_TYPES,
  type RuntimeCommandHandler,
} from '../core/messaging/runtime-command-registry';
import type {
  BackgroundConfig,
  GitHubSkillImportResult,
  GitHubSkillPreview,
  GitHubSkillUpdatePreview,
  LocalSkillImportResponse,
  LocalSkillPreview,
  Memory,
  Skill,
  SystemPromptPreset,
} from '../core/types';
import type { SavedItem } from '../core/saved-items/types';
import {
  createLibraryRuntimeHandlers,
  type LibraryRuntimeHandlerDependencies,
} from '../entrypoints/background/library-handlers';
import {
  createLocalPreferenceRuntimeHandlers,
  type LocalPreferenceRuntimeHandlerDependencies,
} from '../entrypoints/background/local-preference-handlers';
import {
  createMemoryRuntimeHandlers,
  type MemoryRuntimeHandlerDependencies,
} from '../entrypoints/background/memory-handlers';
import { createPersistenceRuntimeHandlers } from '../entrypoints/background/persistence-handlers';
import {
  createSkillRuntimeHandlers,
  type SkillRuntimeHandlerDependencies,
} from '../entrypoints/background/skill-handlers';

/**
 * 持久化处理器组（inventory 的 **Group B**）的**注册面与领域失败语义**。
 *
 * 从上游 `background-persistence-handlers.test.ts`（633 行）移植。改动清单：
 *  - inventory 标题串与计数：上游 `R4.1 / #360 — … (61)` → 本项目 `Group B — … (41)`
 *  - 删掉 5 组本项目已移除的命令：`GET_ARTIFACT`、`GET/SET_DEEPSEEK_THEME`、
 *    `GET/SET_MODEL_TYPE`、`GET/SAVE/CLEAR_PET`、voice 三项（`GET_VOICE_SETTINGS` /
 *    `SAVE_VOICE_SETTINGS` / `GET_VOICE_CAPABILITIES`）
 *  - `ArtifactRecord` / `PetConfig` 类型在本项目**不存在**，一并删掉
 *  - 删掉「项目」整组（9 条命令随功能一起移除）
 *
 * ⚠️ **`memory-handlers.ts` / `skill-handlers.ts` / `persistence-handlers.ts` 两树逐字相同**，
 * 所以「Memory / Skill / Library 行为」那几条断言是**原样成立**的 —— 这也是本文件
 * 值得移植的根据：它覆盖的是本项目真正在用的处理器，不是已删功能的残影。
 *
 * ⚠️ 与姊妹文件 `background-tool-runtime-handlers.test.ts`（Group C，31 个）成对：
 * 两份合起来覆盖了全部 typed handler 的归属与解码面。
 */

const context: RuntimeMessageContext = {
  runtimeId: 'extension-id',
  surface: 'extension_context',
  senderUrl: 'chrome-extension://extension-id/sidepanel.html',
  senderOrigin: 'chrome-extension://extension-id',
  tabId: 17,
  documentSessionId: 'document-1',
};

const memory: Memory = {
  id: 7,
  syncId: 'memory-sync-7',
  type: 'user',
  name: 'Contract memory',
  content: 'Remember this',
  description: '',
  tags: [],
  pinned: false,
  createdAt: 1,
  updatedAt: 1,
  accessCount: 0,
  lastAccessedAt: 1,
};

const skill: Skill = {
  name: 'contract-skill',
  description: 'Contract Skill',
  instructions: 'Follow the contract.',
  source: 'custom',
  memoryEnabled: true,
  enabled: true,
};

const preset: SystemPromptPreset = {
  id: 'preset-1',
  name: 'Preset',
  content: 'Prompt',
  createdAt: 1,
  updatedAt: 1,
};

const savedItem: SavedItem = {
  id: 'saved-1',
  kind: 'snippet',
  title: 'Saved',
  content: 'Text',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
};

describe('Group B persistence runtime handler ownership', () => {
  it('creates exactly the 41 inventory-assigned handlers and completes the sole registry', async () => {
    const handlers = createPersistenceRuntimeHandlers({
      memory: createMemoryDependencies(),
      skill: createSkillDependencies(),
      library: createLibraryDependencies(),
      localPreference: createLocalPreferenceDependencies(),
    });
    const types = handlers.map((handler) => handler.type);
    const expected = readInventoryCommands('Group B — Persistence, library, and local preferences (41)');

    expect(types).toHaveLength(41);
    expect(new Set(types).size).toBe(41);
    expect([...types].sort()).toEqual([...expected].sort());
    for (const type of types) expect(getRuntimeCommandOwner(type)).toBe('typed-handler');
    const decodedTypes = Object.entries(RUNTIME_COMMAND_CONTRACTS)
      .filter(([, contract]) => contract.request.access === 'payload-decoded')
      .map(([type]) => type)
      .filter((type) => expected.includes(type))
      .sort();
    // 与姊妹文件（Group C 的 21 个）同风格：显式钉住数量，再逐项等值比对。
    expect(decodedTypes).toHaveLength(29);
    expect(Object.keys(PERSISTENCE_RUNTIME_PAYLOAD_DECODERS).sort()).toEqual(decodedTypes);

    const registry = createRuntimeCommandRegistry({
      typedHandlers: completeTypedHandlers([
        definePayloadlessRuntimeCommandHandler('GET_CONFIG', () => ({ version: '1.10.0' })),
        definePayloadlessRuntimeCommandHandler('WHATS_NEW_DISMISSED', () => ({ ok: true as const })),
        ...handlers,
      ]),
    });
    await expect(registry.dispatch({ type: 'GET_MEMORIES' }, context)).resolves.toEqual([memory]);
  });

  it('rejects a missing required payload before entering a dependency', async () => {
    const dependencies = createMemoryDependencies();
    const handlers = createMemoryRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, { type: 'SAVE_MEMORY' }))
      .rejects.toThrow('SAVE_MEMORY.payload must be a plain object');
    expect(dependencies.saveMemory).not.toHaveBeenCalled();
  });

  it('rejects a non-plain record payload before entering a dependency', async () => {
    const dependencies = createMemoryDependencies();
    const handlers = createMemoryRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, {
      type: 'SAVE_MEMORY',
      payload: new Date(0),
    })).rejects.toThrow('SAVE_MEMORY.payload must be a plain object');
    expect(dependencies.saveMemory).not.toHaveBeenCalled();
  });

  it('rejects malformed nested fields before persistence or external I/O', async () => {
    const skillDependencies = createSkillDependencies();
    const skillHandlers = createSkillRuntimeHandlers(skillDependencies);

    await expect(dispatch(skillHandlers, {
      type: 'PREVIEW_LOCAL_SKILL_SOURCE',
      payload: { rootPath: 7 },
    })).rejects.toThrow('PREVIEW_LOCAL_SKILL_SOURCE.payload.rootPath must be a non-empty string');
    expect(skillDependencies.previewLocalSkillSource).not.toHaveBeenCalled();

  });
});

describe('Memory handlers', () => {
  it('preserves the atomic import success and released domain failures', async () => {
    const dependencies = createMemoryDependencies();
    vi.mocked(dependencies.importMemoriesAtomically).mockResolvedValue([11, 12]);
    const handlers = createMemoryRuntimeHandlers(dependencies);
    const drafts = [{
      type: 'user' as const,
      name: 'Imported',
      content: 'Memory',
      description: '',
      tags: [],
      pinned: false,
    }];

    await expect(dispatch(handlers, {
      type: 'IMPORT_MEMORY_DRAFTS',
      payload: { memories: drafts },
    })).resolves.toEqual({ ok: true, ids: [11, 12], count: 2 });
    expect(dependencies.importMemoriesAtomically).toHaveBeenCalledWith(drafts);
    expect(dependencies.notifyCommittedStateUpdate).toHaveBeenCalledWith(17);

    vi.mocked(dependencies.notifyCommittedStateUpdate).mockClear();
    await expect(dispatch(handlers, {
      type: 'IMPORT_MEMORY_DRAFTS',
      payload: { memories: 'invalid' },
    })).resolves.toEqual({ ok: false, error: 'invalid_memories' });
    expect(dependencies.notifyCommittedStateUpdate).not.toHaveBeenCalled();

    vi.mocked(dependencies.importMemoriesAtomically)
      .mockRejectedValueOnce(new Error('memory.name must be a string'));
    await expect(dispatch(handlers, {
      type: 'IMPORT_MEMORY_DRAFTS',
      payload: { memories: drafts },
    })).resolves.toEqual({ ok: false, error: 'memory.name must be a string' });
    expect(dependencies.notifyCommittedStateUpdate).not.toHaveBeenCalled();
  });

  it('notifies only after a successful committed mutation', async () => {
    const dependencies = createMemoryDependencies();
    vi.mocked(dependencies.saveMemory).mockRejectedValueOnce(new Error('IndexedDB unavailable'));
    const handlers = createMemoryRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, {
      type: 'SAVE_MEMORY',
      payload: memory,
    })).rejects.toThrow('IndexedDB unavailable');
    expect(dependencies.notifyCommittedStateUpdate).not.toHaveBeenCalled();
  });
});

describe('Skill and library handlers', () => {
  it('preserves both released SAVE_SKILL payload shapes', async () => {
    const dependencies = createSkillDependencies();
    const handlers = createSkillRuntimeHandlers(dependencies);

    await dispatch(handlers, { type: 'SAVE_SKILL', payload: skill });
    await dispatch(handlers, {
      type: 'SAVE_SKILL',
      payload: { skill, previousName: 'old-contract-skill' },
    });

    expect(vi.mocked(dependencies.saveSkill).mock.calls).toEqual([
      [skill, undefined],
      [skill, 'old-contract-skill'],
    ]);
    expect(dependencies.broadcastStateUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not broadcast a blocked local import and propagates a post-commit broadcast failure', async () => {
    const dependencies = createSkillDependencies();
    const blocked: LocalSkillImportResponse = {
      ok: false,
      error: 'Shell Host update required',
      importBlock: { code: 'shell_host_update_required' },
    };
    vi.mocked(dependencies.importLocalSkillSource).mockResolvedValueOnce(blocked);
    const handlers = createSkillRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, {
      type: 'IMPORT_LOCAL_SKILL_SOURCE',
      payload: { rootPath: '/skills', selectedPaths: ['one/SKILL.md'] },
    })).resolves.toEqual(blocked);
    expect(dependencies.broadcastStateUpdate).not.toHaveBeenCalled();

    vi.mocked(dependencies.broadcastStateUpdate)
      .mockRejectedValueOnce(new Error('state snapshot unavailable'));
    await expect(dispatch(handlers, {
      type: 'SAVE_SKILL',
      payload: skill,
    })).rejects.toThrow('state snapshot unavailable');
    expect(dependencies.saveSkill).toHaveBeenCalled();
  });

  it('keeps optional picker payload and empty prompt insertion compatibility', async () => {
    const skillDependencies = createSkillDependencies();
    const libraryDependencies = createLibraryDependencies();
    const skillHandlers = createSkillRuntimeHandlers(skillDependencies);
    const libraryHandlers = createLibraryRuntimeHandlers(libraryDependencies);

    await expect(dispatch(skillHandlers, { type: 'PICK_LOCAL_SKILL_FOLDER' }))
      .resolves.toEqual({ path: '/picked' });
    expect(skillDependencies.pickLocalSkillFolder).toHaveBeenCalledWith(undefined);

    await expect(dispatch(libraryHandlers, { type: 'INSERT_SAVED_PROMPT_INTO_CHAT' }))
      .resolves.toEqual({ ok: false, error: 'empty_prompt_text' });
    await expect(dispatch(libraryHandlers, {
      type: 'INSERT_SAVED_PROMPT_INTO_CHAT',
      payload: { text: 7 },
    })).resolves.toEqual({ ok: false, error: 'empty_prompt_text' });
    expect(vi.mocked(libraryDependencies.insertPromptIntoActiveZaiTab).mock.calls)
      .toEqual([[''], ['']]);
  });

  it('passes partial Prompt and Skill-auto-activation settings to their released normalizers', async () => {
    const dependencies = createLibraryDependencies();
    const handlers = createLibraryRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, {
      type: 'SAVE_PROMPT_INJECTION_SETTINGS',
      payload: { memoryEnabled: false },
    })).resolves.toEqual({
      memoryEnabled: false,
      systemPromptEnabled: true,
      presetCadence: 'default',
      forceResponseLanguage: 'auto',
    });
    // ⚠️ 上游这一条测的是 SAVE_VOICE_SETTINGS —— voice 子系统本项目未移植，
    // 换成本项目实际有的「Skill 自动激活设置」，同样是「部分字段 + 归一化」的契约。
    await expect(dispatch(handlers, {
      type: 'SAVE_SKILL_AUTO_ACTIVATION_SETTINGS',
      payload: { firstMessage: false },
    })).resolves.toEqual({
      firstMessage: false,
      everyMessage: false,
    });
    expect(dependencies.savePromptInjectionSettings).toHaveBeenCalledWith({ memoryEnabled: false });
    expect(dependencies.saveSkillAutoActivationSettings).toHaveBeenCalledWith({ firstMessage: false });
  });
});

describe('Local preference handlers', () => {
  it('keeps same-value background behavior and broadcasts on every committed write', async () => {
    const dependencies = createLocalPreferenceDependencies();
    const handlers = createLocalPreferenceRuntimeHandlers(dependencies);

    const background: BackgroundConfig = {
      enabled: true,
      type: 'url',
      url: 'https://example.test/background.png',
      opacity: 0.4,
    };
    await dispatch(handlers, { type: 'SAVE_BACKGROUND', payload: background });
    expect(dependencies.saveBackgroundConfig).toHaveBeenCalledWith(background);
    expect(dependencies.broadcastBackgroundUpdate).toHaveBeenCalledWith(background);

    vi.mocked(dependencies.broadcastBackgroundUpdate).mockClear();
    await dispatch(handlers, { type: 'CLEAR_BACKGROUND' });
    // 清除也要广播（null 是一次真实的「没有背景」状态，不是「不用通知」）
    expect(dependencies.clearBackgroundConfig).toHaveBeenCalled();
    expect(dependencies.broadcastBackgroundUpdate).toHaveBeenCalledWith(null);
  });

  it('keeps GET_BACKGROUND payloadless and read-only', async () => {
    const dependencies = createLocalPreferenceDependencies();
    const handlers = createLocalPreferenceRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, { type: 'GET_BACKGROUND' })).resolves.toBeNull();
    expect(dependencies.getBackgroundConfig).toHaveBeenCalledTimes(1);
    expect(dependencies.saveBackgroundConfig).not.toHaveBeenCalled();
    expect(dependencies.broadcastBackgroundUpdate).not.toHaveBeenCalled();
  });
});

function createMemoryDependencies(): MemoryRuntimeHandlerDependencies {
  return {
    getAllMemories: vi.fn(async () => [memory]),
    getMemoryById: vi.fn(async () => memory),
    saveMemory: vi.fn(async () => 7),
    importMemoriesAtomically: vi.fn(async () => [7]),
    updateMemory: vi.fn(async () => undefined),
    deleteMemory: vi.fn(async () => undefined),
    touchMemories: vi.fn(async () => undefined),
    notifyCommittedStateUpdate: vi.fn(async () => undefined),
  };
}

function createSkillDependencies(): SkillRuntimeHandlerDependencies {
  const githubPreview = { source: { provider: 'github' }, skills: [], warnings: [], truncated: false } as unknown as GitHubSkillPreview;
  const githubImport = { ok: true, imported: [skill] } as GitHubSkillImportResult;
  const localPreview = { source: { provider: 'local' }, skills: [], warnings: [], truncated: false } as unknown as LocalSkillPreview;
  const localImport = { ok: true, imported: [skill] } as LocalSkillImportResponse;
  const updatePreview = { hasUpdates: false } as GitHubSkillUpdatePreview;
  return {
    getLocale: vi.fn(() => 'zh-CN' as const),
    getAllSkills: vi.fn(async () => [skill]),
    getSkillLibrary: vi.fn(async () => [skill]),
    getAllSkillSources: vi.fn(async () => []),
    saveSkill: vi.fn(async () => undefined),
    deleteSkill: vi.fn(async () => undefined),
    setSkillEnabled: vi.fn(async () => undefined),
    setSkillsEnabled: vi.fn(async () => undefined),
    previewGitHubSkillSource: vi.fn(async () => githubPreview),
    importGitHubSkillSource: vi.fn(async () => githubImport),
    previewLocalSkillSource: vi.fn(async () => localPreview),
    pickLocalSkillFolder: vi.fn(async () => '/picked'),
    importLocalSkillSource: vi.fn(async () => localImport),
    updateLocalSkillSource: vi.fn(async () => localImport),
    relocateLocalSkillSource: vi.fn(async () => localImport),
    checkGitHubSkillSourceUpdates: vi.fn(async () => updatePreview),
    updateGitHubSkillSource: vi.fn(async () => githubImport),
    deleteGitHubSkillSource: vi.fn(async () => undefined),
    broadcastStateUpdate: vi.fn(async () => undefined),
  };
}

function createLibraryDependencies(): LibraryRuntimeHandlerDependencies {
  return {
    getAllPresets: vi.fn(async () => [preset]),
    savePreset: vi.fn(async () => undefined),
    deletePreset: vi.fn(async () => undefined),
    setActivePresetId: vi.fn(async () => undefined),
    getActivePreset: vi.fn(async () => preset),
    getPromptInjectionSettings: vi.fn(async () => ({
      memoryEnabled: true,
      systemPromptEnabled: true,
      presetCadence: 'default' as const,
      forceResponseLanguage: 'auto' as const,
    })),
    savePromptInjectionSettings: vi.fn(async (settings) => ({
      memoryEnabled: settings.memoryEnabled !== false,
      systemPromptEnabled: settings.systemPromptEnabled !== false,
      presetCadence: settings.presetCadence ?? ('default' as const),
      forceResponseLanguage: settings.forceResponseLanguage ?? ('auto' as const),
    })),
    getSkillAutoActivationSettings: vi.fn(async () => ({ firstMessage: true, everyMessage: false })),
    saveSkillAutoActivationSettings: vi.fn(async (settings) => ({
      firstMessage: settings.firstMessage !== false,
      everyMessage: settings.everyMessage === true && settings.firstMessage !== false,
    })),
    getAllSavedItems: vi.fn(async () => [savedItem]),
    saveSavedItem: vi.fn(async () => savedItem),
    deleteSavedItem: vi.fn(async () => undefined),
    insertPromptIntoActiveZaiTab: vi.fn(async (text) => (
      text ? { ok: true as const } : { ok: false as const, error: 'empty_prompt_text' }
    )),
    broadcastStateUpdate: vi.fn(async () => undefined),
    broadcastSavedItemsUpdate: vi.fn(async () => undefined),
  };
}

function createLocalPreferenceDependencies(): LocalPreferenceRuntimeHandlerDependencies {
  return {
    broadcastStateUpdate: vi.fn(async () => undefined),
    getBackgroundConfig: vi.fn(async () => null),
    saveBackgroundConfig: vi.fn(async () => undefined),
    clearBackgroundConfig: vi.fn(async () => undefined),
    broadcastBackgroundUpdate: vi.fn(async () => undefined),
  };
}

function dispatch(
  handlers: readonly RuntimeCommandHandler[],
  message: { type: string; payload?: unknown },
): Promise<unknown> {
  const handler = handlers.find((candidate) => candidate.type === message.type);
  if (!handler) throw new Error(`Handler not found: ${message.type}`);
  return handler.handle(message, context);
}

function completeTypedHandlers(
  handlers: readonly RuntimeCommandHandler[],
): RuntimeCommandHandler[] {
  const provided = new Set<string>(handlers.map((handler) => handler.type));
  const stubs = TYPED_RUNTIME_COMMAND_TYPES
    .filter((type) => !provided.has(type))
    .map((type) => ({
      type,
      handle: async () => null,
    } as unknown as RuntimeCommandHandler));
  return [...handlers, ...stubs];
}

function readInventoryCommands(heading: string): string[] {
  const source = readFileSync('docs/compatibility/runtime-command-inventory.md', 'utf8');
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = source.match(
    new RegExp(`### ${escaped}[^\\n]*\\n\\n` + '```text\\n([\\s\\S]*?)\\n```'),
  )?.[1];
  if (!block) throw new Error(`Inventory block not found: ${heading}`);
  return block.split('\n').filter(Boolean);
}