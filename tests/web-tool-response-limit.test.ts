import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeWebSearchToolCall,
  WEB_TOOL_MAX_RESPONSE_BYTES,
} from '../core/tool/web-search';

/**
 * `web_search` / `web_fetch` 的**响应体字节上限**（内存保护）。
 *
 * 改动的由来：这两个工具此前都是 `await response.text()` —— 先把**整个**响应读进内存，
 * 之后那句 `slice(0, 50_000)` 只截断结果、拦不住读取阶段。上限这一层解决的是后者。
 *
 * ⚠️ 这一层**不改变正常流量的行为**：2 MiB 相对实测 Bing SERP（约 96 KB）有 20 倍余量，
 * 所以「正常页面结果不变」与「超限被拦」两条必须同时成立 —— 只测后者会漏掉回归。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 把若干字节块包成一个可流式读取的 Response，块的边界完全由调用方决定。 */
function streamingResponse(
  chunks: Uint8Array[],
  init: { status?: number; contentType?: string; onCancel?: (reason: unknown) => void } = {},
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel(reason) {
      init.onCancel?.(reason);
    },
  });
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'text/plain' },
  });
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function webFetch(url = 'https://example.test/') {
  return executeWebSearchToolCall(
    { name: 'web_fetch', payload: { url }, raw: '<web_fetch />' },
    'en',
  );
}

describe('web tool response byte limit', () => {
  it('returns the page unchanged when it stays under the limit', async () => {
    const page = 'plain body text that is long enough to be useful';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamingResponse([utf8(page)])));

    const result = await webFetch();

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(false);
    expect((result.output as { content: string }).content).toBe(page);
    expect((result.output as { truncated: boolean }).truncated).toBe(false);
    // 未超限时详情仍是「页面长度 N 字符」，不能落到超限文案上
    expect(result.detail).toBe(`Page length ${page.length} characters`);
  });

  it('stops reading at the limit instead of buffering the whole body', async () => {
    // 40 × 64 KiB = 2.5 MiB，超过 2 MiB 上限
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const chunks = Array.from({ length: 40 }, () => chunk);

    let cancelled = false;
    const readCount = { value: 0 };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const item of chunks) controller.enqueue(item);
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    // 记下基准 reader 被拉取了多少次：提前停止的判据是「没有把 40 块全拉完」
    const originalGetReader = body.getReader.bind(body);
    vi.spyOn(body, 'getReader').mockImplementation(() => {
      const reader = originalGetReader();
      const originalRead = reader.read.bind(reader);
      reader.read = () => {
        readCount.value += 1;
        return originalRead();
      };
      return reader;
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }),
    ));

    const result = await webFetch();

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect((result.output as { truncated: boolean }).truncated).toBe(true);
    // 提前 break：拉取次数应远小于 40 块（上限 2 MiB ÷ 64 KiB = 32 块）
    expect(readCount.value).toBeLessThan(40);
    // 停读后必须取消上游 body，否则连接挂着等 GC
    expect(cancelled).toBe(true);
    // 详情走超限文案，且带上了上限值与已保留长度
    expect(result.detail).toContain(String(WEB_TOOL_MAX_RESPONSE_BYTES));
    expect(result.detail).toContain('stopped reading');
  });

  it('keeps a page that is exactly at the limit', async () => {
    // 32 × 64 KiB = 2 MiB，恰好等于字节上限 —— 边界值不能被误判为超限。
    // ⚠️ 不能用 `truncated === false` 断言：这么长的 ASCII 必然同时撞上**字符**上限
    // （50_000），`truncated` 会因后者为 true。两层要分开看 ——
    // 详情文案是「字符截断」还是「超字节上限」正好能区分它们。
    const chunk = new Uint8Array(64 * 1024).fill(0x62);
    const chunks = Array.from({ length: 32 }, () => chunk);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamingResponse(chunks)));

    const result = await webFetch();

    expect(result.ok).toBe(true);
    // 内容被**字符**上限截到 50_000 + 截断后缀；这段断言只证明「读到了整份正文」，
    // 字节边界本身由下面的详情文案判定。
    expect((result.output as { content: string }).content.startsWith('bbbb')).toBe(true);
    expect((result.output as { content: string }).content.length).toBeGreaterThanOrEqual(50_000);
    // 落在字符上限那条分支（= 未被字节上限拦下），而不是超限分支
    expect(result.detail).toContain('truncated to 50000 characters');
    expect(result.detail).not.toContain('byte limit');
  });

  it('decodes multi-byte characters that straddle a chunk boundary', async () => {
    // 「中」= 3 字节，这里把它切成 1+2 两块：非流式解码会把两块各解成替换字符
    const encoded = utf8('中文内容');
    const chunks = [encoded.slice(0, 1), encoded.slice(1)];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamingResponse(chunks)));

    const result = await webFetch();

    expect(result.ok).toBe(true);
    expect((result.output as { content: string }).content).toBe('中文内容');
  });

  it('treats a page whose extracted text exceeds the character cap as truncated', async () => {
    // 字符数上限（50_000）与字节上限是两层，这里只碰前者：50 KiB 文本远低于 2 MiB
    const page = 'x'.repeat(60_000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamingResponse([utf8(page)])));

    const result = await webFetch();

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect((result.output as { content: string }).content).toContain('[Content truncated');
  });

  it('falls back to a one-shot read when the response has no readable body', async () => {
    // 没有 body 就没有「边读边判」的落点 —— 行为与改动前一致（一次性读取、不判上限）
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(null, { status: 200, headers: { 'content-type': 'text/plain' } }),
    ));

    const result = await webFetch();

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(false);
    expect((result.output as { content: string }).content).toBe('');
  });

  it('rejects an oversized search engine response instead of parsing half an SERP', async () => {
    // 搜索页被截断 = 不可信输入：宁可报错换域重试，也不拿半截 HTML 解析出「看着有结果」的假结果
    const chunk = new Uint8Array(64 * 1024).fill(0x63);
    const chunks = Array.from({ length: 40 }, () => chunk);
    // ⚠️ 每次调用必须造一个**新的** Response：响应体只能读一次，
    // 复用同一个对象会让第二个域的读取报「unreadable」而不是「exceeded」，
    // 掩盖掉这条断言真正想验的东西。
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(streamingResponse(chunks, { contentType: 'text/html' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeWebSearchToolCall(
      { name: 'web_search', payload: { query: 'anything' }, raw: '<web_search />' },
      'en',
    );

    expect(result.ok).toBe(false);
    // 两个域名都试过 → 至少两次；两个都超限 ⇒ 失败而不是「找到 0 条结果」
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.summary).toBe('Search failed');
    expect(result.error?.message).toContain('exceeded');
  });
});