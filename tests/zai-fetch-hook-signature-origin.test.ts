// @vitest-environment-options {"url": "https://chat.z.ai/c/abc"}
import { afterEach, describe, expect, it } from 'vitest';
import { installZaiFetchHook, updateZaiHookState } from '../core/zai/fetch-hook';

/**
 * **`fetch-hook` 必须把「当前页 origin」传进重签名。**
 *
 * ⚠️⚠️ 这条守的是**一跳**，不是签名算法本身：`applyCompletionSignature` 调
 * `resignZaiCompletionRequest(url, body, readPageOrigin())` 时那个**第三个实参**。
 *
 * **为什么这跳需要单独的守卫**：`tests/zai.test.ts` 的 `URL normalization after resigning`
 * 三组用例全部自己给 `resignZaiCompletionRequest` 传 `baseUrl`，所以把
 * `applyCompletionSignature` 里那个实参删掉，它们**照样全绿** —— 被绕过的正是
 * 「谁提供 baseUrl」这件事。而这一跳坏掉是**静默**的：`resignZaiCompletionRequest`
 * 解析相对 URL 失败时返回 `null`，调用方于是沿用页面自己那份 `X-Signature`，
 * 而 body 里的 `signature_prompt` 已被增广改写 ⇒ **签名与正文对不上，全程无报错**。
 *
 * ⚠️⚠️ **本文件把 jsdom 的 origin 设成 `https://chat.z.ai`（非默认站）**，这是判据能否
 * 成立的前提：默认站是 `zchat.z.ai`，若 origin 恰好等于默认站，「传对了 origin」与
 * 「写死成 `ZAI_WEB_ORIGIN`」产出的 URL **完全一样**，断言区分不出来。设成非默认站之后，
 * 三种写法才会分叉：
 * - 传对 → `https://chat.z.ai/api/...`
 * - 写死默认站 → `https://zchat.z.ai/api/...`（第一条断言红）
 * - 干脆不传 → URL 保持相对、且**没有签名**（两条都红）
 *
 * ⚠️ 页面收到响应之后怎么处理是 DOM 行为，**只有真机能验**；本文件只钉 hook 这一层。
 */
describe('the fetch hook resigns completion requests against the page origin', () => {
  const originalFetch = window.fetch;

  afterEach(() => {
    window.fetch = originalFetch;
  });

  const RELATIVE_COMPLETION_URL =
    '/api/v2/chat/completions?timestamp=1793149200000&requestId=r1&user_id=u1';
  const REQUEST_BODY = JSON.stringify({
    model: 'x-preview-l',
    messages: [{ role: 'user', content: '提问' }],
    signature_prompt: '提问',
  });

  /** 装 hook，底层 fetch 换成桩，返回「页面实际发出的那一条请求」。 */
  async function runThroughHook(): Promise<{ url: string; signature: string | null }> {
    const seen: Array<{ url: string; signature: string | null }> = [];

    updateZaiHookState({
      toolDescriptorNames: new Set<string>(),
      // 增广原样放行 —— 本组测的是「重签名用哪个 base」，不是增广本身。
      onRequestBody: async (body, requestId) => ({ body, requestId }),
    });

    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        signature: new Headers(init?.headers ?? {}).get('X-Signature'),
      });
      return new Response('data: {"type":"chat:completion","data":{"phase":"done"}}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof window.fetch;

    const uninstall = installZaiFetchHook();
    try {
      const response = await window.fetch(RELATIVE_COMPLETION_URL, {
        method: 'POST',
        body: REQUEST_BODY,
      });
      await response.text();
    } finally {
      uninstall();
    }

    // 反面自检的前提：hook 真的拦到了这一条（否则下面的断言都在验空气）。
    expect(seen, 'hook 没有拦到这条请求').toHaveLength(1);
    return seen[0];
  }

  it('resolves the relative URL against the page origin, not the default site', async () => {
    const request = await runThroughHook();
    // 期望值手写：唯一的改动是 `signature_timestamp` 被 `set` 成 `timestamp`。
    expect(request.url).toBe(
      `https://chat.z.ai${RELATIVE_COMPLETION_URL}&signature_timestamp=1793149200000`,
    );
  });

  it('attaches a signature computed from the augmented body', async () => {
    const request = await runThroughHook();
    expect(request.signature).toMatch(/^[0-9a-f]{64}$/);
  });
});
