import { afterEach, describe, expect, it } from 'vitest';
import { createZaiStreamAccumulator, type ZaiStreamAccumulator } from '../core/zai/stream-codec';
import { installZaiFetchHook, updateZaiHookState } from '../core/zai/fetch-hook';

/**
 * **SSE 流在任意切点被切开时，解析结果必须与整条喂进去完全一致。**
 *
 * ⚠️⚠️ **为什么需要这个文件**：`createZaiStreamAccumulator` 的 `push` 里有一句
 * `pending` 缓存（把没遇到换行符的尾巴留到下一次 push）—— 它是「跨分片续接」的**全部机制**。
 * 现有测试只覆盖**一个固定切点**（`zai.test.ts` 的 `reassembles a data line split across two pushes`，
 * 切在 JSON 字符串中间），其余任意切点**没有任何断言**。
 *
 * ⚠️ **真实路径是「字节 → 字符 → 行」三段**（见 `core/zai/fetch-hook.ts` 的 `pull`）：
 * `reader.read()` 拿到**任意长度的 Uint8Array** → `decoder.decode(value, { stream: true })`
 * → `accumulator.push(chunk)`。所以切点有**两个层次**，两个都要穷举：
 * ① **字符层**（`push` 收到什么就是什么）；② **字节层**（还要过一遍 `TextDecoder`）。
 * ⚠️ 字节层尤其重要：切在多字节 UTF-8 序列中间时，**漏掉 `{ stream: true }` 会吐替换字符**
 * （`U+FFFD`）—— 那是一条只看字符层永远测不到的缺陷。
 *
 * ⚠️ **判据是「与整条喂进去的 digest 逐字相等」**，不是「正文非空」那类弱断言 ——
 * 弱断言在「切点把某一帧整个丢掉」时照样绿（后一帧的 `content` 替换会把正文盖回来）。
 * digest 同时收 `assistantText` / 事件序列（phase + raw）/ `appendedText` 三样。
 *
 * ⚠️ **判据分两层，缺一不可**：
 * ① **与整条喂进去的 digest 逐字相等**（抓「某个切点破坏了续接」）；
 * ② **digest 本身等于一份手写的期望值**（抓「所有切点一起错」）。
 * ⚠️⚠️ **只有 ① 会退化成同义反复** —— 基线也走同一份实现，所以「实现整体错」时
 * 基线与切点运行**一起错**、两边仍然相等。实测：把 `finish()` 的 flush 整个关掉
 * （末帧永不入账），只断言 ① 的话**全绿**。所以 ② 是必须的。
 *
 * ⚠️ **刻意不含 CRLF 变体**：真实抓包的 SSE 里 `\r` 出现 **0 次** ⇒ 那是现实路径不存在的
 * 防御分支。实测把 `processLine` 里的 `\r` 剥除删掉，本文件**不会红** ——
 * 这是**有意**的，不是守卫漏了。
 */

/**
 * 每条 wire 配一份**手写的**期望值（不派生自被测实现）。
 * `phases` 只钉相位序列，`text` / `appended` 钉语义 —— 手抄整个 JSON 串没有额外信息量。
 */
const WIRES = {
  'newline-terminated': {
    wire: [
      'data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"你好"}}',
      'data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"🌏世界"}}',
      'data: {"type":"chat:completion","data":{"phase":"answer","content":"重置后的正文"}}',
      'data: {"type":"chat:completion","data":{"phase":"answer","edit_content":"替换","edit_index":3}}',
      'data: {"type":"chat:completion","data":{"phase":"other","usage":{"total_tokens":33}}}',
      '',
    ].join('\n'),
    // 逐帧推演：追加「你好」→ 追加「🌏世界」→ content 整体替换成「重置后的正文」
    // → edit_index=3 处换成「替换」（「重置后」+「替换」）→ usage 帧不带文本。
    expected: {
      text: '重置后替换',
      phases: ['answer', 'answer', 'answer', 'answer', 'other'],
      appended: '你好🌏世界重置后的正文替换',
    },
  },
  'no-trailing-newline': {
    wire: [
      'data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"你好"}}',
      'data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"🌏世界"}}',
      'data: {"type":"chat:completion","data":{"phase":"other","usage":{"total_tokens":33}}}',
      'data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"尾巴"}}',
    ].join('\n'),
    // ⚠️ 末帧**没有换行结尾** ⇒ 它必须靠 `finish()` 才入账。这条 wire 是
    // 「`finish()` 不 flush」那类缺陷的唯一探针。
    expected: {
      text: '你好🌏世界尾巴',
      phases: ['answer', 'answer', 'other', 'answer'],
      appended: '你好🌏世界尾巴',
    },
  },
} as const;

interface Digest {
  text: string;
  events: Array<[string, string]>;
  appended: string;
}

/** 把一次运行的全部可观测输出收成一个可比对的形状。 */
function digestOf(accumulator: ZaiStreamAccumulator, events: Array<[string, string]>, appended: string): Digest {
  return { text: accumulator.assistantText, events, appended };
}

/** 按**字符**切点喂进去；`splits` 为空 = 整条一次喂（基线）。 */
function runCharSplits(wire: string, splits: readonly number[]): Digest {
  const accumulator = createZaiStreamAccumulator();
  const events: Array<[string, string]> = [];
  let appended = '';
  let cursor = 0;
  for (const at of [...splits, wire.length]) {
    const result = accumulator.push(wire.slice(cursor, at));
    for (const event of result.events) events.push([event.phase, event.raw]);
    appended += result.appendedText;
    cursor = at;
  }
  const tail = accumulator.finish();
  for (const event of tail.events) events.push([event.phase, event.raw]);
  appended += tail.appendedText;
  return digestOf(accumulator, events, appended);
}

/**
 * 按**字节**切点喂进去 —— 照 `fetch-hook.ts` 的真实路径：
 * `TextDecoder` + `stream: true`，最后再空 `decode()` flush 掉半个序列。
 */
function runByteSplits(wire: string, splits: readonly number[]): Digest {
  const bytes = new TextEncoder().encode(wire);
  const decoder = new TextDecoder();
  const accumulator = createZaiStreamAccumulator();
  const events: Array<[string, string]> = [];
  let appended = '';
  let cursor = 0;
  for (const at of [...splits, bytes.length]) {
    const chunk = decoder.decode(bytes.slice(cursor, at), { stream: true });
    const result = accumulator.push(chunk);
    for (const event of result.events) events.push([event.phase, event.raw]);
    appended += result.appendedText;
    cursor = at;
  }
  decoder.decode();
  const tail = accumulator.finish();
  for (const event of tail.events) events.push([event.phase, event.raw]);
  appended += tail.appendedText;
  return digestOf(accumulator, events, appended);
}

/** 自检：基线本身得是「有内容、有事件」的，否则整组断言会退化成「空 == 空」。 */
function assertBaselineIsMeaningful(baseline: Digest): void {
  expect(baseline.events.length, '基线应当解析出若干事件').toBeGreaterThan(0);
  expect(baseline.text, '基线正文不应为空').not.toBe('');
  expect(baseline.appended, '基线应当有累积文本').not.toBe('');
}

describe('SSE accumulator survives arbitrary split points', () => {
  for (const [label, { wire, expected }] of Object.entries(WIRES)) {
    describe(label, () => {
      const baseline = runCharSplits(wire, []);

      it('has a meaningful baseline', () => {
        assertBaselineIsMeaningful(baseline);
      });

      it('matches the hand-written expectation when fed whole', () => {
        // ⚠️⚠️ **这一条是「所有切点一起错」的解药** —— 其余断言比的都是「与基线相等」，
        // 而基线走的是同一份实现 ⇒ 实现整体错时两边一起错、照样全绿。实测：把 `finish()`
        // 的 flush 关掉后，只有这一条会红。
        expect(baseline.text).toBe(expected.text);
        expect(baseline.appended).toBe(expected.appended);
        expect(baseline.events.map(([phase]) => phase)).toEqual([...expected.phases]);
      });

      it('produces the same digest at every character split point', () => {
        for (let at = 0; at <= wire.length; at += 1) {
          expect(runCharSplits(wire, [at]), `char split at ${at}`).toEqual(baseline);
        }
      });

      it('produces the same digest at every byte split point', () => {
        // ⚠️ 这一条才是真机路径：切在**多字节 UTF-8 序列中间**（中文 3 字节、emoji 4 字节）
        // 时，`TextDecoder` 必须靠 `{ stream: true }` 把半个序列留到下一块。
        const total = new TextEncoder().encode(wire).length;
        for (let at = 0; at <= total; at += 1) {
          expect(runByteSplits(wire, [at]), `byte split at ${at}`).toEqual(baseline);
        }
      });

      it('produces the same digest when fed one character at a time', () => {
        const splits = Array.from({ length: wire.length }, (_, index) => index);
        expect(runCharSplits(wire, splits)).toEqual(baseline);
      });

      it('produces the same digest when fed one byte at a time', () => {
        const total = new TextEncoder().encode(wire).length;
        const splits = Array.from({ length: total }, (_, index) => index);
        expect(runByteSplits(wire, splits)).toEqual(baseline);
      });

      it('produces the same digest for every equal-chunk split into 2..32 pieces', () => {
        for (let pieces = 2; pieces <= 32; pieces += 1) {
          const splits: number[] = [];
          for (let index = 1; index < pieces; index += 1) {
            splits.push(Math.floor((wire.length * index) / pieces));
          }
          expect(runCharSplits(wire, splits), `char split into ${pieces} pieces`).toEqual(baseline);
          const total = new TextEncoder().encode(wire).length;
          const byteSplits: number[] = [];
          for (let index = 1; index < pieces; index += 1) {
            byteSplits.push(Math.floor((total * index) / pieces));
          }
          expect(runByteSplits(wire, byteSplits), `byte split into ${pieces} pieces`).toEqual(baseline);
        }
      });
    });
  }
});

describe('SSE accumulator keeps multi-byte text intact across byte boundaries', () => {
  it('never emits a replacement character when a multi-byte sequence is split', () => {
    // ⚠️ 这条守的是「漏掉 `{ stream: true }`」那一类缺陷：症状是正文里出现 U+FFFD，
    // 而**最终文本长度可能仍然对**（替换字符也是 1 个 code unit）⇒ 只看长度抓不到。
    const wire = WIRES['newline-terminated'].wire;
    const total = new TextEncoder().encode(wire).length;
    for (let at = 0; at <= total; at += 1) {
      const digest = runByteSplits(wire, [at]);
      expect(digest.text, `byte split at ${at}`).not.toContain('�');
      expect(digest.appended, `byte split at ${at}`).not.toContain('�');
      expect(digest.events.every(([, raw]) => !raw.includes('�')), `byte split at ${at}`).toBe(true);
    }
  });

  it('keeps a surrogate pair whole when the split lands inside it', () => {
    // emoji 在 UTF-16 里是 2 个 code unit、在 UTF-8 里是 4 字节 —— 切在中间时
    // 字符层会看到半个代理对。这一条把「emoji 原样出现在正文里」钉住。
    const wire = 'data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"a🌏b"}}\n';
    const baseline = runCharSplits(wire, []);
    expect(baseline.text).toBe('a🌏b');

    const total = new TextEncoder().encode(wire).length;
    for (let at = 0; at <= total; at += 1) {
      expect(runByteSplits(wire, [at]).text, `byte split at ${at}`).toBe('a🌏b');
    }
  });
});

/**
 * ⚠️⚠️ **上面那些只覆盖到「字符层」为止** —— `runByteSplits` 自己拿着一个**正确**的
 * `TextDecoder`。而真机路径里那个 decoder 在 `fetch-hook.ts` 的 `pull` 里
 * （`decoder.decode(value, { stream: true })`），切点由**网络**决定、不是我们喂的。
 *
 * 所以这一组走**真 hook**：装 `installZaiFetchHook()`，用桩 `window.fetch` 造一个
 * 按任意字节切点分片的 SSE 响应，断言两件事：
 * ① **回给页面的字节逐字节不变**（hook 的定位是「只读流 + 透传」）；
 * ② **累积出来的正文与手写期望一致**（`onResponseComplete` 收到的那份）。
 *
 * ⚠️ 实测价值：把 `fetch-hook.ts` 里的 `{ stream: true }` 去掉后，
 * **只测字符层的那些断言全绿**（它们不经过那个 decoder），只有这一组会红。
 */
describe('the real fetch hook survives arbitrary network byte splits', () => {
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

  interface HookRun {
    pageBytes: Uint8Array;
    assistantText: string;
  }

  /** 装 hook，底层 fetch 换成「按 `splits` 分片吐出 `wire`」的桩，读干整条流。 */
  async function runThroughHook(wire: string, splits: readonly number[]): Promise<HookRun> {
    const bytes = new TextEncoder().encode(wire);
    const boundaries = [...splits, bytes.length];
    let assistantText: string | null = null;

    updateZaiHookState({
      toolDescriptorNames: new Set<string>(),
      // 增广原样放行 —— 本组测的是响应侧，不测请求侧。
      onRequestBody: async (body, requestId) => ({ body, requestId }),
      onHeadersCaptured: () => undefined,
      onToolCall: () => undefined,
      onUsageSnapshot: () => undefined,
      onHtmlChallenge: () => undefined,
      onRequestTerminal: () => undefined,
      onResponseComplete: (payload) => {
        assistantText = payload.assistantText;
      },
    });

    const stubFetch = async (): Promise<Response> => {
      let cursor = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (cursor >= boundaries.length) {
            controller.close();
            return;
          }
          const at = boundaries[cursor]!;
          const from = cursor === 0 ? 0 : boundaries[cursor - 1]!;
          cursor += 1;
          controller.enqueue(bytes.slice(from, at));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    window.fetch = stubFetch as unknown as typeof window.fetch;
    // 每次跑都「装 → 跑 → 卸」：cleanup 会还原 `window.fetch`、
    // `XMLHttpRequest.prototype` 并清掉安装标记，让下一次 install 真的重新挂钩。
    const uninstall = installZaiFetchHook();
    try {
      // ⚠️ 必须显式读干 —— hook 的 `pull` 只在页面（这里是我们）拉流时才推进。
      const response = await window.fetch(COMPLETION_URL, { method: 'POST', body: REQUEST_BODY });
      const chunks: Uint8Array[] = [];
      const reader = response.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const pageBytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        pageBytes.set(chunk, offset);
        offset += chunk.length;
      }

      if (assistantText === null) throw new Error('onResponseComplete 没有被调用');
      return { pageBytes, assistantText };
    } finally {
      uninstall();
    }
  }

  const WIRE = WIRES['newline-terminated'].wire;
  const EXPECTED = WIRES['newline-terminated'].expected;
  const TOTAL_BYTES = new TextEncoder().encode(WIRE).length;

  it('passes the page bytes through untouched at every byte split', async () => {
    const original = new TextEncoder().encode(WIRE);
    for (let at = 0; at <= TOTAL_BYTES; at += 1) {
      const run = await runThroughHook(WIRE, [at]);
      expect([...run.pageBytes], `byte split at ${at}`).toEqual([...original]);
    }
  });

  it('accumulates the same assistant text at every byte split', async () => {
    for (let at = 0; at <= TOTAL_BYTES; at += 1) {
      const run = await runThroughHook(WIRE, [at]);
      expect(run.assistantText, `byte split at ${at}`).toBe(EXPECTED.text);
    }
  });

  it('survives being fed one byte at a time', async () => {
    const splits = Array.from({ length: TOTAL_BYTES }, (_, index) => index);
    const run = await runThroughHook(WIRE, splits);
    expect([...run.pageBytes]).toEqual([...new TextEncoder().encode(WIRE)]);
    expect(run.assistantText).toBe(EXPECTED.text);
  });
});
