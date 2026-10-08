/**
 * MAIN world fetch/XHR hook（z.ai 版）。
 *
 * 职责：
 * 1. 拦截 completion 请求 → 交给 isolated 世界增广（改 messages + signature_prompt
 *    并重算 X-Signature）→ 字节透传回页面。
 * 2. 拦截 /chats/new 请求 → 增强首条 user 消息（首条不走 completion）。
 * 3. 解析响应 SSE → 流式工具 XML 识别 → 通知 isolated 执行 → 字节透传。
 * 4. HTML 挑战页检测（completion 返回 text/html 时透传原响应，并通知内容脚本）。
 *
 * 与 glm 版 fetch-hook 最大区别：续跑不在这里直接 fetch（z.ai 有 captcha
 * 墙），改由 DOM 注入让页面自己发。本文件只管「读流 + 识别 + 透传」。
 */

import {
  ZAI_BYPASS_HOOK_HEADER,
  ZAI_WEB_ORIGIN,
  type ZaiWebRouteName,
} from './contracts';
import {
  matchZaiWebRoute,
  parseZaiBody,
  readZaiLastUserMessageText,
  readZaiModelForRoute,
} from './request-codec';
import {
  createZaiStreamAccumulator,
  type ZaiSseEvent,
  type ZaiSseParseResult,
  type ZaiStreamAccumulator,
} from './stream-codec';
import {
  createZaiUsageTracker,
  type ZaiUsageSnapshot,
} from './stream-metrics';
import { resignZaiCompletionRequest } from './sign';

export interface ZaiHookState {
  toolDescriptorNames: ReadonlySet<string>;
  onRequestBody: (
    body: string,
    requestId: string,
    route: ZaiWebRouteName,
  ) => Promise<ZaiRequestBodyModification | null>;
  onHeadersCaptured: (headers: Record<string, string> | null) => void;
  onToolCall: (call: ZaiDetectedToolCall) => void;
  onResponseComplete: (complete: ZaiResponseCompletePayload) => void;
  onRequestTerminal: (terminal: { requestId: string }) => void;
  onHtmlChallenge: (payload: { requestId: string }) => void;
  /** 一轮 completion 结束时的用量快照（含中断的轮次）。 */
  onUsageSnapshot: (snapshot: ZaiUsageSnapshot) => void;
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
}

interface ZaiRequestContext {
  requestId: string;
  originalPrompt: string;
  agentTaskPrompt: string;
  /** completion 请求体顶层 `model`；取不到则 null（用量快照按模型归类用）。 */
  modelType: string | null;
}

const FETCH_HOOK_MARKER = Symbol.for('zai-pp.fetch-hook-installed');
const XHR_HOOK_MARKER = Symbol.for('zai-pp.xhr-hook-installed');

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
    onUsageSnapshot: () => {},
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

/**
 * 页面 prod-fe 版本号的形态（真机抓包：completion 请求头 `x-fe-version: prod-fe-1.0.194`）。
 *
 * ⚠️ **不能带 `g` flag** —— `readFeVersion` 在循环里反复调它，带 `g` 的正则会跨调用
 * 保留 `lastIndex`，表现为「隔一条 resource 才命中一次」，静默漏。
 */
export const ZAI_FE_VERSION_RE = /prod-fe-[\d.]+/;

/** 捕获 completion 请求的完整现场：token / user_id / fe 版本，供 stateless 续跑复用。 */
/** 动态读页面当前 prod-fe 版本（关键坑：硬编码会报「请刷新页面」）。 */
export function readFeVersion(): string {
  const candidates: string[] = [];
  try {
    if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
      for (const entry of performance.getEntriesByType('resource')) {
        const match = ZAI_FE_VERSION_RE.exec(entry.name);
        if (match) candidates.push(match[0]);
      }
    }
  } catch {
    /* ignore */
  }
  if (candidates.length > 0) {
    return candidates.sort().reverse()[0];
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
    modelType: readRequestModelType(body),
  };
}

/**
 * 读请求体里本轮实际使用的模型。**取增强后的 body** —— 自动化任务的模型覆写
 * 发生在增广阶段，读原始 body 会把所有自动化轮次都记成页面默认模型。
 */
function readRequestModelType(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  const model = readZaiModelForRoute(body, 'completion');
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

interface ZaiIntercepted {
  context: ZaiRequestContext;
  requestBody: string;
  requestInit: RequestInit;
  /**
   * 本请求注入提示词的工具标签名。**`undefined` = 未增广**（增广失败 / 结果非法），
   * 与「增广成功但目录为空」（`[]`）是两回事 —— 后者必须按空目录处理、**不能回落全局快照**，
   * 否则会识别出「本请求提示词里根本没列」的标签并执行（见 `extractAndNotifyToolCalls`）。
   */
  toolNames: readonly string[] | undefined;
}

async function prepareRequest(
  body: string,
  route: ZaiWebRouteName,
): Promise<ZaiIntercepted> {
  const originalContext = createRequestContext(body);
  let modified: ZaiRequestBodyModification | null = null;
  try {
    modified = await hookState.onRequestBody(body, originalContext.requestId, route);
  } catch (error) {
    console.error('[GLM++] request augmentation failed; sending original request', error);
  }

  // ⚠️ **保留 `undefined` 与 `[]` 的区别**：`modified` 为 null 只发生在「增广失败 / 结果非法」
  // （`decodeAugmentResult` 的四种拒绝）⇒ 那时才该回落全局快照；增广成功但目录为空时
  // `toolDescriptorNames` 是 `[]`，必须按空目录处理。
  const toolNames = modified?.toolDescriptorNames;
  const requestBody = modified?.body ?? body;

  return {
    context: {
      requestId: modified?.requestId ?? originalContext.requestId,
      originalPrompt: originalContext.originalPrompt,
      agentTaskPrompt: originalContext.agentTaskPrompt,
      // 覆写发生在增广阶段 → 模型类型只能从**增广后**的 body 读。
      modelType: readRequestModelType(parseZaiBody(requestBody)),
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

    const route = url && method ? matchZaiWebRoute({ url, method, baseUrl: ZAI_WEB_ORIGIN }) : null;
    if (!route || typeof init?.body !== 'string') {
      return originalFetch.call(this, input, init);
    }
    if (hasBypassHeader(init.headers)) {
      return originalFetch.call(this, input, { ...init, headers: stripBypassHeader(init.headers) });
    }

    hookState.onHeadersCaptured(captureClientHeaders(init.headers, url));

    const prepared = await prepareRequest(init.body, route);

    let requestInit: RequestInit = { ...init, body: prepared.requestBody };
    if (route === 'completion') {
      const signed = applyCompletionSignature(url, prepared.requestBody);
      if (signed.headers['X-Signature']) {
        const headers = new Headers(requestInit.headers ?? {});
        headers.set('X-Signature', signed.headers['X-Signature']);
        requestInit = { ...requestInit, headers };
      }
      return interceptCompletionResponse(
        prepared.context,
        originalFetch.call(this, signed.url || url, requestInit),
        prepared.toolNames,
      );
    }

    // chatNew 首条建会话：请求原样转发，响应由页面自己处理（SPA 拿不到会话 id 就不会跳转）。
    return originalFetch.call(this, url, requestInit);
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
  const routes = new WeakMap<XMLHttpRequest, ZaiWebRouteName | null>();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
    const routeUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : '';
    const route = routeUrl && typeof method === 'string'
      ? matchZaiWebRoute({ url: routeUrl, method, baseUrl: ZAI_WEB_ORIGIN })
      : null;
    routes.set(this, route);
    return origOpen.apply(this, [method, url, ...rest] as Parameters<typeof origOpen>);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const route = routes.get(this);
    if (route && typeof body === 'string') {
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
  requestToolNames: readonly string[] | undefined,
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
    // 这里不重发：请求由页面发出，本 hook 只读流与透传，没有可原样重放的 body。
    // 改为发信号让内容脚本把在飞的那一轮推进下去，避免整条续跑循环干等。
    // ⚠️ 该信号只在续跑轮有落点（内容脚本按 `activeRequestId` 认领）；原生轮收不到。
    hookState.onHtmlChallenge({ requestId: context.requestId });
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const accumulator = createZaiStreamAccumulator();
  const usageTracker = createZaiUsageTracker(context.requestId, context.modelType);

  const observeUsageFrames = (parsed: ZaiSseParseResult) => {
    for (const event of parsed.events) usageTracker.observeEvent(event);
    if (parsed.appendedText) usageTracker.appendText(parsed.appendedText);
  };

  let terminalSent = false;
  const notifyTerminal = () => {
    if (terminalSent) return;
    terminalSent = true;
    // 用量快照：正常结束 / 出错 / 被取消三条路都收敛到这里，恰好一次。
    // 全程 try/catch —— 这是热路径，统计失败绝不能影响页面请求；onRequestTerminal
    // 刻意留在 try 外面，快照出问题也不能让终态通知被吞掉。
    try {
      const snapshot = usageTracker.finish(accumulator.assistantText);
      if (snapshot) hookState.onUsageSnapshot(snapshot);
    } catch (error) {
      console.error('[GLM++] usage snapshot failed', error);
    }
    hookState.onRequestTerminal({ requestId: context.requestId });
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          decoder.decode();
          // flush 掉最后一行未完结的 data: 行，补进累积文本。
          observeUsageFrames(accumulator.finish());
          const text = accumulator.assistantText;
          extractAndNotifyToolCalls(accumulator, context.requestId, requestToolNames);
          hookState.onResponseComplete({
            requestId: context.requestId,
            originalPrompt: context.originalPrompt,
            agentTaskPrompt: context.agentTaskPrompt,
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
        observeUsageFrames(accumulator.push(chunk));
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

  const rebuilt = new Response(stream, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
  // Response 构造函数没有 url 选项；重建后要把**最终（重定向后）URL**补回去，
  // 否则页面代码读 `response.url` 会拿到空串 —— 这是它唯一还能看到真实端点的地方。
  if (response.url) {
    Object.defineProperty(rebuilt, 'url', {
      value: response.url,
      enumerable: true,
      configurable: true,
    });
  }
  return rebuilt;
}

function registerToolCall(call: ZaiDetectedToolCall): void {
  hookState.onToolCall(call);
}

function extractAndNotifyToolCalls(
  accumulator: ZaiStreamAccumulator,
  requestId: string,
  requestToolNames: readonly string[] | undefined,
): void {
  // 识别用的名单**优先取本请求的那一份** —— 它由隔离世界随增广结果回传，正是
  // **本次实际注入提示词的那份描述符**（`auth.descriptors`）。这消除了「提示词列了 A、
  // 识别器不认 A」的分叉（用户刚加 MCP 工具、`TOOL_DESCRIPTORS_UPDATED` 还没落地时）。
  //
  // ⚠️ **判据是「是不是 undefined」，不是「长度是否 > 0」** —— `undefined` 才代表**未增广**
  // （增广失败 / 结果非法时主世界放行原始 body，拿不到本请求名单），那时才退回全局快照，
  // 保住「老会话里已有的 XML 仍能识别执行」。而**增广成功但目录为空**（`[]`）必须按空目录
  // 处理、**不能回落全局** —— 否则会识别出「本请求提示词里根本没列」的标签并执行。
  const names = requestToolNames !== undefined
    ? new Set(requestToolNames)
    : hookState.toolDescriptorNames;
  const text = accumulator.assistantText;
  if (!names || names.size === 0) return;
  // 同一次扫描内按 `raw + requestId` 去重。工具名来自 descriptor 集合、各自独立匹配，
  // 正常情况下不会命中；留着是防御 —— 名字互为前缀时（`shell` 与 `shell.exec`）正则可能重叠。
  const known = new Set<string>();
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
