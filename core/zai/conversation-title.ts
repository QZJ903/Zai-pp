/**
 * 会话标题的**一手源**：服务端。
 *
 * 页面侧边栏那行只是服务端列表的投影 —— 页面收到 WebSocket 的 `chat:title`
 * 之后**要再重拉一次列表**才会换名，而那一跳不保证每次都成立。所以「侧边栏
 * 有没有真名」不可靠：读一个没更新的源，改多少次触发时点都一样。
 *
 * 这里直接问服务端。用的是**单会话端点** `GET /api/v1/chats/{id}`：
 * 不带分页、不分 chat/agent 模式（列表端点要带 `type`，多一层判断），
 * 响应顶层就带 `title`。
 *
 * ⚠️ 内容脚本在隔离世界，它的 `fetch` **不是**页面那个被我们 hook 过的
 * `window.fetch` —— 不会被自己的 fetch hook 拦到，所以不需要绕过标记。
 */

import { isPlaceholderProjectConversationTitle } from '../project/title';

/** 单会话端点（真机实测：响应形状与 `chats/new` 同源，顶层带 `title`）。 */
export function zaiChatDetailPath(conversationId: string): string {
  return `/api/v1/chats/${encodeURIComponent(conversationId)}`;
}

/**
 * **成功结果**的缓存时长。
 *
 * 取标题的调用点很密（切会话、每轮回答结束都会问一次），而标题在一条会话内
 * 只会变一次（临时名 → 真名），所以成功值缓存一小段是安全的。
 *
 * ⚠️⚠️ **失败与占位串结果一律不缓存** —— 补名有「立刻 + 隔 2.5 秒」两次尝试，
 * 第一次往往早于服务端生成好标题。若把那次 null 缓存下来，第二次会直接命中缓存
 * 拿到同样的 null，重试就白设了。
 */
const TITLE_CACHE_TTL_MS = 10_000;

/**
 * 一次请求的上界。
 *
 * ⚠️ **必须有** —— 这条链路的 promise 不 settle 时，`inFlight` 与面板的
 * `backfillAttemptedIds` 都会被它一直占着，之后每次触发都落到「已尝试」跳过分支，
 * **不会自愈**。Chrome 网络栈对停滞连接有自己的超时，但那不是我们的上界。
 * 5 秒与补名的 2.5 秒重试节奏相称：第一次超时后重试仍有机会。
 */
const TITLE_REQUEST_TIMEOUT_MS = 5_000;

export interface ZaiConversationTitleResolverDependencies {
  /**
   * 读**指定站点**的登录态 token；拿不到就放弃（返回 null）。
   *
   * ⚠️ **站点由 `resolveOrigin()` 给，不由 token 自己带** —— 两站的 token 互不认。
   */
  loadToken: (origin: string) => Promise<string | null>;
  fetchImpl: (
    input: string,
    init: RequestInit,
  ) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
  /**
   * 本会话所属站点的 origin（**不含尾斜杠**）。
   *
   * ⚠️ **必须注入、不能吃 `ZAI_WEB_ORIGIN`** —— 后者是**默认站点**（国区站）。
   * 在国际站上，解析器用默认站的 origin 去拉标题会：
   * ① 请求打到国区站，而两站的 token 互不认 ⇒ 401 ⇒ 拿不到标题；
   * ② 就算拿得到，也会把请求发到一个与当前页无关的站。
   * 内容脚本那一半传 `resolveZaiSite(location.origin)?.origin`。
   */
  resolveOrigin: () => string;
  now?: () => number;
}

export interface ZaiConversationTitleResolver {
  /**
   * 取某条会话的标题（会发请求）。**拿不到、或服务端给的仍是占位串时返回 null** ——
   * 调用方据此「什么都不做」，而不是把占位串当真名写进存储。
   */
  resolve(conversationId: string): Promise<string | null>;
  /**
   * **只读缓存**，不发请求（没有新鲜的成功值就返回 null）。
   *
   * 给**请求增广那条热路径**用：它必须在发请求前同步定下标题，不能为了等一个
   * 网络往返而拖慢每一次对话。配合 `resolve` 的空跑预热，下一轮就能命中缓存。
   */
  peek(conversationId: string): string | null;
}

export function createZaiConversationTitleResolver(
  dependencies: ZaiConversationTitleResolverDependencies,
): ZaiConversationTitleResolver {
  const now = dependencies.now ?? (() => Date.now());
  const cache = new Map<string, { title: string; at: number }>();
  const inFlight = new Map<string, Promise<string | null>>();

  const fetchTitle = async (conversationId: string): Promise<string | null> => {
    // ⚠️ **先定站点、再取那一站的 token**（同 `models.ts` 的口径）——
    // 两次读各自发生的话，中间可以被「用户切站」插进来，token 与请求 URL 就分属两站了。
    const origin = dependencies.resolveOrigin();
    const token = await dependencies.loadToken(origin);
    if (!token) return null;
    let response: Awaited<ReturnType<ZaiConversationTitleResolverDependencies['fetchImpl']>>;
    try {
      response = await dependencies.fetchImpl(
        `${origin}${zaiChatDetailPath(conversationId)}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            authorization: `Bearer ${token}`,
          },
          credentials: 'omit',
          cache: 'no-store',
          signal: AbortSignal.timeout(TITLE_REQUEST_TIMEOUT_MS),
        },
      );
    } catch {
      return null;
    }
    if (!response.ok) return null;
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return null;
    }
    return decodeZaiChatDetailTitle(raw, conversationId);
  };

  return Object.freeze({
    async resolve(conversationId: string): Promise<string | null> {
      if (!conversationId) return null;
      const cached = cache.get(conversationId);
      if (cached && now() - cached.at < TITLE_CACHE_TTL_MS) {
        return cached.title;
      }
      const pending = inFlight.get(conversationId);
      if (pending) {
        return pending;
      }
      const request = (async () => {
        try {
          const title = await fetchTitle(conversationId);
          // 只缓存真名（见 TITLE_CACHE_TTL_MS 的说明）。
          if (title) cache.set(conversationId, { title, at: now() });
          return title;
        } finally {
          inFlight.delete(conversationId);
        }
      })();
      inFlight.set(conversationId, request);
      return request;
    },
    peek(conversationId: string): string | null {
      if (!conversationId) return null;
      const cached = cache.get(conversationId);
      if (!cached) return null;
      return now() - cached.at < TITLE_CACHE_TTL_MS ? cached.title : null;
    },
  });
}

/**
 * 从单会话响应里取标题。
 *
 * ⚠️ **两处都要判**：① 响应对应的确实是请求的那条会话（`id` 对不上说明
 * 服务端做了重定向或别名，此时它的 `title` 属于别的会话）；② 标题不是占位串
 * ——「新聊天」这类临时名不是名字，写进存储会让闸门从此拒绝真名。
 */
export function decodeZaiChatDetailTitle(raw: unknown, conversationId: string): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  if (typeof id === 'string' && id.trim() && id.trim() !== conversationId) return null;
  const title = record.title;
  if (typeof title !== 'string') return null;
  const trimmed = title.replace(/\s+/g, ' ').trim();
  if (!trimmed || isPlaceholderProjectConversationTitle(trimmed)) return null;
  return trimmed;
}
