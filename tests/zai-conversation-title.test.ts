import { describe, expect, it, vi } from 'vitest';
import {
  createZaiConversationTitleResolver,
  decodeZaiChatDetailTitle,
  zaiChatDetailPath,
} from '../core/zai/conversation-title';

/** 真机单会话响应形状（与 `chats/new` 同源：顶层带 id 与 title）。 */
function detail(id: string, title: string) {
  return { id, user_id: 'u1', title, chat: { id, models: [] } };
}

function createResolver(
  respond: (url: string, init: RequestInit) => Promise<unknown>,
  options: {
    token?: string | null;
    now?: () => number;
  } = {},
) {
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const payload = await respond(url, init);
    return { ok: true, status: 200, json: async () => payload };
  });
  const loadToken = vi.fn(async () => (options.token === undefined ? 'tok-1' : options.token));
  const resolver = createZaiConversationTitleResolver({
    loadToken,
    fetchImpl: fetchImpl as never,
    ...(options.now ? { now: options.now } : {}),
  });
  return { resolver, fetchImpl, loadToken };
}

describe('zai chat detail decoding', () => {
  it('reads the title from the top level of the single-conversation response', () => {
    expect(decodeZaiChatDetailTitle(detail('c1', '真实会话名'), 'c1')).toBe('真实会话名');
  });

  it('rejects a response for a different conversation', () => {
    // 服务端做了重定向/别名时，它的 title 属于别的会话 —— 写进去就是错名。
    expect(decodeZaiChatDetailTitle(detail('c2', '别的会话'), 'c1')).toBeNull();
  });

  it('treats every placeholder title as "not a name yet"', () => {
    for (const placeholder of ['新聊天', '新任务', 'New Chat', 'Untitled conversation', '']) {
      expect(decodeZaiChatDetailTitle(detail('c1', placeholder), 'c1'), placeholder).toBeNull();
    }
  });

  it('collapses whitespace and rejects non-object payloads', () => {
    expect(decodeZaiChatDetailTitle(detail('c1', '  多   空格  '), 'c1')).toBe('多 空格');
    expect(decodeZaiChatDetailTitle(null, 'c1')).toBeNull();
    expect(decodeZaiChatDetailTitle([detail('c1', 'x')], 'c1')).toBeNull();
    expect(decodeZaiChatDetailTitle({ title: 42 }, 'c1')).toBeNull();
  });
});

describe('zai conversation title resolver', () => {
  it('requests the single-conversation endpoint with the bearer token', async () => {
    const { resolver, fetchImpl } = createResolver(async () => detail('c1', '真实会话名'));

    await expect(resolver.resolve('c1')).resolves.toBe('真实会话名');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain(zaiChatDetailPath('c1'));
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
  });

  it('returns null when there is no token', async () => {
    const { resolver, fetchImpl } = createResolver(async () => detail('c1', 'x'), { token: null });

    await expect(resolver.resolve('c1')).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing when the request fails', async () => {
    const resolver = createZaiConversationTitleResolver({
      loadToken: async () => 'tok-1',
      fetchImpl: async () => { throw new Error('offline'); },
    });

    await expect(resolver.resolve('c1')).resolves.toBeNull();
  });

  it('caches a real title so repeated calls do not re-request', async () => {
    const { resolver, fetchImpl } = createResolver(async () => detail('c1', '真实会话名'));

    await resolver.resolve('c1');
    await resolver.resolve('c1');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not cache a miss, so a retry can still pick up a late title', async () => {
    // 补名有「立刻 + 隔 2.5 秒」两次尝试，第一次往往早于服务端生成好标题。
    let title = '新聊天';
    const { resolver, fetchImpl } = createResolver(async () => detail('c1', title));

    await expect(resolver.resolve('c1')).resolves.toBeNull();
    title = '真实会话名';
    await expect(resolver.resolve('c1')).resolves.toBe('真实会话名');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent calls into one request', async () => {
    const { resolver, fetchImpl } = createResolver(async () => detail('c1', '真实会话名'));

    const [first, second] = await Promise.all([resolver.resolve('c1'), resolver.resolve('c1')]);

    expect(first).toBe('真实会话名');
    expect(second).toBe('真实会话名');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('exposes the cached title synchronously through peek, without requesting', async () => {
    const { resolver, fetchImpl } = createResolver(async () => detail('c1', '真实会话名'));

    expect(resolver.peek('c1')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();

    await resolver.resolve('c1');
    expect(resolver.peek('c1')).toBe('真实会话名');
  });

  it('stops serving a cached title once it expires', async () => {
    let clock = 1_000;
    const { resolver } = createResolver(
      async () => detail('c1', '真实会话名'),
      { now: () => clock },
    );

    await resolver.resolve('c1');
    expect(resolver.peek('c1')).toBe('真实会话名');

    clock += 60_000;
    expect(resolver.peek('c1')).toBeNull();
  });

  it('escapes the conversation id in the path', () => {
    expect(zaiChatDetailPath('a/b?c')).toBe('/api/v1/chats/a%2Fb%3Fc');
  });
});

describe('zai conversation title refusal paths', () => {
  it('returns null when the server title is still a placeholder', async () => {
    // 服务端还没生成好标题时给的是临时名（「新聊天」），它不是名字 ——
    // 当真名返回会让调用方把它写进存储，而占位闸门从此拒绝真名。
    const { resolver } = createResolver(async () => detail('c1', '新聊天'));

    await expect(resolver.resolve('c1')).resolves.toBeNull();
  });

  it('returns null when the response belongs to another conversation', async () => {
    // 服务端做了重定向/别名时，响应里的 title 属于**别的**会话 —— 写进去就是错名。
    const { resolver } = createResolver(async () => detail('c2', '别的会话'));

    await expect(resolver.resolve('c1')).resolves.toBeNull();
  });

  it('returns null when the response has no usable title field', async () => {
    const { resolver } = createResolver(async () => ({ id: 'c1', chat: {} }));

    await expect(resolver.resolve('c1')).resolves.toBeNull();
  });

  it('bounds the request so a stalled connection cannot hold the in-flight slot forever', async () => {
    // ⚠️ 没有上界时：promise 不 settle → `inFlight` 与面板的 `backfillAttemptedIds`
    // 被长期占住 → 之后每次触发都落到「已尝试」跳过分支，**不会自愈**。
    const { resolver, fetchImpl } = createResolver(async () => detail('c1', '真实会话名'));

    await resolver.resolve('c1');

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it('releases the in-flight slot after a timed-out request so a retry can succeed', async () => {
    let attempt = 0;
    const resolver = createZaiConversationTitleResolver({
      loadToken: async () => 'tok-1',
      fetchImpl: async () => {
        attempt += 1;
        // 第一次模拟超时（AbortSignal 触发的 reject 也是普通异常）。
        if (attempt === 1) throw new DOMException('aborted', 'TimeoutError');
        return { ok: true, status: 200, json: async () => detail('c1', '真实会话名') };
      },
    });

    await expect(resolver.resolve('c1')).resolves.toBeNull();

    // 在飞位已释放 → 下一次还能重试，且超时那次没有被缓存。
    await expect(resolver.resolve('c1')).resolves.toBe('真实会话名');
  });
});
