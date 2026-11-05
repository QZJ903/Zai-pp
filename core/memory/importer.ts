import type { Memory, MemoryType, NewMemory } from '../types';
import { MEMORY_CONTENT_MAX_CHARS } from '../constants';
import { memoryDedupeKey } from './dedupe';

export interface MemoryImportPreview {
  kind: 'memory_import_preview';
  memories: NewMemory[];
  duplicates: number;
  rejected: number;
  /**
   * 因为单次预览上限而被丢掉的条数。
   *
   * ⚠️⚠️ **这一档必须显式带出来，否则「少了 100 条」和「本来就只有 100 条」同形** ——
   * 预览列表是 `slice(0, MEMORY_IMPORT_PREVIEW_LIMIT)` 截的，而 `duplicates` /
   * `rejected` 都只统计被跳过的，不统计被砍掉的 ⇒ 三个数字看起来自洽，
   * 用户和模型都不知道还有下文。
   */
  omitted: number;
  /**
   * `rejected` 之中**因为正文超过 `MEMORY_CONTENT_MAX_CHARS`** 而拒的条数。
   *
   * ⚠️ **单列一档**：拒绝有三种成因（空正文 / 形状不对 / 超长），而超长是唯一一条
   * 用户能自己处理的（切分后重贴）。只报总数等于让人对着「拒绝 3 条」猜是哪三条。
   *
   * ⚠️ 超长**不再截断**，与 `memory_save` 同口径拒绝 —— 截断会让原文后半段永久丢失，
   * 而预览里看到的那一版正是落库的那一版，用户无从发现。
   */
  overLimit: number;
}

/**
 * 单次预览最多列出多少条候选记忆。
 *
 * ⚠️ 超出部分**丢弃但计数**（见 `omitted`）—— 静默丢是旧行为，
 * 现在的判据是「截断必须有信号」，与 `ToolResult.truncated` 同族。
 */
const MEMORY_IMPORT_PREVIEW_LIMIT = 100;

const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'topic', 'reference'];

export function previewMemoryImport(input: {
  content: string;
  defaultType?: MemoryType;
  tags?: string[];
  existingMemories?: readonly Memory[];
}): MemoryImportPreview {
  const defaultType = MEMORY_TYPES.includes(input.defaultType as MemoryType)
    ? input.defaultType as MemoryType
    : 'reference';
  const tags = normalizeTags(input.tags);
  const existingKeys = new Set((input.existingMemories ?? []).map((memory) => dedupeKey(memory.content)));
  const seenKeys = new Set<string>();
  let duplicates = 0;
  let rejected = 0;
  let overLimit = 0;

  const { memories: candidates, rejected: rejectedCandidates, overLimit: overLimitCandidates } =
    extractMemoryCandidates(input.content, defaultType, tags);
  rejected += rejectedCandidates;
  overLimit += overLimitCandidates;
  const memories: NewMemory[] = [];
  for (const candidate of candidates) {
    const key = dedupeKey(candidate.content);
    if (!key) {
      rejected += 1;
      continue;
    }
    if (existingKeys.has(key) || seenKeys.has(key)) {
      duplicates += 1;
      continue;
    }
    seenKeys.add(key);
    memories.push(candidate);
  }

  return {
    kind: 'memory_import_preview',
    memories: memories.slice(0, MEMORY_IMPORT_PREVIEW_LIMIT),
    duplicates,
    rejected,
    overLimit,
    omitted: Math.max(0, memories.length - MEMORY_IMPORT_PREVIEW_LIMIT),
  };
}

function extractMemoryCandidates(content: string, defaultType: MemoryType, tags: string[]): {
  memories: NewMemory[];
  rejected: number;
  overLimit: number;
} {
  const trimmed = content.trim();
  if (!trimmed) return { memories: [], rejected: 0, overLimit: 0 };

  const json = parseJson(trimmed);
  if (json) return extractJsonMemories(json, defaultType, tags);

  // One bad block rejects only that block — same rule the JSON branch already applies
  // per item. Without this, a single over-long paragraph would fail the whole preview.
  const memories: NewMemory[] = [];
  let rejected = 0;
  let overLimit = 0;
  const blocks = trimmed
    .split(/\n{2,}|\n(?=\s*[-*]\s+)/)
    .map((block) => block.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean);
  for (const block of blocks) {
    const verdict = classifyContent(block);
    if (verdict === 'empty') {
      rejected += 1;
      continue;
    }
    if (verdict === 'over_limit') {
      rejected += 1;
      overLimit += 1;
      continue;
    }
    memories.push(createMemoryFromText(block, defaultType, tags));
  }
  return { memories, rejected, overLimit };
}

function extractJsonMemories(value: unknown, defaultType: MemoryType, tags: string[]): {
  memories: NewMemory[];
  rejected: number;
  overLimit: number;
} {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { memories?: unknown }).memories)
      ? (value as { memories: unknown[] }).memories
      : [value];

  const memories: NewMemory[] = [];
  let rejected = 0;
  let overLimit = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      rejected += 1;
      continue;
    }
    const rawContent = firstString(item.content, item.text, item.value) ?? '';
    const verdict = classifyContent(rawContent);
    if (verdict !== 'ok') {
      rejected += 1;
      if (verdict === 'over_limit') overLimit += 1;
      continue;
    }
    memories.push({
      type: normalizeMemoryType(item.type, defaultType),
      name: normalizeTitle(firstString(item.name, item.title, item.key) ?? firstLine(rawContent)),
      content: rawContent.trim(),
      description: firstString(item.description, item.summary) ?? '',
      tags: mergeTags(tags, normalizeTags(item.tags)),
      pinned: item.pinned === true,
      ...(typeof item.syncId === 'string' && item.syncId.trim() ? { syncId: item.syncId.trim() } : {}),
    });
  }
  return { memories, rejected, overLimit };
}

function createMemoryFromText(text: string, type: MemoryType, tags: string[]): NewMemory {
  return {
    type,
    name: normalizeTitle(firstLine(text)),
    content: text.trim(),
    description: '',
    tags,
    pinned: false,
  };
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeMemoryType(value: unknown, fallback: MemoryType): MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType) ? value as MemoryType : fallback;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter(Boolean))];
}

function mergeTags(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? 'Imported memory';
}

function normalizeTitle(value: string): string {
  const title = value.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
  return (title || 'Imported memory').slice(0, 80);
}

/**
 * 一条候选正文的结论：可用 / 空 / 超长。
 *
 * ⚠️ 超长**不再截断**，与 `memory_save` 同口径拒绝（那边报 `invalidContentTooLong`）。
 * 截断的代价是原文后半段永久丢失，而预览里那一版正是落库的那一版。
 */
function classifyContent(value: string): 'ok' | 'empty' | 'over_limit' {
  const content = value.trim();
  if (!content) return 'empty';
  if (content.length > MEMORY_CONTENT_MAX_CHARS) return 'over_limit';
  return 'ok';
}

function dedupeKey(content: string): string {
  return memoryDedupeKey(content);
}
