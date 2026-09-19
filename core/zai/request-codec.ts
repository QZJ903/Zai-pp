/**
 * chat.z.ai 请求体的路由匹配、解析与重写。
 *
 * - completion body：`signature_prompt` 是服务端权威 prompt；`messages` 只含
 *   最后一条 user 消息；agent/chat 区分靠 features.flags。
 * - 首条消息先 POST /api/v1/chats/new，user 内容存在 `chat.history.messages.<id>.content`，
 *   completion 只引用 `current_user_message_id` —— 首条必须额外增强 /chats/new body。
 */

import {
  ZAI_AGENT_FLAG,
  ZAI_WEB_ORIGIN,
  ZAI_WEB_ROUTES,
  type ZaiWebRouteName,
} from './contracts';

export interface ZaiRoutePolicy {
  readonly route: ZaiWebRouteName;
  readonly method: 'POST' | 'GET';
}

const ZAI_ROUTE_POLICY: Record<ZaiWebRouteName, ZaiRoutePolicy> = {
  completion: { route: 'completion', method: 'POST' },
  chatNew: { route: 'chatNew', method: 'POST' },
};

export function matchZaiCompletionRoute(input: {
  url: string;
  method: string;
  baseUrl?: string;
}): boolean {
  const url = readUrl(input.url, input.baseUrl);
  if (!url || url.origin !== ZAI_WEB_ORIGIN) return false;
  return (
    url.pathname === ZAI_WEB_ROUTES.completion &&
    input.method.toUpperCase() === 'POST'
  );
}

export function matchZaiChatNewRoute(input: {
  url: string;
  method: string;
  baseUrl?: string;
}): boolean {
  const url = readUrl(input.url, input.baseUrl);
  if (!url || url.origin !== ZAI_WEB_ORIGIN) return false;
  return (
    url.pathname === ZAI_WEB_ROUTES.chatNew &&
    input.method.toUpperCase() === 'POST'
  );
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