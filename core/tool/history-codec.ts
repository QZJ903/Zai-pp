import { isToolCallHistoryRecord } from '../messaging/tool-record-codec';
import type { ToolCallHistoryRecord } from './types';

export class ToolHistoryStorageContractError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ToolHistoryStorageContractError';
  }
}

/** Strict decoder for the released bare-array Tool History contract. */
export function decodeToolCallHistory(
  raw: unknown,
  path = 'toolHistory',
): ToolCallHistoryRecord[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(path, 'Expected the released tool history array.');

  const ids = new Set<string>();
  return raw.map((value, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isToolCallHistoryRecord(value)) fail(itemPath, 'Invalid tool history record.');
    const record = value as unknown as ToolCallHistoryRecord;
    if (ids.has(record.id)) fail(itemPath, `Duplicate tool history id: ${record.id}.`);
    ids.add(record.id);
    return record;
  });
}

/**
 * 读侧专用：**跳过**不合法的单条记录，只保留能解的。
 *
 * ⚠️⚠️ **只有「读」可以宽容，写仍然必须严格** —— 两者的失败方向完全不同：
 * - **写**宽容 = 把一条畸形记录存进去，此后每次读都受它影响；
 * - **读**严格 = 一条坏记录让**整份历史**读不出来，而它恰好是「清空历史」这个
 *   自救动作自己也要先读的那一步 ⇒ 坏数据连自杀都做不到。
 *
 * ⚠️ **只降级「单条不合法」与「id 重复」两档**；`raw` 不是数组（整份形状错）
 * 仍然抛 —— 那一档说明这个键被别的东西占了，继续「宽容」等于把它当历史用。
 *
 * ⚠️ 重复 id 保留**第一条**：数组按时间倒序存（新的在前），而重复 id 意味着
 * 同一个调用被写了两次，丢掉后来插入的那条不影响展示。
 */
export function decodeToolCallHistoryTolerant(
  raw: unknown,
  path = 'toolHistory',
): { records: ToolCallHistoryRecord[]; dropped: number } {
  if (raw === undefined) return { records: [], dropped: 0 };
  if (!Array.isArray(raw)) fail(path, 'Expected the released tool history array.');

  const records: ToolCallHistoryRecord[] = [];
  const ids = new Set<string>();
  let dropped = 0;
  raw.forEach((value, index) => {
    if (!isToolCallHistoryRecord(value)) {
      dropped += 1;
      return;
    }
    const record = value as unknown as ToolCallHistoryRecord;
    if (ids.has(record.id)) {
      dropped += 1;
      return;
    }
    ids.add(record.id);
    records.push(record);
  });
  return { records, dropped };
}

export function encodeToolCallHistory(
  records: readonly ToolCallHistoryRecord[],
): ToolCallHistoryRecord[] {
  return decodeToolCallHistory([...records]);
}

/**
 * 解 `GET_TOOL_CALL_HISTORY` 的响应：`{ records, dropped }`。
 *
 * ⚠️ **形状必须严判** —— 它跨 runtime 边界回来，`record` 那半边走的是严格解码器
 * （坏一条就抛，与磁盘上的宽容读**不是一个口径**：那批数据刚由写侧校验过）。
 * ⚠️ 侧边栏只取 `records`，`dropped` 留给内容脚本打页面控制台日志。
 */
export function decodeToolCallHistoryEnvelope(
  raw: unknown,
  path = 'toolHistoryEnvelope',
): { records: ToolCallHistoryRecord[]; dropped: number } {
  if (!isPlainRecord(raw)) fail(path, 'Expected a tool history envelope object.');
  return {
    records: decodeToolCallHistory(raw.records, `${path}.records`),
    dropped: typeof raw.dropped === 'number' && Number.isFinite(raw.dropped) ? raw.dropped : 0,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(path: string, message: string): never {
  throw new ToolHistoryStorageContractError(path, message);
}
