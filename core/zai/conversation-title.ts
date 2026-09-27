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
import { ZAI_WEB_ORIGIN } from './contracts';

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
 * 谁在问标题。
 *
 * ⚠️ **必须记下来**：三个调用方的触发时机与前提完全不同，光看「有没有结果」
 * 分不清是「没触发」还是「触发了但拿不到」——
 * - `prewarm`：请求增广热路径的空跑预热，**每次发消息都会问**，与项目无关；
 * - `panel-backfill`：项目面板补名，**只对已归入项目的会话**生效；
 * - `sidebar-read`：侧边栏项目页读当前会话，要打开那一页才触发。
 */
export type ZaiConversationTitleSource = 'prewarm' | 'panel-backfill' | 'sidebar-read';

/**
 * 一次标题解析的结果分类。
 *
 * ⚠️ **这是诊断用的分类，不是业务分支** —— 调用方只关心「拿到标题没有」。
 * 分开记是为了让「为什么没拿到」在 console 里一眼可读（见 `onDiagnostic`）。
 */
export type ZaiConversationTitleOutcome =
  /** 命中缓存，没发请求。 */
  | 'cache-hit'
  /** 在读在飞请求，合并成同一次。 */
  | 'in-flight'
  /** 没有 token，连请求都没发。 */
  | 'no-token'
  /** fetch 抛错（网络/被拦截）。 */
  | 'request-failed'
  /** 响应非 2xx。 */
  | 'http-error'
  /** 响应里的会话 id 与请求的不一致。 */
  | 'id-mismatch'
  /** 响应里没有可用标题字段。 */
  | 'malformed'
  /** 服务端给的仍是占位串（标题还没生成好）。 */
  | 'placeholder'
  /** 拿到真名。 */
  | 'resolved';

export interface ZaiConversationTitleDiagnostic {
  conversationId: string;
  source: ZaiConversationTitleSource;
  outcome: ZaiConversationTitleOutcome;
  title?: string;
  status?: number;
  /**
   * 服务端返回的**原始标题**（判定之前）。
   *
   * ⚠️ 与 `title` 分开记的理由：`placeholder` 只说明「值是占位清单里的某个词」，
   * 但**看不出是哪一个**。有了原始值才能区分「服务端还没生成好」与
   * 「我们的占位清单误伤了一个真名字」—— 这两种情况的修法完全相反。
   */
  observedTitle?: string;
  at: number;
}

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
  /** 读登录态 token；拿不到就放弃（返回 null）。 */
  loadToken: () => Promise<string | null>;
  fetchImpl: (
    input: string,
    init: RequestInit,
  ) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
  now?: () => number;
  /**
   * 诊断回调：每次解析都会调一次（含命中缓存的）。
   *
   * 存在的理由：这条链路**在 `__GLMPP_DIAG__` 里看不见** —— fetch hook 打在页面的
   * MAIN world，而我们的请求发自隔离世界，主世界看不见。所以「请求到底发了没有」
   * 只能靠这个回调记下来。
   */
  onDiagnostic?: (event: ZaiConversationTitleDiagnostic) => void;
}

export interface ZaiConversationTitleResolver {
  /**
   * 取某条会话的标题（会发请求）。**拿不到、或服务端给的仍是占位串时返回 null** ——
   * 调用方据此「什么都不做」，而不是把占位串当真名写进存储。
   */
  resolve(conversationId: string, source: ZaiConversationTitleSource): Promise<string | null>;
  /**
   * **只读缓存**，不发请求（没有新鲜的成功值就返回 null）。
   *
   * 给**请求增广那条热路径**用：它必须在发请求前同步定下标题，不能为了等一个
   * 网络往返而拖慢每一次对话。配合 `resolve` 的空跑预热，下一轮就能命中缓存。
   *
   * ⚠️ **刻意不上报诊断**：它每次发消息都会被调，命中与否从「有没有 `prewarm`
   * 条目」就能看出来（没条目 = 命中了缓存，因为空缓存会触发一次 `resolve`）。
   */
  peek(conversationId: string): string | null;
}

export function createZaiConversationTitleResolver(
  dependencies: ZaiConversationTitleResolverDependencies,
): ZaiConversationTitleResolver {
  const now = dependencies.now ?? (() => Date.now());
  const cache = new Map<string, { title: string; at: number }>();
  const inFlight = new Map<string, Promise<string | null>>();

  const report = (
    conversationId: string,
    source: ZaiConversationTitleSource,
    outcome: ZaiConversationTitleOutcome,
    extra: { title?: string; observedTitle?: string; status?: number } = {},
  ): void => {
    dependencies.onDiagnostic?.({
      conversationId,
      source,
      outcome,
      at: now(),
      ...(extra.title === undefined ? {} : { title: extra.title }),
      ...(extra.observedTitle === undefined ? {} : { observedTitle: extra.observedTitle }),
      ...(extra.status === undefined ? {} : { status: extra.status }),
    });
  };

  const fetchTitle = async (conversationId: string): Promise<{
    title: string | null;
    outcome: ZaiConversationTitleOutcome;
    observedTitle?: string;
    status?: number;
  }> => {
    const token = await dependencies.loadToken();
    if (!token) return { title: null, outcome: 'no-token' };
    let response: Awaited<ReturnType<ZaiConversationTitleResolverDependencies['fetchImpl']>>;
    try {
      response = await dependencies.fetchImpl(
        `${ZAI_WEB_ORIGIN}${zaiChatDetailPath(conversationId)}`,
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
      return { title: null, outcome: 'request-failed' };
    }
    if (!response.ok) return { title: null, outcome: 'http-error', status: response.status };
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return { title: null, outcome: 'malformed', status: response.status };
    }
    const observedTitle = readRawTitle(raw);
    const title = decodeZaiChatDetailTitle(raw, conversationId);
    const withObserved = observedTitle === undefined ? {} : { observedTitle };
    if (title) return { title, outcome: 'resolved', status: response.status, ...withObserved };
    // 没拿到标题时再分一次类：是「响应属于别的会话」还是「服务端还没生成好」——
    // 前者说明请求或服务端行为有问题，后者只是时机问题，排查时差别很大。
    return {
      title: null,
      outcome: classifyEmptyTitle(raw, conversationId),
      status: response.status,
      ...withObserved,
    };
  };

  return Object.freeze({
    async resolve(
      conversationId: string,
      source: ZaiConversationTitleSource,
    ): Promise<string | null> {
      if (!conversationId) return null;
      const cached = cache.get(conversationId);
      if (cached && now() - cached.at < TITLE_CACHE_TTL_MS) {
        report(conversationId, source, 'cache-hit', { title: cached.title });
        return cached.title;
      }
      const pending = inFlight.get(conversationId);
      if (pending) {
        report(conversationId, source, 'in-flight');
        return pending;
      }
      const request = (async () => {
        try {
          const { title, outcome, observedTitle, status } = await fetchTitle(conversationId);
          // 只缓存真名（见 TITLE_CACHE_TTL_MS 的说明）。
          if (title) cache.set(conversationId, { title, at: now() });
          report(conversationId, source, outcome, {
            ...(title ? { title } : {}),
            ...(observedTitle === undefined ? {} : { observedTitle }),
            ...(status === undefined ? {} : { status }),
          });
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

/** 响应顶层的原始 `title`（判定之前）—— 用于区分「没生成好」与「清单误伤真名」。 */
function readRawTitle(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const title = (raw as Record<string, unknown>).title;
  return typeof title === 'string' ? title : undefined;
}

/** 区分「响应属于别的会话」与「标题还没生成好」——排查时这两条路完全不同。 */
function classifyEmptyTitle(raw: unknown, conversationId: string): ZaiConversationTitleOutcome {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'malformed';
  const record = raw as Record<string, unknown>;
  const id = record.id;
  if (typeof id === 'string' && id.trim() && id.trim() !== conversationId) return 'id-mismatch';
  if (typeof record.title !== 'string') return 'malformed';
  return 'placeholder';
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
