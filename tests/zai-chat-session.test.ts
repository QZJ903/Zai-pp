import { describe, expect, it } from 'vitest';
import { buildZaiChatSessionUrl, readZaiChatSessionId } from '../core/zai/chat-session';

/**
 * z.ai 的会话路由是 `/c/<id>`。
 *
 * ⚠️ **这是会话 id 的读入口，两个生产消费者都在授权链上** ——
 * `core/messaging/runtime-boundary.ts` 用它从**浏览器持有的 tab URL** 派生
 * `context.chatSessionId`（`createRuntimeMessageContext` 与
 * `refreshGLMContentRuntimeContext` 各一处），而这个值决定 grant 绑给哪个会话。
 * 读错的表现是 `tool_session_mismatch`（工具静默不可用），不是崩溃 —— 所以要有守卫。
 *
 * ⚠️ **它刻意不校验 origin**（`/c/<id>` 只按 pathname 认）。传入的值由调用方保证是
 * 浏览器持有的 tab URL（`runtime-boundary` 已在更上层做过 origin 校验）；
 * 这里若自己再校一次，会把「相对路径」这种合法入参挡掉。
 *
 * ⚠️ 上游对应文件是 `core/deepseek/chat-session.ts`（路由是 `/a/chat/s/<id>`），
 * 用例形状照搬，**路径换成 z.ai 的 `/c/<id>`**。
 */
describe('zai chat session route', () => {
  it.each([
    ['https://chat.z.ai/c/session-1', 'session-1'],
    ['https://chat.z.ai/c/session%202', 'session 2'],
    ['/c/session-3?from=history', 'session-3'],
    ['/c/session-4#fragment', 'session-4'],
    ['/c/session-5/extra', 'session-5'],
  ])('reads %s as %s', (route, expected) => {
    expect(readZaiChatSessionId(route)).toBe(expected);
  });

  it.each([
    ['/c/', null],
    ['/c', null],
    ['/prefix/c/session-6', null],
    ['/c/%E0%A4%A', null],
    ['/c/%20', null],
    ['', null],
  ])('returns null for %s', (route, expected) => {
    expect(readZaiChatSessionId(route)).toBe(expected);
  });

  it('trims the decoded id and rejects an all-whitespace one', () => {
    expect(readZaiChatSessionId('/c/%20abc%20')).toBe('abc');
    // 编码后全是空白 ⇒ 解码后 trim 成空串 ⇒ 如实返回 null，不返回空字符串。
    expect(readZaiChatSessionId('/c/%20%20')).toBeNull();
  });

  it('accepts a URL object as well as a string', () => {
    expect(readZaiChatSessionId(new URL('https://chat.z.ai/c/url-object'))).toBe('url-object');
    expect(readZaiChatSessionId(new URL('https://chat.z.ai/'))).toBeNull();
  });

  it('reads the pathname only, without checking the origin', () => {
    // ⚠️ 这是**刻意的**：origin 由调用方（runtime-boundary）保证。见文件头说明。
    expect(readZaiChatSessionId('https://evil.test/c/session-7')).toBe('session-7');
  });

  it('builds an openable conversation URL from an id', () => {
    expect(buildZaiChatSessionUrl('abc')).toBe('https://chat.z.ai/c/abc');
    // id 会被 URL 编码，斜杠不会逃出路径段。
    expect(buildZaiChatSessionUrl('a/b')).toBe('https://chat.z.ai/c/a%2Fb');
    expect(buildZaiChatSessionUrl('a b')).toBe('https://chat.z.ai/c/a%20b');
  });

  it('trims trailing slashes on a custom base url', () => {
    expect(buildZaiChatSessionUrl('x', 'https://example.test/')).toBe('https://example.test/c/x');
    expect(buildZaiChatSessionUrl('x', 'https://example.test')).toBe('https://example.test/c/x');
  });

  it('round-trips an id through build and read', () => {
    for (const id of ['abc', 'session-1', 'a b', '中文']) {
      expect(readZaiChatSessionId(buildZaiChatSessionUrl(id))).toBe(id);
    }
  });
});
