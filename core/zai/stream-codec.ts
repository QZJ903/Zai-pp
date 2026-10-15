/**
 * z.ai SSE 流解析（两站同形）。
 *
 * 每行 `data: {...}`，envelope `{type:"chat:completion", data:{phase}}`。
 * phase 全集见 contracts.ts；文本三语义：
 *   - delta_content            → 追加
 *   - content                  → 整体替换（reset 后写入）
 *   - edit_content+edit_index  → substring 替换（edit_index 为 UTF-16 code-unit 偏移）
 *
 * 用途：在 fetch hook 里解析 SSE，累积 assistant 文本用于工具识别与兜底解析。
 *
 * ⚠️ **本文件不碰回给页面的字节** —— 它只「读」流。改字节的是 `stream-strip.ts`
 * （工具 XML 剥离），两者的输入都是**原始** wire，互不依赖。
 */

import {
  ZAI_SSE_ENVELOPE_TYPE,
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
 * `assistantText` 是当前累积的**答案正文**（三语义合并 + 按相位切掉思考）。
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
  /**
   * 答案正文在 `text` 里的起点（UTF-16 偏移）；`null` = 到目前为止全是思考。
   *
   * ⚠️⚠️ **思考必须靠 phase 分，不能靠 `<details>` 标签** —— 真机实测（2026-10）
   * `phase:"thinking"` 帧的 `delta_content` 是**裸文本**，整段累积里 `<details` 出现 0 次。
   * 而旧版站点（2025-12）把思考内联在 `answer` 相位里、包在 `<details>` 中 ⇒
   * `stripZaiThinkingBlocks` 当时够用。**那个前提已经消失**，所以出口那个函数
   * 现在只是「内联 details」那一路的兜底，真正分流在这里。
   * 漏掉这一步的后果不是「多显示一段思考」：`assistantText` 同时是
   * `extractAndNotifyToolCalls` 与兜底 `parseToolXml` 的输入 ⇒
   * **模型写在思考里的完整工具 XML 会被真的执行**。
   *
   * ⚠️ **不能改成「内部累积时就丢掉思考」** —— `edit_content` 的 `edit_index` 是
   * 相对**完整文本**的绝对偏移，内部丢字符会让之后所有偏移错位、正文碎裂。
   * 所以分流只发生在出口（见 `assistantText` getter）。
   */
  let answerStart: number | null = null;

  /** `thinking` 是唯一的「非答案」相位；未知相位一律按答案算（失败方向安全）。 */
  const isThinkingPhase = (phase: ZaiSsePhase): boolean => phase === 'thinking';

  const applyPhase = (event: ZaiSseEvent): string => {
    const d = event.parsed;
    const thinking = isThinkingPhase(event.phase);
    const dc = readString(d.delta_content);
    if (dc) {
      // 首个「非思考相位且带文本」的帧定下答案起点 —— 记的是**追加前**的长度。
      if (answerStart === null && !thinking) answerStart = text.length;
      text += dc;
      return dc;
    }
    const content = readString(d.content);
    if (content) {
      // 整体替换：这段文本的归属由**本帧自己的相位**决定，不继承上一帧。
      answerStart = thinking ? null : 0;
      text = content;
      return content;
    }
    const ec = readString(d.edit_content);
    if (ec) {
      // edit_index 是 UTF-16 code-unit 偏移（浏览器字符串索引语义）。
      const editIndex = readFiniteNumber(d.edit_index) ?? 0;
      const prefix = utf16SafeSlice(text, 0, editIndex);
      // ⚠️ 落点若在答案起点**之前**（含「答案还没开始」），这次改写就覆盖了分流点 ⇒
      // 重定到 edit 之后。落点在答案之内则起点不动（前缀没被碰）。
      // 这是**近似**：认为「edit 之后的内容都算答案」。
      if (editIndex <= (answerStart ?? Number.POSITIVE_INFINITY)) {
        answerStart = thinking ? null : editIndex;
      }
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
      // 先按相位切掉思考（真机：思考是独立的 `thinking` 相位、裸文本），
      // 再过一遍 details 剥离（旧版站点把思考内联在 `answer` 里的那一档兜底）。
      // 两步都只在出口做，内部 `text` 始终是完整的服务端原文。
      const answer = answerStart === null ? '' : utf16SafeSlice(text, answerStart, text.length);
      return stripZaiThinkingBlocks(answer);
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
 * 剥掉内联在正文里的思考块，只取最终答案正文。
 *
 * ⚠️⚠️ **这不是思考分流的主路径** —— 主路径是 `assistantText` getter 里的
 * `answerStart` 按 **phase** 切分。本函数处理的是**另一种站点形态**：思考内联在
 * `answer` 相位的 `delta_content` 里、包在 `<details>…</details>` 中。
 *
 * ⚠️ **成立前提已变（2026-10 真机实测）**：`phase:"thinking"` 现在是**独立相位**、
 * 内容是**裸文本**，整段累积里 `<details` 出现 **0 次** ⇒ 本函数在生产路径上
 * 直接走第一行的快速返回、等价于 no-op。旧版站点（2025-12）确实是内联 + details，
 * 当时它是唯一的分流手段。**留着是因为那个形态可能因灰度或回滚再现** ——
 * 但**别再把它当成「思考已经被挡住了」的依据**。
 *
 * ⚠️ **只在 `assistantText` 出口调用，绝不能改内部累积的 `text`** ——
 * `edit_content` 的 `edit_index` 是相对**原始文本**的 UTF-16 偏移，
 * 内部剥掉 details 会让之后所有偏移错位、正文碎裂。
 *
 * 只剥**开头**的块（不剥全文所有块）：模型在答案中段讨论 / 用代码围栏举例
 * `<details>` 时，开头不是它 ⇒ 不被误剥。唯一不可约的假阳性是「回答恰好以裸的
 * 未围栏 `<details>…</details>` 开头且后续仍有正文」，极罕见。
 *
 * ⚠️⚠️ **必须按「配平的闭合标签」剥，不能用非贪婪正则** —— 非贪婪会在**内层**的
 * `</details>` 处收手，`<details>思考<details>内层</details>更多</details>正文`
 * 会剥成 `更多</details>正文`：外层剩下的半截思考被当成正文留下。
 * 而 `assistantText` 是工具识别的输入（`extractAndNotifyToolCalls` 与兜底
 * `parseToolXml`），**模型写在思考里的工具 XML 会因此漏出去并真的被执行** ——
 * 单层时那种 XML 会随整块一起被剥掉，嵌套时这个保护就没了。
 */
export function stripZaiThinkingBlocks(text: string): string {
  if (!text || !text.toLowerCase().includes('<details')) return text;
  let out = text;
  // 剥开头的思考块（连续多个也一并剥）。
  for (;;) {
    // 先按配平的闭合标签整块剥（见上方说明）。
    const balancedEnd = findBalancedLeadingDetailsEnd(out);
    if (balancedEnd !== null) {
      const rest = out.slice(balancedEnd);
      // 剥完必须还有正文，否则不认它是思考块 —— 防「回答本身就是个 details 元素」被误剥。
      // ⚠️ 这一档**退回下面的非贪婪路径**，不能直接 `return out`：`out` 可能是一整个
      // 嵌套块，整段吐回去会把思考里的工具 XML 一并交出去。
      if (rest.trim()) {
        out = rest;
        continue;
      }
    }
    const match = ZAI_LEADING_DETAILS_RE.exec(out);
    if (!match) break;
    const rest = out.slice(match[0].length);
    if (!rest.trim()) return out;
    out = rest;
  }
  // 剥完后若仍以未闭合的 `<details` 开头 ⇒ 流被截断，砍到结尾。
  if (ZAI_LEADING_DETAILS_OPEN_RE.test(out)) {
    out = out.slice(0, out.search(ZAI_LEADING_DETAILS_OPEN_RE));
  }
  return out.replace(/^\s+/, '');
}

/**
 * 取「开头那个配平的 `<details>` 块」的结束偏移。不配平（从未闭合 / 内层未闭合）返回 null，
 * 交给非贪婪路径按截断语义处理。
 *
 * 判据是**深度归零**，不是「遇到第一个 `</details>`」—— 后者正是嵌套形态剥错的成因。
 */
function findBalancedLeadingDetailsEnd(text: string): number | null {
  if (!ZAI_LEADING_DETAILS_OPEN_RE.test(text)) return null;
  let depth = 0;
  ZAI_DETAILS_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ZAI_DETAILS_TAG_RE.exec(text))) {
    if (match[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return match.index + match[0].length;
    } else {
      depth += 1;
    }
  }
  return null;
}

const ZAI_LEADING_DETAILS_RE = /^\s*<details\b[^>]*>[\s\S]*?<\/details>/i;
const ZAI_LEADING_DETAILS_OPEN_RE = /^\s*<details\b/i;
const ZAI_DETAILS_TAG_RE = /<details\b[^>]*>|<\/details\s*>/gi;

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
