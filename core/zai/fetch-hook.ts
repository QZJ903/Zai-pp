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
 * 与上游 fetch-hook 最大区别：续跑不在这里直接 fetch（z.ai 有 captcha
 * 墙），改由 DOM 注入让页面自己发。本文件只管「读流 + 识别 + 透传」。
 */

import {
  ZAI_BYPASS_HOOK_HEADER,
  ZAI_WEB_ORIGIN,
  resolveZaiSiteOrigin,
  type ZaiWebRouteName,
} from './contracts';
import { stripZaiHistoryResponse, type ZaiHistoryToolRecord } from './history-cleanup';
import { resolveHistoryToolNames } from './history-tool-names';
import {
  isZaiAugmentableRoute,
  isZaiHistoryRoute,
  matchZaiWebRoute,
  parseZaiBody,
  readZaiLastUserMessageText,
  readZaiModelForRoute,
} from './request-codec';
import {
  createZaiStreamAccumulator,
  type ZaiSseParseResult,
  type ZaiStreamAccumulator,
} from './stream-codec';
import {
  createZaiUsageTracker,
  type ZaiUsageSnapshot,
} from './stream-metrics';
import { resignZaiCompletionRequest } from './sign';
import {
  createZaiCompletionStreamRewriter,
  encodeZaiStreamText,
} from './stream-strip';
import { matchCatalogToolName } from './tool-name-match';
import { findZaiToolXmlBlocks } from './tool-xml';

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
  /**
   * 历史响应清洗时剥出来的**工具调用归属记录**（面板跨刷新恢复的锚点来源）。
   *
   * ⚠️ **它只在历史端点触发**（`chatDetail` / `chatMessages`），completion 不会。
   * ⚠️ **同一批会被反复送**（页面每次拉历史都会跑一遍清洗）⇒ 接的一方按
   * `messageId` 去重，重挂是幂等的。
   * ⚠️ **`chatSessionId` 是「这批记录属于哪条会话」**（由请求 URL 读出，
   * 读不到时 null）—— 记录要带会话归属，否则切过会话之后兜底定位会把旧记录
   * 挂到新会话的消息上（真机实测过）。null 表示「不知道」，接的一方按放行处理。
   */
  onHistoryToolRecords: (
    records: readonly ZaiHistoryToolRecord[],
    chatSessionId: string | null,
  ) => void;
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
  /**
   * 本轮模型**用错通道**调用的本地工具名（把本地工具写进 agent 原生 `tool_call`）。
   *
   * ⚠️ **判据是 `delta_name` 落在本请求的模型可见目录里** —— 服务端自己的 tool_call
   * （`delta_name: "Bash"` 这类沙箱工具）是正常流量，**不能按「出现 tool_call」判**。
   * ⚠️ **误用轮的 `assistantText` 是空串** —— `tool_call` 与 `tool_response` 两个相位
   * 都在 `NON_ANSWER_PHASES` 里被挖掉，所以这一轮没有任何可执行内容。
   * 缺省（不误用）时是空数组，调用方按「这一轮正常」处理。
   */
  misusedNativeToolNames?: string[];
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

/**
 * 本 hook 所在页面的站点 origin。
 *
 * ⚠️⚠️ **相对 URL 的解析基准必须是它，不能是 `ZAI_WEB_ORIGIN`** —— 后者是
 * **默认站点**（国区站）的 origin。在国际站上，页面发出的是相对路径
 * （`/api/v2/chat/completions`），拿国区站的 origin 当 base 解析出来的
 * origin 与请求实际的 origin 对不上 ⇒ `matchZaiWebRoute` 的站点判据失败 ⇒
 * **增广、工具剥离、用量统计在这条链上全部静默失效**。
 *
 * ⚠️ **认不出（页面不在站点集合里）时回落默认站** —— 那意味着这个页面的请求本来
 * 就不该被我们处理（路由匹配会因 origin 对不上而返回 null），回落只是让解析有个
 * 合法基准，不会放宽判据。
 *
 * ⚠️⚠️ **那个回落分支在同一份实现的隔离世界侧（`zai.content.ts` 的 `currentSiteOrigin`）
 * 有对应的一段说明，两处必须同改** —— 要点：本钩子所在脚本没开 `all_frames`
 * （只注入顶层帧）⇒ 顶层帧的 origin 必然是站点表里的一员 ⇒ 回落不可达。
 * **打开 `all_frames` 会让它变成可达**，改之前先读那一处。
 */
function readPageOrigin(): string {
  try {
    return resolveZaiSiteOrigin(location.origin) ?? ZAI_WEB_ORIGIN;
  } catch {
    return ZAI_WEB_ORIGIN;
  }
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
    onUsageSnapshot: () => {},
    onHistoryToolRecords: () => {},
  };
}

/**
 * 局部更新 hook 状态。
 *
 * ⚠️⚠️ **必须浅合并，不能整体替换** —— 全仓两个调用点给的是**不同的子集**：
 * `main()` 一次给全 8 个回调（`zai-main-world.content.ts`），而 `SYNC_HOOK_STATE`
 * 分支只给 `toolDescriptorNames`。改成整体替换的话，那条同步消息会把**其余回调
 * 全清成空函数**，而表现是静默的：工具识别还在（名字同步了），但执行通知、
 * 用量快照、历史记录**全部停摆**。
 */
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
    return new URL(url, readPageOrigin()).searchParams.get('token')?.trim() ?? '';
  } catch {
    return '';
  }
}

/** 从相对/绝对 URL 里读任意 query 参数。 */
function readQueryParam(url: string | undefined, name: string): string {
  if (!url) return '';
  try {
    return new URL(url, readPageOrigin()).searchParams.get(name)?.trim() ?? '';
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
    // ⚠️ **不能 `sort()`** —— 那是字典序，`prod-fe-1.0.99` 会排在 `prod-fe-1.0.194` 后面
    // 被当成「更新」。版本号必须按**数字段**比。
    return candidates.reduce((best, next) => (compareFeVersions(next, best) > 0 ? next : best));
  }
  return '';
}

/** 按**数字段**比较两个 `prod-fe-x.y.z`（形态由 `ZAI_FE_VERSION_RE` 保证）。 */
function compareFeVersions(a: string, b: string): number {
  const left = a.replace(/^prod-fe-/, '').split('.').map((part) => Number(part) || 0);
  const right = b.replace(/^prod-fe-/, '').split('.').map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
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
    console.error('[Zai++] request augmentation failed; sending original request', error);
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
    toolNames,
  };
}

function applyCompletionSignature(
  url: string,
  requestBody: string,
): { url: string; headers: Record<string, string> } {
  const body = parseZaiBody(requestBody);
  if (!body) return { url, headers: {} };
  // ⚠️ **必须传 `baseUrl`** —— fetch hook 拿到的 `url` 可能是相对路径，
  // 而 `resignZaiCompletionRequest` 内部要 `new URL()` 才能读 query 里的
  // `timestamp` / `requestId` / `user_id`。相对路径解析失败时它会返回 `null`，
  // 调用方于是沿用页面自己那份 `X-Signature`，而 body 里的 `signature_prompt`
  // 已经被增广改写 ⇒ 签名与正文对不上，且**全程无报错**。
  const resigned = resignZaiCompletionRequest(url, body, readPageOrigin());
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

    const route = url && method
      ? matchZaiWebRoute({ url, method, baseUrl: readPageOrigin() })
      : null;

    // ⚠️⚠️ **bypass 排在所有改写之前** —— 它的语义是「这条请求谁都别碰」。
    // 排在历史分支之后的话，带 bypass 头的**历史请求仍会被清洗**（响应被重写）。
    //
    // ⚠️⚠️ **但它不能连「采集请求头」一起跳过** —— 那个回调是 token / user_id /
    // fe 版本 / deviceId 的**唯一采集入口**（隔离世界据此写 `zaiCachedAuth` 桶，
    // 后台的模型清单就靠它）。跳过它等于「页面上的任何脚本都能单方面关掉自己的
    // 凭据采集」。所以这里**先采一次头再放行**。
    // `hasBypassHeader` 为真 ⇒ `init.headers` 必然存在（它判的就是这个），不必再兜底。
    if (hasBypassHeader(init?.headers)) {
      hookState.onHeadersCaptured(captureClientHeaders(init!.headers, url));
      return originalFetch.call(this, input, { ...init, headers: stripBypassHeader(init!.headers) });
    }

    // ⚠️⚠️ **历史路由先于增广分支** —— 它们的响应体里有我们注入过的文本与工具 XML，
    // 要剥；而它们的**请求体里没有提示词**，绝不能进增广（见 `isZaiAugmentableRoute`）。
    // ⚠️ 这一判**不能写成 `route === 'chatDetail'`**：历史路由是**两条**，
    // 漏一条的表现是「其中一个端点静默不剥」。
    if (route && isZaiHistoryRoute(route)) {
      return interceptHistoryResponse(
        originalFetch.call(this, input, init),
        readHistoryRouteChatSessionId(url),
      );
    }

    // ⚠️ **匹配上路由 ≠ 该增强** —— 未匹配（`null`）与「匹配上但不在增强白名单」
    // 走同一条原样转发。这是加历史路由之后**必须**分开的一件事。
    if (!isZaiAugmentableRoute(route) || typeof init?.body !== 'string') {
      return originalFetch.call(this, input, init);
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
      ? matchZaiWebRoute({ url: routeUrl, method, baseUrl: readPageOrigin() })
      : null;
    routes.set(this, route);
    return origOpen.apply(this, [method, url, ...rest] as Parameters<typeof origOpen>);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const route = routes.get(this);
    // ⚠️ **只有可增强路由才走增广** —— 历史路由（`chatMessages` 是 POST、有 body）
    // 进了这条分支就会被写进 `signature_prompt`，把请求打碎。
    // ⚠️ **历史路由的响应侧这里仍然不处理**（本 hook 的响应侧整条缺失）——
    // 真机实测 z.ai 的 API 请求全走 fetch，XHR 侧无流量；这条是休眠通道的既有状态。
    if (isZaiAugmentableRoute(route) && typeof body === 'string') {
      const xhr = this;
      void prepareRequest(body, route).then((prepared) => {
        return origSend.call(xhr, prepared.requestBody);
      }).catch((error: unknown) => {
        // ⚠️ **降成 log 是刻意的，只因为这是休眠通道**（真机两轮实测 `xhrApiRequests: []`）。
        // 语义上与 fetch 那条「增广失败、原样放行」完全等价 —— 一旦哪天真的出现 XHR 流量，
        // 这里就是「模型以为有工具、实际一个都不执行」而界面无感，应当改回 `console.error`。
        console.log('[Zai++] XHR augmentation failed; sending original', error);
        return origSend.call(xhr, body);
      });
      return;
    }
    return origSend.call(this, body);
  };

  Object.defineProperty(prototype, XHR_HOOK_MARKER, { value: true, configurable: true });
  // ⚠️⚠️ **cleanup 要比「装完之后那一版」** —— 比 `origOpen` 会恒不等
  // （装完之后 `prototype.open` 已经是上面那个 wrapper）⇒ 卸载永不生效、
  // 反复安装会一层层叠上去。与 `hookFetch` 的 `hookedFetch` 同一口径。
  const hookedOpen = prototype.open;
  const hookedSend = prototype.send;
  return () => {
    if (prototype.open === hookedOpen) prototype.open = origOpen as typeof XMLHttpRequest.prototype.open;
    if (prototype.send === hookedSend) prototype.send = origSend;
    // `defineProperty` 没有 `writable` ⇒ 该属性只读，只能 `delete`（`configurable: true`
    // 使 delete 合法），赋值在严格模式下会抛。
    delete prototype[XHR_HOOK_MARKER];
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
  // 工具 XML 剥离（当场那一份）。名单 = 内置基线 ∪ 本请求名单 ∪ 全局快照。
  const rewriter = createZaiCompletionStreamRewriter(resolveHistoryToolNames(
    requestToolNames ?? hookState.toolDescriptorNames,
  ));

  /**
   * 本轮「用错通道」的本地工具名（把本地工具写进了 agent 原生 `tool_call`）。
   *
   * ⚠️ **判据是 `delta_name` 落在本请求的模型可见目录里** —— 服务端自己的 tool_call
   * （`delta_name: "Bash"` 这类沙箱工具）是正常流量，不能按「出现 tool_call 相位」判。
   * ⚠️⚠️ **判据不能是「整串相等」** —— `delta_name` 在真机上会带**模型自造的 XML 尾巴**
   * （实测：`shell_status>{}</arg_value>`、`shell_status>\n{}\n</arg_value>`），
   * 整串相等会一条都命中不了。匹配规则见 `matchCatalogToolName`（边界匹配、取第一个命中的）。
   * ⚠️ **也不改读 `tool_response.tool_name`** —— 那一份同样被原样回显成垃圾，
   * 且有一份样本整轮根本没有 `tool_response`。
   * ⚠️ **`requestToolNames` 为 `undefined`（未增广）时不判** —— 那时拿不到「本轮注入了
   * 哪些本地工具」，判下去会把沙箱工具误报成本地工具。
   */
  const misusedNativeToolNames = new Set<string>();
  const observeToolCallPhases = (parsed: ZaiSseParseResult) => {
    if (requestToolNames === undefined) return;
    for (const event of parsed.events) {
      if (event.phase !== 'tool_call') continue;
      const name = matchCatalogToolName(event.parsed.delta_name, requestToolNames);
      if (!name) continue;
      misusedNativeToolNames.add(name);
    }
  };

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
      console.log('[Zai++] usage snapshot failed', error);
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
          const flushedFrames = accumulator.finish();
          observeUsageFrames(flushedFrames);
          observeToolCallPhases(flushedFrames);
          const text = accumulator.assistantText;
          extractAndNotifyToolCalls(accumulator, context.requestId, requestToolNames);
          hookState.onResponseComplete({
            requestId: context.requestId,
            originalPrompt: context.originalPrompt,
            agentTaskPrompt: context.agentTaskPrompt,
            assistantText: text,
            ...(misusedNativeToolNames.size > 0
              ? { misusedNativeToolNames: [...misusedNativeToolNames] }
              : {}),
          });
          // 流结束：把扣住的尾巴（未闭合的块也一并删掉）放行给页面。
          const flushed = rewriter.finish();
          if (flushed.text) controller.enqueue(encodeZaiStreamText(flushed.text));
          controller.close();
          notifyTerminal();
          return;
        }
        const chunk = decoder.decode(value, { stream: true });
        // ⚠️ **工具 XML 从回给页面的字节里剥掉** —— 模型吐的 `<shell_exec>{…}`
        // 否则会一直留在正文里（用户可见）；刷新后服务端存的那份由历史侧另管。
        // ⚠️ `unchanged` 为真时**透传原始字节**，保住「没改动就逐字节不变」。
        const rewritten = rewriter.push(chunk);
        controller.enqueue(rewritten.unchanged ? value : encodeZaiStreamText(rewritten.text));
        // 增量解析 SSE 做工具识别（输入是**原始** wire，与剥离无关）。
        const parsed = accumulator.push(chunk);
        observeUsageFrames(parsed);
        observeToolCallPhases(parsed);
      } catch (error) {
        controller.error(error);
        notifyTerminal();
      }
    },
    cancel(reason) {
      // ⚠️ **页面放弃读取时必须把底层 reader 一起取消** —— 否则那条 HTTP 连接既不释放
      // 也不消费，要等服务器自己发完（实测：底层流的 `cancel` 回调一次都不触发）。
      // ⚠️ 与「`read()` 抛错时不能补 cancel」那一档不同：那里流已 errored、`cancel` 必 reject；
      // 这里是**正常 cancel**，合法且有效。
      void reader.cancel(reason).catch(() => undefined);
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

/**
 * 历史响应清洗：`GET /api/v1/chats/{id}` 与 `POST /api/v1/chats/{id}/messages/batch`。
 *
 * 两个端点形状不同、正文位置也不同（见 `history-cleanup.ts` 顶部的表），
 * 但**清洗逻辑是一份** —— 它按路径逐层取，取不到就是 no-op。
 *
 * ⚠️⚠️ **这里改的是响应体，不是字节** —— 先 `await response.text()` 再 `JSON.parse`
 * （**不是** `response.json()`），这样解析失败时还能用**原文**重建响应放行。
 * 页面拿到的是 `JSON.stringify` 后的等价对象，字段顺序可能变，但**值一个不动**
 * （除了要剥的那几个 content）。
 *
 * ⚠️ **重建时必须删 `content-length` / `content-encoding`** —— 长度已经变了，
 * 而 `content-encoding` 指向的压缩已经由浏览器解掉。`content-length` 对不上时
 * Chrome 会截断或挂住响应。与 `interceptCompletionResponse` 同一处理。
 *
 * ⚠️ **不加字节上限** —— 这是页面**必需**的响应，读一半就废掉整个会话。
 * 实测量级：`messages/batch` 80 KB、`chats/{id}` 34 KB。与「五处刻意不加限」
 * 同一取舍（那五处是 `core/skill/github-importer.ts` 的四处读响应 + 本文件这一处）。
 */
/**
 * 从历史请求的 URL 里读出会话 id（`/api/v1/chats/<id>[/messages/batch]`）。
 *
 * ⚠️ **不能复用 `readZaiChatSessionId`** —— 那个认的是**页面地址** `/c/<id>`，
 * 而这里是 API 路径 `/api/v1/chats/<id>`，两套形状不同（各写一遍的代价是
 * 将来站点改路径时只改一处）。
 * ⚠️ **读不到返回 null**（不是抛错、也不是空串）：下游按「不知道 ⇒ 放行」处理。
 */
function readHistoryRouteChatSessionId(url: string): string | null {
  try {
    const pathname = new URL(url, readPageOrigin()).pathname;
    const match = /^\/api\/v1\/chats\/([^/]+)/.exec(pathname);
    if (!match?.[1]) return null;
    const decoded = decodeURIComponent(match[1]);
    return decoded.trim() ? decoded.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 历史响应拦截：剥掉我们注入的文本与工具 XML，并**顺手把工具记录送出去**。
 *
 * ⚠️ **`chatSessionId` 由调用方从请求 URL 读出来传进来**（`/api/v1/chats/<id>/…`
 * 里的 `<id>`）—— 记录要带会话归属，否则切过会话之后兜底定位会把旧记录挂到
 * 新会话的消息上（真机实测过）。
 */
async function interceptHistoryResponse(
  responsePromise: Promise<Response>,
  chatSessionId: string | null,
): Promise<Response> {
  // ⚠️ 网络层失败要让 rejection 原样传给页面（页面自己有错误处理），不能吞掉换成空响应。
  const response = await responsePromise;
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('json') || !response.body) return response;
  // ⚠️⚠️ **`await response.text()` 之后这个 Response 就已经读干了** —— 所以**每一条**
  // 后续路径都必须走 `rebuildHistoryResponse` 重建，绝不能 `return response`。
  // 返回已读干的响应给页面，表现是**整个会话加载不出来**（页面读 body 拿到空串）。
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return response;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // 不是 JSON（HTML 挑战页 / 空 body）：用原文重建。
    return rebuildHistoryResponse(raw, response);
  }

  const stats = stripZaiHistoryResponse(json, {
    toolNames: resolveHistoryToolNames(hookState.toolDescriptorNames),
    // 顺手把「这条消息调用过哪些工具」送出去（面板恢复的锚点来源）。
    onToolRecords: (records) => hookState.onHistoryToolRecords(records, chatSessionId),
  });
  // 一处都没改时也**必须重建**（理由见上），只是不做序列化、直接把原文放回去。
  // ⚠️ **三个计数都要判** —— 漏一个的表现是「那类清洗静默不生效」（响应被原样放回）。
  const changed = stats.restoredUserMessages > 0
    || stats.replacedContinuationMessages > 0
    || stats.strippedToolBlocks > 0;
  if (!changed) {
    return rebuildHistoryResponse(raw, response);
  }

  return rebuildHistoryResponse(JSON.stringify(json), response);
}

/** 用一段文本重建响应，保留状态码 / 状态文本 / 除长度与编码外的全部 header。 */
function rebuildHistoryResponse(text: string, source: Response): Response {
  const headers = new Headers(source.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  const rebuilt = new Response(text, {
    headers,
    status: source.status,
    statusText: source.statusText,
  });
  // Response 构造函数没有 url 选项；重建后补回最终 URL（与流式那条同处理）。
  if (source.url) {
    Object.defineProperty(rebuilt, 'url', {
      value: source.url,
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
  // 同一次扫描内按 `raw + requestId` 去重。扫描器按名字逐个匹配，而名字互为前缀时
  // （`shell` 与 `shell_exec`）**同一个块可能被两个名字各认一次** ⇒ 这道去重仍然需要。
  const known = new Set<string>();
  // ⚠️⚠️ **必须与「解析」「剥离」用同一个扫描器** —— 曾经这里是手写的
  // `<name\b[^>]*>[\s\S]*?</name>` 正则，与 `findZaiToolXmlBlocks` 口径不同：
  // ① `<name id="1">` 只有正则认 ⇒ 会发一条 `TOOL_CALL`，下游解析不出、只留一行日志；
  // ② `< name >` 只有扫描器认 ⇒ XML 被剥掉了、却**没有 `TOOL_CALL` 发出**，
  //    同一轮若还有别的正常块，兜底解析也不会触发 ⇒ **静默不执行**。
  // 「什么算一个工具块」只能有一份实现（`core/zai/tool-xml.ts`）。
  for (const block of findZaiToolXmlBlocks(text, [...names])) {
    const key = block.raw + requestId;
    if (known.has(key)) continue;
    known.add(key);
    registerToolCall({ name: block.name, raw: block.raw, requestId });
  }
}
