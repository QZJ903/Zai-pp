/**
 * z.ai 会话 id ↔ URL：`/c/<id>`。
 */
import { ZAI_WEB_ORIGIN } from './contracts';

const ZAI_CHAT_SESSION_PATHNAME = /^\/c\/([^/?#]+)/;

/** 由会话 id 构造可打开的会话 URL（与页面 /c/<id> 同形）。 */
export function buildZaiChatSessionUrl(chatSessionId: string, baseUrl = ZAI_WEB_ORIGIN): string {
  const origin = baseUrl.replace(/\/+$/, '');
  return `${origin}/c/${encodeURIComponent(chatSessionId)}`;
}

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