import type {
  BackgroundConfig,
  GitHubSkillImportResult,
  GitHubSkillPreview,
  GitHubSkillSource,
  GitHubSkillUpdatePreview,
  LocalSkillImportResponse,
  LocalSkillPreview,
  Memory,
  MessageAction,
  SavedItem,
  Skill,
  SkillImportSource,
  SystemPromptPreset,
} from '../types';
import type { PromptInjectionSettings } from '../prompt/settings';
import type { SkillAutoActivationSettings } from '../skill/auto-activation-settings';

type DeclaredRuntimeRequest<TType extends MessageAction['type']> = Extract<
  MessageAction,
  { type: TType }
>;

type Ack = { ok: true };
type DomainFailure = { ok: false; error: string };

export interface PersistenceRuntimeCommandContracts {
  GET_MEMORIES: {
    request: DeclaredRuntimeRequest<'GET_MEMORIES'>;
    response: Memory[];
  };
  GET_MEMORY_BY_ID: {
    request: DeclaredRuntimeRequest<'GET_MEMORY_BY_ID'>;
    response: Memory | null;
  };
  SAVE_MEMORY: {
    request: DeclaredRuntimeRequest<'SAVE_MEMORY'>;
    response: { id: number };
  };
  IMPORT_MEMORY_DRAFTS: {
    request: DeclaredRuntimeRequest<'IMPORT_MEMORY_DRAFTS'>;
    response: { ok: true; ids: number[]; count: number } | DomainFailure;
  };
  UPDATE_MEMORY: {
    request: DeclaredRuntimeRequest<'UPDATE_MEMORY'>;
    response: Ack;
  };
  DELETE_MEMORY: {
    request: DeclaredRuntimeRequest<'DELETE_MEMORY'>;
    response: Ack;
  };
  TOUCH_MEMORIES: {
    request: { type: 'TOUCH_MEMORIES'; payload: { ids: number[] } };
    response: Ack;
  };
  CLEAR_MEMORIES: {
    request: { type: 'CLEAR_MEMORIES' };
    response: Ack;
  };
  GET_SKILLS: {
    request: DeclaredRuntimeRequest<'GET_SKILLS'>;
    response: Skill[];
  };
  GET_SKILL_LIBRARY: {
    request: DeclaredRuntimeRequest<'GET_SKILL_LIBRARY'>;
    response: Skill[];
  };
  GET_SKILL_SOURCES: {
    request: DeclaredRuntimeRequest<'GET_SKILL_SOURCES'>;
    response: SkillImportSource[];
  };
  GET_GITHUB_SKILL_SOURCES: {
    request: DeclaredRuntimeRequest<'GET_GITHUB_SKILL_SOURCES'>;
    response: GitHubSkillSource[];
  };
  SAVE_SKILL: {
    request: DeclaredRuntimeRequest<'SAVE_SKILL'>;
    response: Ack;
  };
  DELETE_SKILL: {
    request: DeclaredRuntimeRequest<'DELETE_SKILL'>;
    response: Ack;
  };
  SET_SKILL_ENABLED: {
    request: DeclaredRuntimeRequest<'SET_SKILL_ENABLED'>;
    response: Ack;
  };
  SET_SKILLS_ENABLED: {
    request: DeclaredRuntimeRequest<'SET_SKILLS_ENABLED'>;
    response: Ack;
  };
  PREVIEW_GITHUB_SKILL_SOURCE: {
    request: DeclaredRuntimeRequest<'PREVIEW_GITHUB_SKILL_SOURCE'>;
    response: GitHubSkillPreview;
  };
  IMPORT_GITHUB_SKILL_SOURCE: {
    request: DeclaredRuntimeRequest<'IMPORT_GITHUB_SKILL_SOURCE'>;
    response: GitHubSkillImportResult;
  };
  PREVIEW_LOCAL_SKILL_SOURCE: {
    request: DeclaredRuntimeRequest<'PREVIEW_LOCAL_SKILL_SOURCE'>;
    response: LocalSkillPreview;
  };
  PICK_LOCAL_SKILL_FOLDER: {
    request: DeclaredRuntimeRequest<'PICK_LOCAL_SKILL_FOLDER'>;
    /**
     * `path` 为 `null` = **用户点了取消**，不是失败。
     *
     * ⚠️ 取消与失败必须分得开：失败要走错误通道并显示原因，取消应当什么都不做
     * （用户已经知道自己取消了）。把两者压成一个「没拿到路径」，界面就会对着
     * 一次取消说「原文件夹已挪动或不存在」。
     */
    response: { path: string | null };
  };
  IMPORT_LOCAL_SKILL_SOURCE: {
    request: DeclaredRuntimeRequest<'IMPORT_LOCAL_SKILL_SOURCE'>;
    response: LocalSkillImportResponse;
  };
  UPDATE_LOCAL_SKILL_SOURCE: {
    request: DeclaredRuntimeRequest<'UPDATE_LOCAL_SKILL_SOURCE'>;
    response: LocalSkillImportResponse;
  };
  RELOCATE_LOCAL_SKILL_SOURCE: {
    request: DeclaredRuntimeRequest<'RELOCATE_LOCAL_SKILL_SOURCE'>;
    response: LocalSkillImportResponse;
  };
  CHECK_GITHUB_SKILL_SOURCE_UPDATES: {
    request: DeclaredRuntimeRequest<'CHECK_GITHUB_SKILL_SOURCE_UPDATES'>;
    response: GitHubSkillUpdatePreview;
  };
  UPDATE_GITHUB_SKILL_SOURCE: {
    request: DeclaredRuntimeRequest<'UPDATE_GITHUB_SKILL_SOURCE'>;
    response: GitHubSkillImportResult;
  };
  DELETE_GITHUB_SKILL_SOURCE: {
    request: DeclaredRuntimeRequest<'DELETE_GITHUB_SKILL_SOURCE'>;
    response: Ack;
  };
  GET_PRESETS: {
    request: DeclaredRuntimeRequest<'GET_PRESETS'>;
    response: SystemPromptPreset[];
  };
  SAVE_PRESET: {
    request: DeclaredRuntimeRequest<'SAVE_PRESET'>;
    response: Ack;
  };
  DELETE_PRESET: {
    request: DeclaredRuntimeRequest<'DELETE_PRESET'>;
    response: Ack;
  };
  SET_ACTIVE_PRESET: {
    request: DeclaredRuntimeRequest<'SET_ACTIVE_PRESET'>;
    response: Ack;
  };
  GET_ACTIVE_PRESET: {
    request: DeclaredRuntimeRequest<'GET_ACTIVE_PRESET'>;
    response: SystemPromptPreset | null;
  };
  GET_PROMPT_INJECTION_SETTINGS: {
    request: DeclaredRuntimeRequest<'GET_PROMPT_INJECTION_SETTINGS'>;
    response: PromptInjectionSettings;
  };
  SAVE_PROMPT_INJECTION_SETTINGS: {
    request: DeclaredRuntimeRequest<'SAVE_PROMPT_INJECTION_SETTINGS'>;
    response: PromptInjectionSettings;
  };
  GET_SKILL_AUTO_ACTIVATION_SETTINGS: {
    request: DeclaredRuntimeRequest<'GET_SKILL_AUTO_ACTIVATION_SETTINGS'>;
    response: SkillAutoActivationSettings;
  };
  SAVE_SKILL_AUTO_ACTIVATION_SETTINGS: {
    request: DeclaredRuntimeRequest<'SAVE_SKILL_AUTO_ACTIVATION_SETTINGS'>;
    response: SkillAutoActivationSettings;
  };
  GET_SAVED_ITEMS: {
    request: DeclaredRuntimeRequest<'GET_SAVED_ITEMS'>;
    response: SavedItem[];
  };
  SAVE_SAVED_ITEM: {
    request: DeclaredRuntimeRequest<'SAVE_SAVED_ITEM'>;
    response: SavedItem;
  };
  DELETE_SAVED_ITEM: {
    request: DeclaredRuntimeRequest<'DELETE_SAVED_ITEM'>;
    response: Ack;
  };
  INSERT_SAVED_PROMPT_INTO_CHAT: {
    request: DeclaredRuntimeRequest<'INSERT_SAVED_PROMPT_INTO_CHAT'>;
    response: Ack | DomainFailure;
  };
  GET_BACKGROUND: {
    request: DeclaredRuntimeRequest<'GET_BACKGROUND'>;
    response: BackgroundConfig | null;
  };
  SAVE_BACKGROUND: {
    request: DeclaredRuntimeRequest<'SAVE_BACKGROUND'>;
    response: Ack;
  };
  CLEAR_BACKGROUND: {
    request: DeclaredRuntimeRequest<'CLEAR_BACKGROUND'>;
    response: Ack;
  };
}
