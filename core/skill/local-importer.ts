import { getMcpToolDescriptors, refreshMcpServerDiscovery } from '../mcp/discovery';
import { getAllMcpServers, getMcpToolCache } from '../mcp/store';
import { createMcpDescriptorId } from '../mcp/descriptor-identity';
import { isLocalSkillPathUnavailableCode, isShellMcpServer, LOCAL_SKILL_ERROR_CODES } from '../shell';
import type {
  LocalSkillImportRequest,
  LocalSkillImportBlock,
  LocalSkillImportBlockCode,
  LocalSkillImportResponse,
  LocalSkillPreview,
  LocalSkillPreviewItem,
  LocalSkillSource,
  RemoteSkillFile,
  Skill,
} from '../types';
import type { McpServerConfig } from '../mcp/types';
import type { LocalStateMutationRunner } from '../persistence/local-state-mutation';
import type { JsonValue, ToolResult } from '../tool/types';
import type { ToolCall } from '../tool/types';
import { utf8ByteLength } from '../tool/result-bytes';
import {
  getAllSkillSources,
  getSkillCollisionCandidates,
  stageUpsertLocalSkillSourceAlreadyLocked,
  type SkillCollisionCandidate,
} from './registry';
import { extractScenarioBlock } from './local-skill-scorer';
import { requireSkillSlug } from './slug';
import { parseSkillDoc as parseSkillDocShared, type ParsedSkillDoc } from './skill-doc';

/** SKILL.md 的体积上限，单位 **UTF-8 字节**（与 Shell host 的 `stat.size` 判据同单位）。 */
const MAX_SKILL_BYTES = 120_000;
const ON_DEMAND_RESOURCE_READER_NAMES = new Set(['local_file_read', 'shell_exec']);
const STALE_LOCAL_FILE_READ_MESSAGE = [
  'Current Shell Native Host can preview local Skills but does not expose local_file_read, and shell_exec is not available to chat.',
  'Reinstall Shell Native Host from MCP > Shell Local to add the least-privilege reader, restart the browser, then try again.',
].join(' ');

interface LocalSkillHostBundle {
  rootPath: string;
  displayName: string;
  directoryName: string;
  skills: LocalSkillHostItem[];
  warnings: string[];
  truncated: boolean;
}

interface LocalSkillBundleReadResult {
  bundle: LocalSkillHostBundle;
  onDemandResourceBlock?: LocalSkillImportBlock;
}

interface OnDemandResourceIssue {
  code: LocalSkillImportBlockCode;
  detail?: string;
  message: string;
}

class LocalSkillImportBlockedError extends Error {
  constructor(
    message: string,
    readonly importBlock: LocalSkillImportBlock,
  ) {
    super(message);
    this.name = 'LocalSkillImportBlockedError';
  }
}

/**
 * **「那个文件夹已经不可用」**（挪走 / 改名 / 被删 / 读不出 Skill）。
 *
 * ⚠️ 这一档是**唯一**值得引导用户「重新选择路径」的失败。存储写失败、锁恢复失败、
 * 解码失败都不属于它 —— 那些重选文件夹也修不好，压成 `ok:false` 只会让人白走一遍。
 */
class LocalSkillPathUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalSkillPathUnavailableError';
  }
}

/**
 * Every path the caller asked for must appear in what was actually loaded.
 *
 * ⚠️ **Two call sites** (`importLocalSkillSource` and `relocateLocalSkillSource`) differ
 * only in *which* list is authoritative — the request's selection vs the stored source's.
 * Keeping one implementation means the message and the error class can never drift apart
 * between them; the "everything missing" case is folded into the same check because
 * `mismatched` then equals the whole list.
 *
 * Throws `LocalSkillPathUnavailableError`, which `update`/`relocate` turn into
 * `ok:false` + `local_path_unavailable` for the UI.
 */
function assertSelectedPathsLoaded(
  requestedPaths: readonly string[],
  importedPaths: ReadonlySet<string>,
): void {
  if (requestedPaths.length === 0) {
    throw new LocalSkillPathUnavailableError('Selected local Skill paths were not found.');
  }
  const missingPaths = requestedPaths.filter((path) => !importedPaths.has(path));
  if (missingPaths.length > 0) {
    throw new LocalSkillPathUnavailableError(
      `Selected local Skill paths were not found: ${missingPaths.join(', ')}`,
    );
  }
}

/** 读 host 回包经 `normalizeMcpToolResult` 透出来的**结构化**失败码。 */
function readHostErrorCode(result: ToolResult): string | undefined {
  const details = result.error?.details as Record<string, unknown> | undefined;
  const code = details?.structuredCode;
  return typeof code === 'string' && code ? code : undefined;
}

/**
 * 把「原路径不可用」的失败包成专用类，其余原样返回。
 *
 * ⚠️ **判据是 host 的结构化错误码，不是 message 文案** —— 文案会随 host 迭代漂移，
 * 而码表两侧各有镜像（`core/shell/contracts.ts` ↔
 * `packages/shell-host/native/contracts.mjs`），由测试逐码比对。
 * ⚠️ **旧 host 没有码**时会落到「普通失败」那一支：用户看到原始报错、不被引导重选。
 * 这是刻意的取舍 —— 宁可少引导，也不按文案猜。
 */
function toPathAwareError(error: unknown, hostCode: string | undefined): Error {
  if (error instanceof LocalSkillPathUnavailableError || error instanceof LocalSkillImportBlockedError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return isLocalSkillPathUnavailableCode(hostCode)
    ? new LocalSkillPathUnavailableError(message)
    : (error instanceof Error ? error : new Error(message));
}

interface LocalSkillHostItem {
  path: string;
  directory: string;
  directoryPath: string;
  content: string;
  includedFiles: Array<RemoteSkillFile & { content: string }>;
  omittedFiles: RemoteSkillFile[];
  scriptFiles: RemoteSkillFile[];
  warnings: string[];
}

interface LoadedLocalSkill {
  item: LocalSkillPreviewItem;
  skill: Skill;
}

interface LoadedLocalSource {
  preview: LocalSkillPreview;
  skills: LoadedLocalSkill[];
}

interface ExistingSkillContext {
  occupiedNames: Set<string>;
  byName: Map<string, SkillCollisionCandidate>;
  bySourcePath: Map<string, SkillCollisionCandidate>;
}

export interface LocalSkillImporterDeps {
  executeToolCall(call: ToolCall): Promise<ToolResult>;
}

export interface LocalSkillImportDeps extends LocalSkillImporterDeps, LocalStateMutationRunner {}

export async function previewLocalSkillSource(
  rootPath: string,
  deps: LocalSkillImporterDeps,
): Promise<LocalSkillPreview> {
  return (await loadLocalSkillSource(rootPath, undefined, undefined, deps)).preview;
}

/**
 * 弹系统文件夹选择框。
 *
 * 返回 `null` = **用户点了取消**；抛错 = 真的失败（host 不可用、路径不可读等）。
 *
 * ⚠️⚠️ **取消不能和失败共用一个出口** —— 之前两处调用点都把它当失败：导入面板弹出
 * 一条红色 `Folder selection was cancelled.`，技能页更糟 —— `catch { return null }`
 * 把取消与「选择器坏了」压成同一个值，于是界面报「原文件夹已挪动或不存在」，
 * 用户只是不想选了却被告知文件夹出事了。
 *
 * ⚠️ 判据是 host 回的**结构化错误码**，不是 message 文案（那是 UI 字符串）。
 */
export async function pickLocalSkillFolder(
  defaultPath?: string,
  deps?: LocalSkillImporterDeps,
): Promise<string | null> {
  if (!deps) throw new Error('Local Skill importer runtime executor is required.');
  const server = await getShellMcpServer();
  const result = await executeShellMcpTool(server, 'local_folder_pick', {
    title: 'Choose a local Skill folder',
    ...(defaultPath ? { defaultPath } : {}),
  }, deps);

  if (!result.ok) {
    if (readHostErrorCode(result) === LOCAL_SKILL_ERROR_CODES.folderPickCancelled) return null;
    throw new Error(formatToolFailure(result));
  }
  return parseLocalFolderPickOutput(result.output);
}

export async function importLocalSkillSource(
  request: LocalSkillImportRequest,
  deps: LocalSkillImportDeps,
): Promise<LocalSkillImportResponse> {
  if (request.selectedPaths.length === 0) {
    throw new Error('Select at least one local Skill before importing.');
  }

  const selectedImportNames = new Map(Object.entries(request.selectedImportNames ?? {}));
  let loaded: LoadedLocalSource;
  try {
    loaded = await loadLocalSkillSource(
      request.rootPath,
      new Set(request.selectedPaths),
      selectedImportNames,
      deps,
    );
  } catch (error) {
    if (error instanceof LocalSkillImportBlockedError) {
      return {
        ok: false,
        error: error.message,
        importBlock: error.importBlock,
      };
    }
    throw error;
  }
  const selected = loaded.skills.filter((skill) => request.selectedPaths.includes(skill.item.path));
  const importedPaths = new Set(selected.map((skill) => skill.item.path));
  assertSelectedPathsLoaded(request.selectedPaths, importedPaths);

  const now = Date.now();
  const source: LocalSkillSource = {
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
    stageUpsertLocalSkillSourceAlreadyLocked(source, incomingSkills)
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

// Update a local skill source: re-scan the same rootPath and store in place.
// The source id is derived from rootPath and stays stable across re-imports, so
// this refreshes the index layer (name/description) and keeps the skillDir pointer.
// Drives the UI "Update" button (definition file changed -> re-read index; whole
// folder moved -> when the path is invalid, the UI guides re-selection).
export async function updateLocalSkillSource(
  sourceId: string,
  deps: LocalSkillImportDeps,
): Promise<LocalSkillImportResponse> {
  if (!sourceId) throw new Error('Local Skill source id must be a non-empty string.');
  const sources = await getAllSkillSources();
  const source = sources.find((candidate) => candidate.id === sourceId);
  if (!source || source.provider !== 'local') {
    throw new Error('Local Skill source was not found');
  }
  const localSource = source as LocalSkillSource;
  // 只有两档该转成 `ok:false` 交给 UI 处理：
  //  · 导入阻塞（缺读取器）—— UI 显示原因，**不**引导重选；
  //  · 原路径不可用 —— UI 引导重新选择文件夹并 relocate。
  // 其余（存储写失败、锁恢复失败、解码失败……）一律原样抛：它们重选文件夹也修不好，
  // 压成 ok:false 只会让用户白走一遍重选流程，最后才看到真正的错。
  try {
    return await importLocalSkillSource(
      { rootPath: localSource.rootPath, selectedPaths: localSource.skillPaths },
      deps,
    );
  } catch (error) {
    if (error instanceof LocalSkillImportBlockedError) {
      return { ok: false, error: error.message, importBlock: error.importBlock };
    }
    if (error instanceof LocalSkillPathUnavailableError) {
      return {
        ok: false,
        error: error.message,
        importBlock: { code: 'local_path_unavailable' },
      };
    }
    throw error;
  }
}

// Relocate a local skill source: after the original folder is moved/renamed,
// re-import from the user's newly selected path.
// Key: update the existing source record in place, keeping the original source.id
// (stable linkage) to avoid breaking activation references, disabled states, and user settings.
// Do NOT call importLocalSkillSource (which would generate a new id from the new rootPath, invalidating old references).
// Path-validation / missing-source errors reuse existing messages (:160 / :211).
export async function relocateLocalSkillSource(
  sourceId: string,
  newRootPath: string,
  deps: LocalSkillImportDeps,
): Promise<LocalSkillImportResponse> {
  if (!sourceId) throw new Error('Local Skill source id must be a non-empty string.');
  if (!newRootPath?.trim()) throw new Error('New root path must be a non-empty string.');
  const sources = await getAllSkillSources();
  const source = sources.find((candidate) => candidate.id === sourceId);
  if (!source || source.provider !== 'local') {
    throw new Error('Local Skill source was not found');
  }
  const localSource = source as LocalSkillSource;

  let loaded: LoadedLocalSource;
  try {
    loaded = await loadLocalSkillSource(newRootPath.trim(), new Set(localSource.skillPaths), undefined, deps);
  } catch (error) {
    if (error instanceof LocalSkillImportBlockedError) {
      return { ok: false, error: error.message, importBlock: error.importBlock };
    }
    if (error instanceof LocalSkillPathUnavailableError) {
      return { ok: false, error: error.message, importBlock: { code: 'local_path_unavailable' } };
    }
    throw error;
  }
  const selected = loaded.skills.filter((skill) => localSource.skillPaths.includes(skill.item.path));
  const importedPaths = new Set(selected.map((skill) => skill.item.path));
  assertSelectedPathsLoaded(localSource.skillPaths, importedPaths);

  const now = Date.now();
  // Use the old source as the base, keeping id/provider/importedAt, overwriting fields from the new-path load result.
  const updated: LocalSkillSource = {
    ...localSource,
    rootPath: loaded.preview.source.rootPath,
    displayName: loaded.preview.source.displayName,
    directoryName: loaded.preview.source.directoryName,
    warnings: loaded.preview.source.warnings,
    skillPaths: selected.map((skill) => skill.item.path),
    importedSkillNames: selected.map((skill) => skill.skill.name),
    updatedAt: now,
    lastCheckedAt: now,
  };
  const incomingSkills = selected.map((loadedSkill) => ({
    ...loadedSkill.skill,
    remote: loadedSkill.skill.remote ? {
      ...loadedSkill.skill.remote,
      // Relocation updates in place and keeps the original source.id (see the updated construction).
      // The new-path load yields a fresh remote.sourceId that must be aligned with the retained old id,
      // otherwise the "remote must match source" assertion (registry.ts:315) rejects the write.
      sourceId: updated.id,
      importedAt: loadedSkill.skill.remote.importedAt || now,
      updatedAt: now,
      lastCheckedAt: now,
    } : undefined,
  }));
  const result = await deps.runLocalStateMutation(() => (
    stageUpsertLocalSkillSourceAlreadyLocked(updated, incomingSkills)
  ));

  return {
    ok: true,
    source: {
      ...updated,
      importedSkillNames: result.imported.map((skill) => skill.name),
    },
    imported: result.imported,
    replaced: result.replaced,
    renamed: result.renamed,
    warnings: loaded.preview.warnings,
  };
}

async function loadLocalSkillSource(
  rootPath: string,
  selectedPaths?: Set<string>,
  selectedImportNames?: ReadonlyMap<string, string>,
  deps?: LocalSkillImporterDeps,
): Promise<LoadedLocalSource> {
  if (!deps) throw new Error('Local Skill importer runtime executor is required.');
  const { bundle, onDemandResourceBlock } = await readLocalSkillBundle(rootPath, selectedPaths, deps);
  if (bundle.skills.length === 0) {
    throw new LocalSkillPathUnavailableError('No SKILL.md was found under this local directory.');
  }

  const now = Date.now();
  const source: LocalSkillSource = {
    id: createLocalSourceId(bundle.rootPath),
    provider: 'local',
    rootPath: bundle.rootPath,
    displayName: bundle.displayName,
    directoryName: bundle.directoryName,
    skillPaths: bundle.skills.map((skill) => skill.path),
    importedSkillNames: [],
    importedAt: now,
    updatedAt: now,
    lastCheckedAt: now,
    warnings: bundle.warnings,
  };

  const existingContext = await createExistingSkillContext(source.id);
  const loadedSkills = bundle.skills.map((skill) => loadLocalSkill(
    source,
    skill,
    existingContext,
    skill.omittedFiles.length > 0 ? onDemandResourceBlock : undefined,
    selectedImportNames?.get(skill.path),
  ));
  const previewSkills = loadedSkills.map((skill) => skill.item);

  return {
    preview: {
      source: {
        ...source,
        skillPaths: previewSkills.map((skill) => skill.path),
        importedSkillNames: previewSkills.map((skill) => skill.importName),
      },
      skills: previewSkills,
      warnings: bundle.warnings,
      truncated: bundle.truncated,
    },
    skills: loadedSkills,
  };
}

function loadLocalSkill(
  source: LocalSkillSource,
  hostSkill: LocalSkillHostItem,
  existingContext: ExistingSkillContext,
  importBlock?: LocalSkillImportBlock,
  selectedImportName?: string,
): LoadedLocalSkill {
  const warnings = [...hostSkill.warnings];
  const bodyBytes = utf8ByteLength(hostSkill.content);
  if (bodyBytes > MAX_SKILL_BYTES) {
    throw new Error(`${hostSkill.path} is too large to import (${bodyBytes} bytes).`);
  }

  const parsed = parseSkillDoc(hostSkill.content, hostSkill.path);
  const existingRemoteSkill = existingContext.bySourcePath.get(`${source.id}:${hostSkill.path}`);
  const baseImportName = existingRemoteSkill?.name ?? selectedImportName ?? parsed.name;
  const importName = existingRemoteSkill?.name ?? createUniqueSkillName(baseImportName, existingContext.occupiedNames);
  existingContext.occupiedNames.add(importName);

  const now = Date.now();
  const instructions = buildLocalImportedInstructions({
    source,
    skillPath: hostSkill.path,
    directory: hostSkill.directory,
    directoryPath: hostSkill.directoryPath,
    parsed,
    resources: hostSkill.includedFiles,
    omittedFiles: hostSkill.omittedFiles,
    scriptFiles: hostSkill.scriptFiles,
  });
  // Bring the SKILL.md applicable / not-applicable scenario text into the index card
  // (instructions) so the implicit scorer's scenarioAdjustment can match it.
  // Otherwise a local Skill's description holds only the frontmatter one-liner, scenarioAdjustment
  // can never extract scenario text, and Chinese queries almost never activate the local Skill
  // (breaking the intended "activate on match" design).
  const applicable = extractScenarioBlock(hostSkill.content, '适用场景', '适用场景|适用|使用场景');
  const notApplicable = extractScenarioBlock(hostSkill.content, '不适用场景', '不适用场景|不适用|禁用场景');
  const scenarioSection = [
    applicable && `适用场景：\n${applicable}`,
    notApplicable && `不适用场景：\n${notApplicable}`,
  ].filter(Boolean).join('\n\n');
  const finalInstructions = scenarioSection ? `${instructions}\n\n---\n\n${scenarioSection}` : instructions;
  const remote = {
    provider: 'local' as const,
    sourceId: source.id,
    path: hostSkill.path,
    originalName: parsed.name,
    importedAt: existingRemoteSkill?.remote?.importedAt ?? now,
    updatedAt: now,
    lastCheckedAt: now,
    localRootPath: source.rootPath,
    localDirectory: hostSkill.directoryPath,
    localDisplayName: source.displayName,
    upstreamVersion: parsed.version,
    upstreamUpdatedAt: parsed.lastUpdated,
    // 清单里的路径保持 **rootPath 相对**（Shell host 的口径，`collectLocalSkillResources`
    // 用 `normalizeRelativePath` 相对 rootPath 生成）。绝对化那一层按同一个基拼接，
    // 两边基必须一致，否则嵌套技能永远命中不了。
    includedFiles: toRootRelativeFiles(hostSkill.includedFiles),
    omittedFiles: toRootRelativeFiles(hostSkill.omittedFiles),
    scriptFiles: toRootRelativeFiles(hostSkill.scriptFiles),
    warnings,
  };
  const skill: Skill = {
    name: importName,
    description: parsed.description,
    instructions: finalInstructions,
    source: 'remote',
    memoryEnabled: false,
    enabled: existingRemoteSkill?.enabled ?? true,
    metadata: {
      provider: 'local',
      sourceId: source.id,
      rootPath: source.rootPath,
      path: hostSkill.path,
      originalName: parsed.name,
      localDirectory: hostSkill.directoryPath,
      upstreamVersion: parsed.version ?? '',
    },
    remote,
  };

  const conflictingSkill = existingContext.byName.get(parsed.name);
  const includedFiles = remote.includedFiles;
  const item: LocalSkillPreviewItem = {
    path: hostSkill.path,
    name: parsed.name,
    importName,
    description: parsed.description,
    version: parsed.version,
    lastUpdated: parsed.lastUpdated,
    bytes: bodyBytes + includedFiles.reduce((sum, file) => sum + file.bytes, 0),
    bodyBytes,
    includedFiles,
    omittedFiles: remote.omittedFiles,
    scriptFiles: remote.scriptFiles ?? [],
    warnings,
    importBlock,
    nameChanged: importName !== parsed.name,
    existingSkillName: existingRemoteSkill?.name ?? conflictingSkill?.name,
    existingSourceId: existingRemoteSkill?.remote?.sourceId ?? conflictingSkill?.remote?.sourceId,
  };

  return { item, skill };
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

async function readLocalSkillBundle(
  rootPath: string,
  selectedPaths: Set<string> | undefined,
  deps: LocalSkillImporterDeps,
): Promise<LocalSkillBundleReadResult> {
  const server = await getShellMcpServer();
  const result = await executeShellMcpTool(server, 'local_skill_preview', {
    rootPath,
    ...(selectedPaths ? { selectedPaths: [...selectedPaths] } : {}),
  }, deps);

  if (!result.ok) {
    throw toPathAwareError(new Error(formatToolFailure(result)), readHostErrorCode(result));
  }
  const bundle = parseLocalSkillHostBundle(result.output);
  const onDemandResourceIssue = await getOnDemandResourceIssue(server, bundle);
  if (selectedPaths && onDemandResourceIssue) {
    throw new LocalSkillImportBlockedError(
      onDemandResourceIssue.message,
      toLocalSkillImportBlock(onDemandResourceIssue),
    );
  }
  return {
    bundle,
    onDemandResourceBlock: onDemandResourceIssue
      ? toLocalSkillImportBlock(onDemandResourceIssue)
      : undefined,
  };
}

function toLocalSkillImportBlock(issue: OnDemandResourceIssue): LocalSkillImportBlock {
  return {
    code: issue.code,
    ...(issue.detail ? { detail: issue.detail } : {}),
  };
}

async function getOnDemandResourceIssue(
  server: McpServerConfig,
  bundle: LocalSkillHostBundle,
): Promise<OnDemandResourceIssue | null> {
  const hasOnDemandResources = bundle.skills.some((skill) => skill.omittedFiles.length > 0);
  if (!hasOnDemandResources) return null;

  const discovery = await refreshMcpServerDiscovery(server.id);
  if (discovery.health.status === 'error') {
    const detail = discovery.health.error || 'MCP discovery failed.';
    return {
      code: 'shell_discovery_failed',
      detail,
      message: `Unable to verify Shell MCP local_file_read availability: ${detail}`,
    };
  }
  const runtimeDescriptors = await getMcpToolDescriptors();
  const reader = runtimeDescriptors.find((descriptor) =>
    descriptor.provider.kind === 'mcp' &&
    descriptor.provider.id === server.id &&
    ON_DEMAND_RESOURCE_READER_NAMES.has(descriptor.name)
  );
  if (reader) return null;

  const hasLocalFileReader = discovery.descriptors.some((descriptor) => descriptor.name === 'local_file_read');
  if (!hasLocalFileReader) {
    return {
      code: 'shell_host_update_required',
      message: STALE_LOCAL_FILE_READ_MESSAGE,
    };
  }
  return {
    code: 'shell_reader_unavailable',
    message: 'Shell MCP on-demand file reading is not available to chat. Set Shell Local execution mode to Auto and allow local_file_read before importing this Skill.',
  };
}

async function executeShellMcpTool(
  server: McpServerConfig,
  name: 'local_skill_preview' | 'local_folder_pick',
  payload: Record<string, unknown>,
  deps: LocalSkillImporterDeps,
): Promise<ToolResult> {
  // Uses the shared builder rather than spelling the format out: this id is matched
  // against cache descriptors below, so a format change here would not fail loudly —
  // it would just stop hitting the cache.
  const descriptorId = createMcpDescriptorId(server.id, name);
  const cache = await getMcpToolCache(server.id);
  if (!cache?.descriptors.some((descriptor) => descriptor.id === descriptorId)) {
    await refreshMcpServerDiscovery(server.id);
  }
  const call = {
    name,
    descriptorId,
    provider: {
      kind: 'mcp' as const,
      id: server.id,
      displayName: server.displayName,
      transport: server.transport.kind,
    },
    payload,
    raw: '',
    source: { trigger: 'manual_chat' as const },
  };
  const result = await deps.executeToolCall(call);
  if (result.ok || result.error?.code !== 'mcp_tool_not_found') return result;
  await refreshMcpServerDiscovery(server.id);
  return deps.executeToolCall(call);
}

async function getShellMcpServer(): Promise<McpServerConfig> {
  const servers = await getAllMcpServers({ includeSecrets: false });
  let server = servers.find((candidate) =>
    candidate.transport.kind === 'native_messaging' &&
    isShellMcpServer(candidate)
  );

  if (!server) {
    throw new Error('Shell MCP was not found. Create and install Shell Native Host from the MCP page first.');
  }
  if (!server.enabled) {
    throw new Error('Shell MCP is disabled. Enable Shell Local on the MCP page first.');
  }
  if (!server.execution.enabled || server.execution.mode === 'disabled') {
    throw new Error('Shell MCP execution is disabled. Enable execution on the MCP page before importing local Skills.');
  }
  // ⚠️⚠️ **不再自动替用户打开工具** —— 这里曾经调 `buildShellAllowlistUpgrade`
  // 把 `local_folder_pick` / `local_file_read` 等补进 allowlist，后果是用户关掉的工具
  // 每次导入 Skill 又被打开一次。现在工具开关完全归用户；缺了就在下面按需报错。
  return server;
}

function parseLocalSkillHostBundle(output: JsonValue | undefined): LocalSkillHostBundle {
  const value = output && typeof output === 'object' && !Array.isArray(output)
    ? output as Record<string, unknown>
    : {};
  const data = value.data && typeof value.data === 'object' && !Array.isArray(value.data)
    ? value.data as Record<string, unknown>
    : value;
  const rootPath = readRequiredString(data, 'rootPath');
  const displayName = readRequiredString(data, 'displayName');
  const directoryName = readRequiredString(data, 'directoryName');
  const skills = readArray(data.skills).map(parseHostSkill);
  return {
    rootPath,
    displayName,
    directoryName,
    skills,
    warnings: readStringArray(data.warnings),
    truncated: data.truncated === true,
  };
}

function parseLocalFolderPickOutput(output: JsonValue | undefined): string {
  const value = output && typeof output === 'object' && !Array.isArray(output)
    ? output as Record<string, unknown>
    : {};
  const data = value.data && typeof value.data === 'object' && !Array.isArray(value.data)
    ? value.data as Record<string, unknown>
    : value;
  const path = data.path;
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('Shell MCP local_folder_pick response is missing path');
  }
  return path.trim();
}

function parseHostSkill(value: unknown): LocalSkillHostItem {
  const data = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    path: readRequiredString(data, 'path'),
    directory: readRequiredString(data, 'directory'),
    directoryPath: readRequiredString(data, 'directoryPath'),
    content: readRequiredString(data, 'content'),
    // The host also publishes `bodyBytes`; it is the same UTF-8 length this module
    // derives locally, so parsing it would create a second, unused source of truth.
    includedFiles: readArray(data.includedFiles).map(parseContentFile),
    omittedFiles: readArray(data.omittedFiles).map(parseFile),
    scriptFiles: readArray(data.scriptFiles).map(parseFile),
    warnings: readStringArray(data.warnings),
  };
}

function parseContentFile(value: unknown): RemoteSkillFile & { content: string } {
  const data = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    ...parseFile(data),
    content: readRequiredString(data, 'content'),
  };
}

function parseFile(value: unknown): RemoteSkillFile {
  const data = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    path: readRequiredString(data, 'path'),
    bytes: readNumber(data.bytes),
  };
}

// Index-form marker: used at runtime to distinguish "index-imported" instructions
// from "legacy frozen snapshot" instructions. See isLocalIndexSkill in request-augmentation.ts.
export const LOCAL_INDEX_MARKER = 'Index form: true';

export function isLocalIndexInstructions(instructions: string | undefined): boolean {
  return typeof instructions === 'string' && instructions.includes(LOCAL_INDEX_MARKER);
}

function buildLocalImportedInstructions(input: {
  source: LocalSkillSource;
  skillPath: string;
  directory: string;
  directoryPath: string;
  parsed: ParsedSkillDoc;
  resources: Array<RemoteSkillFile & { content: string }>;
  omittedFiles: RemoteSkillFile[];
  scriptFiles: RemoteSkillFile[];
}): string {
  const { source, skillPath, directory, directoryPath, parsed, resources, omittedFiles, scriptFiles } = input;
  // Import only registers an "index" (name/description + skillDir pointer + activation hint + execution boundary),
  // no longer inlining the SKILL.md body and full text-resource contents. The real disk read is done by the
  // Agent at activation via local_file_read (see the local-skill activation branch in request-augmentation.ts).
  const header = [
    `# Local Skill: ${parsed.name}`,
    '',
    '## Zai++ Import Metadata',
    '',
    `- Source: ${source.displayName}`,
    `- Root path: ${source.rootPath}`,
    `- Skill path: ${skillPath}`,
    `- Skill directory path: ${directoryPath}`,
    parsed.version ? `- Upstream version: ${parsed.version}` : '',
    parsed.lastUpdated ? `- Upstream updated: ${parsed.lastUpdated}` : '',
    `- ${LOCAL_INDEX_MARKER}`,
    `- Bundled supporting files: ${resources.length}`,
    scriptFiles.length > 0 ? `- Local executable/script files: ${scriptFiles.length}` : '',
    omittedFiles.length > 0 ? `- Supporting files available on demand: ${omittedFiles.length}` : '',
    '',
    '## Activation Notice',
    '',
    'This Skill was imported by reference from a local folder. Its full SKILL.md body and supporting file contents are NOT inlined here.',
    'When this Skill is activated (explicit `/' + parsed.name + '` or an implicit scoring match), you MUST read the local definition before doing any work:',
    `- Read the Skill definition file with the local file tool: ${directoryPath}/SKILL.md`,
    '- Parse and follow it fully before starting the task.',
    '- Resolve every relative path inside it against the Skill directory path above (double-base rule).',
  ].filter(Boolean).join('\n');

  const scripts = scriptFiles.length === 0 ? '' : [
    '## Local Script Files',
    '',
    'These scripts remain in the local Skill directory. Import does not execute them and does not bundle their source into the prompt.',
    '',
    ...scriptFiles.map((file) => `- ${relativeToSkillDirectory(file.path, directory)} (${file.bytes} bytes)`),
  ].join('\n');

  const omitted = omittedFiles.length === 0 ? '' : [
    '## Supporting Files Available on Demand',
    '',
    'These files remain in the referenced local Skill directory and were not bundled into the prompt because of count or size limits. Read them with the local file tool when the upstream instructions need them.',
    '',
    ...omittedFiles.map((file) => `- ${relativeToSkillDirectory(file.path, directory)} (${file.bytes} bytes)`),
  ].join('\n');

  const executionBoundary = buildLocalExecutionBoundary(directoryPath);

  return [header, scripts, omitted, executionBoundary].filter(Boolean).join('\n\n---\n\n');
}

  // Dynamic soft hint (fallback layer): generates a "local execution boundary" note from skillDir.
  // Both import and activation use this function, keeping path-resolution rules / initial cwd hint / escape prohibition consistent.
  // Note: "cwd set to skillDir" means the initial hint that "session-start cwd is skillDir",
  // not a hard session-wide persistent binding; real-body relative references rely on the Agent following the "double-base rule".
export function buildLocalExecutionBoundary(skillDir: string): string {
  return [
    '## Local Execution Boundary',
    '',
    '- This Skill was imported by reference from a local folder. The extension did not execute any local script during import.',
    '- If the task requires a bundled script, use Shell MCP only when the tool list exposes the needed shell tool. Do not invent command results.',
    `- Run commands with the initial cwd set to the Skill directory path: ${skillDir}`,
    `- Resolve every relative path inside this Skill against the Skill directory path: ${skillDir}`,
    '- Use the double-base rule: first try relative to the referencing file, then relative to the Skill directory path.',
    '- Never use `..` to escape the Skill directory path.',
    '- Treat paths shown here as local user-machine paths. Do not expose or rewrite them unless the user asks.',
    `- Before relying on this Skill, verify the definition file exists: run local_file_stat on \`${skillDir}/SKILL.md\`.`,
    '- If the definition file is missing or moved, stop and tell the user the Skill definition file is unavailable; suggest using the Skill Update action to re-specify the path.',
  ].join('\n');
}

/**
 * 去掉 `content`（那是正文，不是清单字段），只留 `{ path, bytes }`。
 *
 * ⚠️ 路径**不改基**：它们由 Shell host 生成、以 rootPath 为相对根
 * （`collectLocalSkillResources` 用 `normalizeRelativePath(relativePath)`，
 * 其根是传入的 rootPath）。消费侧（`composeLocalSkillPrompt` 的绝对化）必须用同一个基。
 */
function toRootRelativeFiles(
  files: ReadonlyArray<RemoteSkillFile & { content?: string }>,
): RemoteSkillFile[] {
  return files.map(({ content: _content, ...file }) => file);
}

function relativeToSkillDirectory(path: string, directory: string): string {
  const normalizedPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const normalizedDirectory = directory.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalizedDirectory) return normalizedPath;
  const prefix = `${normalizedDirectory}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}

/**
 * Parse a SKILL.md document (agentskills.io / pi-ecosystem format).
 *
 * Thin wrapper over the shared parser so this module keeps its historical export — the
 * pi-ecosystem contract tests import it from here. The implementation lives in
 * `./skill-doc`, shared with the GitHub import chain.
 */
export function parseSkillDoc(raw: string, path: string): ParsedSkillDoc {
  return parseSkillDocShared(raw, path, {
    describeFallback: (skillPath) => `Imported local Skill from ${skillPath}`,
  });
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Shell MCP local_skill_preview response is missing ${key}`);
  return value;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function createLocalSourceId(rootPath: string): string {
  return `local:${rootPath}`;
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
  throw new Error(`Unable to generate a unique name for local Skill: ${preferred}`);
}

function formatToolFailure(result: ToolResult): string {
  if (result.error?.code === 'mcp_tool_not_found' && result.name === 'local_folder_pick') {
    return 'Current Shell Native Host does not expose local_folder_pick. Reinstall Shell Native Host from the MCP page, restart the browser, then try again.';
  }
  if (result.error?.code === 'mcp_tool_not_found' && result.name === 'local_skill_preview') {
    return 'Current Shell Native Host does not expose local_skill_preview. Reinstall Shell Native Host from the MCP page, restart the browser, then try again.';
  }
  // ⚠️⚠️ **`mcp_tool_disabled` 要单独给一句可操作的** —— 它的成因是「用户在 MCP 页把这个工具关掉了」，
  // 而笼统的 `is disabled by server policy.` 既不说是哪个工具、也没告诉他去哪儿打开。
  // ⚠️ **改前这条路基本见不到**：那时候启动链会把缺的工具自动补回 allowlist
  // （那个升级已删除），所以用户关掉也会被悄悄打开 ⇒ 永远撞不到这个码。
  // ⚠️ **只有 `local_folder_pick` 能走到这里** —— 内部工具（`local_skill_preview`）在
  // `applyMcpToolPolicy` 里跳过 allowlist，只受服务级三道门约束，而那三道门各自有更早的错误码。
  // 那条分支作为对称保留：将来内部工具的口径若变了，它会自己生效。
  if (result.error?.code === 'mcp_tool_disabled' && result.name === 'local_folder_pick') {
    return 'Shell MCP tool local_folder_pick is turned off. Open MCP > Shell Local, enable it in the tools list, then try again.';
  }
  if (result.error?.code === 'mcp_tool_disabled' && result.name === 'local_skill_preview') {
    return 'Shell MCP tool local_skill_preview is turned off, so local Skill folders cannot be read. Open MCP > Shell Local, enable it in the tools list, then try again.';
  }
  const message = result.error?.message || result.detail || result.summary || 'Local Skill scan failed';
  if (isLegacyWindowsFolderPickerFailure(message)) {
    return [
      'The installed Shell Native Host is older than the extension and still passes folder picker labels as PowerShell command text.',
      'Open MCP > Shell Local > Shell Native Host, copy the generated install command from that page, run it, then restart the browser.',
      'Do not run a placeholder command with <extension-id>; the MCP page command includes the current browser and extension id.',
    ].join(' ');
  }
  return message;
}

function isLegacyWindowsFolderPickerFailure(message: string): boolean {
  return /powershell\.exe[\s\S]*-Command[\s\S]*FolderBrowserDialog/i.test(message) &&
    /CommandNotFoundException|ObjectNotFound|Choose a local Skill folder|Choose\s*:/i.test(message);
}
