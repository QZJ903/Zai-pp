/**
 * MAIN world fetch/XHR hook（z.ai 版）。
 *
 * 职责：
 * 1. 拦截 completion 请求 → 交给 isolated 世界增广（改 messages + signature_prompt
 *    并重算 X-Signature）→ 字节透传回页面。
 * 2. 拦截 /chats/new 请求 → 增强首条 user 消息（首条不走 completion）。
 * 3. 解析响应 SSE → 流式工具 XML 识别 → 通知 isolated 执行 → 字节透传。
 * 4. HTML 挑战页检测（completion 返回 text/html 时重发）。
 *
 * 与 glm 版 fetch-hook 最大区别：续跑不在这里直接 fetch（z.ai 有 captcha
 * 墙），改由 DOM 注入让页面自己发。本文件只管「读流 + 识别 + 透传」。
 */

import {
  ZAI_BYPASS_HOOK_HEADER,
  ZAI_DIAG_GLOBAL,
  ZAI_WEB_ORIGIN,
} from './contracts';
import {
  matchZaiChatNewRoute,
  matchZaiCompletionRoute,
  parseZaiBody,
  readZaiLastUserMessageText,
} from './request-codec';
import {
  createZaiStreamAccumulator,
  type ZaiSseEvent,
  type ZaiStreamAccumulator,
} from './stream-codec';
import { resignZaiCompletionRequest } from './sign';

export interface ZaiHookState {
  toolDescriptorNames: ReadonlySet<string>;
  onRequestBody: (
    body: string,
    requestId: string,
    route: 'completion' | 'chatNew',
  ) => Promise<ZaiRequestBodyModification | null>;
  onHeadersCaptured: (headers: Record<string, string> | null) => void;
  onToolCall: (call: ZaiDetectedToolCall) => void;
  onResponseComplete: (complete: ZaiResponseCompletePayload) => void;
  onRequestTerminal: (terminal: { requestId: string }) => void;
  onHtmlChallenge: (payload: { requestId: string }) => void;
}

export interface ZaiRequestBodyModification {
  body: string;
  requestId?: string;
  toolDescriptorNames?: string[];
}

export interface ZaiDetectedToolCall {
  name: string;
  raw: string;
  requestId: string;
}

export interface ZaiResponseCompletePayload {
  requestId: string;
  originalPrompt: string;
  agentTaskPrompt: string;
  assistantText: string;
  toolCalls: ZaiDetectedToolCall[];
}

interface ZaiRequestContext {
  requestId: string;
  originalPrompt: string;
  agentTaskPrompt: string;
}

const HTML_CHALLENGE_MAX_RETRIES = 6;
const FETCH_HOOK_MARKER = Symbol.for('zai-pp.fetch-hook-installed');
const XHR_HOOK_MARKER = Symbol.for('zai-pp.xhr-hook-installed');

const diag = createGlobalDiagnostics();

function createGlobalDiagnostics() {
  const target = (typeof window !== 'undefined' ? window : globalThis) as unknown as Record<string, unknown>;
  const existing = target[ZAI_DIAG_GLOBAL] as
    | { responses?: unknown[]; toolCalls?: unknown[]; failures?: unknown[]; errors?: unknown[]; chatNewLog?: unknown[] }
    | undefined;
  const state = existing ?? { responses: [], toolCalls: [], failures: [], errors: [], chatNewLog: [] };
  if (!state.errors) state.errors = [];
  if (!state.failures) state.failures = [];
  if (!state.chatNewLog) state.chatNewLog = [];
  target[ZAI_DIAG_GLOBAL] = state;
  return state;
}

let hookState: ZaiHookState = createEmptyHookState();

function createEmptyHookState(): ZaiHookState {
  return {
    toolDescriptorNames: new Set(),
    onRequestBody: async () => null,
    onHeadersCaptured: () => {},
    onToolCall: () => {},
    onResponseComplete: () => {},
    onRequestTerminal: () => {},
    onHtmlChallenge: () => {},
  };
}

export function updateZaiHookState(partial: Partial<ZaiHookState>): void {
  hookState = { ...hookState, ...partial };
}

export function installZaiFetchHook(): () => void {
  const cleanups: Array<() => void> = [];
  try {
    cleanups.push(hookFetch());
    cleanups.push(hookXHR());
  } catch (error) {
    for (const cleanup of cleanups.reverse()) cleanup();
    throw error;
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}

function hasBypassHeader(headers: HeadersInit | undefined): boolean {
  if (!headers) return false;
  try {
    return new Headers(headers).has(ZAI_BYPASS_HOOK_HEADER);
  } catch {
    return false;
  }
}

function stripBypassHeader(headers: HeadersInit | undefined): HeadersInit | undefined {
  if (!headers) return headers;
  const next = new Headers(headers);
  next.delete(ZAI_BYPASS_HOOK_HEADER);
  return next;
}

function captureClientHeaders(
  headers: HeadersInit | undefined,
  requestUrl?: string,
): Record<string, string> | null {
  try {
    const captured: Record<string, string> = {};
    // token 在 query 的 `token=` 参数字段（优先），本地 localStorage 兜底（2.3.1 stateless 结论）。
    const queryToken = readQueryToken(requestUrl);
    const storedToken = readLocalStorageToken();
    const token = queryToken || storedToken;
    if (token) captured.token = token;
    const queryUserId = readQueryParam(requestUrl, 'user_id');
    if (queryUserId) captured.user_id = queryUserId;
    if (!queryUserId) {
      const userId = readUserIdFromToken(token);
      if (userId) captured.user_id = userId;
    }
    if (!headers) return captured.token || captured.user_id ? captured : null;
    const normalized = new Headers(headers);
    const authorization = normalized.get('authorization');
    if (authorization) captured.Authorization = authorization;
    const feVersion = readFeVersion();
    if (feVersion) captured['X-FE-Version'] = feVersion;
    else {
      const headerFe = normalized.get('x-fe-version');
      if (headerFe) captured['X-FE-Version'] = headerFe;
    }
    const signature = normalized.get('x-signature');
    if (signature) captured['X-Signature'] = signature;
    const deviceId = normalized.get('x-device-id');
    if (deviceId) captured['x-device-id'] = deviceId;
    if (captured.token || captured.user_id || authorization || signature) return captured;
    return null;
  } catch {
    return null;
  }
}

/** 从相对/绝对 URL 里读 `token=` query 参数（token 在 query 里，不在 header）。 */
function readQueryToken(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url, ZAI_WEB_ORIGIN).searchParams.get('token')?.trim() ?? '';
  } catch {
    return '';
  }
}

/** 从相对/绝对 URL 里读任意 query 参数。 */
function readQueryParam(url: string | undefined, name: string): string {
  if (!url) return '';
  try {
    return new URL(url, ZAI_WEB_ORIGIN).searchParams.get(name)?.trim() ?? '';
  } catch {
    return '';
  }
}

/** 读 localStorage 里的 `token`（登录或 guest token），仅作兜底。 */
function readLocalStorageToken(): string {
  try {
    if (typeof localStorage === 'undefined') return '';
    const raw = localStorage.getItem('token');
    return raw ? raw.trim() : '';
  } catch {
    return '';
  }
}

/** 从 JWT payload 解出 `id`（completion 签名需要 user_id）。 */
function readUserIdFromToken(token: string): string {
  if (!token) return '';
  const parts = token.split('.');
  if (parts.length < 2) return '';
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const payload = JSON.parse(decoded) as { id?: unknown };
    if (typeof payload.id === 'string') return payload.id;
    if (typeof payload.id === 'number' && Number.isFinite(payload.id)) return String(payload.id);
    return '';
  } catch {
    return '';
  }
}

/** 捕获 completion 请求的完整现场：token / user_id / fe 版本，供 stateless 续跑复用。 */
/** 动态读页面当前 prod-fe 版本（关键坑：硬编码会报「请刷新页面」）。 */
export function readFeVersion(): string {
  const candidates: string[] = [];
  try {
    if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
      for (const entry of performance.getEntriesByType('resource')) {
        const name = entry.name;
        const match = /prod-fe-[\d.]+/.exec(name);
        if (match) candidates.push(match[0]);
      }
    }
  } catch {
    /* ignore */
  }
  if (candidates.length > 0) {
    const latest = candidates.sort().reverse()[0];
    return latest.replace(/^prod-fe-/, 'prod-fe-');
  }
  return '';
}

function createRequestContext(bodyStr: string): ZaiRequestContext {
  const body = parseZaiBody(bodyStr);
  const prompt = body ? readZaiLastUserMessageText(body) : '';
  return {
    requestId: crypto.randomUUID(),
    originalPrompt: prompt,
    agentTaskPrompt: prompt,
  };
}

interface ZaiIntercepted {
  context: ZaiRequestContext;
  requestBody: string;
  requestInit: RequestInit;
  toolNames: string[];
}

async function prepareRequest(
  body: string,
  route: 'completion' | 'chatNew',
): Promise<ZaiIntercepted> {
  const originalContext = createRequestContext(body);
  let modified: ZaiRequestBodyModification | null = null;
  try {
    modified = await hookState.onRequestBody(body, originalContext.requestId, route);
  } catch (error) {
    console.error('[GLM++] request augmentation failed; sending original request', error);
  }

  const toolNames = modified?.toolDescriptorNames ?? [];
  const requestBody = modified?.body ?? body;

  return {
    context: {
      requestId: modified?.requestId ?? originalContext.requestId,
      originalPrompt: originalContext.originalPrompt,
      agentTaskPrompt: originalContext.agentTaskPrompt,
    },
    requestBody,
    requestInit: ({} as RequestInit),
    toolNames,
  };
}

function applyCompletionSignature(
  url: string,
  requestBody: string,
): { url: string; headers: Record<string, string> } {
  const body = parseZaiBody(requestBody);
  if (!body) return { url, headers: {} };
  const resigned = resignZaiCompletionRequest(url, body);
  if (!resigned) return { url, headers: {} };
  return { url: resigned.url, headers: { 'X-Signature': resigned.signature } };
}

function hookFetch(): () => void {
  const currentFetch = window.fetch as typeof window.fetch & { [FETCH_HOOK_MARKER]?: true };
  if (currentFetch[FETCH_HOOK_MARKER]) return () => undefined;
  const originalFetch = window.fetch;

  const hookedFetch = async function (
    this: Window,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : '';
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

    const isCompletion = url && method ? matchZaiCompletionRoute({ url, method, baseUrl: ZAI_WEB_ORIGIN }) : false;
    const isChatNew = url && method ? matchZaiChatNewRoute({ url, method, baseUrl: ZAI_WEB_ORIGIN }) : false;
    if ((!isCompletion && !isChatNew) || typeof init?.body !== 'string') {
      return originalFetch.call(this, input, init);
    }
    if (hasBypassHeader(init.headers)) {
      return originalFetch.call(this, input, { ...init, headers: stripBypassHeader(init.headers) });
    }

    const route = isCompletion ? 'completion' : 'chatNew';
    hookState.onHeadersCaptured(captureClientHeaders(init.headers, url));

    const prepared = await prepareRequest(init.body, route);

    // chatNew body 诊断：记录原始 vs 增强后的 body，便于定位 400。
    // 只抓结构 + 关键字段 + 原始原文（orig body 很小 ~1KB，augmented 截断头部），
    // 供手动(200) vs 自动化(400) 逐字段 diff。
    if (route === 'chatNew') {
      const orig = parseZaiBody(init.body);
      const next = parseZaiBody(prepared.requestBody);
      const summarize = (b: Record<string, unknown> | null) => {
        if (!b) return null;
        const chat = (b.chat ?? null) as Record<string, unknown> | null;
        const history = (chat?.history ?? null) as Record<string, unknown> | null;
        const messages = (history?.messages ?? null) as Record<string, unknown> | null;
        const firstMsg = messages ? (Object.values(messages)[0] as Record<string, unknown> | null | undefined) : null;
        return {
          topKeys: Object.keys(b).slice(0, 20),
          chatKeys: chat ? Object.keys(chat).slice(0, 30) : null,
          chatType: chat?.type ?? null,
          chatFlags: Array.isArray(chat?.flags) ? chat.flags : null,
          chatId: chat?.id ?? null,
          chatTitle: chat?.title ?? null,
          chatModels: chat?.models ?? null,
          chatTimestamp: chat?.timestamp ?? null,
          chatMessageVersion: chat?.message_version ?? null,
          chatParams: chat?.params ?? null,
          chatExtra: chat?.extra ?? null,
          hasSignaturePrompt: typeof b.signature_prompt === 'string',
          hasFeatures: typeof b.features === 'object' && b.features !== null,
          firstMsgId: typeof firstMsg?.id === 'string' ? firstMsg.id : null,
          firstMsgParentId: firstMsg?.parentId ?? null,
          firstMsgRole: firstMsg?.role ?? null,
          firstMsgTimestamp: firstMsg?.timestamp ?? null,
          firstMsgContentLen: typeof firstMsg?.content === 'string' ? firstMsg.content.length : null,
          firstMsgContentHead: typeof firstMsg?.content === 'string' ? firstMsg.content.slice(0, 80) : null,
        };
      };
      diag.chatNewLog?.push({
        at: Date.now(),
        kind: 'body-snapshot',
        url: url.slice(0, 200),
        orig: summarize(orig),
        augmented: summarize(next),
        origRaw: init.body.slice(0, 2500),
      });
    }

    let requestInit: RequestInit = { ...init, body: prepared.requestBody };
    if (isCompletion) {
      const signed = applyCompletionSignature(url, prepared.requestBody);
      if (signed.headers['X-Signature']) {
        const headers = new Headers(requestInit.headers ?? {});
        headers.set('X-Signature', signed.headers['X-Signature']);
        requestInit = { ...requestInit, headers };
      }
      return interceptCompletionResponse(
        prepared.context,
        originalFetch.call(this, signed.url || url, requestInit),
      );
    }

    // chatNew 首条建会话：这里记录请求现场 + 响应状态，供自动化判断「为什么没跳 /c/<id>」。
    // 若 /chats/new 非 2xx（签名错/captcha/高峰/服务端拒绝），页面 SPA 拿不到会话 id，
    // 就不跳转 —— 这是「发送成功但仍卡首页」的最后一个未排除环节。
    const sendStartedAt = Date.now();
    const eventual = originalFetch.call(this, url, requestInit);
    void (async () => {
      try {
        const resp = await eventual;
        const status = resp.status;
        let bodyText = '';
        let errored = false;
        try {
          const clone = resp.clone();
          bodyText = (await clone.text()).slice(0, 400);
        } catch {
          errored = true;
        }
        diag.chatNewLog?.push({
          at: sendStartedAt,
          status,
          ok: status >= 200 && status < 300,
          bodyHead: bodyText,
          errored,
        });
      } catch (err) {
        diag.chatNewLog?.push({ at: sendStartedAt, threw: true, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return eventual;
  };

  Object.defineProperty(hookedFetch, FETCH_HOOK_MARKER, { value: true, configurable: true });
  window.fetch = hookedFetch as typeof window.fetch;
  return () => {
    if (window.fetch === hookedFetch) window.fetch = originalFetch;
  };
}

function hookXHR(): () => void {
  const prototype = XMLHttpRequest.prototype as XMLHttpRequest & { [XHR_HOOK_MARKER]?: true };
  if (prototype[XHR_HOOK_MARKER]) return () => undefined;
  const routes = new WeakMap<XMLHttpRequest, 'completion' | 'chatNew' | null>();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
    const routeUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : '';
    let route: 'completion' | 'chatNew' | null = null;
    if (routeUrl && typeof method === 'string') {
      if (matchZaiCompletionRoute({ url: routeUrl, method, baseUrl: ZAI_WEB_ORIGIN })) route = 'completion';
      else if (matchZaiChatNewRoute({ url: routeUrl, method, baseUrl: ZAI_WEB_ORIGIN })) route = 'chatNew';
    }
    routes.set(this, route);
    return origOpen.apply(this, [method, url, ...rest] as Parameters<typeof origOpen>);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const route = routes.get(this);
    if ((route === 'completion' || route === 'chatNew') && typeof body === 'string') {
      const xhr = this;
      void prepareRequest(body, route).then((prepared) => {
        return origSend.call(xhr, prepared.requestBody);
      }).catch((error: unknown) => {
        console.error('[GLM++] XHR augmentation failed; sending original', error);
        return origSend.call(xhr, body);
      });
      return;
    }
    return origSend.call(this, body);
  };

  Object.defineProperty(prototype, XHR_HOOK_MARKER, { value: true, configurable: true });
  return () => {
    if (prototype.open === origOpen) prototype.open = origOpen as typeof XMLHttpRequest.prototype.open;
    if (prototype.send === origSend) prototype.send = origSend;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prototype as any)[XHR_HOOK_MARKER] = undefined;
  };
}

async function interceptCompletionResponse(
  context: ZaiRequestContext,
  responsePromise: Promise<Response>,
): Promise<Response> {
  const response = await responsePromise;
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.body) {
    hookState.onRequestTerminal({ requestId: context.requestId });
    return response;
  }

  if (contentType.includes('text/html')) {
    // HTML 挑战页（peak 高峰服务端对 completion 返回 HTML）。这里只是透传原始响应，
    // 页面按 JSON 解析会打 `Unexpected token '<'`（z.ai 前端自己打的，消不掉）。
    // stateless 续跑侧的 html 重发在 completion.ts / zai.content.ts 处理，这里只记录诊断。
    diag.failures?.push({ requestId: context.requestId, kind: 'html_challenge' });
    hookState.onHtmlChallenge({ requestId: context.requestId });
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const accumulator = createZaiStreamAccumulator();
  const detectedToolCalls: ZaiDetectedToolCall[] = [];
  let terminalSent = false;
  const notifyTerminal = () => {
    if (terminalSent) return;
    terminalSent = true;
    hookState.onRequestTerminal({ requestId: context.requestId });
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          decoder.decode();
          // flush 掉最后一行未完结的 data: 行，补进累积文本。
          accumulator.finish();
          const text = accumulator.assistantText;
          extractAndNotifyToolCalls(accumulator, detectedToolCalls, context.requestId);
          hookState.onResponseComplete({
            requestId: context.requestId,
            originalPrompt: context.originalPrompt,
            agentTaskPrompt: context.agentTaskPrompt,
            assistantText: text,
            toolCalls: detectedToolCalls,
          });
          diag.responses?.push({
            requestId: context.requestId,
            textLength: text.length,
            assistantText: text,
          });
          controller.close();
          notifyTerminal();
          return;
        }
        const chunk = decoder.decode(value, { stream: true });
        // 字节透传（原样回给页面）。
        controller.enqueue(value);
        // 增量解析 SSE 做工具识别（不改变页面收到的字节）。
        accumulator.push(chunk);
      } catch (error) {
        controller.error(error);
        notifyTerminal();
      }
    },
    cancel() {
      notifyTerminal();
    },
  }, { highWaterMark: 0 });

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');

  return new Response(stream, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function registerToolCall(call: ZaiDetectedToolCall): void {
  diag.toolCalls?.push({
    kind: 'detected',
    name: call.name,
    requestId: call.requestId,
    raw: call.raw,
  });
  hookState.onToolCall(call);
}

function extractAndNotifyToolCalls(
  accumulator: ZaiStreamAccumulator,
  already: ZaiDetectedToolCall[],
  requestId: string,
): void {
  // 记录识别现场：names 为空意味着隔离世界还没把工具目录推过来，
  // 此时 memory_save 无法被识别（模型吐了也白吐）。
  const names = hookState.toolDescriptorNames;
  const text = accumulator.assistantText;
  const unregistered = extractXmlTagNames(text);
  const unregisteredTags = unregistered.filter((tag) => !(names && names.has(tag)));
  if (unregisteredTags.length > 0) {
    diag.responses?.push({
      requestId,
      hookStateNamesSize: names ? names.size : 0,
      unregisteredTags,
      assistantText: text.slice(0, 2000),
    });
  }
  if (!names || names.size === 0) return;
  const known = new Set(already.map((call) => call.raw + requestId));
  // 用简单正则找完整 `<tool>...</tool>` 块，避免半截标签误报。
  for (const name of names) {
    const re = new RegExp(`<${escapeRegExp(name)}\\b[^>]*>[\\s\\S]*?<\\/${escapeRegExp(name)}>`, 'g');
    for (const match of text.matchAll(re)) {
      const raw = match[0];
      const key = raw + requestId;
      if (known.has(key)) continue;
      known.add(key);
      registerToolCall({ name, raw, requestId });
    }
  }
}

function extractXmlTagNames(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/<\/?([A-Za-z_][A-Za-z0-9_.:-]*)\b[^>]*>/g)) {
    const name = match[1];
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const ZAI_FE_VERSION_RE = /prod-fe-[\d.]+/;