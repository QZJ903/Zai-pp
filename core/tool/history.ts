import type {
  JsonValue,
  ToolCall,
  ToolCallHistoryRecord,
  ToolExecutionTrigger,
  ToolResult,
} from './types';
import { decodeToolCallHistoryTolerant, encodeToolCallHistory } from './history-codec';
import { createCoalescingMutationQueue } from '../persistence/coalescing-mutation-queue';
import { TOOL_OUTPUT_MAX_CHARS } from './result-bytes';

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

/**
 * 一次读的结果 + **被丢掉的条数**。
 *
 * ⚠️⚠️ **`dropped` 必须能跨进程带出去** —— 只在本模块 `console.log` 的话，它只出现在
 * `chrome://extensions` 的 service worker 控制台，而**用户按 F12 看的是页面控制台**，
 * 两者不是一个地方。内容脚本拿到这个数后再打一行 log，才是「用户能看见」的那条。
 */
export interface ToolCallHistoryReadResult {
  records: ToolCallHistoryRecord[];
  dropped: number;
}

export interface ToolCallHistoryReadOptions {
  limit?: number;
  /**
   * 只看某一个 provider（MCP 服务）的记录。
   *
   * ⚠️⚠️ **必须先筛再截** —— 界面说的是「这个服务的最近调用」，那这个条数就必须
   * 只数它自己的。先 `slice` 再筛时，别的服务活跃几次就能把它挤到 0 条，而界面
   * 照旧显示「暂无调用」。
   *
   * ⚠️ **`limit` 的语义随它变**：给了 `serverId` 是「这个服务最近 N 条」，没给是
   * 「全体最近 N 条」。这也是本函数收对象入参的原因 —— 两个位置参数一个数字一个
   * 字符串，传反了 `slice(0, 'abc')` 不抛错、只是返回空数组。
   */
  serverId?: string;
}

export async function getToolCallHistoryReport(
  options: ToolCallHistoryReadOptions = {},
): Promise<ToolCallHistoryReadResult> {
  const limit = options.limit ?? MAX_HISTORY;
  const serverId = options.serverId;
  return toolHistoryOperations.barrier(async () => {
    const { records, dropped } = await readToolHistoryBare();
    const ordered = orderToolCallHistory(records);
    // ⚠️ **`dropped` 恒为全量口径** —— 它是解码整键时丢掉的坏记录数，与过滤无关。
    // 给了 `serverId` 之后，「这个服务 3 条 + 丢了 5 条」里的那 5 条可能全属于别的
    // 服务，别把两个数并起来读。
    const scoped = serverId === undefined
      ? ordered
      : ordered.filter((record) => record.call.provider?.id === serverId);
    return { records: scoped.slice(0, limit).map(restoreOutputSnapshot), dropped };
  });
}

export async function getToolCallHistory(
  options: ToolCallHistoryReadOptions = {},
): Promise<ToolCallHistoryRecord[]> {
  return (await getToolCallHistoryReport(options)).records;
}

export async function clearToolCallHistory(): Promise<void> {
  await toolHistoryOperations.barrier(async () => {
    await chrome.storage.local.remove(TOOL_HISTORY_STORAGE_KEY);
  });
}

/**
 * 读回本模块拥有的整键历史，**连同被丢掉的条数一起返回**。
 *
 * ⚠️⚠️ **读宽容、写严格，两者不对称是有意的**：
 * - **写**（`encodeToolCallHistory`）仍然严格 —— 保证落库的每一条都合法；
 * - **读**必须宽容 —— 否则一条坏记录会让**整份历史**读不出来，连带三条路一起死：
 *   ① `getToolCallHistory` 读不出（面板退回只有摘要）；
 *   ② `persistToolHistoryBurst` 读不出 ⇒ 此后**每次工具执行**都失败，
 *      并被包成 `tool_post_effect_persistence_failed`（「可能已执行、别重试」）；
 *   ③ `clearToolCallHistory` 旧版也要先读 ⇒ **连清空这个自救动作都做不到**。
 *
 * ⚠️ **整份形状错（不是数组）仍然抛** —— 那一档说明这个键被别的东西占了，
 * 把它当历史用只会写出更乱的数据。
 *
 * ⚠️ **本函数不打日志** —— 丢弃信号要由**能看到用户的地方**打（内容脚本的页面控制台）。
 * 这一层只负责把数带出去，理由见 `ToolCallHistoryReadResult`。
 */
async function readToolHistoryBare(): Promise<ToolCallHistoryReadResult> {
  const data = await chrome.storage.local.get(TOOL_HISTORY_STORAGE_KEY) as Record<string, unknown>;
  return decodeToolCallHistoryTolerant(data[TOOL_HISTORY_STORAGE_KEY]);
}

/** 写侧与 `persistToolHistoryBurst` 用的薄封装：只要记录、丢弃数由调用方决定怎么报。 */
async function readToolCallHistoryAlreadyOwned(): Promise<ToolCallHistoryRecord[]> {
  return (await readToolHistoryBare()).records;
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
 *
 * ## 两类结构化结果单列更宽的上限（`STRUCTURED_OUTPUT_LIMITS`）
 *
 * ⚠️⚠️ **这两个工具不是「偶尔超」，是「写长就必超」** —— 而超了不是少看一点，
 * 是**卡片整个退化成纯文本、按钮静默消失**（`restoreOutputSnapshot` 解析不回来）。
 * 实测（`JSON.stringify` 后的字符数）：
 * - `skill_draft_create` 允许 16_000 字符指令 ⇒ 产出 JSON **16 755**（全角）
 *   ~ **64 755**（指令里全是反斜杠时的最坏转义）字符；
 * - `memory_import_preview` 单条记忆上限 8_000 字 ⇒ 5 条就 **10 328** 字符。
 *
 * 所以按 `kind` 给两档更宽的上限，**但仍然截断** —— 不截的版本实测会让
 * `memory_import_preview` 单条到 816 KB、100 条 230 MB（预算只有 7.5 MB），
 * `trimToFit` 会砍到只剩个位数，把别的工具的记录一起挤掉。
 * ⇒ 这里的判据是「够画卡片，超了照旧降级」，不是「越大越好」。
 */
const STRUCTURED_OUTPUT_LIMITS: ReadonlyMap<string, number> = new Map([
  // 16_000 字符指令 + 名称/描述/警告的最坏转义 ≈ 64 KB，刚好装下。
  ['skill_draft', 64_000],
  // 32 KB 能装下约 15 条满长记忆；再多就说明用户该分批导入了。
  ['memory_import_preview', 32_000],
]);

function sanitizeResult(result: ToolResult): ToolResult {
  return {
    ...result,
    detail: truncateString(result.detail, 4_000),
    output: result.output === undefined
      ? undefined
      : truncateString(JSON.stringify(result.output), outputLimitFor(result.output)),
    error: result.error
      ? {
        ...result.error,
        message: truncateString(result.error.message, 2_000) ?? '',
        details: result.error.details ? truncateRecord(result.error.details, 2_000) : undefined,
      }
      : undefined,
  };
}

function outputLimitFor(output: JsonValue): number {
  const kind = output && typeof output === 'object' && !Array.isArray(output)
    ? (output as Record<string, unknown>).kind
    : undefined;
  return typeof kind === 'string'
    ? STRUCTURED_OUTPUT_LIMITS.get(kind) ?? TOOL_OUTPUT_MAX_CHARS
    : TOOL_OUTPUT_MAX_CHARS;
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
