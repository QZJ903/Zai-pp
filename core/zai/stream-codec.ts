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
      return stripZaiThinkingBlocks(text);
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

/**
 * 剥掉 z.ai 的思考块，只取最终答案正文。
 *
 * z.ai 的思考内联在 `answer` 相位的 `delta_content` 里、包在 `<details>…</details>`
 * 中，**不是**独立的 `phase:"thinking"` 帧 —— 所以按 phase 过滤无效，只能按标签剥。
 * 真机抓样确认思考块恒在 `assistantText` 最前（推理先于答案）。
 *
 * ⚠️ **只在 `assistantText` 出口调用，绝不能改内部累积的 `text`** ——
 * `edit_content` 的 `edit_index` 是相对**原始文本**的 UTF-16 偏移，
 * 内部剥掉 details 会让之后所有偏移错位、正文碎裂。
 *
 * 只剥**开头**的块（不剥全文所有块）：模型在答案中段讨论 / 用代码围栏举例
 * `<details>` 时，开头不是它 ⇒ 不被误剥。唯一不可约的假阳性是「回答恰好以裸的
 * 未围栏 `<details>…</details>` 开头且后续仍有正文」，极罕见。
 *
 * ⚠️ **另一个已知残余：嵌套 `<details>`** —— 正则非贪婪，`<details>思考<details>内层</details>更多</details>正文`
 * 会剥成 `更多</details>正文`（留半截思考 + 一个孤立闭标签）。真机思考块内嵌 `<details>` 概率极低，
 * 未处理；孤立的 `</details>` 会进 `extractXmlTagNames` 的诊断（只影响诊断噪声，不影响执行）。
 */
export function stripZaiThinkingBlocks(text: string): string {
  if (!text || !text.toLowerCase().includes('<details')) return text;
  let out = text;
  // 剥开头的思考块（连续多个也一并剥）。
  for (;;) {
    const match = ZAI_LEADING_DETAILS_RE.exec(out);
    if (!match) break;
    const rest = out.slice(match[0].length);
    // 剥完必须还有正文，否则不认它是思考块 —— 防「回答本身就是个 details 元素」被误剥。
    // ⚠️ **返回 `out` 而不是 `text`** —— 此时前面几轮已剥掉的思考块不该被「吐回来」。
    if (!rest.trim()) return out;
    out = rest;
  }
  // 剥完后若仍以未闭合的 `<details` 开头 ⇒ 流被截断，砍到结尾。
  if (ZAI_LEADING_DETAILS_OPEN_RE.test(out)) {
    out = out.slice(0, out.search(ZAI_LEADING_DETAILS_OPEN_RE));
  }
  return out.replace(/^\s+/, '');
}

const ZAI_LEADING_DETAILS_RE = /^\s*<details\b[^>]*>[\s\S]*?<\/details>/i;
const ZAI_LEADING_DETAILS_OPEN_RE = /^\s*<details\b/i;

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
  // JS string.slice 本身就是 UTF-16 code-unit 语义。⚠️ 必须**两个端点都夹**：
  // 只夹 `start`、切到 `start`（原写法）会让 `edit_content` 被当成整体替换。
  const clampedStart = Math.max(0, Math.min(start, value.length));
  const clampedEnd = Math.max(clampedStart, Math.min(end, value.length));
  return value.slice(clampedStart, clampedEnd);
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