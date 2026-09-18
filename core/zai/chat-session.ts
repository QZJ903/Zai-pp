/**
 * 读取 z.ai 会话 id：`/c/<id>`。
 */
const ZAI_CHAT_SESSION_PATHNAME = /^\/c\/([^/?#]+)/;

export function readZaiChatSessionId(value: string | URL): string | null {
  const pathname = typeof value === 'string' ? readPathname(value) : value.pathname;
  const match = pathname.match(ZAI_CHAT_SESSION_PATHNAME);
  if (!match?.[1]) return null;
  try {
    const sessionId = decodeURIComponent(match[1]);
    return sessionId.trim() ? sessionId.trim() : null;
  } catch {
    return null;
  }
}

function readPathname(value: string): string {
  try {
    return new URL(value, 'https://chat.z.ai').pathname;
  } catch {
    return value;
  }
}