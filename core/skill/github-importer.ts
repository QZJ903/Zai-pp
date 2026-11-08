import type {
  GitHubSkillImportRequest,
  GitHubSkillImportResult,
  GitHubSkillPreview,
  GitHubSkillPreviewItem,
  GitHubSkillSource,
  GitHubSkillUpdatePreview,
  RemoteSkillFile,
  Skill,
} from '../types';
import type { LocalStateMutationRunner } from '../persistence/local-state-mutation';
import {
  getAllSkillSources,
  getGitHubSkillSourceById,
  getSkillCollisionCandidates,
  stageUpsertGitHubSkillSourceAlreadyLocked,
  updateGitHubSkillSourceLastCheckedAt,
  type SkillCollisionCandidate,
} from './registry';
import { requireSkillSlug } from './slug';
import { parentDirectory, parseSkillDoc as parseSkillDocShared, type ParsedSkillDoc } from './skill-doc';
import { utf8ByteLength } from '../tool/result-bytes';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com';
const MAX_SKILLS_PER_SOURCE = 80;
/** SKILL.md 的体积上限，单位 **UTF-8 字节**（与本地导入链同口径）。 */
const MAX_SKILL_BYTES = 120_000;
const MAX_RESOURCE_FILES_PER_SKILL = 16;
const MAX_RESOURCE_BYTES_PER_SKILL = 100_000;
const MAX_RESOURCE_FILE_BYTES = 40_000;
const REQUEST_TIMEOUT_MS = 20_000;

const TEXT_RESOURCE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.yaml',
  '.yml',
  '.json',
  '.tex',
]);

interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  mode: 'repo' | 'tree' | 'blob';
  ref?: string;
  path: string;
  refPathParts?: string[];
  url: string;
}

interface GitHubRepoResponse {
  full_name: string;
  html_url: string;
  default_branch: string;
  description?: string | null;
  license?: {
    key?: string | null;
    spdx_id?: string | null;
    name?: string | null;
  } | null;
}

interface GitHubCommitResponse {
  sha: string;
}

interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
  url: string;
}

interface GitHubTreeResponse {
  sha: string;
  truncated: boolean;
  tree: GitHubTreeEntry[];
}

interface LoadedGitHubSkill {
  item: GitHubSkillPreviewItem;
  skill: Skill;
}

interface LoadedGitHubSource {
  preview: GitHubSkillPreview;
  skills: LoadedGitHubSkill[];
}

interface ResourceBundle {
  included: Array<RemoteSkillFile & { content: string }>;
  omitted: RemoteSkillFile[];
  warnings: string[];
}

export async function previewGitHubSkillSource(url: string): Promise<GitHubSkillPreview> {
  return (await loadGitHubSkillSource(url)).preview;
}

export async function importGitHubSkillSource(
  request: GitHubSkillImportRequest,
  deps: LocalStateMutationRunner,
  options: { expectedSkillPaths?: readonly string[] } = {},
): Promise<GitHubSkillImportResult> {
  if (request.selectedPaths.length === 0) {
    throw new Error('Select at least one Skill before importing.');
  }

  // Paths the caller already holds (an update's previous selection) join the request's
  // own selection as pinned, so neither can be pushed past the preview cap.
  const knownPaths = options.expectedSkillPaths ?? request.selectedPaths;
  const loaded = await loadGitHubSkillSource(
    request.url,
    new Set(request.selectedPaths),
    new Set(knownPaths),
  );
  const selected = loaded.skills.filter((skill) => request.selectedPaths.includes(skill.item.path));
  const importedPaths = new Set(selected.map((skill) => skill.item.path));
  const missingPaths = request.selectedPaths.filter((path) => !importedPaths.has(path));
  if (missingPaths.length > 0) {
    throw new Error(`Selected Skill paths are missing from the GitHub source: ${missingPaths.join(', ')}`);
  }
  if (selected.length === 0) {
    throw new Error('Selected Skill paths are missing from the GitHub source.');
  }

  const now = Date.now();
  const source: GitHubSkillSource = {
    ...loaded.preview.source,
    skillPaths: selected.map((skill) => skill.item.path),
    importedSkillNames: selected.map((skill) => skill.skill.name),
    updatedAt: now,
    lastCheckedAt: now,
  };
  const incomingSkills = selected.map((loadedSkill) => ({
    ...loadedSkill.skill,
    remote: loadedSkill.skill.remote ? {
      ...loadedSkill.skill.remote,
      importedAt: loadedSkill.skill.remote.importedAt || now,
      updatedAt: now,
      lastCheckedAt: now,
    } : undefined,
  }));
  const result = await deps.runLocalStateMutation(() => (
    stageUpsertGitHubSkillSourceAlreadyLocked(
      source,
      incomingSkills,
      options.expectedSkillPaths,
    )
  ));

  return {
    ok: true,
    source: {
      ...source,
      importedSkillNames: result.imported.map((skill) => skill.name),
    },
    imported: result.imported,
    replaced: result.replaced,
    renamed: result.renamed,
    warnings: loaded.preview.warnings,
  };
}

export async function checkGitHubSkillSourceUpdates(sourceId: string): Promise<GitHubSkillUpdatePreview> {
  const source = await getGitHubSkillSourceById(sourceId);
  if (!source) throw new Error('GitHub Skill source not found.');

  const loaded = await loadGitHubSkillSource(source.url, undefined, new Set(source.skillPaths));
  const latestPaths = new Set(loaded.preview.skills.map((skill) => skill.path));
  const currentPaths = new Set(source.skillPaths);
  const missingPaths = source.skillPaths.filter((path) => !latestPaths.has(path));
  const newPaths = loaded.preview.skills
    .map((skill) => skill.path)
    .filter((path) => !currentPaths.has(path));
  const existingPaths = source.skillPaths.filter((path) => latestPaths.has(path));
  const hasCommitUpdates = loaded.preview.source.commitSha !== source.commitSha;
  const latestVersion = loaded.preview.source.packageVersion;
  const checkedAt = Date.now();
  const checkedSource = await updateGitHubSkillSourceLastCheckedAt(source.id, checkedAt);

  return {
    source: checkedSource,
    latestCommitSha: loaded.preview.source.commitSha,
    latestVersion,
    hasUpdates: hasCommitUpdates || missingPaths.length > 0 || newPaths.length > 0 || latestVersion !== source.packageVersion,
    changedPaths: hasCommitUpdates ? existingPaths : [],
    missingPaths,
    newPaths,
    warnings: loaded.preview.warnings,
    checkedAt,
  };
}

export async function updateGitHubSkillSource(
  sourceId: string,
  deps: LocalStateMutationRunner,
): Promise<GitHubSkillImportResult> {
  const source = await getGitHubSkillSourceById(sourceId);
  if (!source) throw new Error('GitHub Skill source not found.');

  const loaded = await loadGitHubSkillSource(source.url, undefined, new Set(source.skillPaths));
  const latestPaths = new Set(loaded.preview.skills.map((skill) => skill.path));
  const selectedPaths = source.skillPaths.filter((path) => latestPaths.has(path));
  if (selectedPaths.length === 0) {
    throw new Error('Upstream no longer contains any of the Skills this source imported, so the update was stopped to avoid clearing local content.');
  }
  return importGitHubSkillSource(
    { url: source.url, selectedPaths },
    deps,
    { expectedSkillPaths: source.skillPaths },
  );
}

async function loadGitHubSkillSource(
  url: string,
  selectedPaths?: Set<string>,
  pinnedPaths?: ReadonlySet<string>,
): Promise<LoadedGitHubSource> {
  const parsedUrl = parseGitHubUrl(url);
  const repo = await fetchGitHubJson<GitHubRepoResponse>(`/repos/${parsedUrl.owner}/${parsedUrl.repo}`);
  const resolved = await resolveSourceLocation(parsedUrl, repo.default_branch);
  const [tree, packageInfo] = await Promise.all([
    fetchGitHubJson<GitHubTreeResponse>(`/repos/${parsedUrl.owner}/${parsedUrl.repo}/git/trees/${encodeURIComponent(resolved.ref)}?recursive=1`),
    fetchPackageInfo(parsedUrl.owner, parsedUrl.repo, resolved.commit.sha),
  ]);
  const sourceId = createSourceId(parsedUrl.owner, parsedUrl.repo, resolved.ref, resolved.rootPath);
  const skillPaths = findSkillPaths(tree, resolved.rootPath, parsedUrl.mode);
  const warnings: string[] = [];

  if (tree.truncated) {
    warnings.push('GitHub returned a truncated repository tree, so some Skill files may be missing.');
  }
  if (skillPaths.length === 0) {
    throw new Error('No SKILL.md was found under this GitHub link.');
  }

  // **Pinned first, then cap.** A path the caller already holds must survive the
  // preview limit: upstream can grow past it, and an update that cannot see the
  // path would treat it as "no longer upstream" and delete it with the whole source
  // replacement. Same rule the Shell host preview applies (filter, then cap).
  const pinned = [...(pinnedPaths ?? [])].filter((path) => skillPaths.includes(path));
  const pinnedSet = new Set(pinned);
  const limitedPaths = [
    ...pinned,
    ...skillPaths
      .filter((path) => !pinnedSet.has(path))
      .slice(0, Math.max(0, MAX_SKILLS_PER_SOURCE - pinned.length)),
  ];

  // ⚠️ **Phrased after the cap is computed, not before.** With pinned paths the kept
  // set is no longer "the first N upstream" — the already-imported ones are kept
  // regardless of where they sort — so saying "the first N" would describe a rule
  // this code does not follow.
  if (limitedPaths.length < skillPaths.length) {
    warnings.push(
      pinned.length > 0
        ? `Found ${skillPaths.length} Skills; the preview caps at ${MAX_SKILLS_PER_SOURCE}, keeping the ${pinned.length} already-imported one(s) first.`
        : `Found ${skillPaths.length} Skills; only the first ${MAX_SKILLS_PER_SOURCE} are previewed.`,
    );
  }
  const now = Date.now();
  const source: GitHubSkillSource = {
    id: sourceId,
    provider: 'github',
    url: normalizeSourceUrl(parsedUrl.url),
    owner: parsedUrl.owner,
    repo: parsedUrl.repo,
    repository: repo.full_name,
    ref: resolved.ref,
    rootPath: resolved.rootPath,
    commitSha: resolved.commit.sha,
    defaultBranch: repo.default_branch,
    repoUrl: repo.html_url,
    licenseName: repo.license?.name ?? undefined,
    licenseSpdxId: repo.license?.spdx_id ?? repo.license?.key ?? undefined,
    packageVersion: packageInfo.version,
    description: packageInfo.description ?? repo.description ?? undefined,
    skillPaths: limitedPaths,
    importedSkillNames: [],
    importedAt: now,
    updatedAt: now,
    lastCheckedAt: now,
  };

  const existingContext = await createExistingSkillContext(sourceId);
  const loadedSkills: LoadedGitHubSkill[] = [];
  for (const skillPath of limitedPaths) {
    // Pinned paths are loaded even when they are outside the current selection —
    // the update path needs their metadata to keep the record alive.
    if (selectedPaths && !selectedPaths.has(skillPath) && !pinnedSet.has(skillPath)) continue;
    loadedSkills.push(await loadGitHubSkill(parsedUrl.owner, parsedUrl.repo, source.commitSha, source, tree, skillPath, existingContext));
  }

  // The preview lists what the current selection covers. Pinned entries that were
  // loaded only to keep an update from dropping them must not appear as selectable rows.
  const previewSkills = selectedPaths
    ? limitedPaths
      .filter((skillPath) => selectedPaths.has(skillPath) || pinnedSet.has(skillPath))
      .map((skillPath) => loadedSkills.find((skill) => skill.item.path === skillPath)?.item)
      .filter((item): item is GitHubSkillPreviewItem => Boolean(item))
    : loadedSkills.map((skill) => skill.item);

  return {
    preview: {
      source: {
        ...source,
        skillPaths: previewSkills.map((skill) => skill.path),
        importedSkillNames: previewSkills.map((skill) => skill.importName),
      },
      skills: previewSkills,
      warnings,
      // "Was this preview cut short?" — not "did upstream exceed the cap?". Pinned paths
      // are loaded first and the rest fill up to the cap, so compare the two counts
      // directly instead of re-deriving it from the upstream total.
      truncated: tree.truncated || limitedPaths.length < skillPaths.length,
    },
    skills: loadedSkills,
  };
}

async function loadGitHubSkill(
  owner: string,
  repo: string,
  ref: string,
  source: GitHubSkillSource,
  tree: GitHubTreeResponse,
  skillPath: string,
  existingContext: ExistingSkillContext,
): Promise<LoadedGitHubSkill> {
  const warnings: string[] = [];
  const content = await fetchGitHubContent(owner, repo, ref, skillPath);
  const bodyBytes = utf8ByteLength(content);
  if (bodyBytes > MAX_SKILL_BYTES) {
    throw new Error(`${skillPath} is too large, so the import was stopped (${bodyBytes} bytes).`);
  }

  const parsed = parseSkillDoc(content, skillPath);
  const resourceBundle = await fetchResourceBundle(owner, repo, ref, tree, skillPath, parsed.body);
  warnings.push(...resourceBundle.warnings);

  const existingRemoteSkill = existingContext.bySourcePath.get(`${source.id}:${skillPath}`);
  const baseImportName = existingRemoteSkill?.name ?? parsed.name;
  const importName = existingRemoteSkill?.name ?? createUniqueSkillName(baseImportName, existingContext.occupiedNames);
  existingContext.occupiedNames.add(importName);

  const now = Date.now();
  const instructions = buildImportedInstructions({
    source,
    skillPath,
    parsed,
    resources: resourceBundle,
  });
  const remote = {
    provider: 'github' as const,
    sourceId: source.id,
    sourceUrl: source.url,
    repository: source.repository,
    ref: source.ref,
    commitSha: source.commitSha,
    path: skillPath,
    originalName: parsed.name,
    importedAt: existingRemoteSkill?.remote?.importedAt ?? now,
    updatedAt: now,
    lastCheckedAt: now,
    licenseName: source.licenseName,
    licenseSpdxId: source.licenseSpdxId,
    upstreamVersion: parsed.version,
    upstreamUpdatedAt: parsed.lastUpdated,
    includedFiles: resourceBundle.included.map(({ content: _content, ...file }) => file),
    omittedFiles: resourceBundle.omitted,
    warnings,
  };
  const skill: Skill = {
    name: importName,
    description: parsed.description,
    instructions,
    source: 'remote',
    memoryEnabled: false,
    enabled: existingRemoteSkill?.enabled ?? true,
    metadata: {
      provider: 'github',
      sourceId: source.id,
      repository: source.repository,
      ref: source.ref,
      path: skillPath,
      commitSha: source.commitSha,
      originalName: parsed.name,
      license: source.licenseSpdxId ?? source.licenseName ?? '',
      upstreamVersion: parsed.version ?? '',
    },
    remote,
  };

  const conflictingSkill = existingContext.byName.get(parsed.name);
  const item: GitHubSkillPreviewItem = {
    path: skillPath,
    name: parsed.name,
    importName,
    description: parsed.description,
    version: parsed.version,
    lastUpdated: parsed.lastUpdated,
    bytes: bodyBytes + remote.includedFiles.reduce((sum, file) => sum + file.bytes, 0),
    bodyBytes,
    includedFiles: remote.includedFiles,
    omittedFiles: remote.omittedFiles,
    warnings,
    nameChanged: importName !== parsed.name,
    existingSkillName: existingRemoteSkill?.name ?? conflictingSkill?.name,
    existingSourceId: existingRemoteSkill?.remote?.sourceId ?? conflictingSkill?.remote?.sourceId,
  };

  return { item, skill };
}

interface ExistingSkillContext {
  occupiedNames: Set<string>;
  byName: Map<string, SkillCollisionCandidate>;
  bySourcePath: Map<string, SkillCollisionCandidate>;
}

async function createExistingSkillContext(sourceId: string): Promise<ExistingSkillContext> {
  const [skills, sources] = await Promise.all([
    getSkillCollisionCandidates(),
    getAllSkillSources(),
  ]);
  const validSourceIds = new Set(sources.map((source) => source.id));
  validSourceIds.add(sourceId);
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const bySourcePath = new Map<string, SkillCollisionCandidate>();
  for (const skill of skills) {
    if (skill.source === 'remote' && skill.remote && validSourceIds.has(skill.remote.sourceId)) {
      bySourcePath.set(`${skill.remote.sourceId}:${skill.remote.path}`, skill);
    }
  }

  return {
    occupiedNames: new Set(skills.map((skill) => skill.name)),
    byName,
    bySourcePath,
  };
}

function parseGitHubUrl(input: string): ParsedGitHubUrl {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('The GitHub link must not be empty.');

  const shorthand = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?$/);
  if (shorthand) {
    return {
      owner: shorthand[1],
      repo: stripGitSuffix(shorthand[2]),
      mode: 'repo',
      path: '',
      url: `https://github.com/${shorthand[1]}/${stripGitSuffix(shorthand[2])}`,
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Enter a GitHub repository, directory, or SKILL.md link.');
  }

  if (url.hostname === 'raw.githubusercontent.com') {
    const [owner, repo, ...refPathParts] = url.pathname.split('/').filter(Boolean);
    if (!owner || !repo || refPathParts.length < 2) throw new Error('The raw GitHub link is missing a repository or path.');
    const [ref, ...pathParts] = refPathParts;
    const path = pathParts.join('/');
    return {
      owner,
      repo: stripGitSuffix(repo),
      mode: isSkillDocPath(path) ? 'blob' : 'tree',
      ref,
      path,
      refPathParts,
      url: trimmed,
    };
  }

  if (url.hostname !== 'github.com') {
    throw new Error('Only github.com and raw.githubusercontent.com links are supported.');
  }

  const [owner, rawRepo, action, ...rest] = url.pathname.split('/').filter(Boolean);
  if (!owner || !rawRepo) throw new Error('The GitHub link is missing owner/repo.');
  const repo = stripGitSuffix(rawRepo);

  if (action === 'tree' || action === 'blob') {
    if (rest.length === 0) throw new Error('The GitHub tree/blob link is missing a branch.');
    return {
      owner,
      repo,
      mode: action,
      ref: rest[0],
      path: rest.slice(1).join('/'),
      refPathParts: rest,
      url: trimmed,
    };
  }

  return {
    owner,
    repo,
    mode: 'repo',
    path: '',
    url: trimmed,
  };
}

async function resolveSourceLocation(
  parsed: ParsedGitHubUrl,
  defaultBranch: string,
): Promise<{ ref: string; rootPath: string; commit: GitHubCommitResponse }> {
  const candidates = createSourceLocationCandidates(parsed, defaultBranch);

  for (const candidate of candidates) {
    const commit = await fetchOptionalGitHubJson<GitHubCommitResponse>(
      `/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(candidate.ref)}`,
    );
    if (commit) return { ...candidate, commit };
  }

  throw new Error('The branch, tag, or commit in this GitHub link does not exist.');
}

function createSourceLocationCandidates(
  parsed: ParsedGitHubUrl,
  defaultBranch: string,
): Array<{ ref: string; rootPath: string }> {
  if (parsed.mode === 'repo') {
    return [{ ref: parsed.ref ?? defaultBranch, rootPath: trimSlashes(parsed.path) }];
  }

  const parts = parsed.refPathParts?.filter(Boolean) ?? [];
  if (parts.length === 0) {
    return [{ ref: defaultBranch, rootPath: trimSlashes(parsed.path) }];
  }

  const candidates: Array<{ ref: string; rootPath: string }> = [];
  const defaultBranchParts = defaultBranch.split('/').filter(Boolean);
  if (startsWithSegments(parts, defaultBranchParts)) {
    candidates.push({
      ref: defaultBranch,
      rootPath: parts.slice(defaultBranchParts.length).join('/'),
    });
  }

  for (let refLength = parts.length; refLength >= 1; refLength -= 1) {
    candidates.push({
      ref: parts.slice(0, refLength).join('/'),
      rootPath: parts.slice(refLength).join('/'),
    });
  }

  return dedupeSourceLocationCandidates(candidates);
}

function startsWithSegments(parts: string[], prefix: string[]): boolean {
  return prefix.length > 0 && prefix.every((part, index) => parts[index] === part);
}

function dedupeSourceLocationCandidates(
  candidates: Array<{ ref: string; rootPath: string }>,
): Array<{ ref: string; rootPath: string }> {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.ref}\n${candidate.rootPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Does this repo path name a Skill definition file?
 *
 * Case-insensitive: a repo that stores `skill.md` is still a Skill, and the previous
 * exact-case check turned it into "no SKILL.md found under this link" — the file was
 * right there. Only the **last** segment is compared, so `sub/SKILL.md` qualifies.
 */
const SKILL_DOC_PATH_RE = /(^|\/)skill\.md$/i;

function isSkillDocPath(path: string): boolean {
  return SKILL_DOC_PATH_RE.test(path);
}

function findSkillPaths(tree: GitHubTreeResponse, rootPath: string, mode: ParsedGitHubUrl['mode']): string[] {
  const normalizedRoot = trimSlashes(rootPath);
  if (mode === 'blob') {
    if (!isSkillDocPath(normalizedRoot)) throw new Error('Single-file import only supports SKILL.md.');
    const exists = tree.tree.some((entry) => entry.type === 'blob' && entry.path === normalizedRoot);
    if (!exists) throw new Error(`${normalizedRoot} does not exist in the GitHub source.`);
    return [normalizedRoot];
  }

  const prefix = normalizedRoot ? `${normalizedRoot}/` : '';
  return tree.tree
    .filter((entry) => entry.type === 'blob')
    .map((entry) => entry.path)
    .filter((path) => path.startsWith(prefix) && isSkillDocPath(path))
    .sort((a, b) => a.localeCompare(b));
}

async function fetchResourceBundle(
  owner: string,
  repo: string,
  ref: string,
  tree: GitHubTreeResponse,
  skillPath: string,
  skillBody: string,
): Promise<ResourceBundle> {
  const directory = parentDirectory(skillPath);
  const prefix = directory ? `${directory}/` : '';
  const candidates = tree.tree
    .filter((entry) => entry.type === 'blob')
    .filter((entry) => entry.path.startsWith(prefix))
    // A nested SKILL.md belongs to a child Skill, not to this one's supporting files.
    // (The Shell host's collectLocalSkillResources excludes them the same way.)
    .filter((entry) => entry.path !== skillPath && !isSkillDocPath(entry.path))
    .filter((entry) => isTextResource(entry.path))
    .sort((a, b) => rankResource(a.path, skillBody) - rankResource(b.path, skillBody) || a.path.localeCompare(b.path));

  const included: ResourceBundle['included'] = [];
  const omitted: RemoteSkillFile[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;

  for (const candidate of candidates) {
    // ⚠️ **Missing `size` must not mean "zero bytes".** GitHub omits `size` for blobs it
    // does not size inline; treating that as 0 would pass both caps below and then
    // download the whole file — for a >100 MB blob, into the extension's heap and
    // then into the prompt. Unknown size is therefore treated as "too big to bundle":
    // the file is omitted, and only appears in the on-demand list.
    const size = candidate.size;
    if (typeof size !== 'number' || !Number.isFinite(size)) {
      omitted.push({ path: candidate.path, bytes: 0 });
      warnings.push(`${candidate.path} did not report a file size, so it is treated as read-on-demand.`);
      continue;
    }
    if (included.length >= MAX_RESOURCE_FILES_PER_SKILL) {
      omitted.push({ path: candidate.path, bytes: size });
      continue;
    }
    if (size > MAX_RESOURCE_FILE_BYTES) {
      omitted.push({ path: candidate.path, bytes: size });
      warnings.push(`${candidate.path} exceeds the per-file resource limit and was not bundled.`);
      continue;
    }
    if (totalBytes + size > MAX_RESOURCE_BYTES_PER_SKILL) {
      omitted.push({ path: candidate.path, bytes: size });
      continue;
    }

    const content = await fetchGitHubContent(owner, repo, ref, candidate.path);
    const contentBytes = utf8ByteLength(content);
    totalBytes += contentBytes;
    included.push({ path: candidate.path, bytes: contentBytes, content });
  }

  if (omitted.length > 0) {
    warnings.push(`${omitted.length} sibling resource(s) were not bundled; see the upstream repository for them.`);
  }

  return { included, omitted, warnings };
}

function buildImportedInstructions(input: {
  source: GitHubSkillSource;
  skillPath: string;
  parsed: ParsedSkillDoc;
  resources: ResourceBundle;
}): string {
  const { source, skillPath, parsed, resources } = input;
  const header = [
    `# GitHub Skill: ${parsed.name}`,
    '',
    '## Zai++ Import Metadata',
    '',
    `- Source: ${source.repository}`,
    `- Path: ${skillPath}`,
    `- Ref: ${source.ref}`,
    `- Commit: ${source.commitSha}`,
    `- License: ${source.licenseSpdxId ?? source.licenseName ?? 'Unknown'}`,
    parsed.version ? `- Upstream version: ${parsed.version}` : '',
    parsed.lastUpdated ? `- Upstream updated: ${parsed.lastUpdated}` : '',
    `- Bundled supporting files: ${resources.included.length}`,
    resources.omitted.length > 0 ? `- Omitted supporting files: ${resources.omitted.length}` : '',
  ].filter(Boolean).join('\n');

  const body = [
    '## Upstream SKILL.md',
    '',
    parsed.body.trim(),
  ].join('\n');

  const resourceDocs = resources.included.length === 0 ? '' : [
    '## Bundled Supporting Files',
    '',
    '这些文件来自同一个上游 Skill 目录，用于补齐原始 SKILL.md 中引用的 agents、references、templates 或 examples。',
    '',
    ...resources.included.map((resource) => [
      `### ${resource.path}`,
      '',
      resource.content.trim(),
    ].join('\n')),
  ].join('\n\n');

  const omitted = resources.omitted.length === 0 ? '' : [
    '## Omitted Supporting Files',
    '',
    '以下文件因为数量或大小限制没有合并进 prompt；需要时请参考上游仓库。',
    '',
    ...resources.omitted.map((file) => `- ${file.path} (${file.bytes} bytes)`),
  ].join('\n');

  return [header, body, resourceDocs, omitted].filter(Boolean).join('\n\n---\n\n');
}

function parseSkillDoc(raw: string, path: string): ParsedSkillDoc {
  return parseSkillDocShared(raw, path, {
    describeFallback: (skillPath) => `Imported GitHub Skill from ${skillPath}`,
  });
}

async function fetchPackageInfo(owner: string, repo: string, ref: string): Promise<{ version?: string; description?: string }> {
  for (const path of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'package.json']) {
    const raw = await fetchOptionalGitHubContent(owner, repo, ref, path);
    if (raw === null) {
      continue;
    }
    let parsed: { version?: unknown; description?: unknown };
    try {
      parsed = JSON.parse(raw) as { version?: unknown; description?: unknown };
    } catch {
      throw new Error(`${path} is not valid JSON, so the import was stopped.`);
    }
    return {
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
    };
  }
  return {};
}

async function fetchOptionalGitHubContent(owner: string, repo: string, ref: string, path: string): Promise<string | null> {
  try {
    return await fetchGitHubContent(owner, repo, ref, path);
  } catch (error) {
    if (isGitHubHttpStatus(error, 404)) return null;
    throw error;
  }
}

async function fetchOptionalGitHubJson<T>(path: string): Promise<T | null> {
  try {
    return await fetchGitHubJson<T>(path);
  } catch (error) {
    if (isGitHubHttpStatus(error, 404)) return null;
    throw error;
  }
}

async function fetchGitHubContent(owner: string, repo: string, ref: string, path: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(createGitHubRawUrl(owner, repo, ref, path), {
      signal: controller.signal,
      headers: {
        accept: 'text/plain, application/octet-stream',
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`GitHub raw content request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 180)}` : ''}`);
    }
    return await response.text();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('GitHub raw content request timed out');
    }
    if (error instanceof TypeError) {
      throw new Error('Unable to access GitHub raw content. Grant raw.githubusercontent.com access and confirm the network is available.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGitHubJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${GITHUB_API_BASE}${path}`, {
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if ((response.status === 403 || response.status === 429) && /rate limit/i.test(detail)) {
        throw new Error('GitHub API rate limit exceeded while reading repository metadata. Wait for the GitHub rate-limit window to reset, then retry.');
      }
      throw new Error(`GitHub request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 180)}` : ''}`);
    }
    return await response.json() as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('GitHub request timed out.');
    }
    if (error instanceof TypeError) {
      throw new Error('Unable to reach the GitHub API. Grant GitHub access permission and confirm the network is available.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isGitHubHttpStatus(error: unknown, status: number): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`HTTP ${status}`);
}

function createGitHubRawUrl(owner: string, repo: string, ref: string, path: string): string {
  return [
    GITHUB_RAW_BASE,
    encodeURIComponent(owner),
    encodeURIComponent(repo),
    encodeURIComponent(ref),
    ...path.split('/').map(encodeURIComponent),
  ].join('/');
}

function isTextResource(path: string): boolean {
  return TEXT_RESOURCE_EXTENSIONS.has(pathExtension(path));
}

function rankResource(path: string, skillBody: string): number {
  const relativeName = path.split('/').slice(-2).join('/');
  if (skillBody.includes(path) || skillBody.includes(relativeName)) return 0;
  if (path.includes('/agents/')) return 1;
  if (path.includes('/references/')) return 2;
  if (path.includes('/templates/')) return 3;
  if (path.includes('/examples/')) return 4;
  return 5;
}

function pathExtension(path: string): string {
  const name = path.split('/').pop() ?? '';
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

function createSourceId(owner: string, repo: string, ref: string, rootPath: string): string {
  return `github:${owner}/${repo}:${ref}:${rootPath || '.'}`;
}

function normalizeSourceUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/, '');
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function normalizeSkillName(name: string): string {
  return requireSkillSlug(name);
}

function createUniqueSkillName(preferred: string, occupiedNames: Set<string>): string {
  const normalized = normalizeSkillName(preferred);
  if (!occupiedNames.has(normalized)) return normalized;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${normalized}-${suffix}`;
    if (!occupiedNames.has(candidate)) return candidate;
  }
  throw new Error(`Unable to generate a unique name for the remote Skill: ${preferred}`);
}
