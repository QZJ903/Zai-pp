import {
  definePayloadlessRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import type {
  SavedItem,
  SavedItemInput,
  SystemPromptPreset,
} from '../../core/types';
import type { PromptInjectionSettings } from '../../core/prompt/settings';
import type { SkillAutoActivationSettings } from '../../core/skill/auto-activation-settings';
import {
  definePersistencePayloadRuntimeCommandHandler,
} from './runtime-handler';

type AckOrFailure = { ok: true } | { ok: false; error: string };

export interface LibraryRuntimeHandlerDependencies {
  getAllPresets(): Promise<SystemPromptPreset[]>;
  savePreset(preset: SystemPromptPreset): Promise<void>;
  deletePreset(id: string): Promise<void>;
  setActivePresetId(id: string | null): Promise<void>;
  getActivePreset(): Promise<SystemPromptPreset | null>;
  getPromptInjectionSettings(): Promise<PromptInjectionSettings>;
  savePromptInjectionSettings(settings: Partial<PromptInjectionSettings>): Promise<PromptInjectionSettings>;
  getSkillAutoActivationSettings(): Promise<SkillAutoActivationSettings>;
  saveSkillAutoActivationSettings(settings: Partial<SkillAutoActivationSettings>): Promise<SkillAutoActivationSettings>;
  getAllSavedItems(): Promise<SavedItem[]>;
  saveSavedItem(input: SavedItemInput): Promise<SavedItem>;
  deleteSavedItem(id: string): Promise<void>;
  insertPromptIntoActiveZaiTab(text: string): Promise<AckOrFailure>;
  /**
   * 尽力通知「预设 / 提示词设置」已提交。
   *
   * ⚠️⚠️ **`notify*` 而不是 `broadcast*`：广播失败被吞掉并上报，不会把一次已经落库
   * 成功的写入变成失败响应。** 广播的第一步要读五路状态，任何一路读失败都会让那次
   * 读抛错 —— 直接 `await` 它会让用户看到「保存失败」而库里其实已经写好了。
   */
  notifyStateCommitted(excludeTabId?: number): Promise<void>;
  /** 尽力通知「收藏项」已提交。同样的失败方向，理由见上。 */
  notifySavedItemsCommitted(excludeTabId?: number): Promise<void>;
}

export function createLibraryRuntimeHandlers(
  dependencies: LibraryRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    definePayloadlessRuntimeCommandHandler('GET_PRESETS', () => (
      dependencies.getAllPresets()
    )),
    definePersistencePayloadRuntimeCommandHandler('SAVE_PRESET', async (preset, context) => {
      await dependencies.savePreset(preset);
      await dependencies.notifyStateCommitted(context.tabId);
      return { ok: true as const };
    }),
    definePersistencePayloadRuntimeCommandHandler('DELETE_PRESET', async (payload, context) => {
      await dependencies.deletePreset(payload.id);
      await dependencies.notifyStateCommitted(context.tabId);
      return { ok: true as const };
    }),
    definePersistencePayloadRuntimeCommandHandler('SET_ACTIVE_PRESET', async (payload, context) => {
      await dependencies.setActivePresetId(payload.id);
      await dependencies.notifyStateCommitted(context.tabId);
      return { ok: true as const };
    }),
    definePayloadlessRuntimeCommandHandler('GET_ACTIVE_PRESET', () => (
      dependencies.getActivePreset()
    )),
    definePayloadlessRuntimeCommandHandler('GET_PROMPT_INJECTION_SETTINGS', () => (
      dependencies.getPromptInjectionSettings()
    )),
    definePersistencePayloadRuntimeCommandHandler('SAVE_PROMPT_INJECTION_SETTINGS', async (settings, context) => {
      const saved = await dependencies.savePromptInjectionSettings(settings);
      await dependencies.notifyStateCommitted(context.tabId);
      return saved;
    }),
    definePayloadlessRuntimeCommandHandler('GET_SKILL_AUTO_ACTIVATION_SETTINGS', () => (
      dependencies.getSkillAutoActivationSettings()
    )),
    definePersistencePayloadRuntimeCommandHandler('SAVE_SKILL_AUTO_ACTIVATION_SETTINGS', async (settings, context) => {
      const saved = await dependencies.saveSkillAutoActivationSettings(settings);
      await dependencies.notifyStateCommitted(context.tabId);
      return saved;
    }),
    definePayloadlessRuntimeCommandHandler('GET_SAVED_ITEMS', () => (
      dependencies.getAllSavedItems()
    )),
    definePersistencePayloadRuntimeCommandHandler('SAVE_SAVED_ITEM', async (input, context) => {
      const item = await dependencies.saveSavedItem(input);
      await dependencies.notifySavedItemsCommitted(context.tabId);
      return item;
    }),
    definePersistencePayloadRuntimeCommandHandler('DELETE_SAVED_ITEM', async (payload, context) => {
      await dependencies.deleteSavedItem(payload.id);
      await dependencies.notifySavedItemsCommitted(context.tabId);
      return { ok: true as const };
    }),
    definePersistencePayloadRuntimeCommandHandler('INSERT_SAVED_PROMPT_INTO_CHAT', (payload) => (
      dependencies.insertPromptIntoActiveZaiTab(
        typeof payload?.text === 'string' ? payload.text : '',
      )
    )),
  ]);
}
