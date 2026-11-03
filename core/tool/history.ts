import type {
  JsonValue,
  ToolCall,
  ToolCallHistoryRecord,
  ToolExecutionTrigger,
  ToolResult,
} from './types';
import { decodeToolCallHistory, encodeToolCallHistory } from './history-codec';
import { createCoalescingMutationQueue } from '../persistence/coalescing-mutation-queue';

export const TOOL_HISTORY_STORAGE_KEY = 'zai_pp_tool_history';
// Lowered from 200 → 100. Each record carries detail/output snapshots, and each
// persisted burst replaces the whole key. 200 records of untrimmed MCP output
// easily pushed the serialized payload past chrome.storage.local's QUOTA_BYTES
// (10 MB), which then failed on every subsequent write. 100
// trimmed records keep the working set well under quota.
const MAX_HISTORY = 100;
// Reserve headroom so other storage keys (memories, skills, settings) are not
// evicted when tool history grows. 0.75 of the per-key budget.
const HISTORY_BUDGET_RATIO = 0.75;
type ToolHistoryMutation = {
  call: ToolCall;
  result: ToolResult;
  source: ToolExecutionTrigger;
};
const toolHistoryOperations = createCoalescingMutationQueue<
  ToolHistoryMutation,
  ToolCallHistoryRecord
>(persistToolHistoryBurst);

export async function appendToolCallHistory(
  call: ToolCall,
  result: ToolResult,
  source: ToolExecutionTrigger,
): Promise<ToolCallHistoryRecord> {
  return toolHistoryOperations.mutate({ call, result, source });
}

async function persistToolHistoryBurst(
  mutations: readonly ToolHistoryMutation[],
): Promise<ToolCallHistoryRecord[]> {
  let history = orderToolCallHistory(await readToolCallHistoryAlreadyOwned());
  const results: ToolCallHistoryRecord[] = [];
  const budgetBytes = getHistoryBudgetBytes();
  for (const { call, result, source } of mutations) {
    const record: ToolCallHistoryRecord = {
      id: crypto.randomUUID(),
      call: sanitizeCall(call),
      result: sanitizeResult(result),
      source,
      createdAt: Date.now(),
    };
    history = trimToFit([record, ...history.slice(0, MAX_HISTORY)], budgetBytes)
      .slice(0, MAX_HISTORY);
    results.push(record);
  }
  await chrome.storage.local.set({
    [TOOL_HISTORY_STORAGE_KEY]: encodeToolCallHistory(history),
  });
  return results;
}

export async function getToolCallHistory(limit: number = MAX_HISTORY): Promise<ToolCallHistoryRecord[]> {
  return toolHistoryOperations.barrier(async () => {
    const history = orderToolCallHistory(await readToolCallHistoryAlreadyOwned());
    return history.slice(0, limit).map(restoreOutputSnapshot);
  });
}

export async function clearToolCallHistory(): Promise<void> {
  await toolHistoryOperations.barrier(async () => {
    await readToolCallHistoryAlreadyOwned();
    await chrome.storage.local.remove(TOOL_HISTORY_STORAGE_KEY);
  });
}

async function readToolCallHistoryAlreadyOwned(): Promise<ToolCallHistoryRecord[]> {
  const data = await chrome.storage.local.get(TOOL_HISTORY_STORAGE_KEY) as Record<string, unknown>;
  return decodeToolCallHistory(data[TOOL_HISTORY_STORAGE_KEY]);
}

function orderToolCallHistory(
  history: readonly ToolCallHistoryRecord[],
): ToolCallHistoryRecord[] {
  return [...history].sort((a, b) => b.createdAt - a.createdAt);
}

function sanitizeCall(call: ToolCall): ToolCall {
  return {
    ...call,
    payload: truncateRecord(call.payload, 4_000),
    raw: call.raw.length > 4_000 ? `${call.raw.slice(0, 4_000)}\n...[truncated]` : call.raw,
  };
}

/**
 * 落库前裁一遍 `detail` / `output` / `error`。
 *
 * ⚠️⚠️ **这里的 4_000 是「工具面板刷新后回读」的预算，不是模型看到的那个上限。**
 * 两个消费者服务的东西不同：
 * - **续跑 prompt** 读的是内存里的 `executionsByRequest`，**没经过本函数**；
 *   它对 `browser_snapshot` 的 detail 单列了 `BROWSER_SNAPSHOT_DETAIL_MAX_CHARS`
 *   （24_000，见 `core/zai/continuation.ts`）—— 模型要看全快照才能点对元素。
 * - **本函数**落的是 `zai_pp_tool_history`，给面板回读用。人看一屏够了，
 *   而这块**受配额硬约束**：`MAX_HISTORY`（100 条）× 这份上限就是整键的体积，
 *   而 `chrome.storage.local` 只有 10 MB、写超了是**之后每次写都失败**
 *   （见文件头那段 200 → 100 的事故记录）。
 *
 * ⇒ **别看到 24_000 就回来把这里抬上去。** 真要抬得先算配额：
 * 现在 `100 × (4_000 + 8_000)` 约 1.2 MB，抬到 24_000 就是 3.2 MB。
 */
function sanitizeResult(result: ToolResult): ToolResult {
  return {
    ...result,
    detail: truncateString(result.detail, 4_000),
    output: result.output === undefined ? undefined : truncateString(JSON.stringify(result.output), 8_000),
    error: result.error
      ? {
        ...result.error,
        message: truncateString(result.error.message, 2_000) ?? '',
        details: result.error.details ? truncateRecord(result.error.details, 2_000) : undefined,
      }
      : undefined,
  };
}

function truncateRecord(value: Record<string, unknown>, maxLength: number): Record<string, unknown> {
  const json = JSON.stringify(value);
  if (json.length <= maxLength) return value;
  return { truncated: true, preview: json.slice(0, maxLength) };
}

function truncateString(value: string | undefined, maxLength: number): string | undefined {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated]`;
}

/**
 * 把落库时序列化成字符串的 `output` 还原回对象。
 *
 * ⚠️⚠️ **不还原的后果是静默的**：落库时 `output` 被 `JSON.stringify` 成字符串
 * （见 `sanitizeResult`，为的是让它受同一套字符上限约束），而**结构化结果的消费者
 * 全部按对象形状判**（`tool-result-renderer` 的两个 `get*Output` 都是
 * `typeof value !== 'object'` 就返回 null）⇒ 读回来的记录画不出卡片，
 * 表现是「刷新后保存按钮没了」，没有任何报错。
 * ⚠️ **只在读取侧还原、写入侧保持字符串** —— 反过来改会让已经落库的旧记录仍然坏着。
 * ⚠️ **截断过的还原不了**（末尾带 `...[truncated]`，JSON 不完整）⇒ 原样留着，
 * 消费方按「形状不对」退回纯文本，与改造前行为一致。
 */
function restoreOutputSnapshot(record: ToolCallHistoryRecord): ToolCallHistoryRecord {
  const output = record.result?.output;
  if (typeof output !== 'string') return record;
  const parsed = tryParseJson(output);
  if (parsed === undefined) return record;
  return { ...record, result: { ...record.result, output: parsed } };
}

function tryParseJson(value: string): JsonValue | undefined {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * Drop the oldest records until the serialized history fits within the budget.
 * Prevents the chrome.storage.local.set() call from throwing QUOTA_BYTES on
 * every tool call once the key fills up. The newest record is
 * always retained so the current execution is never lost.
 */
function trimToFit(records: ToolCallHistoryRecord[], budgetBytes: number): ToolCallHistoryRecord[] {
  let candidate = records;
  while (candidate.length > 1) {
    const serialized = JSON.stringify(candidate);
    if (new Blob([serialized]).size <= budgetBytes) return candidate;
    // Drop oldest (highest index after we prepended the newest at index 0).
    candidate = candidate.slice(0, -1);
  }
  return candidate;
}

function getHistoryBudgetBytes(): number {
  // chrome.storage.local.QUOTA_BYTES is 10 MB (10,485,760) for unpacked/packed
  // extensions; fall back to that constant if the runtime does not expose it.
  const quota = (chrome.storage.local.QUOTA_BYTES as number | undefined) ?? 10_485_760;
  return Math.floor(quota * HISTORY_BUDGET_RATIO);
}
