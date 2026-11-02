import { afterEach, describe, expect, it } from 'vitest';
import {
  createZaiCompletionStreamRewriter,
  createZaiToolXmlTextFilter,
} from '../core/zai/stream-strip';
import { installZaiFetchHook, updateZaiHookState } from '../core/zai/fetch-hook';
import { ZAI_BUILTIN_HISTORY_TOOL_NAMES } from '../core/zai/history-tool-names';

/**
 * **流式工具 XML 剥离**（流式侧）。
 *
 * 两层结构：文本层（`createZaiToolXmlTextFilter`）管「跨帧扣尾巴」，
 * wire 层（`createZaiCompletionStreamRewriter`）管「按行拆 SSE、只改正文」。
 *
 * ⚠️⚠️ **必须按帧解析、不能对 wire 文本做字符串替换** —— 标签的 `<` 在 JSON
 * 字符串内部，直接剪会破坏 JSON（少一个引号就整帧解析失败、页面整段回答消失）。
 */

const NAMES = ['shell_exec', 'memory_save'];

function deltaFrame(text: string, phase = 'answer'): string {
  return `data: ${JSON.stringify({ type: 'chat:completion', data: { phase, delta_content: text } })}\n\n`;
}

/** 把 wire 拆成 data 行的 payload 列表（只留能解析的）。 */
function payloadsOf(wire: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of wire.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const json = JSON.parse(raw) as Record<string, unknown>;
      out.push(json);
    } catch {
      out.push({ __parseError: raw });
    }
  }
  return out;
}

/** 拼出「页面最终看到的正文」= 各帧的 delta_content（追加）与 content（整体替换）按顺序推演。 */
function visibleTextOf(wire: string): string {
  let text = '';
  for (const json of payloadsOf(wire)) {
    const data = json.data as Record<string, unknown> | undefined;
    if (typeof data?.delta_content === 'string') { text += data.delta_content; continue; }
    if (typeof data?.content === 'string') { text = data.content; continue; }
  }
  return text;
}

/** 跨多次 push / finish 累积页面最终看到的正文（测试里逐块喂时用）。 */
function accumulate(...wires: string[]): string {
  return visibleTextOf(wires.join(''));
}

describe('zai tool XML text filter', () => {
  it('passes plain prose straight through', () => {
    const filter = createZaiToolXmlTextFilter(NAMES);
    expect(filter.push('普通正文')).toBe('普通正文');
    expect(filter.finish()).toBe('');
  });

  it('holds back a partial opening tag across pushes', () => {
    const filter = createZaiToolXmlTextFilter(NAMES);
    // `<shell_ex` 可能是开标签的前半截 ⇒ 这一帧一个字符都不放。
    expect(filter.push('前面的话<shell_ex')).toBe('前面的话');
    expect(filter.heldLength).toBe(9);
    // 补齐后确认是完整块 ⇒ 只放行块之后的内容。
    const out = filter.push('ec>{"command":"ls"}</shell_exec>后面的话');
    expect(out).toBe('后面的话');
    expect(filter.heldLength).toBe(0);
  });

  // ⚠️⚠️ 真机实测：同一个 `<memory_save>` 的**开标签与闭标签落在两个不同的帧**里
  // （`atLength:80` 帧带开标签、`atLength:176` 帧带 `]}\n</memory_save>`）。
  // 按单帧剥会漏掉它 —— 这条把跨帧状态机钉死。
  it('holds back a complete opening tag whose closing tag has not arrived', () => {
    const filter = createZaiToolXmlTextFilter(NAMES);
    expect(filter.push('好的。\n\n<memory_save>\n{"type"')).toBe('好的。\n\n');
    // 中间若干帧全是载荷，一个字符都不该放行。
    expect(filter.push(':"user","name":"颜色偏好",')).toBe('');
    expect(filter.push('"content":"用户喜欢蓝色"}')).toBe('');
    expect(filter.push('\n</memory_save>')).toBe('');
    // 闭标签之后的正文才放行。
    expect(filter.push('\n\n记好了。')).toBe('\n\n记好了。');
  });

  it('flushes the held tail at finish and drops an unterminated block', () => {
    const filter = createZaiToolXmlTextFilter(NAMES);
    expect(filter.push('开始。<shell_exec>{"command":"ls"')).toBe('开始。');
    // 流结束：未闭合的块也一并删掉，扣住的载荷不吐出去。
    expect(filter.finish()).toBe('');
  });

  it('flushes held plain text at finish when it was never a tool tag', () => {
    const filter = createZaiToolXmlTextFilter(NAMES);
    // `<` 后面还没到能判定的时候流就结束了 ⇒ 必须原样放行，不能吞掉用户正文。
    expect(filter.push('比较 <')).toBe('比较 ');
    expect(filter.finish()).toBe('<');
  });

  it('keeps a complete block that spans the flush boundary out of the output', () => {
    const filter = createZaiToolXmlTextFilter(NAMES);
    const first = filter.push('前言<shell_exec>{"command":"ls"}');
    expect(first).toBe('前言');
    // 闭标签与后文一起到 —— 块被删掉，只有后文放行。
    expect(filter.push('</shell_exec>后记')).toBe('后记');
  });

  it('removes several blocks in one push', () => {
    const filter = createZaiToolXmlTextFilter(NAMES);
    const out = filter.push('<shell_exec>{"a":1}</shell_exec>中间<memory_save>{"b":2}</memory_save>末尾');
    expect(out).toBe('中间末尾');
  });

  it('is a no-op when the name list is empty', () => {
    const filter = createZaiToolXmlTextFilter([]);
    const wire = '<shell_exec>{"command":"ls"}</shell_exec>';
    expect(filter.push(wire)).toBe(wire);
    expect(filter.disabled).toBe(true);
  });

  it('drops the held tail when the text is replaced wholesale', () => {
    // `content` 是整体替换：扣住的尾巴属于**被替换掉**的那一段，不能吐出去。
    const filter = createZaiToolXmlTextFilter(NAMES);
    expect(filter.push('旧文<shell_ex')).toBe('旧文');
    filter.discard();
    expect(filter.heldLength).toBe(0);
    expect(filter.push('新文')).toBe('新文');
  });
});

/**
 * **「提及」不等于「调用」** —— 模型在正文里写 `<shell_exec>` 这个标签名时，
 * 后面跟的是**散文**，不是 JSON 载荷。
 *
 * ⚠️⚠️ 不加这条守卫的后果（实测）：从那个开标签起到**流结束**的全部正文被当块删掉。
 * 历史侧（`core/zai/tool-xml.ts` 的 `looksLikeTruncatedPayload`）早就有这条守卫，
 * 流式侧漏了 ⇒ 用户看到「话说一半没了」，而且**没有任何报错**。
 *
 * ⚠️ 判据是「开标签之后第一个非空白字符 ∈ `{` / `[` / 空」——
 * 与历史侧**逐字同口径**。改这里要同改 `core/zai/tool-xml.ts`。
 */
describe('zai tool XML filter: a mere mention is not a tool call', () => {
  it('passes a mentioned tag through when prose follows it', () => {
    const filter = createZaiToolXmlTextFilter(NAMES);
    const text = '你可以写 <shell_exec> 来执行命令，注意转义。';
    expect(filter.push(text) + filter.finish()).toBe(text);
  });

  it('passes a long mention through instead of eating the rest of the answer', () => {
    const filter = createZaiToolXmlTextFilter(NAMES);
    const text = '关于 <shell_exec> 这个标签，它用于执行命令，参数必须是 JSON 对象。以上是全部说明。';
    expect(filter.push(text) + filter.finish()).toBe(text);
  });

  it('still drops a block that is genuinely truncated inside its payload', () => {
    // 反面对照：开标签之后是 `{` ⇒ 那是被截断的载荷，仍要删（与历史侧同判）。
    const filter = createZaiToolXmlTextFilter(NAMES);
    expect(filter.push('开始执行<shell_exec>{"command":"ls -la"')).toBe('开始执行');
    expect(filter.finish()).toBe('');
  });

  it('still drops an opening tag that is followed by nothing but whitespace', () => {
    // 「开标签后什么都没有」在流里最可能就是载荷还没到 ⇒ 与历史侧同判（删）。
    const filter = createZaiToolXmlTextFilter(NAMES);
    expect(filter.push('开始<shell_exec>   ')).toBe('开始');
    expect(filter.finish()).toBe('');
  });

  it('keeps a mention whose name differs from the block that follows it', () => {
    // ⚠️ **必须用异名**：同名时「开标签→同名闭标签」的匹配会把提及与真块连成**一个块**
    // （`<shell_exec>` 提及 + 后面的 `</shell_exec>` 被当成同一对的起止）——
    // 那是「名字相同」这个前提的固有结果，**历史侧同样如此**（实测 `stripZaiToolCalls` 也删到 `用 完`）。
    // 本条钉的是「流式侧不再把异名提及之后的正文整段吃掉，且不早退漏掉后面的真块」。
    const filter = createZaiToolXmlTextFilter(NAMES);
    const out = filter.push('用 <memory_save> 可以存记忆。<shell_exec>{"a":1}</shell_exec>好了。')
      + filter.finish();
    expect(out).toBe('用 <memory_save> 可以存记忆。好了。');
  });
});

/**
 * **跨相位**：`thinking` 帧里出现未闭合开标签时，不能让**下一相位**的正文被扣住。
 *
 * ⚠️⚠️ 实测过的形态：`thinking` 帧里写「我该用 `<shell_exec>` 这个标签」，
 * 紧接着 `answer` 帧吐**整段最终答案** —— 未修时那整段答案被扣到流结束并删掉，
 * 用户只看到思考里那半句。
 *
 * ⚠️ 对照用例（thinking 里没有标签）必须**同时**留着：它证明红的是「跨相位扣住」
 * 而不是「answer 本来就不该出现」。
 */
describe('zai completion stream rewriter: mentions must not cross phases', () => {
  it('lets the answer through when thinking merely mentions a tag', () => {
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    let out = rewriter.push(deltaFrame('我该用 <shell_exec> 这个标签', 'thinking')).text;
    out += rewriter.push(deltaFrame('这是最终答案，很重要。')).text;
    out += rewriter.push(deltaFrame('', 'done')).text;
    out += rewriter.finish().text;
    expect(visibleTextOf(out)).toBe('我该用 <shell_exec> 这个标签这是最终答案，很重要。');
  });

  it('lets the answer through when thinking has no tag at all (control)', () => {
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    let out = rewriter.push(deltaFrame('我想一想', 'thinking')).text;
    out += rewriter.push(deltaFrame('这是最终答案，很重要。')).text;
    out += rewriter.push(deltaFrame('', 'done')).text;
    out += rewriter.finish().text;
    expect(visibleTextOf(out)).toBe('我想一想这是最终答案，很重要。');
  });

  it('still strips a real block that spans the thinking/answer boundary', () => {
    // 反面对照：真块跨相位时仍要剥 —— 守卫只放过「散文开头」的那一种。
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    let out = rewriter.push(deltaFrame('先看看<shell_exec>{"command":"ls"}', 'thinking')).text;
    out += rewriter.push(deltaFrame('</shell_exec>看完了。')).text;
    out += rewriter.finish().text;
    expect(visibleTextOf(out)).toBe('先看看看完了。');
  });
});

describe('zai completion stream rewriter', () => {
  it('rewrites a delta frame that contains a tool block', () => {
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    const wire = deltaFrame('好的。\n\n<shell_exec>\n{"command":"ls"}\n</shell_exec>\n\n完成。');
    const result = rewriter.push(wire);
    expect(result.unchanged).toBe(false);
    expect(visibleTextOf(result.text)).toBe('好的。\n\n\n\n完成。');
    expect(rewriter.finish().text).toBe('');
  });

  it('keeps the JSON envelope intact (every emitted line must parse)', () => {
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    const wire = deltaFrame('前言<shell_exec>{"command":"ls"}</shell_exec>后记');
    const result = rewriter.push(wire);
    const payloads = payloadsOf(result.text);
    expect(payloads.every((p) => !('__parseError' in p))).toBe(true);
    // envelope 形状不变：仍是 chat:completion + data.phase。
    expect((payloads[0]!.data as any).phase).toBe('answer');
  });

  it('reports unchanged (so the caller can pass raw bytes) when nothing matched', () => {
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    const wire = deltaFrame('这是一段普通回答。');
    const result = rewriter.push(wire);
    expect(result.unchanged).toBe(true);
    // ⚠️ unchanged 为真时 `text` 就是**入参原文**，调用方直接透传原始字节。
    expect(result.text).toBe(wire);
  });

  it('does not report unchanged when a partial line is held across chunks', () => {
    // 半行留在手上时不能声称「逐字节未改」—— 那一块根本没吐出去。
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    const wire = deltaFrame('普通正文');
    const first = rewriter.push(wire.slice(0, 20));
    expect(first.unchanged).toBe(false);
    expect(first.text).toBe('');
    const second = rewriter.push(wire.slice(20));
    expect(second.unchanged).toBe(false);
    expect(visibleTextOf(second.text)).toBe('普通正文');
  });

  it('leaves non-data lines and the [DONE] sentinel alone', () => {
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    const wire = `: keep-alive comment\n${deltaFrame('正文')}data: [DONE]\n\n`;
    const result = rewriter.push(wire);
    expect(result.text).toContain(': keep-alive comment');
    expect(result.text).toContain('data: [DONE]');
  });

  it('flushes a held tail as a synthetic delta frame at finish', () => {
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    // 开标签到了、闭标签还没到，流就结束了。
    const first = rewriter.push(deltaFrame('前言<shell_exec>{"command":"ls"'));
    expect(visibleTextOf(first.text)).toBe('前言');
    const tail = rewriter.finish();
    // ⚠️ 未闭合的块**不吐给页面**（半截工具标签同样是内部协议）——
    // 但扣住的正文里没有别的东西，所以合成帧是空的、`finish` 返回空串。
    expect(tail.text).toBe('');
  });

  it('flushes held plain text as a synthetic delta frame at finish', () => {
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    rewriter.push(deltaFrame('对比 <'));
    const tail = rewriter.finish();
    // 扣住的 `<` 必须还回去（那是用户正文，不是工具标签）。
    expect(visibleTextOf(tail.text)).toBe('<');
  });

  it('emits the flushed tail before the trailing partial line', () => {
    // ⚠️ 顺序是承重的：扣住的正文在逻辑上早于末尾那半行。
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    const first = rewriter.push(deltaFrame('对比 <'));
    rewriter.push('data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"后续');
    const tail = rewriter.finish();
    // 第一次 push 放行了 `对比 `（扣住 `<`），finish 才把 `<` 交回来 ——
    // 所以页面看到的正文要**跨两次输出**拼起来。
    expect(visibleTextOf(first.text)).toBe('对比 ');
    expect(visibleTextOf(tail.text)).toBe('<');
    expect(accumulate(first.text, tail.text)).toBe('对比 <');
    // 末尾那半行没有换行 ⇒ 不是合法帧，原样留在尾部。
    expect(tail.text.endsWith('"delta_content":"后续')).toBe(true);
    // 合成帧排在未完结行之前。
    expect(tail.text.indexOf('对比')).toBe(-1);
    expect(tail.text.indexOf('"delta_content":"<"')).toBeLessThan(tail.text.indexOf('后续'));
  });

  it('preserves the envelope type on synthetic frames', () => {
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    rewriter.push(deltaFrame('对比 <', 'thinking'));
    const tail = rewriter.finish();
    const payloads = payloadsOf(tail.text);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.type).toBe('chat:completion');
    expect((payloads[0]!.data as any).phase).toBe('thinking');
  });

  it('applies content-replace semantics without leaking the replaced tail', () => {
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    rewriter.push(deltaFrame('旧文<shell_ex'));
    const wire = `data: ${JSON.stringify({
      type: 'chat:completion',
      data: { phase: 'answer', content: '整段替换的新正文。' },
    })}\n\n`;
    const result = rewriter.push(wire);
    expect(visibleTextOf(result.text)).toBe('整段替换的新正文。');
  });
});

describe('zai completion stream rewriter: edit_content defence', () => {
  // ⚠️⚠️ **遇到 `edit_content` 就关掉剥离**（用户拍板的防御）。
  // `edit_index` 是相对**服务端累积文本**的绝对 UTF-16 偏移，剥掉字符后页面那份
  // 更短 ⇒ 之后的 edit 会错位、被剥掉的 XML 可能被整段写回来。
  // 真机实测（2026-10，三轮含工具调用与 190 帧长回答）**零 edit**，所以这条路
  // 当前不触发；一旦触发就退回原样透传。
  it('turns stripping off and hands back the held text when an edit arrives', () => {
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    const first = rewriter.push(deltaFrame('前言<shell_ex'));
    expect(visibleTextOf(first.text)).toBe('前言');
    expect(rewriter.disabled).toBe(false);

    const editWire = `data: ${JSON.stringify({
      type: 'chat:completion',
      data: { phase: 'answer', edit_content: '改写后的正文。', edit_index: 0 },
    })}\n\n`;
    const result = rewriter.push(editWire);
    expect(rewriter.disabled).toBe(true);
    // 扣住的原文（`<shell_ex`）被交回去 —— 宁可看得见半截标签，也不要正文碎裂。
    expect(visibleTextOf(result.text)).toBe('<shell_ex');
    // edit 帧本身原样保留。
    expect(result.text).toContain('"edit_content"');
  });

  it('stops stripping every later frame once disabled', () => {
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    rewriter.push(`data: ${JSON.stringify({
      type: 'chat:completion',
      data: { phase: 'answer', edit_content: 'x', edit_index: 0 },
    })}\n\n`);
    expect(rewriter.disabled).toBe(true);
    const wire = deltaFrame('<shell_exec>{"command":"ls"}</shell_exec>');
    const result = rewriter.push(wire);
    expect(result.unchanged).toBe(true);
    expect(visibleTextOf(result.text)).toBe('<shell_exec>{"command":"ls"}</shell_exec>');
  });
});

describe('the real fetch hook strips tool XML from the page stream', () => {
  const COMPLETION_URL = 'https://chat.z.ai/api/v2/chat/completions?requestId=r1&user_id=u1';
  const REQUEST_BODY = JSON.stringify({
    model: 'x-preview-l',
    messages: [{ role: 'user', content: '提问' }],
    signature_prompt: '提问',
  });
  const originalFetch = window.fetch;

  afterEach(() => {
    window.fetch = originalFetch;
  });

  async function runThroughHook(wire: string): Promise<string> {
    updateZaiHookState({
      toolDescriptorNames: new Set<string>(),
      onRequestBody: async (body, requestId) => ({ body, requestId }),
      onHeadersCaptured: () => undefined,
      onToolCall: () => undefined,
      onUsageSnapshot: () => undefined,
      onHtmlChallenge: () => undefined,
      onRequestTerminal: () => undefined,
      onResponseComplete: () => undefined,
    });

    const bytes = new TextEncoder().encode(wire);
    const stubFetch = async (): Promise<Response> => {
      let cursor = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (cursor >= bytes.length) { controller.close(); return; }
          const next = Math.min(cursor + 23, bytes.length);
          controller.enqueue(bytes.slice(cursor, next));
          cursor = next;
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    window.fetch = stubFetch as unknown as typeof window.fetch;
    const uninstall = installZaiFetchHook();
    try {
      const response = await window.fetch(COMPLETION_URL, { method: 'POST', body: REQUEST_BODY });
      const decoder = new TextDecoder();
      let out = '';
      const reader = response.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
      out += decoder.decode();
      return out;
    } finally {
      uninstall();
    }
  }

  it('removes a tool block that arrives split across many byte chunks', async () => {
    const wire = [
      deltaFrame('好的，我看看。\n\n'),
      deltaFrame('<shell_exec>'),
      deltaFrame('\n{"command": "ls"}\n'),
      deltaFrame('</shell_exec>'),
      deltaFrame('\n\n完成。'),
      'data: {"type":"chat:completion","data":{"phase":"done","done":true}}\n\n',
    ].join('');
    const out = await runThroughHook(wire);
    expect(visibleTextOf(out)).toBe('好的，我看看。\n\n\n\n完成。');
    expect(out).not.toContain('shell_exec');
    // 收尾帧必须原样保留（否则页面等不到 done）。
    expect(out).toContain('"done":true');
  });

  it('passes a stream with no tool block through byte-for-byte', async () => {
    // ⚠️ 「没改动就逐字节不变」这条不变量只在**真正发生剥离**时才失效。
    const wire = deltaFrame('这是一段普通回答，没有工具调用。');
    expect(await runThroughHook(wire)).toBe(wire);
  });

  it('uses the built-in baseline when the hook state snapshot is still empty', async () => {
    // ⚠️ 页面加载时会话历史 / completion 都可能早于 `SYNC_HOOK_STATE` 落地 ——
    // 那一刻快照是空集。基线兜住这个窗口，否则一个块都剥不掉（失败方向静默）。
    expect(ZAI_BUILTIN_HISTORY_TOOL_NAMES).toContain('shell_exec');
    const wire = deltaFrame('<shell_exec>{"command":"ls"}</shell_exec>');
    expect(await runThroughHook(wire)).not.toContain('shell_exec');
  });
});

/**
 * **终止帧（`done: true`）之前必须把扣住的正文放行。**
 *
 * ⚠️⚠️ 真机实测（N1，2026-11-02）：页面收到终止帧之后**不再处理任何后续帧** ——
 * 探针插在流末尾时，连对照组的 `answer` 帧都不渲染。而 `finish()` 是在
 * `pull(done)` 里调的 ⇒ 合成帧天然排在终止帧**之后** ⇒ 用户永远看不到它。
 *
 * ⇒ 判据两条：① 合成帧**排在终止帧之前**；② 它的 `phase` 不继承终止帧自己的 `done`
 *   （真机同样验过：`done` 相位的 `delta_content` 不渲染）。
 */
describe('zai completion stream rewriter: flush before the terminal frame', () => {
  const DONE_FRAME = 'data: {"type":"chat:completion","data":{"phase":"done","done":true}}\n\n';

  const framesOf = (wire: string) => wire.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      const data = (JSON.parse(line.slice(6)) as { data?: Record<string, unknown> }).data ?? {};
      return {
        phase: data.phase as string,
        delta: (data.delta_content ?? '') as string,
        terminal: data.done === true,
      };
    });

  it('emits the held tail before the terminal frame', () => {
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    let out = rewriter.push(deltaFrame('结论，对比 <')).text;
    out += rewriter.push(DONE_FRAME).text;
    out += rewriter.finish().text;

    const frames = framesOf(out);
    const terminal = frames.findIndex((frame) => frame.terminal);
    const synthetic = frames.findIndex((frame) => frame.delta === '<');
    expect(synthetic, '扣住的 "<" 必须作为一帧出现').toBeGreaterThanOrEqual(0);
    expect(synthetic, '它必须排在终止帧之前').toBeLessThan(terminal);
    expect(frames[synthetic]!.phase, '不能继承终止帧的 done').toBe('answer');
  });

  it('does not add an extra frame when nothing was held', () => {
    const rewriter = createZaiCompletionStreamRewriter(NAMES);
    let out = rewriter.push(deltaFrame('正常回答。')).text;
    out += rewriter.push(DONE_FRAME).text;
    out += rewriter.finish().text;
    expect(framesOf(out).map((frame) => frame.phase)).toEqual(['answer', 'done']);
  });

  it('keeps the held tail in a text-bearing phase', () => {
    // `thinking` / `tool_response` 是真会带正文的相位（真机 626/626、5/5）⇒ 原样保留；
    // `done` / `other` 不带（0/1、0/5）⇒ 回落 `answer`。
    const cases: [string, string][] = [
      ['thinking', 'thinking'],
      ['tool_response', 'tool_response'],
      ['done', 'answer'],
      ['other', 'answer'],
    ];
    for (const [lastPhase, expected] of cases) {
      const rewriter = createZaiCompletionStreamRewriter(NAMES);
      let out = rewriter.push(deltaFrame('尾巴 <', lastPhase)).text;
      out += rewriter.push(DONE_FRAME).text;
      out += rewriter.finish().text;
      const synthetic = framesOf(out).find((frame) => frame.delta === '<');
      expect(synthetic?.phase, lastPhase).toBe(expected);
    }
  });
});
