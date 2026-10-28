import type { Memory } from '../types';
import { MEMORY_TOKEN_BUDGET, STOP_WORDS } from '../constants';
import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n/background';
import { estimateTokens } from '../token/estimator';

export { estimateTokens } from '../token/estimator';

const segmenter =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('zh-Hans', { granularity: 'word' })
    : null;

const SEGMENT_CACHE_LIMIT = 1000;
const segmentCache = new Map<string, string[]>();

export function segmentText(text: string): string[] {
  const cached = segmentCache.get(text);
  if (cached) return cached;

  const words = segmenter
    ? [...segmenter.segment(text)]
      .filter((s) => s.isWordLike)
      .map((s) => s.segment.toLowerCase())
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    : text
      .toLowerCase()
      .split(/[\s,，。！？；：、\-_/]+/)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  if (segmentCache.size >= SEGMENT_CACHE_LIMIT) {
    const firstKey = segmentCache.keys().next().value;
    if (firstKey !== undefined) segmentCache.delete(firstKey);
  }
  segmentCache.set(text, words);
  return words;
}

function keywordScore(promptWords: string[], memory: Memory): number {
  const promptSet = new Set(promptWords);

  let tagHits = 0;
  for (const tag of memory.tags) {
    const tagLower = tag.toLowerCase();
    if (tagLower.length > 1 && promptSet.has(tagLower)) tagHits++;
    for (const pw of promptWords) {
      if (pw.length > 2 && tagLower.includes(pw) && tagLower !== pw) tagHits += 0.5;
    }
  }

  const nameWords = segmentText(memory.name);
  let nameHits = 0;
  for (const w of nameWords) {
    if (promptSet.has(w)) nameHits++;
  }

  const contentWords = segmentText(memory.content);
  let contentHits = 0;
  for (const w of contentWords) {
    if (promptSet.has(w)) contentHits++;
  }

  return tagHits * 20 + nameHits * 15 + contentHits * 5;
}

function decayScore(memory: Memory): number {
  const daysSinceAccess = (Date.now() - memory.lastAccessedAt) / 86_400_000;
  const freshness = Math.max(0, 10 - daysSinceAccess * 0.1);
  return Math.min(memory.accessCount, 20) + freshness;
}

export interface SelectOptions {
  budget?: number;
  identityOnly?: boolean;
  locale?: SupportedLocale;
}

/**
 * 一条被选中的记忆 + **注入时实际使用的正文**。
 *
 * ⚠️ **正文与 `memory.content` 分开存**，不直接改写 `memory` —— 调用方拿到的是
 * 存储里的原对象，若把截断后的内容写回去就会污染库（这里是唯一消费者、当前安全，
 * 但接口不该给这种机会）。
 */
export interface SelectedMemory {
  memory: Memory;
  /** 注入时实际使用的正文（可能已被截断）。 */
  content: string;
  /** 正文被截断过；`formatMemoryLine` 据此追加「已截断」标记。 */
  truncated: boolean;
}

export function getMemoryBudget(promptTokens: number): number {
  if (promptTokens > 3000) {
    return Math.max(800, MEMORY_TOKEN_BUDGET - Math.floor((promptTokens - 3000) * 0.2));
  }
  return MEMORY_TOKEN_BUDGET;
}

export function selectMemories(
  prompt: string,
  allMemories: Memory[],
  options?: SelectOptions,
): SelectedMemory[] {
  if (allMemories.length === 0) return [];

  const {
    budget = MEMORY_TOKEN_BUDGET,
    identityOnly = false,
    locale = DEFAULT_LOCALE,
  } = options ?? {};

  const candidates = identityOnly
    ? allMemories.filter((m) => m.type === 'user' || m.type === 'feedback' || m.pinned)
    : allMemories;

  if (candidates.length === 0) return [];

  const promptWords = segmentText(prompt);

  const scored = candidates.map((m) => ({
    memory: m,
    score:
      (m.pinned ? 1000 : 0) +
      keywordScore(promptWords, m) +
      decayScore(m) +
      (Date.now() - m.lastAccessedAt < 3600_000 ? 5 : 0),
  }));

  scored.sort((a, b) => b.score - a.score);

  const selected: SelectedMemory[] = [];
  let remaining = budget;

  for (const { memory } of scored) {
    const cost = estimateTokens(formatMemoryLine(memory, locale));
    if (cost <= remaining) {
      selected.push({ memory, content: memory.content, truncated: false });
      remaining -= cost;
      continue;
    }
    // ⚠️ **放不下时不再无条件收下** —— 早先的判据是
    // `if (remaining - cost < 0 && selected.length > 0) break;`，那个附加条件让
    // **第一条永不因超预算被拒**，而记忆正文此前没有长度上限 ⇒ 一条 4 万字的记忆
    // 能把注入撑到预算的 16 倍，之后每一轮都要多付这些 token。
    // 现在：第一条截断到预算内（保证至少有一条），后续条目维持「放不下就停」。
    if (selected.length > 0) break;
    const truncated = truncateContentToBudget(memory, remaining, locale);
    if (!truncated) break;
    selected.push({ memory, content: truncated, truncated: true });
    break;
  }

  return selected;
}

/**
 * 把正文截到「含截断标记后仍不超过 `remaining`」的最长前缀。
 *
 * ⚠️ **标记本身也算预算** —— 否则截断后仍会超，预算就不是上限了。
 * ⚠️ **二分而不是按比例估** —— `estimateTokens` 按字符类别计价（CJK 0.6 / ASCII 0.3），
 * 同样的字符数代价可能差一倍，按比例估会算错。
 *
 * ⚠️ **不需要再防「切在代理对中间」** —— `estimateTokenUnits` 用 `for...of` 按**码点**
 * 迭代，而孤立高代理（`'a\ud83d'`）与完整 emoji（`'a😀'`）算出的代价**完全相同**；
 * 二分取的是「最大的合法 `mid`」⇒ 永远落在完整码点边界上。实测扫 6 种前缀长度 ×
 * 3000 个 budget，切半一次都不发生（写过的防护是死代码，已删）。
 *
 * 连一个字符加标记都放不下时返回 `null`（调用方据此判「这条进不来」）。
 */
function truncateContentToBudget(
  memory: Memory,
  remaining: number,
  locale: SupportedLocale,
): string | null {
  if (remaining <= 0) return null;

  let low = 0;
  let high = memory.content.length;
  let best = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = formatMemoryLine({ ...memory, content: memory.content.slice(0, mid) }, locale, true);
    if (estimateTokens(candidate) <= remaining) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (best < 1) return null;
  return memory.content.slice(0, best);
}

function sanitizeContent(text: string): string {
  return text.replace(/｜DSML｜/g, '|DSML|');
}

export function formatMemoryLine(
  m: Memory,
  locale: SupportedLocale = DEFAULT_LOCALE,
  truncated = false,
): string {
  const idPrefix = m.id != null ? `#${m.id} ` : '';
  const body = sanitizeContent(m.content);
  const withMarker = truncated
    ? `${body} ${translate(locale, 'prompt.memoryTruncated')}`
    : body;
  return `- ${idPrefix}[${m.type}] ${sanitizeContent(m.name)}: ${withMarker}`;
}

export function formatMemoriesBlock(
  memories: readonly SelectedMemory[],
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  if (memories.length === 0) return translate(locale, 'prompt.memoryEmpty');
  return memories
    .map((entry) => formatMemoryLine(
      { ...entry.memory, content: entry.content },
      locale,
      entry.truncated,
    ))
    .join('\n');
}
