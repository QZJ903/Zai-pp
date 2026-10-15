/**
 * z.ai 会话 id ↔ URL：`/c/<id>`。
 *
 * ⚠️ **路径形状两站相同**（真机实测：国区站与国际站都是 `/c/<uuid>`），
 * 所以这一层不需要按站分叉 —— 要分叉的只有**拼 URL 时的 origin**（见
 * `buildZaiChatSessionUrl` 的 `baseUrl`）与**读 URL 时的站点校验**（本层刻意不做，
 * 见 `readZaiChatSessionId`）。
 */
import { ZAI_WEB_ORIGIN } from './contracts';

const ZAI_CHAT_SESSION_PATHNAME = /^\/c\/([^/?#]+)/;

/**
 * 由会话 id 构造可打开的会话 URL（与页面 /c/<id> 同形）。
 *
 * ⚠️⚠️ **调用方必须传对 `baseUrl`** —— 默认值是**默认站点**（国区站），
 * 与「当前页是哪一站」无关。在国际站的页面上用默认值拼链接，会把用户带到国区站。
 * 有页面上下文的调用方传 `resolveZaiSite(location.origin)?.origin`（内容脚本的部分），
 * 有会话归属的传记录里带的站点（自动化那几处）；**只有两者都拿不到时才吃默认值**。
 */
export function buildZaiChatSessionUrl(chatSessionId: string, baseUrl = ZAI_WEB_ORIGIN): string {
  const origin = baseUrl.replace(/\/+$/, '');
  return `${origin}/c/${encodeURIComponent(chatSessionId)}`;
}

/**
 * 从 URL / 路径里读会话 id。
 *
 * ⚠️ **刻意不校验 origin，也不校验站点** —— 它只回答「这条路径是不是 `/c/<id>`」，
 * 与「这是哪个站的 URL」是两个问题（后者由调用方按需判，如侧边栏过滤
 * `chrome.tabs.onUpdated` 时用 `isZaiSiteOrigin`）。加站点校验会让它多一个
 * 现在没有的失败分支，而所有现有调用点都不需要它。
 */
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

/**
 * 取路径。
 *
 * ⚠️ **base 用哪个站不影响结果** —— 本函数只读 `pathname`，而 `/c/<id>` 是绝对路径，
 * 套任何 absolute base 解析出来的 pathname 都一样（传进来的值本身也可能是另一站的
 * 完整 URL，同理）。用默认站的 origin 当 base 只是为了让 `new URL` 有个合法基准。
 */
function readPathname(value: string): string {
  try {
    return new URL(value, ZAI_WEB_ORIGIN).pathname;
  } catch {
    return value;
  }
}