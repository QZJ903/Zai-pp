import { USAGE_MESSAGE_COUNT } from '../constants';
import { toLocalDayKey } from './stats';
import type {
  TokenMetricSource,
  UsageRecordSource,
  UsageTurnRecord,
} from './types';

export function normalizeUsageTurnInput(input: unknown): UsageTurnRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Usage turn payload must be an object.');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Usage turn payload must be a plain object.');
  }
  const value = input as Record<string, unknown>;
  const id = normalizeString(value.id);
  if (!id) throw new Error('Usage turn id is required.');

  const recordedAt = normalizePositiveNumber(value.recordedAt, Date.now());
  const totalTokens = normalizeNonNegativeInteger(value.totalTokens);
  if (totalTokens === null) {
    throw new Error('Usage turn totalTokens must be a non-negative number.');
  }

  return {
    id,
    recordedAt,
    day: toLocalDayKey(recordedAt),
    source: normalizeUsageRecordSource(value.source),
    chatSessionId: normalizeString(value.chatSessionId),
    assistantMessageId: normalizeNullableInteger(value.assistantMessageId),
    modelType: normalizeString(value.modelType),
    totalTokens,
    tokenSource: normalizeMetricSource(value.tokenSource),
    tps: normalizePositiveNumber(value.tps, 0),
    speedSource: normalizeMetricSource(value.speedSource),
    elapsedMs: normalizePositiveNumber(value.elapsedMs, 0),
    messageCount: normalizePositiveInteger(value.messageCount, USAGE_MESSAGE_COUNT),
  };
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * ⚠️⚠️ **这里的整数判据必须与读回侧（`codec.ts` 的 `positiveInteger` /
 * `nonNegativeInteger`）用同一个取值域。**
 *
 * 写入侧产出的记录会原样落进 `chrome.storage.local`，下次读到它时过的是**读回侧**
 * 的判据。两侧对「什么是合法整数」的分歧，表现是**写进去了、读不出来** ——
 * 而读回失败会抛 `UsageStorageContractError` 并且**刻意不改写**存储
 * ⇒ 整份 usage 数据打不开，`getUsageRecords` / `recordUsageTurn` / `clearUsageRecords`
 * 全部失败。
 *
 * ⇒ 一律用 `Number.isSafeInteger`（`Number.isInteger` 会放行 `2**53`、`1e300` 这类
 * 超出安全整数范围的值，而读回侧会拒收）。
 */
function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return fallback;
  // `Math.round` 在这里只服务「上游偶尔传小数」这一档；取整后必须仍 > 0，
  // 否则 `0.4 → 0` 会产出一个读回侧拒收的值。
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : fallback;
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeNullableInteger(value: unknown): number | null {
  // Integer-only: rounding fractional message ids could alias a different
  // record (e.g. 3.6 → 4 collides with id 4).
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function normalizeMetricSource(value: unknown): TokenMetricSource {
  return value === 'server' ? 'server' : 'estimated';
}

function normalizeUsageRecordSource(value: unknown): UsageRecordSource {
  if (value === 'sidepanel-web' || value === 'sidepanel-api') return value;
  return 'glm-web';
}
