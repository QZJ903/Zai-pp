import type { GitHubSkillSource, LocalSkillSource, Skill, SkillImportSource } from '../types';
import { DEFAULT_LOCALE, type SupportedLocale } from '../i18n/background';
import { withSyncLocalStateLock } from '../persistence/local-state-lock';
import {
  createChromeStorageSlot,
  createVersionedRepository,
} from '../persistence/versioned-repository';
import { BUILTIN_SKILLS, getLocalizedBuiltinSkills } from './builtin';
import { slugifySkillName } from './slug';
import {
  decodeGitHubSkillSource,
  decodeSkillImportSource,
  decodeSkillSourceCollection,
  decodeUserSkill,
  skillSourceCollectionCodec,
  userSkillCollectionCodec,
} from './codec';

export const SKILLS_STORAGE_KEY = 'zai_pp_skills';
export const SKILL_SOURCES_STORAGE_KEY = 'zai_pp_skill_sources';

const userSkillRepository = createVersionedRepository({
  label: 'skills',
  createDefault: () => [],
  codec: userSkillCollectionCodec,
  storage: createChromeStorageSlot(SKILLS_STORAGE_KEY),
});

const skillSourceRepository = createVersionedRepository({
  label: 'skillSources',
  createDefault: () => [],
  codec: skillSourceCollectionCodec,
  storage: createChromeStorageSlot(SKILL_SOURCES_STORAGE_KEY),
});

export interface ImportedSkillMutationResult {
  imported: Skill[];
  replaced: number;
  renamed: number;
}

export type SkillCollisionCandidate = Pick<Skill, 'name' | 'source' | 'enabled' | 'remote'>;

export async function getAllSkills(
  options: { includeDisabled?: boolean; locale?: SupportedLocale } = {},
): Promise<Skill[]> {
  const userSkills = await getUserSkills();
  const skills = [
    ...getLocalizedBuiltinSkills(options.locale ?? DEFAULT_LOCALE),
    ...userSkills,
  ];
  if (options.includeDisabled) return skills;
  return skills.filter((skill) => skill.enabled !== false);
}

export async function getSkillLibrary(locale: SupportedLocale = DEFAULT_LOCALE): Promise<Skill[]> {
  return getAllSkills({ includeDisabled: true, locale });
}

export async function getSkillCollisionCandidates(): Promise<SkillCollisionCandidate[]> {
  const userSkills = await getUserSkills();
  return [
    ...BUILTIN_SKILLS.map(({ name, source }) => ({ name, source })),
    ...userSkills.map(({ name, source, enabled, remote }) => ({ name, source, enabled, remote })),
  ];
}

export async function getUserSkills(): Promise<Skill[]> {
  return userSkillRepository.read();
}

export async function getUserSkillsAlreadyLocked(): Promise<Skill[]> {
  return userSkillRepository.readAlreadyLocked();
}

export async function saveSkill(skill: Skill, previousName?: string): Promise<void> {
  await withSyncLocalStateLock(async () => {
    if (previousName !== undefined) requireNonEmptyString(previousName, 'Skill previousName');
    const incomingSkill = decodeUserSkill({
      ...skill,
      source: 'custom',
      enabled: skill.enabled === undefined ? true : skill.enabled,
    }, 'skill');
    const userSkills = await getUserSkillsAlreadyLocked();
    /**
     * ⚠️⚠️ **名字在整个技能库里必须唯一，不能只跟 custom 那一档比。**
     *
     * 名字是**身份**：激活走 `/name`，`resolveSkills` 只按名字取第一条
     * （列表顺序 builtin → custom → remote），同名时后面的那条**永远调不到**。
     *
     * 判重分两步：
     * ① **builtin / remote 占用的名字一律拒绝** —— 它们不在本次替换范围内，
     *    写进去就是造出一条重名（`previousName` 除外：那条是**正在被替换的自己**）；
     * ② **custom 里同名的那条属于「替换」而不是「冲突」** —— 这是
     *    「按名字 upsert」的既有语义（保存技能草稿就靠它）。
     *    同名 custom 多于一条时由下面的 `matchingIndexes` 判 ambiguous。
     */
    const replacedName = previousName ?? null;
    const collides = [...BUILTIN_SKILLS, ...userSkills].some((candidate) => (
      candidate.source !== 'custom'
      && candidate.name === incomingSkill.name
      && candidate.name !== replacedName
    ));
    if (collides) {
      throw new Error(`Skill name is already used: ${incomingSkill.name}`);
    }
    const custom = userSkills.filter((s) => s.source === 'custom');
    const namesToReplace = new Set<string>([incomingSkill.name]);
    if (previousName) namesToReplace.add(previousName);
    const matchingIndexes = custom
      .map((item, index) => namesToReplace.has(item.name) ? index : -1)
      .filter((index) => index >= 0);
    if (matchingIndexes.length > 1) {
      throw new Error('Skill edit is ambiguous because multiple custom Skills use the same name');
    }
    const insertIndex = matchingIndexes[0] ?? -1;
    const next = custom.filter((s) => !namesToReplace.has(s.name));
    const remote = userSkills.filter((s) => s.source === 'remote');
    const existingSkill = insertIndex >= 0 ? custom[insertIndex] : undefined;
    const savedSkill = decodeUserSkill({
      ...existingSkill,
      ...incomingSkill,
      source: 'custom',
      enabled: incomingSkill.enabled !== false,
    }, 'skill');

    if (insertIndex >= 0) {
      next.splice(Math.min(insertIndex, next.length), 0, savedSkill);
    } else {
      next.push(savedSkill);
    }
    await userSkillRepository.writeAfterReadAlreadyLocked([...next, ...remote]);
  });
}

export async function stageDeleteSkillAlreadyLocked(
  name: string,
): Promise<() => Promise<void>> {
  requireNonEmptyString(name, 'Skill name');
  const [userSkills, sources] = await Promise.all([
    getUserSkillsAlreadyLocked(),
    getAllSkillSourcesAlreadyLocked(),
  ]);
  const removedSkills = userSkills.filter((skill) => skill.name === name);
  /**
   * ⚠️⚠️ **重名时必须拒绝删除，不能「按名字全删」。**
   *
   * 落库顺序是 builtin → custom → remote，而删除只按名字匹配 ⇒ 重名时
   * 一次会删掉**多条**，并且把 remote 那条从它所属 source 的
   * `skillPaths` / `importedSkillNames` 里一并摘掉（等于「删一个自建技能，
   * 把导入技能也删了」）。`saveSkill` 现在会拒绝产生新的重名，但**已有的**重名
   * 数据仍可能存在于本机，这里必须给一个明确的失败而不是静默误删。
   */
  if (removedSkills.length > 1) {
    throw new Error(`Skill name matches multiple records and cannot be deleted safely: ${name}`);
  }
  const nextSkills = userSkills.filter((skill) => skill.name !== name);
  const nextSources = removedSkills.reduce((current, skill) => (
    skill.source === 'remote' && skill.remote
      ? removeSkillFromSources(current, skill.remote.sourceId, skill.remote.path, skill.name)
      : current
  ), sources);

  return async () => {
    if (nextSkills.length !== userSkills.length) {
      await userSkillRepository.writeAfterReadAlreadyLocked(nextSkills);
    }
    if (nextSources !== sources) {
      await skillSourceRepository.writeAfterReadAlreadyLocked(nextSources);
    }
  };
}

export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  await setSkillsEnabled([{ name, enabled }]);
}

export async function setSkillsEnabled(updates: Array<{ name: string; enabled: boolean }>): Promise<void> {
  if (updates.length === 0) return;
  for (const update of updates) {
    requireNonEmptyString(update.name, 'Skill name');
    if (typeof update.enabled !== 'boolean') throw new Error('Skill enabled must be a boolean');
  }

  await withSyncLocalStateLock(() => setSkillsEnabledUnlocked(updates));
}

async function setSkillsEnabledUnlocked(updates: Array<{ name: string; enabled: boolean }>): Promise<void> {
  const updateByName = new Map<string, boolean>();
  for (const update of updates) {
    updateByName.set(update.name, update.enabled);
  }

  const userSkills = await getUserSkillsAlreadyLocked();
  /**
   * ⚠️ **重名时拒绝开关，不能「按名字全改」。**
   *
   * 界面上每条技能是一张独立的卡片，用户点其中一张的开关时预期只有它变。
   * 而落库顺序是 builtin → custom → remote、开关只按名字匹配 ⇒ 重名时一次改掉多条，
   * 用户看到的是「我点了 A，B 也跟着变了」。`saveSkill` 现在会拒绝产生新的重名，
   * 这条守的是**已经在库里的**重名数据。
   */
  for (const name of updateByName.keys()) {
    const matches = userSkills.filter((skill) => skill.name === name);
    if (matches.length > 1) {
      throw new Error(`Skill name matches multiple records and cannot be toggled safely: ${name}`);
    }
  }
  let userSkillsChanged = false;
  const matchedNames = new Set<string>();
  const next = userSkills.map((skill) => {
    if (!updateByName.has(skill.name)) return skill;
    const enabled = updateByName.get(skill.name) ?? true;
    matchedNames.add(skill.name);
    userSkillsChanged = true;
    return { ...skill, enabled };
  });
  for (const name of matchedNames) updateByName.delete(name);

  if (!userSkillsChanged) return;
  await userSkillRepository.writeAfterReadAlreadyLocked(next);
}

export async function getAllSkillSources(): Promise<SkillImportSource[]> {
  return skillSourceRepository.read();
}

export async function getAllSkillSourcesAlreadyLocked(): Promise<SkillImportSource[]> {
  return skillSourceRepository.readAlreadyLocked();
}

export async function getSkillSourceById(sourceId: string): Promise<SkillImportSource | null> {
  requireNonEmptyString(sourceId, 'Skill source id');
  const sources = await getAllSkillSources();
  return findUniqueSourceById(sources, sourceId);
}

export async function getGitHubSkillSourceById(sourceId: string): Promise<GitHubSkillSource | null> {
  const source = await getSkillSourceById(sourceId);
  return source?.provider === 'github' ? source : null;
}

export async function updateGitHubSkillSourceLastCheckedAt(
  sourceId: string,
  lastCheckedAt: number,
): Promise<GitHubSkillSource> {
  requireNonEmptyString(sourceId, 'Skill source id');
  if (!Number.isFinite(lastCheckedAt)) throw new Error('Skill source lastCheckedAt must be finite');
  return withSyncLocalStateLock(async () => {
    const sources = await getAllSkillSourcesAlreadyLocked();
    const source = findUniqueSourceById(sources, sourceId);
    if (!source || source.provider !== 'github') throw new Error('GitHub Skill source was not found');
    const index = sources.indexOf(source);
    const updated = decodeGitHubSkillSource({ ...source, lastCheckedAt }, 'skillSource');
    const next = [...sources];
    next[index] = updated;
    await skillSourceRepository.writeAfterReadAlreadyLocked(next);
    return updated;
  });
}

export async function stageUpsertGitHubSkillSourceAlreadyLocked(
  source: GitHubSkillSource,
  incomingSkills: Skill[],
  expectedSkillPaths?: readonly string[],
): Promise<() => Promise<ImportedSkillMutationResult>> {
  return stageUpsertImportedSkillSourceAlreadyLocked(source, incomingSkills, expectedSkillPaths);
}

export async function stageUpsertLocalSkillSourceAlreadyLocked(
  source: LocalSkillSource,
  incomingSkills: Skill[],
): Promise<() => Promise<ImportedSkillMutationResult>> {
  return stageUpsertImportedSkillSourceAlreadyLocked(source, incomingSkills);
}

async function stageUpsertImportedSkillSourceAlreadyLocked(
  source: SkillImportSource,
  incomingSkills: Skill[],
  expectedSkillPaths?: readonly string[],
): Promise<() => Promise<ImportedSkillMutationResult>> {
  const decodedSource = decodeSkillImportSource(source, 'skillSource');
  const decodedIncoming = incomingSkills.map((skill, index) => (
    decodeUserSkill(skill, `skills[${index}]`)
  ));
  for (const [index, skill] of decodedIncoming.entries()) {
    if (skill.source !== 'remote' || !skill.remote) {
      throw new Error(`skills[${index}] must be a remote Skill`);
    }
    if (skill.remote.sourceId !== decodedSource.id || skill.remote.provider !== decodedSource.provider) {
      throw new Error(`skills[${index}].remote does not match its Skill source`);
    }
  }
  const [existingUserSkills, existingSources] = await Promise.all([
    getUserSkillsAlreadyLocked(),
    getAllSkillSourcesAlreadyLocked(),
  ]);
  const existingSource = findUniqueSourceById(existingSources, decodedSource.id);
  if (expectedSkillPaths) {
    const currentSource = existingSource;
    if (!currentSource || currentSource.provider !== 'github' || !sameStrings(currentSource.skillPaths, expectedSkillPaths)) {
      throw new Error('GitHub Skill source changed while its update was loading; retry the update');
    }
  }

  const sourceSkills = existingUserSkills.filter(
    (skill) => skill.source === 'remote' && skill.remote?.sourceId === decodedSource.id,
  );
  const sourceSkillByPath = new Map(sourceSkills.map((skill) => [skill.remote?.path, skill]));
  const incomingPaths = new Set(decodedIncoming.map((skill) => skill.remote?.path).filter((path): path is string => Boolean(path)));
  const replaced = sourceSkills.filter((skill) => incomingPaths.has(skill.remote?.path ?? '')).length;

  const occupiedNames = new Set([
    ...BUILTIN_SKILLS.map((skill) => skill.name),
    ...existingUserSkills
      .filter((skill) => skill.remote?.sourceId !== decodedSource.id)
      .map((skill) => skill.name),
  ]);

  let renamed = 0;
  const imported = decodedIncoming.map((skill) => {
    const existing = sourceSkillByPath.get(skill.remote?.path);
    const preferredName = existing?.name ?? skill.name;
    const name = existing ? preferredName : createUniqueSkillName(preferredName, occupiedNames);
    if (!existing && name !== preferredName) renamed += 1;
    occupiedNames.add(name);
    return {
      ...existing,
      ...skill,
      name,
      source: 'remote' as const,
      enabled: existing?.enabled ?? skill.enabled ?? true,
      ...(skill.remote
        ? { remote: { ...existing?.remote, ...skill.remote } }
        : {}),
    };
  });

  const nextUserSkills = [
    ...existingUserSkills.filter((skill) => skill.remote?.sourceId !== decodedSource.id),
    ...imported,
  ];
  const nextSource: SkillImportSource = {
    ...existingSource,
    ...decodedSource,
    skillPaths: imported.map((skill) => skill.remote?.path).filter((path): path is string => Boolean(path)),
    importedSkillNames: imported.map((skill) => skill.name),
  };
  const nextSources = [
    ...existingSources.filter((item) => item.id !== decodedSource.id),
    nextSource,
  ];

  return async () => {
    await userSkillRepository.writeAfterReadAlreadyLocked(nextUserSkills);
    await skillSourceRepository.writeAfterReadAlreadyLocked(nextSources);
    return { imported, replaced, renamed };
  };
}

export async function stageDeleteSkillSourceAlreadyLocked(
  sourceId: string,
): Promise<() => Promise<void>> {
  requireNonEmptyString(sourceId, 'Skill source id');
  const [userSkills, sources] = await Promise.all([
    getUserSkillsAlreadyLocked(),
    getAllSkillSourcesAlreadyLocked(),
  ]);
  const nextSkills = userSkills.filter((skill) => skill.remote?.sourceId !== sourceId);
  const nextSources = sources.filter((source) => source.id !== sourceId);
  return async () => {
    await userSkillRepository.writeAfterReadAlreadyLocked(nextSkills);
    await skillSourceRepository.writeAfterReadAlreadyLocked(nextSources);
  };
}

function createUniqueSkillName(preferred: string, occupiedNames: Set<string>): string {
  const normalized = normalizeSkillName(preferred);
  if (!occupiedNames.has(normalized)) return normalized;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${normalized}-${suffix}`;
    if (!occupiedNames.has(candidate)) return candidate;
  }
  throw new Error(`Unable to generate a unique name for remote Skill: ${preferred}`);
}

function normalizeSkillName(name: string): string {
  const normalized = slugifySkillName(name);
  if (!normalized) throw new Error('Skill name cannot be empty');
  return normalized;
}

function removeSkillFromSources(
  sources: SkillImportSource[],
  sourceId: string,
  path: string,
  name: string,
): SkillImportSource[] {
  return sources
    .map((source) => {
      if (source.id !== sourceId) return source;
      return {
        ...source,
        skillPaths: source.skillPaths.filter((item) => item !== path),
        importedSkillNames: source.importedSkillNames.filter((item) => item !== name),
        updatedAt: Date.now(),
      };
    })
    .filter((source) => source.skillPaths.length > 0);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
}

function findUniqueSourceById(
  sources: SkillImportSource[],
  sourceId: string,
): SkillImportSource | null {
  const matches = sources.filter((source) => source.id === sourceId);
  if (matches.length > 1) {
    throw new Error(`Skill source mutation is ambiguous because the id is duplicated: ${sourceId}`);
  }
  return matches[0] ?? null;
}
