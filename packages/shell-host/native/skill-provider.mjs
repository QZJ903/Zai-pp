import { basename, dirname, join } from 'node:path';
import {
  LOCAL_SCRIPT_EXTENSIONS,
  LOCAL_SKILL_ERROR_CODES,
  LOCAL_TEXT_RESOURCE_EXTENSIONS,
  MAX_LOCAL_PREVIEW_FRAME_BYTES,
  MAX_LOCAL_RESOURCE_BYTES_PER_SKILL,
  MAX_LOCAL_RESOURCE_FILE_BYTES,
  MAX_LOCAL_RESOURCE_FILES_PER_SKILL,
  MAX_LOCAL_SKILL_BYTES,
  MAX_LOCAL_SKILLS,
  MAX_LOCAL_TOTAL_CONTENT_BYTES,
} from './contracts.mjs';
import {
  readTextFile,
  resolveLocalPath,
  resolveUnderRoot,
  safeReadDirectory,
  safeStat,
} from './file-provider.mjs';

export function createSkillToolHandlers() {
  return [{ name: 'local_skill_preview', handle: createLocalSkillPreviewResult }];
}

/**
 * A preview failure that carries a **structured code**.
 *
 * ⚠️ The extension branches on `code` (only "the folder is gone" leads to a re-pick
 * prompt), never on the message text. Every `throw` in this file therefore has to carry
 * one — an uncoded throw degrades to `local_skill_preview_failed`, which the UI reports
 * as a plain error without offering the folder picker.
 */
class LocalSkillPreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalSkillPreviewError';
    this.code = code;
  }
}

function createLocalSkillPreviewResult(args) {
  const rootInput = args?.rootPath;
  if (typeof rootInput !== 'string' || rootInput.trim().length === 0) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'rootPath is required and must be a non-empty string.' }],
    };
  }

  try {
    const selectedPaths = Array.isArray(args?.selectedPaths)
      ? new Set(args.selectedPaths.filter(item => typeof item === 'string' && item.trim()).map(normalizeRelativePath))
      : null;
    const data = scanLocalSkillFolder(rootInput, selectedPaths);
    return {
      content: [{ type: 'text', text: `Found ${data.skills.length} local Skill(s) in ${data.rootPath}` }],
      structuredContent: {
        ok: true,
        data,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The failure envelope mirrors the success one (`{ ok, ... }`) so the extension can
    // read a machine-readable reason instead of pattern-matching `content[0].text`.
    const code = err instanceof LocalSkillPreviewError
      ? err.code
      : LOCAL_SKILL_ERROR_CODES.PREVIEW_FAILED;
    return {
      isError: true,
      content: [{ type: 'text', text: message }],
      structuredContent: {
        ok: false,
        error: { code, message },
      },
    };
  }
}

function scanLocalSkillFolder(rootInput, selectedPaths) {
  const rootPath = resolveLocalPath(rootInput);
  const rootStat = safeStat(rootPath);
  if (!rootStat || !rootStat.isDirectory()) {
    throw new LocalSkillPreviewError(LOCAL_SKILL_ERROR_CODES.ROOT_UNREADABLE, `Local Skill root is not a readable directory: ${rootPath}`);
  }

  const warnings = [];
  const allSkillPaths = findLocalSkillPaths(rootPath);
  if (allSkillPaths.length === 0) {
    throw new LocalSkillPreviewError(LOCAL_SKILL_ERROR_CODES.NOT_FOUND, `No SKILL.md found under ${rootPath}`);
  }
  if (allSkillPaths.length > MAX_LOCAL_SKILLS) {
    warnings.push(`Found ${allSkillPaths.length} Skills; preview is limited to ${MAX_LOCAL_SKILLS}.`);
  }

  // Filter first, then cap: a path the caller named explicitly must not be lost to
  // the preview limit — otherwise the import path reports "not found" for a Skill
  // that is right there on disk.
  const requestedPaths = selectedPaths
    ? allSkillPaths.filter(path => selectedPaths.has(path))
    : allSkillPaths;
  if (selectedPaths && requestedPaths.length === 0) {
    throw new LocalSkillPreviewError(LOCAL_SKILL_ERROR_CODES.PATHS_MISSING, 'Selected local Skill paths were not found under the root path.');
  }
  const selected = requestedPaths.slice(0, MAX_LOCAL_SKILLS);
  if (selectedPaths && requestedPaths.length > MAX_LOCAL_SKILLS) {
    warnings.push(`Selected ${requestedPaths.length} Skills; preview is limited to ${MAX_LOCAL_SKILLS}.`);
  }

  let totalContentBytes = 0;
  const skills = [];
  const unreadablePaths = [];
  for (const skillPath of selected) {
    let item;
    try {
      item = readLocalSkill(rootPath, skillPath, totalContentBytes);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // One unreadable Skill must not abort a whole-folder preview — but an explicit
      // selection must not degrade into "path not found" either. The import path
      // turns a missing entry into `Selected local Skill paths were not found`, which
      // points the user at the path when the real cause is the file itself.
      if (selectedPaths) {
        // Keep the inner code (too-large vs unreadable are different stories) while
        // wrapping the message so the caller can still tell which Skill failed.
        throw new LocalSkillPreviewError(
          error instanceof LocalSkillPreviewError ? error.code : LOCAL_SKILL_ERROR_CODES.UNREADABLE,
          `Selected local Skill could not be read (${skillPath}): ${reason}`,
        );
      }
      unreadablePaths.push(skillPath);
      warnings.push(`${skillPath} was skipped: ${reason}`);
      continue;
    }
    totalContentBytes += item.contentBytes;
    skills.push(item.skill);
    warnings.push(...item.warnings);
  }
  // Whole-folder preview where nothing at all could be read is not a useful empty
  // result — say so instead of returning an empty list.
  if (skills.length === 0 && unreadablePaths.length > 0) {
    throw new LocalSkillPreviewError(LOCAL_SKILL_ERROR_CODES.UNREADABLE, `No local Skill could be read under ${rootPath}: ${unreadablePaths.join(', ')}`);
  }

  const displayName = basename(rootPath) || rootPath;
  const trimmed = fitSkillsToPreviewFrame({
    rootPath,
    displayName,
    directoryName: displayName,
    skills,
    warnings,
    requestedExplicitly: Boolean(selectedPaths),
  });

  return {
    rootPath,
    displayName,
    directoryName: displayName,
    skills: trimmed.skills,
    warnings: dedupeStrings(trimmed.warnings),
    truncated: allSkillPaths.length > MAX_LOCAL_SKILLS
      || requestedPaths.length > MAX_LOCAL_SKILLS
      || unreadablePaths.length > 0
      || trimmed.omittedPaths.length > 0
      || trimmed.truncatedBodyPaths.length > 0
      || warnings.some(warning => warning.includes('content budget')),
  };
}

/**
 * Keep the response inside the native frame budget.
 *
 * The constraint is the serialized frame, and how much a Skill costs after JSON
 * escaping depends on its content — quotes and backslashes double, control
 * characters grow six-fold. A fixed byte budget on the raw text would either drop
 * Skills that would have fit or still overflow on escape-heavy content, so this
 * measures the real cost and drops from the tail.
 *
 * A preview (no explicit request) drops the overflow and says so. An explicit
 * request is not silently shortened: the caller asked for those Skills by name, and
 * the import path turns missing entries into "path not found".
 */
function fitSkillsToPreviewFrame({ rootPath, displayName, directoryName, skills, warnings, requestedExplicitly }) {
  const frameCost = (list, warningList) => Buffer.byteLength(JSON.stringify({
    rootPath,
    displayName,
    directoryName,
    skills: list,
    warnings: warningList,
    truncated: true,
  }), 'utf8');

  const total = frameCost(skills, warnings);
  if (total <= MAX_LOCAL_PREVIEW_FRAME_BYTES) {
    return { skills, warnings, omittedPaths: [], truncatedBodyPaths: [] };
  }

  if (requestedExplicitly) {
    throw new LocalSkillPreviewError(
      LOCAL_SKILL_ERROR_CODES.PREVIEW_TOO_LARGE,
      `Selected ${skills.length} Skills would produce a ${total} byte response, over the ${MAX_LOCAL_PREVIEW_FRAME_BYTES} byte preview limit. Import them in smaller batches.`,
    );
  }

  // Cost each Skill once, then drop from the tail while the running total is over
  // budget. Re-serializing the whole payload per drop would be quadratic.
  const nextWarnings = [...warnings];
  const skillCosts = skills.map(skill => Buffer.byteLength(JSON.stringify(skill), 'utf8') + 1);
  let running = total;
  const omittedPaths = [];
  while (skills.length > 1 && running > MAX_LOCAL_PREVIEW_FRAME_BYTES) {
    const index = skills.length - 1;
    const dropped = skills.pop();
    running -= skillCosts[index];
    omittedPaths.unshift(dropped.path);
    const before = Buffer.byteLength(JSON.stringify(nextWarnings), 'utf8');
    nextWarnings.push(`${dropped.path} was omitted because the preview response would exceed the size limit.`);
    running += Buffer.byteLength(JSON.stringify(nextWarnings), 'utf8') - before;
  }

  // A single Skill can still be over budget on its own (large body plus escape-heavy
  // supporting files). Truncating that one is better than returning a frame the
  // browser would reject — and the note belongs on the Skill itself so it survives
  // into the import record.
  const truncatedBodyPaths = [];
  if (skills.length === 1 && running > MAX_LOCAL_PREVIEW_FRAME_BYTES) {
    const only = skills[0];
    const note = `${only.path} was truncated because the preview response would exceed the size limit.`;
    // Both notes go in before measuring, so the amount shaved off the body covers
    // the bytes the notes themselves add.
    const before = Buffer.byteLength(JSON.stringify(nextWarnings), 'utf8');
    nextWarnings.push(note);
    running += Buffer.byteLength(JSON.stringify(nextWarnings), 'utf8') - before;
    const costBefore = Buffer.byteLength(JSON.stringify(only), 'utf8');
    only.warnings = [...(only.warnings ?? []), note];
    running += Buffer.byteLength(JSON.stringify(only), 'utf8') - costBefore;
    const shrinkBy = Math.max(0, running - MAX_LOCAL_PREVIEW_FRAME_BYTES);
    only.content = truncateJsonBudget(only.content, shrinkBy);
    only.bodyBytes = Buffer.byteLength(only.content, 'utf8');
    truncatedBodyPaths.push(only.path);

    // The body is not the only thing a Skill carries: `scriptFiles` / `omittedFiles`
    // are path lists with no count cap, so emptying the body can still leave the
    // frame over budget. Returning that would report success for a response that is
    // silently cut off downstream — fail loudly instead.
    const settled = Buffer.byteLength(JSON.stringify({
      rootPath,
      displayName,
      directoryName,
      skills,
      warnings: nextWarnings,
      truncated: true,
    }), 'utf8');
    if (settled > MAX_LOCAL_PREVIEW_FRAME_BYTES) {
      throw new LocalSkillPreviewError(
        LOCAL_SKILL_ERROR_CODES.PREVIEW_TOO_LARGE,
        `${only.path} cannot be reduced under the ${MAX_LOCAL_PREVIEW_FRAME_BYTES} byte preview limit (${settled} bytes remain after truncating the body). This Skill lists too many supporting or script files — import it from a folder with fewer files.`,
      );
    }
  }

  return { skills, warnings: nextWarnings, omittedPaths, truncatedBodyPaths };
}

// Shrink `text` so its JSON-escaped form loses at least `shrinkBy` bytes, without
// splitting a character. Binary-search the longest prefix that fits.
function truncateJsonBudget(text, shrinkBy) {
  const escapedBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') - 2;
  const target = Math.max(0, escapedBytes(text) - shrinkBy);
  if (escapedBytes(text) <= target) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (escapedBytes(text.slice(0, mid)) <= target) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

function findLocalSkillPaths(rootPath) {
  const result = [];
  walkLocalDirectory(rootPath, '', (relativePath, absolutePath, entry) => {
    if (!entry.isFile()) return;
    if (entry.name === 'SKILL.md') result.push(normalizeRelativePath(relativePath));
  });
  return result.sort((a, b) => a.localeCompare(b));
}

function readLocalSkill(rootPath, skillPath, usedContentBytes) {
  const absoluteSkillPath = resolveUnderRoot(rootPath, skillPath);
  const skillStat = safeStat(absoluteSkillPath);
  if (!skillStat || !skillStat.isFile()) {
    throw new LocalSkillPreviewError(LOCAL_SKILL_ERROR_CODES.UNREADABLE, `Local Skill file is not readable: ${skillPath}`);
  }
  if (skillStat.size > MAX_LOCAL_SKILL_BYTES) {
    throw new LocalSkillPreviewError(LOCAL_SKILL_ERROR_CODES.TOO_LARGE, `${skillPath} exceeds the SKILL.md size limit (${skillStat.size} bytes).`);
  }

  const content = readTextFile(absoluteSkillPath);
  const directory = normalizeRelativePath(dirname(skillPath));
  const directoryPath = dirname(absoluteSkillPath);
  const bundle = collectLocalSkillResources(rootPath, directory, content, usedContentBytes + Buffer.byteLength(content, 'utf8'));
  const skill = {
    path: skillPath,
    directory,
    directoryPath,
    content,
    bodyBytes: Buffer.byteLength(content, 'utf8'),
    includedFiles: bundle.includedFiles,
    omittedFiles: bundle.omittedFiles,
    scriptFiles: bundle.scriptFiles,
    warnings: bundle.warnings,
  };
  const contentBytes = skill.bodyBytes + bundle.includedFiles.reduce((sum, file) => sum + file.bytes, 0);
  return {
    skill,
    contentBytes,
    warnings: bundle.warnings,
  };
}

function collectLocalSkillResources(rootPath, directory, skillBody, startingContentBytes) {
  const prefix = directory ? directory + '/' : '';
  const candidates = [];
  walkLocalDirectory(resolveUnderRoot(rootPath, directory || '.'), prefix, (relativePath, absolutePath, entry) => {
    if (!entry.isFile()) return;
    const normalized = normalizeRelativePath(relativePath);
    if (normalized === `${prefix}SKILL.md` || normalized.endsWith('/SKILL.md')) return;
    const stat = safeStat(absolutePath);
    if (!stat) return;
    candidates.push({
      path: normalized,
      absolutePath,
      bytes: stat.size,
    });
  }, { stopAtNestedSkillRoots: true });

  const scriptFiles = candidates
    .filter(candidate => isLocalScriptFile(candidate.path))
    .map(({ path, bytes }) => ({ path, bytes }));
  const textCandidates = candidates
    .filter(candidate => isLocalTextResource(candidate.path))
    .sort((a, b) => rankLocalResource(a.path, skillBody) - rankLocalResource(b.path, skillBody) || a.path.localeCompare(b.path));

  const includedFiles = [];
  const omittedFiles = [];
  const warnings = [];
  let resourceBytes = 0;
  let totalBytes = startingContentBytes;

  for (const candidate of textCandidates) {
    if (includedFiles.length >= MAX_LOCAL_RESOURCE_FILES_PER_SKILL) {
      omittedFiles.push({ path: candidate.path, bytes: candidate.bytes });
      continue;
    }
    if (candidate.bytes > MAX_LOCAL_RESOURCE_FILE_BYTES) {
      omittedFiles.push({ path: candidate.path, bytes: candidate.bytes });
      warnings.push(`${candidate.path} exceeds the per-file resource limit and was not bundled.`);
      continue;
    }
    if (resourceBytes + candidate.bytes > MAX_LOCAL_RESOURCE_BYTES_PER_SKILL) {
      omittedFiles.push({ path: candidate.path, bytes: candidate.bytes });
      continue;
    }
    if (totalBytes + candidate.bytes > MAX_LOCAL_TOTAL_CONTENT_BYTES) {
      omittedFiles.push({ path: candidate.path, bytes: candidate.bytes });
      warnings.push(`${candidate.path} was omitted because the local Skill preview reached the content budget.`);
      continue;
    }

    const content = readTextFile(candidate.absolutePath);
    const bytes = Buffer.byteLength(content, 'utf8');
    resourceBytes += bytes;
    totalBytes += bytes;
    includedFiles.push({ path: candidate.path, bytes, content });
  }

  return { includedFiles, omittedFiles, scriptFiles, warnings: dedupeStrings(warnings) };
}

function walkLocalDirectory(rootPath, prefix, visit, options = {}) {
  const stack = [{ absolutePath: rootPath, relativePrefix: prefix }];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = safeReadDirectory(current.absolutePath);
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.svn' || entry.name === '.hg') continue;
      const absolutePath = join(current.absolutePath, entry.name);
      const relativePath = normalizeRelativePath(join(current.relativePrefix, entry.name));
      visit(relativePath, absolutePath, entry);
      if (entry.isDirectory()) {
        if (options.stopAtNestedSkillRoots && hasLocalSkillFile(absolutePath)) continue;
        stack.push({ absolutePath, relativePrefix: relativePath });
      }
    }
  }
}

function hasLocalSkillFile(directoryPath) {
  return safeStat(join(directoryPath, 'SKILL.md'))?.isFile() === true;
}

function isLocalTextResource(path) {
  return LOCAL_TEXT_RESOURCE_EXTENSIONS.has(pathExtension(path));
}

function isLocalScriptFile(path) {
  return LOCAL_SCRIPT_EXTENSIONS.has(pathExtension(path));
}

function rankLocalResource(path, skillBody) {
  const relativeName = path.split('/').slice(-2).join('/');
  if (skillBody.includes(path) || skillBody.includes(relativeName)) return 0;
  if (path.includes('/agents/')) return 1;
  if (path.includes('/references/')) return 2;
  if (path.includes('/templates/')) return 3;
  if (path.includes('/examples/')) return 4;
  return 5;
}

function pathExtension(path) {
  const name = path.split('/').pop() ?? '';
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

function normalizeRelativePath(path) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return normalized === '.' ? '' : normalized;
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

// --- Shell execution ---
