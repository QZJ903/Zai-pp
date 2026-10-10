/**
 * z.ai completion 流的**工具 XML 剥离**（跑在页面主世界）。
 *
 * 模型输出的 `<shell_exec>{…}</shell_exec>` 会**原样留在对话正文里**，刷新后
 * 服务端存的那份也还在。历史侧（`history-cleanup.ts`）管刷新后那份，本文件管
 * **当场那一份** —— 边流边剥，页面自始至终看不到工具 XML。
 *
 * ## 两层结构
 *
 * - **文本层**（`createZaiToolXmlTextFilter`）：吃「正文增量」，返回「现在可以放行
 *   的正文」。跨帧的块靠**扣住尾巴**处理 —— 实测同一个 `<memory_save>` 的开标签与
 *   闭标签落在**两个不同的帧**里。
 * - **wire 层**（`createZaiCompletionStreamRewriter`）：吃解码后的 SSE 文本，按行
 *   拆开、只改 `data:` 行里的正文，再拼回去。
 *
 * ⚠️⚠️ **必须按帧解析、不能直接对 wire 文本做字符串替换** —— SSE 行是
 * `data: {"delta_content":"…<shell_exec>…"}`，标签的 `<` 在 **JSON 字符串内部**。
 * 对原始文本做「找块、删块」会把 JSON 本身剪坏（少一个引号就整帧解析失败），
 * 表现是页面**整段回答消失**。
 *
 * ⚠️⚠️ **遇到 `edit_content` 就关掉剥离**（用户拍板的防御）。`edit_index` 是相对
 * **服务端累积文本**的绝对 UTF-16 偏移，而我们剥掉字符后页面那份更短 ⇒ 之后的
 * edit 会错位、**被剥掉的 XML 可能被整段写回来**。真机实测（2026-10，三轮含工具
 * 调用与 190 帧长回答）**零 `edit_content`**，所以这条路当前不触发；一旦触发就
 * 退回原样透传，宁可看得见 XML，也不要正文碎裂。
 * ⚠️ **已知残余**：若 edit 出现在**已经剥过**的流里，那段已放行的文本无法撤回 ——
 * 防御只能保证「不再继续剥」。上游的 `XmlToolStreamFilter` 之所以能一直剥，是因为
 * DeepSeek 的补丁是 `{p, o:'APPEND', v}` **纯追加、没有绝对偏移**；z.ai 有
 * `edit_index`，所以那套**不能直接搬**。
 *
 * ⚠️ **不做空行折叠** —— 上游有一整套跨帧围栏状态机（9 条用例）专门折叠剥完残留的
 * `\n\n\n\n`。markdown 渲染下连续空行本来只呈现一个空行，**先不做**（真机看效果再定）。
 */

import { findFirstXmlToolTag, getPartialXmlToolTagTailLength } from '../tool/xml-tags';

interface BlockRange {
  start: number;
  end: number;
}

/**
 * 扫出文本里的工具块。
 *
 * ⚠️ **未闭合的那一个要单独返回起点**（而不是像 `findZaiToolXmlStripRanges` 那样
 * 只判「一直空到文末」）—— 流式语义下「闭标签还没到」是常态，必须从开标签起扣住。
 */
function scanBlocks(
  text: string,
  nameSet: ReadonlySet<string>,
): { complete: BlockRange[]; unterminatedStart: number | null } {
  const complete: BlockRange[] = [];
  let fromIndex = 0;
  while (fromIndex < text.length) {
    const open = findFirstXmlToolTag(text, nameSet, { closing: false, fromIndex });
    if (!open) break;
    // 闭标签只在**同名**里找（与 `findZaiToolXmlBlocks` 同口径）。
    const close = findFirstXmlToolTag(
      text,
      new Set([open.name]),
      { closing: true, fromIndex: open.endIndex },
    );
    if (!close) return { complete, unterminatedStart: open.index };
    complete.push({ start: open.index, end: close.endIndex });
    fromIndex = close.endIndex;
  }
  return { complete, unterminatedStart: null };
}

function removeRanges(text: string, ranges: readonly BlockRange[], limit: number): string {
  if (ranges.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.end > limit) break;
    parts.push(text.slice(cursor, range.start));
    cursor = range.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

export interface ZaiToolXmlTextFilter {
  /** 吃一段正文增量，返回**现在可以放行**的正文（可能是空串）。 */
  push(delta: string): string;
  /** 流结束：把扣住的尾巴全部放行（未闭合的块也一并删掉）。 */
  finish(): string;
  /** 丢掉扣住的尾巴（正文被整体替换时，它属于**被替换掉**的那一段）。 */
  discard(): void;
  /** 关掉剥离并交出扣住的原文（遇到 `edit_content` 时调用）。 */
  disable(): string;
  readonly disabled: boolean;
  /** 当前扣住多少字符（0 = 上一帧的正文已经全部放行）。 */
  readonly heldLength: number;
}

/**
 * 文本层：跨帧扣住「可能还没写完的标签」，其余放行。
 *
 * ⚠️ **扣住的判据有三条，缺一条就会漏**：
 * ① 尾部可能是**半个开标签**（`<shell_ex`）→ 用 `getPartialXmlToolTagTailLength`；
 * ② 尾部是**完整开标签但闭标签还没到**（`<shell_exec>` 后什么都没有）→ 从该开标签扣起；
 * ③ **跨越放行点的完整块** → 放行点必须退到该块起点（否则会删掉半个块）。
 */
export function createZaiToolXmlTextFilter(names: readonly string[]): ZaiToolXmlTextFilter {
  const nameSet = new Set(names);
  const enabled = nameSet.size > 0;
  let held = '';
  let off = false;

  const holdPoint = (text: string, final: boolean): number => {
    if (final) return text.length;
    const { complete, unterminatedStart } = scanBlocks(text, nameSet);
    let holdFrom = text.length;
    if (unterminatedStart !== null) holdFrom = Math.min(holdFrom, unterminatedStart);
    const partial = getPartialXmlToolTagTailLength(text, nameSet, { closing: false });
    if (partial > 0) holdFrom = Math.min(holdFrom, text.length - partial);
    for (const range of complete) {
      if (range.start < holdFrom && range.end > holdFrom) holdFrom = range.start;
    }
    return holdFrom;
  };

  const drain = (final: boolean): string => {
    const { complete, unterminatedStart } = scanBlocks(held, nameSet);
    const limit = holdPoint(held, final);
    const prefix = held.slice(0, limit);
    held = held.slice(limit);
    // ⚠️ **流结束时那个未闭合的块要一起删掉** —— 它是「回答被截断在工具标签里」，
    // 那半截标签同样是内部协议、不该给用户看。`scanBlocks` 只返回**完整**块，
    // 所以这里要显式补上未闭合那一段（否则扣住的载荷会被原样吐给页面）。
    const ranges = final && unterminatedStart !== null
      ? [...complete, { start: unterminatedStart, end: prefix.length }]
      : complete;
    return removeRanges(prefix, ranges, limit);
  };

  return {
    push(delta) {
      if (!delta) return '';
      if (off || !enabled) return delta;
      held += delta;
      return drain(false);
    },
    finish() {
      if (off || !enabled) {
        const rest = held;
        held = '';
        return rest;
      }
      return drain(true);
    },
    discard() {
      held = '';
    },
    disable() {
      if (off) return '';
      off = true;
      const rest = held;
      held = '';
      return rest;
    },
    get disabled() {
      return off || !enabled;
    },
    get heldLength() {
      return held.length;
    },
  };
}

export interface ZaiStreamRewriteResult {
  /** 可以放行的 wire 文本。 */
  text: string;
  /** `true` = 本块**逐字节未改**，调用方可以直接透传原始字节。 */
  unchanged: boolean;
}

export interface ZaiCompletionStreamRewriter {
  push(chunk: string): ZaiStreamRewriteResult;
  finish(): ZaiStreamRewriteResult;
  /** 是否已经因为遇到 `edit_content` 而关掉剥离。 */
  readonly disabled: boolean;
}

/**
 * wire 层：按行拆开 SSE，只改 `data:` 行里的正文，其余原样拼回。
 *
 * ⚠️ **`unchanged` 是承重的** —— 没改动时调用方透传**原始字节**，于是
 * 「不剥的场景」（未匹配到块、已禁用、非 completion 路由）保持**逐字节不变**，
 * 那条既有不变量只在真正发生剥离时才失效。
 */
export function createZaiCompletionStreamRewriter(
  names: readonly string[],
): ZaiCompletionStreamRewriter {
  const filter = createZaiToolXmlTextFilter(names);
  const encoder = new TextEncoder();
  let pending = '';
  let lastPhase = 'answer';

  /** 把扣住的正文包成一条合成的 delta 帧（关掉剥离 / 流结束时用）。 */
  const syntheticDeltaFrame = (text: string): string => (
    text
      ? `data: ${JSON.stringify({
        type: 'chat:completion',
        data: { phase: lastPhase, delta_content: text },
      })}\n\n`
      : ''
  );

  const rewriteLine = (line: string): { text: string; changed: boolean } => {
    // 行尾换行（可能是 `\n` 或 `\r\n`）要原样保留。
    const body = line.endsWith('\n')
      ? (line.endsWith('\r\n') ? line.slice(0, -2) : line.slice(0, -1))
      : line;
    const eol = line.slice(body.length);
    if (!body.startsWith('data:')) return { text: line, changed: false };

    const payload = body.slice(5).trimStart();
    if (!payload || payload === '[DONE]') return { text: line, changed: false };

    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return { text: line, changed: false };
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return { text: line, changed: false };
    }
    const envelope = json as Record<string, unknown>;
    const inner = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
      ? (envelope.data as Record<string, unknown>)
      : envelope;

    if (typeof inner.phase === 'string') lastPhase = inner.phase;

    // ⚠️ 遇到 edit 立刻关掉剥离：偏移语义已经不可信，宁可露出 XML 也不要正文碎裂。
    if (typeof inner.edit_content === 'string') {
      const flushed = filter.disable();
      return { text: syntheticDeltaFrame(flushed) + line, changed: true };
    }

    // 正文三语义里只有 delta（追加）与 content（整体替换）需要过剥。
    const key = typeof inner.delta_content === 'string'
      ? 'delta_content'
      : (typeof inner.content === 'string' ? 'content' : null);
    if (!key) return { text: line, changed: false };

    const original = inner[key] as string;
    // `content` 是**整体替换**：先丢掉扣住的尾巴（它属于被替换掉的那一段）。
    if (key === 'content') filter.discard();
    const visible = filter.push(original);
    if (visible === original) return { text: line, changed: false };

    inner[key] = visible;
    const prefix = body.slice(0, body.length - payload.length);
    return { text: `${prefix}${JSON.stringify(envelope)}${eol}`, changed: true };
  };

  return {
    push(chunk) {
      const pendingBefore = pending;
      pending += chunk;
      let out = '';
      let changed = false;
      let start = 0;
      for (;;) {
        const nl = pending.indexOf('\n', start);
        if (nl === -1) break;
        const line = pending.slice(start, nl + 1);
        start = nl + 1;
        const result = rewriteLine(line);
        out += result.text;
        if (result.changed) changed = true;
      }
      pending = pending.slice(start);
      // 「逐字节未改」= 本块没触发任何改写、且进出都没有半个行留在手上。
      const unchanged = !changed && pendingBefore === '' && pending === '';
      return unchanged ? { text: chunk, unchanged: true } : { text: out, unchanged: false };
    },
    finish() {
      // ⚠️ **顺序是承重的**：扣住的正文在逻辑上**早于**末尾那半行，必须先放行。
      // 反过来的话「末行是扣住正文的续写」时会被拼到前面去。
      const flushed = filter.finish();
      const tail = pending;
      pending = '';
      const text = syntheticDeltaFrame(flushed) + tail;
      return { text, unchanged: false };
    },
    get disabled() {
      return filter.disabled;
    },
  };
}

/** 给调用方复用，避免每块都新建一个 `TextEncoder`。 */
export const ZAI_STREAM_ENCODER = new TextEncoder();

export function encodeZaiStreamText(text: string): Uint8Array {
  return ZAI_STREAM_ENCODER.encode(text);
}
