import { describe, expect, it } from 'vitest';
import {
  createZaiUsageTracker,
  decodeZaiUsageSnapshot,
  readZaiServerTokenUsage,
} from '../core/zai/stream-metrics';
import {
  createZaiStreamAccumulator,
  parseZaiSseData,
  type ZaiSseEvent,
} from '../core/zai/stream-codec';

/** 把一行 SSE 文本解析成事件；解析不出返回 null（与 fetch hook 的用法一致）。 */
function frame(data: unknown): ZaiSseEvent | null {
  return parseZaiSseData(JSON.stringify(data));
}

/** 真机形状的 usage 帧。 */
function usageFrame(usage: Record<string, unknown>): ZaiSseEvent | null {
  return frame({ type: 'chat:completion', data: { phase: 'other', usage } });
}

describe('readZaiServerTokenUsage', () => {
  it('reads the authoritative token counts from a usage frame', () => {
    expect(readZaiServerTokenUsage(usageFrame({
      prompt_tokens: 6,
      completion_tokens: 151,
      total_tokens: 157,
    }))).toEqual({
      promptTokens: 6,
      completionTokens: 151,
      totalTokens: 157,
    });
  });

  it('selects on the shape rather than the phase name', () => {
    // 相位名换掉也照样取到 —— 写死 'other' 会在服务端改名时静默失效。
    const renamed = frame({
      type: 'chat:completion',
      data: { phase: 'usage', usage: { total_tokens: 42 } },
    });
    expect(readZaiServerTokenUsage(renamed)?.totalTokens).toBe(42);
  });

  it('ignores frames without a usable total', () => {
    expect(readZaiServerTokenUsage(frame({
      type: 'chat:completion',
      data: { phase: 'answer', delta_content: 'hi' },
    }))).toBeNull();
    expect(readZaiServerTokenUsage(usageFrame({ prompt_tokens: 6 }))).toBeNull();
    expect(readZaiServerTokenUsage(usageFrame({ total_tokens: 0 }))).toBeNull();
    expect(readZaiServerTokenUsage(usageFrame({ total_tokens: '157' }))).toBeNull();
    expect(readZaiServerTokenUsage(usageFrame({ total_tokens: Number.NaN }))).toBeNull();
    expect(readZaiServerTokenUsage(null)).toBeNull();
  });

  it('keeps optional counts null when they are missing', () => {
    expect(readZaiServerTokenUsage(usageFrame({ total_tokens: 10 }))).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: 10,
    });
  });
});

describe('createZaiUsageTracker', () => {
  function createTracker(now: () => number, modelType: string | null = 'glm-5.3') {
    return createZaiUsageTracker('req-1', modelType, { now });
  }

  it('prefers the server total and labels the source as server', () => {
    let clock = 0;
    const tracker = createTracker(() => clock);

    tracker.appendText('hello');
    clock += 1_000;
    tracker.observeEvent(usageFrame({ total_tokens: 157 }));
    const snapshot = tracker.finish('hello');

    expect(snapshot).toMatchObject({
      requestId: 'req-1',
      modelType: 'glm-5.3',
      totalTokens: 157,
      tokenSource: 'server',
      // 速度永远只按流式正文估算，不用含 prompt 的服务端总量。
      speedSource: 'estimated',
    });
  });

  it('falls back to the estimated total when no usage frame arrives', () => {
    let clock = 0;
    const tracker = createTracker(() => clock);

    // 10 个 CJK 字符 × 0.6 = 6 token（与上游同一估算口径）。
    const text = '你好世界你好世界你好';
    tracker.appendText(text);
    clock += 1_000;
    const snapshot = tracker.finish(text);

    expect(snapshot).toMatchObject({
      totalTokens: 6,
      tokenSource: 'estimated',
      speedSource: 'estimated',
      estimatedTokens: 6,
    });
  });

  it('measures the decode window from the first streamed text, not tracker creation', () => {
    let clock = 0;
    const tracker = createTracker(() => clock);

    // 预填充/排队 3 秒：这段不该进解码窗口，否则速度被拉低。
    clock += 3_000;
    const text = 'a'.repeat(100);
    tracker.appendText(text);
    clock += 1_000;
    const snapshot = tracker.finish(text);

    // 100 个 ASCII 字符 × 0.3 = 30 token / 1000ms → 30 tok/s
    // （若从 tracker 创建起算，4000ms 会算成 7.5）
    expect(snapshot?.tps).toBeCloseTo(30, 5);
    // elapsedMs 的口径是「tracker 构造 → 流结束」，即响应头到达之后开始算
    // （TTFB 不在内）。这里 clock 在构造时归零，所以 4000 就是这段窗口。
    expect(snapshot?.elapsedMs).toBe(4_000);
  });

  it('reports zero speed when no text ever streamed', () => {
    let clock = 0;
    const tracker = createTracker(() => clock);

    clock += 500;
    tracker.observeEvent(usageFrame({ total_tokens: 12 }));
    const snapshot = tracker.finish('');

    expect(snapshot).toMatchObject({ totalTokens: 12, tokenSource: 'server', tps: 0 });
  });
  it('returns null when neither a server total nor any text was seen', () => {
    const tracker = createTracker(() => 0);
    expect(tracker.finish('')).toBeNull();
  });

  it('emits at most one snapshot per request', () => {
    let clock = 0;
    const tracker = createTracker(() => clock);

    tracker.appendText('hello');
    clock += 100;
    expect(tracker.finish('hello')).not.toBeNull();
    expect(tracker.finish('hello')).toBeNull();
  });

  it('estimates from the final text so replaced content is not double counted', () => {
    let clock = 0;
    const tracker = createTracker(() => clock);
    const accumulator = createZaiStreamAccumulator();

    // 三语义：先追加，再整体替换成更短的文本。
    const first = accumulator.push('data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"aaaaaaaa"}}\n');
    for (const event of first.events) tracker.observeEvent(event);
    tracker.appendText(first.appendedText);

    clock += 1_000;
    const second = accumulator.push('data: {"type":"chat:completion","data":{"phase":"answer","content":"bb"}}\n');
    for (const event of second.events) tracker.observeEvent(event);
    tracker.appendText(second.appendedText);

    const snapshot = tracker.finish(accumulator.assistantText);

    // 最终正文是 'bb'（2 个 ASCII × 0.3 = 0.6 → 1），不是 8+2 个字符的累加。
    expect(snapshot?.estimatedTokens).toBe(1);
    expect(accumulator.assistantText).toBe('bb');
  });
});

describe('decodeZaiUsageSnapshot', () => {
  const valid = {
    requestId: 'req-1',
    modelType: 'glm-5.3',
    totalTokens: 157,
    tokenSource: 'server',
    tps: 12.5,
    speedSource: 'estimated',
    elapsedMs: 1_500,
    estimatedTokens: 120,
  };

  it('accepts a well-formed snapshot and normalizes the metric sources', () => {
    expect(decodeZaiUsageSnapshot(valid)).toEqual(valid);
    expect(decodeZaiUsageSnapshot({ ...valid, tokenSource: 'nonsense' })?.tokenSource)
      .toBe('estimated');
    expect(decodeZaiUsageSnapshot({ ...valid, speedSource: 'server' })?.speedSource)
      .toBe('server');
  });

  it('rejects payloads that cannot produce a usable record', () => {
    // 跨世界边界：缺 requestId 或总量不为正的一律丢弃，别让后台的严格解码器抛。
    expect(decodeZaiUsageSnapshot(null)).toBeNull();
    expect(decodeZaiUsageSnapshot('nope')).toBeNull();
    expect(decodeZaiUsageSnapshot({ ...valid, requestId: '' })).toBeNull();
    expect(decodeZaiUsageSnapshot({ ...valid, requestId: '  ' })).toBeNull();
    expect(decodeZaiUsageSnapshot({ ...valid, totalTokens: 0 })).toBeNull();
    expect(decodeZaiUsageSnapshot({ ...valid, totalTokens: -1 })).toBeNull();
    expect(decodeZaiUsageSnapshot({ ...valid, totalTokens: Number.NaN })).toBeNull();
  });

  it('trims the model id and drops a blank one to null', () => {
    expect(decodeZaiUsageSnapshot({ ...valid, modelType: '  glm-5.3  ' })?.modelType)
      .toBe('glm-5.3');
    expect(decodeZaiUsageSnapshot({ ...valid, modelType: '   ' })?.modelType).toBeNull();
    expect(decodeZaiUsageSnapshot({ ...valid, modelType: 7 })?.modelType).toBeNull();
  });

  it('defaults missing optional metrics instead of rejecting the snapshot', () => {
    const { tps, elapsedMs, estimatedTokens, ...rest } = valid;
    expect(decodeZaiUsageSnapshot(rest)).toMatchObject({
      tps: 0,
      elapsedMs: 0,
      estimatedTokens: 0,
    });
  });
});
