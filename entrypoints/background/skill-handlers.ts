import type { SupportedLocale } from '../../core/i18n';
import {
  definePayloadlessRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import type {
  GitHubSkillImportRequest,
  GitHubSkillImportResult,
  GitHubSkillPreview,
  GitHubSkillUpdatePreview,
  LocalSkillImportRequest,
  LocalSkillImportResponse,
  LocalSkillPreview,
  SaveSkillPayload,
  Skill,
  SkillImportSource,
} from '../../core/types';
import {
  definePersistencePayloadRuntimeCommandHandler,
} from './runtime-handler';

export interface SkillRuntimeHandlerDependencies {
  getLocale(): SupportedLocale;
  getAllSkills(locale: SupportedLocale): Promise<Skill[]>;
  getSkillLibrary(locale: SupportedLocale): Promise<Skill[]>;
  getAllSkillSources(): Promise<SkillImportSource[]>;
  saveSkill(skill: Skill, previousName?: string): Promise<void>;
  deleteSkill(name: string): Promise<void>;
  setSkillEnabled(name: string, enabled: boolean): Promise<void>;
  setSkillsEnabled(updates: Array<{ name: string; enabled: boolean }>): Promise<void>;
  previewGitHubSkillSource(url: string): Promise<GitHubSkillPreview>;
  importGitHubSkillSource(request: GitHubSkillImportRequest): Promise<GitHubSkillImportResult>;
  previewLocalSkillSource(rootPath: string): Promise<LocalSkillPreview>;
  /** 返回 `null` = 用户点了取消（**不是失败**，不应当走错误通道）。 */
  pickLocalSkillFolder(defaultPath?: string): Promise<string | null>;
  importLocalSkillSource(request: LocalSkillImportRequest): Promise<LocalSkillImportResponse>;
  updateLocalSkillSource(sourceId: string): Promise<LocalSkillImportResponse>;
  relocateLocalSkillSource(sourceId: string, newRootPath: string): Promise<LocalSkillImportResponse>;
  checkGitHubSkillSourceUpdates(sourceId: string): Promise<GitHubSkillUpdatePreview>;
  updateGitHubSkillSource(sourceId: string): Promise<GitHubSkillImportResult>;
  deleteGitHubSkillSource(sourceId: string): Promise<void>;
  /**
   * 通知各上下文「技能状态已提交」。
   *
   * ⚠️⚠️ **`notify*` 而不是 `broadcast*`：它是尽力通知** —— 广播失败被吞掉并上报，
   * 不会把一次**已经落库成功**的写入变成失败响应。广播的第一步要读五路状态
   * （记忆 / 技能 / 预设 / 提示词设置 / 自动激活），任何一路读失败（例如记忆库里有
   * 一条坏记录）都会让那次读抛错；若直接 `await` 它，用户会看到「保存技能失败」，
   * 而技能其实已经存进去了 —— 重试还会因重名再失败一次。
   */
  notifyStateCommitted(excludeTabId?: number): Promise<void>;
}

export function createSkillRuntimeHandlers(
  dependencies: SkillRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    definePayloadlessRuntimeCommandHandler('GET_SKILLS', () => (
      dependencies.getAllSkills(dependencies.getLocale())
    )),
    definePayloadlessRuntimeCommandHandler('GET_SKILL_LIBRARY', () => (
      dependencies.getSkillLibrary(dependencies.getLocale())
    )),
    definePayloadlessRuntimeCommandHandler('GET_SKILL_SOURCES', () => (
      dependencies.getAllSkillSources()
    )),
    definePayloadlessRuntimeCommandHandler('GET_GITHUB_SKILL_SOURCES', async () => (
      (await dependencies.getAllSkillSources()).filter((source) => source.provider === 'github')
    )),
    definePersistencePayloadRuntimeCommandHandler('SAVE_SKILL', async (payload, context) => {
      const { skill, previousName } = splitSaveSkillPayload(payload);
      await dependencies.saveSkill(skill, previousName);
      await dependencies.notifyStateCommitted(context.tabId);
      return { ok: true as const };
    }),
    definePersistencePayloadRuntimeCommandHandler('DELETE_SKILL', async (payload, context) => {
      await dependencies.deleteSkill(payload.name);
      await dependencies.notifyStateCommitted(context.tabId);
      return { ok: true as const };
    }),
    definePersistencePayloadRuntimeCommandHandler('SET_SKILL_ENABLED', async (payload, context) => {
      await dependencies.setSkillEnabled(payload.name, payload.enabled);
      await dependencies.notifyStateCommitted(context.tabId);
      return { ok: true as const };
    }),
    definePersistencePayloadRuntimeCommandHandler('SET_SKILLS_ENABLED', async (payload, context) => {
      await dependencies.setSkillsEnabled(payload.updates);
      await dependencies.notifyStateCommitted(context.tabId);
      return { ok: true as const };
    }),
    definePersistencePayloadRuntimeCommandHandler('PREVIEW_GITHUB_SKILL_SOURCE', (payload) => (
      dependencies.previewGitHubSkillSource(payload.url)
    )),
    definePersistencePayloadRuntimeCommandHandler('IMPORT_GITHUB_SKILL_SOURCE', async (request, context) => {
      const result = await dependencies.importGitHubSkillSource(request);
      await dependencies.notifyStateCommitted(context.tabId);
      return result;
    }),
    definePersistencePayloadRuntimeCommandHandler('PREVIEW_LOCAL_SKILL_SOURCE', (payload) => (
      dependencies.previewLocalSkillSource(payload.rootPath)
    )),
    definePersistencePayloadRuntimeCommandHandler('PICK_LOCAL_SKILL_FOLDER', async (payload) => ({
      path: await dependencies.pickLocalSkillFolder(payload?.defaultPath),
    })),
    definePersistencePayloadRuntimeCommandHandler('IMPORT_LOCAL_SKILL_SOURCE', async (request, context) => {
      const result = await dependencies.importLocalSkillSource(request);
      if (!result.ok) return result;
      await dependencies.notifyStateCommitted(context.tabId);
      return result;
    }),
    definePersistencePayloadRuntimeCommandHandler('UPDATE_LOCAL_SKILL_SOURCE', async (payload, context) => {
      const result = await dependencies.updateLocalSkillSource(payload.sourceId);
      if (!result.ok) return result;
      await dependencies.notifyStateCommitted(context.tabId);
      return result;
    }),
    definePersistencePayloadRuntimeCommandHandler('RELOCATE_LOCAL_SKILL_SOURCE', async (payload, context) => {
      const result = await dependencies.relocateLocalSkillSource(payload.sourceId, payload.newRootPath);
      if (!result.ok) return result;
      await dependencies.notifyStateCommitted(context.tabId);
      return result;
    }),
    definePersistencePayloadRuntimeCommandHandler('CHECK_GITHUB_SKILL_SOURCE_UPDATES', (payload) => (
      dependencies.checkGitHubSkillSourceUpdates(payload.sourceId)
    )),
    definePersistencePayloadRuntimeCommandHandler('UPDATE_GITHUB_SKILL_SOURCE', async (payload, context) => {
      const result = await dependencies.updateGitHubSkillSource(payload.sourceId);
      await dependencies.notifyStateCommitted(context.tabId);
      return result;
    }),
    definePersistencePayloadRuntimeCommandHandler('DELETE_GITHUB_SKILL_SOURCE', async (payload, context) => {
      await dependencies.deleteGitHubSkillSource(payload.sourceId);
      await dependencies.notifyStateCommitted(context.tabId);
      return { ok: true as const };
    }),
  ]);
}

function splitSaveSkillPayload(payload: SaveSkillPayload): {
  skill: Skill;
  previousName?: string;
} {
  if ('skill' in payload) {
    return {
      skill: payload.skill,
      previousName: payload.previousName,
    };
  }
  return { skill: payload };
}
