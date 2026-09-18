/**
 * chat.z.ai SSE 流解析。
 *
 * 每行 `data: {...}`，envelope `{type:"chat:completion", data:{phase}}`。
 * phase 全集见 contracts.ts；文本三语义：
 *   - delta_content            → 追加
 *   - content                  → 整体替换（reset 后写入）
 *   - edit_content+edit_index  → substring 替换（edit_index 为 UTF-16 code-unit 偏移）
 *
 * 用途：在 fetch hook 里把 SSE 字节里的工具 XML 识别出来、并作字节级透传
 * （扩展只「读」流、不改页面渲染的字节），同时累积 assistant 文本用于工具解析。
 */

import {
  ZAI_SSE_ENVELOPE_TYPE,
  ZAI_SSE_PHASES,
  type ZaiSsePhase,
} from './contracts';

export interface ZaiSseEvent {
  phase: ZaiSsePhase;
  parsed: Record<string, unknown>;
  raw: string;
}

export interface ZaiSseParseResult {
  events: ZaiSseEvent[];
  appendedText: string;
}

/**
 * 一个可累积 assistant 文本的解析器。`consumeZaiSseData` 推进状态，
 * `assistantText` 是当前累积的正文（三语义合并）。
 */
export interface ZaiStreamAccumulator {
  assistantText: string;
  push(text: string): ZaiSseParseResult;
  finish(): ZaiSseParseResult;
}

/**
 * 逐 data-line 解析。扩展需要的是「识别增量文本里的工具 XML」，因此这里
 * 只做每帧的枚举 + 文本累积，不做跨帧的 edit 语义历史还原（三语义各自
 * 直接落到 accumulated text：delta_content 追加、content 替换、edit_content 局部替换）。
 */
export function parseZaiSseData(data: string): ZaiSseEvent | null {
  if (!data) return null;
  const trimmed = data.trim();
  if (!trimmed || trimmed === '[DONE]') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;

  // envelope: {"type":"chat:completion","data":{"phase":...}}
  let inner: Record<string, unknown> | null = null;
  if (record.type === ZAI_SSE_ENVELOPE_TYPE && isRecord(record.data)) {
    inner = record.data as Record<string, unknown>;
  } else if (typeof record.phase === 'string') {
    inner = record;
  }
  if (!inner) return null;

  const phase = typeof inner.phase === 'string' ? (inner.phase as ZaiSsePhase) : 'other';
  return { phase, parsed: inner, raw: trimmed };
}

/**
 * 增量消费一段 SSE 文本，累积 assistant 正文并枚举事件。
 * 文本三语义（delta_content=append / content=replace / edit_content+edit_index=substring replace）。
 */
export function consumeZaiSseData(
  accumulator: ZaiStreamAccumulator,
  text: string,
): ZaiSseParseResult {
  return accumulator.push(text);
}

export function createZaiStreamAccumulator(): ZaiStreamAccumulator {
  let text = '';
  // SSE 的 `data:` 行可能跨 TextDecoder 分片被截断，必须把未完结的行缓存到下一次 push。
  let pending = '';

  const applyPhase = (event: ZaiSseEvent): string => {
    const d = event.parsed;
    const dc = readString(d.delta_content);
    if (dc) {
      text += dc;
      return dc;
    }
    const content = readString(d.content);
    if (content) {
      text = content;
      return content;
    }
    const ec = readString(d.edit_content);
    if (ec) {
      // edit_index 是 UTF-16 code-unit 偏移（浏览器字符串索引语义）。
      const editIndex = readFiniteNumber(d.edit_index) ?? 0;
      const prefix = utf16SafeSlice(text, 0, editIndex);
      text = prefix + ec;
      return ec;
    }
    return '';
  };

  const processLine = (line: string): ZaiSseEvent | null => {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!trimmed.startsWith('data:')) return null;
    const data = trimmed.slice(5).trimStart();
    if (!data) return null;
    return parseZaiSseData(data);
  };

  return {
    get assistantText() {
      return text;
    },
    push(chunk: string): ZaiSseParseResult {
      const events: ZaiSseEvent[] = [];
      let appendedText = '';
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const event = processLine(line);
        if (!event) continue;
        events.push(event);
        appendedText += applyPhase(event);
      }
      return { events, appendedText };
    },
    finish(): ZaiSseParseResult {
      const events: ZaiSseEvent[] = [];
      let appendedText = '';
      if (pending) {
        const event = processLine(pending);
        pending = '';
        if (event) {
          events.push(event);
          appendedText += applyPhase(event);
        }
      }
      return { events, appendedText };
    },
  };
}

/** 在 SSE 累积文本里提取工具 XML（供 fetch hook 增广侧判断是否需要续跑）。 */
export function extractZaiToolCalls(
  text: string,
  toolNames: ReadonlySet<string>,
): Array<{ name: string; raw: string }> {
  if (!text || toolNames.size === 0) return [];
  const pattern = new RegExp(
    `<\\s*(${Array.from(toolNames).map(escapeRegExp).join('|')})\\b[^>]*>`,
    'gi',
  );
  const found: Array<{ name: string; raw: string }> = [];
  for (const match of text.matchAll(pattern)) {
    found.push({ name: match[1], raw: match[0] });
  }
  return found;
}

/** 解析 SSE 内嵌错误详情（HTTP 200 但 body 里带 error）。 */
export function extractZaiErrorDetail(from: unknown): string {
  const record = isRecord(from) ? from : null;
  if (!record) return '';
  const data = isRecord(record.data) ? record.data : null;
  const error = data ? (isRecord(data.error) ? data.error : null) : null;
  if (!error) return '';
  if (typeof error.detail === 'string' && error.detail) return error.detail;
  if (typeof error.message === 'string' && error.message) return error.message;
  return '';
}

function utf16SafeSlice(value: string, start: number, end: number): string {
  // JS string.slice 本身就是 UTF-16 code-unit 语义，直接 slice 即可。
  const clampedStart = Math.max(0, Math.min(start, value.length));
  return value.slice(0, clampedStart);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const ZAI_SSE_PHASE_SET: ReadonlySet<string> = new Set(ZAI_SSE_PHASES);