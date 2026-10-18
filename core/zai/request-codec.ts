/**
 * z.ai 请求体的路由匹配、解析与重写（两个站点共用同一套路由与形状）。
 *
 * - completion body：`signature_prompt` 是服务端权威 prompt；`messages` 只含
 *   最后一条 user 消息；agent/chat 区分靠 features.flags。
 * - 首条消息先 POST /api/v1/chats/new，user 内容存在 `chat.history.messages.<id>.content`，
 *   completion 只引用 `current_user_message_id` —— 首条必须额外增强 /chats/new body。
 */

import {
  ZAI_AGENT_FLAG,
  ZAI_AUGMENTABLE_WEB_ROUTES,
  ZAI_HISTORY_WEB_ROUTES,
  ZAI_WEB_ORIGIN,
  ZAI_WEB_ROUTES,
  isZaiSiteOrigin,
  type ZaiAugmentableWebRoute,
  type ZaiHistoryWebRoute,
  type ZaiWebRouteName,
} from './contracts';

export interface ZaiRoutePolicy {
  readonly route: ZaiWebRouteName;
  readonly method: 'POST' | 'GET';
}

/**
 * 路径模板里 `{id}` 段**不能**匹配的已知字面量段。
 *
 * 真机实测存在的同前缀端点：`/api/v1/chats/all`、`/chats/all/archived`、
 * `/chats/subagents`、`/chats/remix`、`/chats/{id}/tags`（后者由模板自身的
 * `/messages/batch` 后缀排除）。
 *
 * ⚠️ **刻意不要求 id 必须是 UUID 形态** —— 那会引入一个**静默失效**：
 * 万一服务端换了 id 形态（短 id / 带前缀），我们就不再匹配、于是**静默不剥**。
 * 用「排除已知字面段」则失败方向相反：未知字面段端点被当成 `chatDetail` 走一次剥，
 * 而剥函数对不认识的形状是 no-op ⇒ 无害。
 */
const ZAI_CHAT_ID_LITERAL_SEGMENTS: readonly string[] = [
  'all',
  'subagents',
  'remix',
  'new',
  'archived',
];

/** 单个路径段（不含 `/`），且不是上面那几个字面量。 */
const ZAI_CHAT_ID_SEGMENT = `(?!${ZAI_CHAT_ID_LITERAL_SEGMENTS.join('|')}(?:/|$))[^/]+`;

/**
 * 把 `ZAI_WEB_ROUTES` 里的路径模板编译成匹配 `pathname` 的正则。
 *
 * ⚠️ **必须是整串锚定的正则**（`^…$`），不能用 `includes` / `startsWith` ——
 * 近似匹配会把「加后缀 / 藏在 query 里 / 异源」几类一起放进来，表现是
 * **把提示词注进了不该注的请求**。拒绝面由 `tests/zai.test.ts` 逐条钉住。
 */
function compileRoutePattern(template: string): RegExp {
  const source = template
    .split('/')
    .map((segment) => (segment === '{id}' ? ZAI_CHAT_ID_SEGMENT : escapeRegExp(segment)))
    .join('/');
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 可增强路由的**策略表** —— 路由名 → 路径 + 方法。
 *
 * ⚠️ **这是路由匹配的唯一真源**：`matchZaiWebRoute` 遍历它，新增一条路由只改这张表。
 * 曾经这里被架空过 —— 表在、但匹配是两个各自内联 `ZAI_WEB_ROUTES` + 字面 `'POST'` 的
 * 函数，两张函数体逐字相同、只差一个路径常量（漏改一处的表现是**两条路由互相认领
 * 对方的请求**，且不报错）。
 */
const ZAI_ROUTE_POLICY: Record<ZaiWebRouteName, ZaiRoutePolicy> = {
  completion: { route: 'completion', method: 'POST' },
  chatNew: { route: 'chatNew', method: 'POST' },
  // 历史路由：页面用 GET 拉会话详情、用 POST 批量取消息正文。
  chatDetail: { route: 'chatDetail', method: 'GET' },
  chatMessages: { route: 'chatMessages', method: 'POST' },
};

const ZAI_ROUTE_PATTERNS: ReadonlyMap<ZaiWebRouteName, RegExp> = new Map(
  (Object.keys(ZAI_ROUTE_POLICY) as ZaiWebRouteName[])
    .map((route) => [route, compileRoutePattern(ZAI_WEB_ROUTES[route])] as const),
);

/**
 * 匹配一条请求属于哪个路由；不属于任何一个则返回 `null`。
 *
 * ⚠️ 判据是 origin 属于**站点集合**、且 pathname 与模板**整串相等**
 * （不是 `includes` / `startsWith`）—— 近似匹配会把「加后缀 / 藏在 query 里 / 异源」
 * 这几类一起放进来，表现是**把提示词注进了不该注的请求**。拒绝面由
 * `tests/zai.test.ts` 逐条钉住。
 *
 * ⚠️ **origin 判据是「集合相等」而不是「等于某一个站」** —— z.ai 有两个站点
 * （国区站 `zchat.z.ai` 与国际站 `chat.z.ai`，跑同一份前端产物），只认一个会让
 * 另一个站上的扩**一条路由都匹配不上**（增广、工具剥离、用量统计全部静默失效）。
 * ⚠️ 但它**不是**「后缀匹配」：`isZaiSiteOrigin` 是精确 equals，站点自己有
 * `zcode.z.ai` 之类的同域子站，放宽到后缀等于把信任范围放大到一个域。
 *
 * ⚠️ **相对 URL 必须用 `new URL(url, baseUrl ?? ZAI_WEB_ORIGIN)` 兜底** ——
 * fetch hook 里拿到的就是相对路径（而那个 base 必须是**当前页**那一站，
 * 否则解析出来的 origin 对不上、路由匹配失败）。
 *
 * ⚠️⚠️ **匹配上 ≠ 该增强** —— 该不该增强看 `isZaiAugmentableRoute` /
 * `isZaiHistoryRoute`。三条名单互相独立，理由见 `contracts.ts` 的说明。
 */
export function matchZaiWebRoute(input: {
  url: string;
  method: string;
  baseUrl?: string;
}): ZaiWebRouteName | null {
  const url = readUrl(input.url, input.baseUrl);
  if (!url || !isZaiSiteOrigin(url.origin)) return null;
  const method = input.method.toUpperCase();
  for (const policy of Object.values(ZAI_ROUTE_POLICY)) {
    if (method !== policy.method) continue;
    if (ZAI_ROUTE_PATTERNS.get(policy.route)?.test(url.pathname)) return policy.route;
  }
  return null;
}

const ZAI_AUGMENTABLE_ROUTE_SET: ReadonlySet<string> = new Set(ZAI_AUGMENTABLE_WEB_ROUTES);

/**
 * 这条路由的**请求体**要不要注入提示词。
 *
 * ⚠️ 与「路由匹配上了吗」是两个问题：历史路由同样会被 `matchZaiWebRoute` 匹配到，
 * 但它们的请求体里没有提示词（`chatMessages` 的 body 是 `{"ids":[…]}`）⇒
 * 让它们进增广分支会把 `signature_prompt` 写进一个不该有它的请求体。
 */
export function isZaiAugmentableRoute(
  route: ZaiWebRouteName | null | undefined,
): route is ZaiAugmentableWebRoute {
  return typeof route === 'string' && ZAI_AUGMENTABLE_ROUTE_SET.has(route);
}

const ZAI_HISTORY_ROUTE_SET: ReadonlySet<string> = new Set(ZAI_HISTORY_WEB_ROUTES);

/** 这条路由的**响应体**要不要剥掉内部文本与工具 XML。 */
export function isZaiHistoryRoute(
  route: ZaiWebRouteName | null | undefined,
): route is ZaiHistoryWebRoute {
  return typeof route === 'string' && ZAI_HISTORY_ROUTE_SET.has(route);
}

/** 相对 URL 必须用 `new URL(url, ZAI_WEB_ORIGIN)` 兜底（关键坑：fetch hook 里 URL 是相对路径）。 */
function readUrl(rawUrl: string, baseUrl?: string): URL | null {
  try {
    // 相对路径直接 new URL 会抛错，所以先按 ZAI_WEB_ORIGIN 当 base 解析。
    return new URL(rawUrl, baseUrl ?? ZAI_WEB_ORIGIN);
  } catch {
    return null;
  }
}

export function parseZaiBody(bodyStr: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(bodyStr);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 读取 completion body 里最后一条 user 消息文本。
 * completion 的 messages 始终只含最后一条 user 消息（历史由 parent 链还原）。
 */
export function readZaiLastUserMessageText(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && typeof message === 'object') {
      const record = message as Record<string, unknown>;
      if (record.role === 'user' && typeof record.content === 'string') {
        return record.content;
      }
    }
  }
  return '';
}

/** 重写 completion body 的最后一条 user 消息内容与 signature_prompt（保持同步）。 */
export function rewriteZaiLastUserMessage(
  body: Record<string, unknown>,
  nextText: string,
): Record<string, unknown> {
  const next = { ...body };
  const messages = Array.isArray(next.messages) ? next.messages.slice() : [];
  let replaced = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && typeof message === 'object') {
      const record = message as Record<string, unknown>;
      if (record.role === 'user' && typeof record.content === 'string') {
        messages[i] = { ...record, content: nextText };
        replaced = true;
        break;
      }
    }
  }
  if (replaced) next.messages = messages;
  // signature_prompt 是服务端权威 prompt：增强必须同步改它。
  next.signature_prompt = nextText;
  return next;
}

/**
 * 判断某条 completion 请求是否「会话首条消息」。
 * z.ai 首条消息走 /api/v1/chats/new 单独建立，completion 里带 `current_user_message_parent_id`
 * (=上一条请求 id)。首条 completion 该字段为 null/undefined；正常多轮带 parent id。
 */
export function readZaiCurrentUserMessageParentId(body: Record<string, unknown>): unknown {
  return (body as { current_user_message_parent_id?: unknown }).current_user_message_parent_id ?? null;
}

export interface ZaiChatNewBody {
  userId?: string | null;
  /** 首条 user 消息文本挂在 chat.history.messages.<id>.content 下。 */
  userMessageTexts: string[];
  /** agent 模式的标志（type/general_agent、flags）。 */
  isAgent: boolean;
}

/**
 * 解析 /api/v1/chats/new body，找出要增强的首条 user 消息文本。
 * 结构（真机抓包）：`{ chat: { history: { messages: { <id>: { content: "..." } } }, type, flags } }`
 * 容忍多种嵌套形状。
 */
export function parseZaiChatNewBody(body: Record<string, unknown>): ZaiChatNewBody | null {
  const chat = readRecord(body.chat);
  if (!chat) return null;

  const isAgent =
    chat.type === ZAI_AGENT_FLAG ||
    (Array.isArray(chat.flags) && chat.flags.includes(ZAI_AGENT_FLAG));

  const history = readRecord(chat.history);
  const messages = history ? readRecord(history.messages) : null;
  const texts: string[] = [];
  if (messages) {
    for (const value of Object.values(messages)) {
      const message = readRecord(value);
      if (message && typeof message.content === 'string') {
        texts.push(message.content);
      }
    }
  }
  if (texts.length === 0) {
    // 兜底：直接挂 chat.messages / body.messages。
    const direct = readRecord(chat.messages ?? body.messages);
    if (direct) {
      for (const value of Object.values(direct)) {
        const message = readRecord(value);
        if (message && typeof message.content === 'string') texts.push(message.content);
      }
    }
  }
  if (texts.length === 0) return null;
  return { userId: typeof chat.user_id === 'string' ? chat.user_id : null, userMessageTexts: texts, isAgent };
}

/** 重写 /chats/new body 的首条 user 消息（原样保留其它字段）。 */
export function rewriteZaiChatNewUserMessages(
  body: Record<string, unknown>,
  nextTexts: string[],
): Record<string, unknown> {
  const next = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const chat = readRecord(next.chat);
  if (chat) {
    const history = readRecord(chat.history);
    const messages = history ? readRecord(history.messages) : null;
    if (messages) writeMessageTexts(messages, nextTexts);
  }
  return next;
}

function writeMessageTexts(container: Record<string, unknown>, texts: string[]): void {
  const keys = Object.keys(container);
  const userKeys = keys
    .map((key) => {
      const message = readRecord(container[key]);
      return message && typeof message.content === 'string' ? key : null;
    })
    .filter((key): key is string => key !== null);
  const count = Math.min(userKeys.length, texts.length);
  for (let i = 0; i < count; i += 1) {
    const message = container[userKeys[i]] as Record<string, unknown>;
    message.content = texts[i];
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ---------------------------------------------------------------------------
// z.ai 原生联网开关：强制关闭（features.auto_web_search + features.web_search 一起置 false）。
// 协议依据：z.ai 真机抓包 —— 普通搜索两个 flag 都是 true，高级搜索是
// auto_web_search=true / web_search=false；两个都写 false 用来观测能否关掉原生联网。
// 联网一律走扩展自带的 web_search / web_fetch。
// ---------------------------------------------------------------------------

/**
 * 安全合并 features：关闭原生联网 = auto_web_search + web_search 都置 false。
 * 语义（z.ai 真机抓包）：`auto_web_search`=自动判断要不要搜，`web_search`=强制联网搜索。
 * 两个都置 false 用于关闭服务器侧的原生检索通道（保留其它既有 features 字段）。
 */
export function mergeZaiNativeSearchDisabled(features: unknown): Record<string, unknown> {
  const existing = readRecord(features) ?? {};
  return { ...existing, auto_web_search: false, web_search: false };
}

/** 在 body 顶层 `features` 上关闭原生联网搜索（原地合并浅拷贝，返回是否可写）。 */
export function disableZaiNativeWebSearch(body: Record<string, unknown>): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  body.features = mergeZaiNativeSearchDisabled(body.features);
  return true;
}

// ---------------------------------------------------------------------------
// 自动化任务的模型选择：把任务选定的模型写进请求体。
// ⚠️ **chat 与 agent 两种模式都适用** —— 真机实测 agent 的请求体里模型字段是活的
// （同一会话不同轮次会带不同 id），不存在「agent 由服务端装配、覆写无效」这回事。
//
// 两个路由的模型**落点不同**，是两个函数而不是一个：
//   - completion：顶层 `model`（字符串）
//   - chats/new：`chat.models` + 首条 user 消息的 `models` + `features.models`（三个数组）
// ---------------------------------------------------------------------------

/**
 * 覆写 completion body 顶层的 `model`（原地写，返回是否写入）。
 *
 * **只在 body 本来就有 `model` 时才覆写**：凭空往里加一个页面没发过的字段，
 * 历史上正是 400 的来源（`chat.features` 那次）。
 */
export function applyZaiModelOverride(
  body: Record<string, unknown>,
  model: string | null | undefined,
): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const next = normalizeZaiModelOverride(model);
  if (!next) return false;
  if (!Object.hasOwn(body, 'model')) return false;
  if (body.model === next) return false;
  body.model = next;
  return true;
}

/**
 * 覆写 `/api/v1/chats/new` body 的模型（原地写，返回是否写入）。
 *
 * **建会话的模型不在顶层**，而是**同一个值出现在三个落点**（真机抓包确认三者始终同值）：
 *   - `chat.models`（数组）
 *   - 首条 user 消息自己的 `models`（数组）
 *   - `features.models`（数组）
 *
 * ⇒ **三处一起写**。少写任何一处都会**亲手制造不一致**（页面自己始终让它们同值），
 * 而服务端读哪一个没有公开依据。
 *
 * ⚠️ **这一步不能省。** 会话模型是**建会话那一刻**定下的：只在 completion 阶段写
 * `model` 改不动已有会话，页面仍显示默认模型。
 *
 * 三处都只在字段已存在时覆写 —— 页面没发过的字段不凭空造。
 */
export function applyZaiChatNewModelOverride(
  body: Record<string, unknown>,
  model: string | null | undefined,
): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const next = normalizeZaiModelOverride(model);
  if (!next) return false;
  const chat = readRecord(body.chat);
  if (!chat) return false;

  let changed = false;
  if (Array.isArray(chat.models) && !isSingleModel(chat.models, next)) {
    chat.models = [next];
    changed = true;
  }
  // 首条 user 消息自带一份 models，与 chat.models 保持同值（页面自身也这么发）。
  const history = readRecord(chat.history);
  const messages = history ? readRecord(history.messages) : null;
  if (messages) {
    for (const value of Object.values(messages)) {
      const message = readRecord(value);
      if (!message || !Array.isArray(message.models)) continue;
      if (isSingleModel(message.models, next)) continue;
      message.models = [next];
      changed = true;
    }
  }
  // 第三个落点：`features.models`。页面把它与上面两处写成同值，漏掉就是不一致。
  const features = readRecord(body.features);
  if (features && Array.isArray(features.models) && !isSingleModel(features.models, next)) {
    features.models = [next];
    changed = true;
  }
  return changed;
}

/** 读当前 `/chats/new` body 里的会话模型（诊断与测试用）。 */
export function readZaiChatNewModel(body: Record<string, unknown>): unknown {
  const chat = readRecord(body.chat);
  return chat?.models ?? null;
}

/**
 * 模型落点由**路由**决定，与调用点在代码里的位置无关。
 *
 * ⚠️ **取值域是「可增强路由」而不是全部路由** —— 模型覆写发生在增广阶段，
 * 只有可增强路由会走到那里。用 `ZaiWebRouteName` 会让历史路由也能传进来，
 * 而那两条路根本没有模型落点（`readZaiModelForRoute` 会把它们当 `completion` 读）。
 */
export type ZaiModelRoute = ZaiAugmentableWebRoute;

/**
 * 按路由把任务选定的模型写进请求体 —— **唯一入口**。
 *
 * 两个路由的落点不同（见上面两个函数），但「该用哪个落点」的依据是**路由本身**，
 * 不是「调用点恰好写在哪个分支里」。分散调用时这两者只是碰巧一致，新加注入点很容易
 * 挑错写入函数，而挑错的表现是**静默失效**（模型没被应用，请求照发）。
 */
export function applyZaiModelOverrideForRoute(
  body: Record<string, unknown>,
  route: ZaiModelRoute,
  model: string | null | undefined,
): boolean {
  return route === 'chatNew'
    ? applyZaiChatNewModelOverride(body, model)
    : applyZaiModelOverride(body, model);
}

/** 按路由读当前的模型落点（诊断用）。 */
export function readZaiModelForRoute(
  body: Record<string, unknown>,
  route: ZaiModelRoute,
): unknown {
  return route === 'chatNew' ? readZaiChatNewModel(body) : (body.model ?? null);
}

function normalizeZaiModelOverride(model: string | null | undefined): string {
  return typeof model === 'string' ? model.trim() : '';
}

function isSingleModel(models: readonly unknown[], model: string): boolean {
  return models.length === 1 && models[0] === model;
}