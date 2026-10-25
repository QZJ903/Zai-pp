import { afterEach, describe, expect, it } from 'vitest';
import { installZaiFetchHook, updateZaiHookState } from '../core/zai/fetch-hook';

/**
 * **completion 返回 HTML（挑战页）时，hook 的行为是一条独立契约。**
 *
 * 这条分支此前零测试 —— 全仓搜 `onHtmlChallenge` 只有一处命中，而那处把它设成
 * `() => undefined` 的空桩（`zai-sse-arbitrary-split.test.ts`），等于没测。
 *
 * ⚠️⚠️ **它守的是什么**：`core/zai/fetch-hook.ts` 在 `content-type` 含 `text/html` 时
 * **只透传原响应 + 发一条 `HTML_CHALLENGE`**，然后直接 `return` —— 不读流、不算用量、
 * 不发 `RESPONSE_COMPLETE`、**也不发 `REQUEST_TERMINAL`**。
 * 后面这几条「不发」是承重的：`REQUEST_TERMINAL` 是请求级状态的释放点
 * （`releaseRequestState`），而挑战页这一轮**根本没写过那些容器**；多发一条反而会
 * 触发 `armManualStopDetection` 的另一个入口。
 *
 * ⚠️ **它不守什么**：页面收到 HTML 之后怎么渲染（弹不弹错误卡片、Stop 按钮闪不闪）
 * 是 DOM 行为，**只有真机能验**。本文件只钉 hook 这一层。
 */
describe('the fetch hook treats an HTML completion response as a challenge page', () => {
  const COMPLETION_URL = 'https://chat.z.ai/api/v2/chat/completions?requestId=r1&user_id=u1';
  const REQUEST_BODY = JSON.stringify({
    model: 'x-preview-l',
    messages: [{ role: 'user', content: '提问' }],
    signature_prompt: '提问',
  });
  const CHALLENGE_HTML = '<!doctype html><html><body>challenge</body></html>';

  const originalFetch = window.fetch;

  afterEach(() => {
    window.fetch = originalFetch;
  });

  interface HookRun {
    /** 页面实际读到的字节。 */
    pageBytes: Uint8Array;
    /** 本轮的 requestId（hook 自己生成的，从 `onRequestBody` 捕获）。 */
    requestId: string;
    /** 收到的回调，按发生顺序。 */
    events: string[];
  }

  /** 装 hook，底层 fetch 换成「固定吐 `response`」的桩，把响应读干。 */
  async function runThroughHook(makeResponse: () => Response): Promise<HookRun> {
    const events: string[] = [];
    let requestId = '';

    updateZaiHookState({
      toolDescriptorNames: new Set<string>(),
      // 增广原样放行 —— 本组测的是响应侧，不测请求侧。
      onRequestBody: async (body, id) => {
        requestId = id;
        return { body, requestId: id };
      },
      onHeadersCaptured: () => { events.push('headers'); },
      onToolCall: () => { events.push('toolCall'); },
      onUsageSnapshot: () => { events.push('usage'); },
      onHtmlChallenge: (payload) => { events.push(`challenge:${payload.requestId}`); },
      onRequestTerminal: (payload) => { events.push(`terminal:${payload.requestId}`); },
      onResponseComplete: (payload) => { events.push(`complete:${payload.requestId}`); },
    });

    const stubFetch = async (): Promise<Response> => makeResponse();
    window.fetch = stubFetch as unknown as typeof window.fetch;
    const uninstall = installZaiFetchHook();
    try {
      const response = await window.fetch(COMPLETION_URL, { method: 'POST', body: REQUEST_BODY });
      const chunks: Uint8Array[] = [];
      // 空 body 是其中一档被测行为（`!response.body` 走另一个提前分支），所以不能无条件读。
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
      }
      const pageBytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        pageBytes.set(chunk, offset);
        offset += chunk.length;
      }
      return { pageBytes, requestId, events };
    } finally {
      uninstall();
    }
  }

  it('passes the challenge bytes through untouched', async () => {
    const run = await runThroughHook(() => new Response(CHALLENGE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));

    expect([...run.pageBytes]).toEqual([...new TextEncoder().encode(CHALLENGE_HTML)]);
  });

  it('fires onHtmlChallenge exactly once, carrying the request id', async () => {
    const run = await runThroughHook(() => new Response(CHALLENGE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));

    expect(run.events.filter((event) => event.startsWith('challenge:')))
      .toEqual([`challenge:${run.requestId}`]);
  });

  it('does not treat a challenge page as a completed turn', async () => {
    const run = await runThroughHook(() => new Response(CHALLENGE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));

    // ⚠️ 三条「不发」是这条分支的**全部要点**：它没读流、没算用量、没有终态。
    // 发了 terminal 会让挑战页这一轮被当成「正常结束」去释放请求级状态
    // （而这一轮压根没写过那些容器），并给手动停止检测多开一个入口。
    expect(run.events.filter((event) => event.startsWith('terminal:'))).toEqual([]);
    expect(run.events.filter((event) => event.startsWith('complete:'))).toEqual([]);
    expect(run.events).not.toContain('usage');
    expect(run.events).not.toContain('toolCall');
  });

  it('still completes normally when the response is an SSE stream', async () => {
    // ⚠️ **反向对照** —— 没有它，上面三条「不发」可能是恒真的（例如 hook 根本没被装上）。
    const wire = 'data: {"type":"chat:completion","data":{"phase":"done"}}\n\n';
    const run = await runThroughHook(() => new Response(wire, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    expect(run.events).toContain(`complete:${run.requestId}`);
    expect(run.events).toContain(`terminal:${run.requestId}`);
    expect(run.events.filter((event) => event.startsWith('challenge:'))).toEqual([]);
    expect([...run.pageBytes]).toEqual([...new TextEncoder().encode(wire)]);
  });

  it('treats a body-less response as a terminal, not as a challenge', async () => {
    // ⚠️ 空 body 走的是**另一个**提前分支（在 `text/html` 判定之前），它**要**发 terminal。
    // 钉住它，免得将来有人把两个提前分支合并时丢掉这条。
    const run = await runThroughHook(() => new Response(null, { status: 204 }));

    expect(run.events).toContain(`terminal:${run.requestId}`);
    expect(run.events.filter((event) => event.startsWith('challenge:'))).toEqual([]);
    expect(run.pageBytes).toHaveLength(0);
  });
});
