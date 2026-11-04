import type {
  McpJsonRpcNotification,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpProtocolTransport,
  McpServerConfig,
} from '../types';
import { McpTransportError, normalizeJsonRpcResponse } from './common';
import { SHELL_MCP_NATIVE_HOST } from '../../shell';
import {
  MCP_NATIVE_ENVELOPE_PROTOCOL,
  MCP_NATIVE_ENVELOPE_VERSION,
  type McpNativeEnvelope,
} from '../native-contract';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface NativePortState {
  port: chrome.runtime.Port;
  pendingRequests: Map<number | string, PendingRequest>;
}

// Ceiling for a **request** frame sent to the native host.
//
// ⚠️⚠️ **Chrome's two directions have different caps** — the documented limits are
// 64 MiB for extension→host and 1 MiB for host→extension. This constant bounds the
// request direction, and 1 MiB is a **self-imposed safety threshold**, not Chrome's
// limit for that direction.
//
// ⚠️ **Why not raise it to the documented 64 MiB**: the host reads frames with
// `buffer = Buffer.concat([buffer, chunk])` on every `data` event, so a large frame
// costs quadratic copying (measured estimate: an 8 MiB frame re-copies ~516 MiB, a
// 64 MiB frame ~32.8 GiB). On top of that an oversized frame makes the host exit
// (dropping every persistent shell session). Raising this number requires rewriting
// that accumulator first — do not touch it on its own.
const MAX_NATIVE_REQUEST_BYTES = 1 * 1024 * 1024;
// local_file_write content cap with headroom for the JSON-RPC envelope. Keep
// models writing in chunks: write the first section, then append the rest
// with append=true. This is a *content* cap — it does not replace the envelope
// measurement below, because escaping can inflate the payload past the frame cap.
const MAX_LOCAL_FILE_WRITE_BYTES = 900_000;

const nativePortStates = new Map<string, NativePortState>();

function getPortState(nativeHost: string): NativePortState {
  const existing = nativePortStates.get(nativeHost);
  if (existing) return existing;

  if (!chrome.runtime?.connectNative) {
    throw new McpTransportError('mcp_native_messaging_unavailable', 'Browser native messaging is unavailable.', {
      retryable: false,
    });
  }

  const port = chrome.runtime.connectNative(nativeHost);
  const state: NativePortState = {
    port,
    pendingRequests: new Map(),
  };
  nativePortStates.set(nativeHost, state);

  port.onMessage.addListener((response: any) => {
    // ⚠️ **只认顶层的 `id`，不看 `result.id`。**
    // 这里曾经还兜过一层 `response?.result?.id`，那是一条走不到的路径：JSON-RPC 2.0
    // 的响应把 `id` 放在**顶层**，而 `tools/call` 的 `result` 里根本没有 `id` 字段。
    // 留着它的唯一效果是：真收到畸形帧时，`rpcId` 可能落到某个不相干的结果字段上，
    // 那条请求既不该被 resolve、又匹配不上任何 pending，只能白等到 120 秒超时；
    // 就算凑巧匹配上，`normalizeJsonRpcResponse` 也会因为 `jsonrpc !== '2.0'`
    // 立刻判 `mcp_response_invalid`。⇒ 让它匹配不上、如实超时，比「匹配到错的东西」好。
    const rpcId = response?.id;
    if (rpcId != null && state.pendingRequests.has(rpcId)) {
      const pending = state.pendingRequests.get(rpcId)!;
      state.pendingRequests.delete(rpcId);
      clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      pending.resolve(response);
    }
  });

  port.onDisconnect.addListener(() => {
    const err = new McpTransportError(
      'mcp_native_host_disconnected',
      chrome.runtime.lastError?.message || 'Native host disconnected.',
      { retryable: true },
    );
    for (const pending of state.pendingRequests.values()) {
      clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      pending.reject(err);
    }
    state.pendingRequests.clear();
    nativePortStates.delete(nativeHost);
  });

  return state;
}

export function createMcpNativeMessagingTransport(server: McpServerConfig): McpProtocolTransport {
  return {
    request(request, options) {
      return sendNativeMessage(server, request, options?.timeoutMs, options?.signal);
    },
    async notify(notification, options) {
      await sendNativeMessage(server, notification, options?.timeoutMs, options?.signal);
    },
  };
}

/*
 * ⚠️⚠️ **本 transport 是四个里唯一不接 `options.maxResponseBytes` 的**（对照
 * `http.ts` / `sse.ts` 都显式传了）。这不是漏 —— 那一档走的是 HTTP 的按块累计上限，
 * native 那条链的响应上限由**宿主**在 `framing.mjs` 的 `writeNativeMessage` 里判
 * （`MAX_NATIVE_RESPONSE_BYTES`，host → extension 方向）。
 *
 * ⚠️ **两个方向的常量是分开的，别混**：本文件的 `MAX_NATIVE_REQUEST_BYTES` 管
 * **extension → host**（`assertNativePayloadSize` 量的就是发出去的信封）；
 * 宿主侧的 `MAX_NATIVE_RESPONSE_BYTES` 管回来的那一帧。Chrome 官方两个方向的上限
 * 本来就不同（扩展→host 64 MiB、host→扩展 1 MiB），本项目两个都用 1 MiB 是**自选的
 * 保守值**，不是照抄官方 —— 理由见 `contracts.mjs` 与 `framing.mjs` 的注释。
 *
 * ⚠️ **超限的后果也不一样**：请求方向超限会让宿主 `onInvalidFrame` → `process.exit(1)`
 * （连带杀掉所有持久 shell 会话）；响应方向超限只是宿主 `reject`，`runtime-dispatcher`
 * 接住并尝试回一条错误帧，**不杀进程**。
 */

async function sendNativeMessage<TParams extends Record<string, unknown> | undefined, TResult>(
  server: McpServerConfig,
  message: McpJsonRpcRequest<TParams> | McpJsonRpcNotification,
  timeoutMs: number = server.timeouts.requestMs,
  signal?: AbortSignal,
): Promise<McpJsonRpcResponse<TResult>> {
  throwIfNativeSignalAborted(signal);
  const nativeHost = server.transport.nativeHost;
  if (!nativeHost) {
    throw new McpTransportError('mcp_native_host_missing', 'Native messaging host is not configured.', {
      retryable: false,
    });
  }

  const expectedRequest = 'id' in message ? message as McpJsonRpcRequest<TParams> : undefined;
  const envelope = await createNativeEnvelope(server, message);
  if (expectedRequest) {
    assertNativePayloadSize(nativeHost, envelope);
  }

  let response: unknown;
  if (expectedRequest) {
    throwIfNativeSignalAborted(signal);
    response = await sendAndWait(nativeHost, envelope, expectedRequest.id, timeoutMs, signal);
    throwIfNativeSignalAborted(signal);
  } else {
    throwIfNativeSignalAborted(signal);
    const state = getPortState(nativeHost);
    state.port.postMessage(envelope);
    return undefined as any;
  }

  return normalizeJsonRpcResponse<TResult>(response, expectedRequest);
}

function throwIfNativeSignalAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Native MCP request was aborted.', 'AbortError');
}

function sendAndWait(
  nativeHost: string,
  envelope: McpNativeEnvelope,
  requestId: number | string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let state: NativePortState;
    try {
      state = getPortState(nativeHost);
    } catch (err) {
      reject(err);
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      state.pendingRequests.delete(requestId);
      reject(new McpTransportError('mcp_native_timeout', `Native MCP request exceeded ${timeoutMs} ms.`));
    }, timeoutMs);

    const onAbort = () => {
      clearTimeout(timer);
      state.pendingRequests.delete(requestId);
      const reason = signal?.reason;
      reject(reason instanceof Error
        ? reason
        : new DOMException('Native MCP request was aborted.', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Native MCP request was aborted.', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    state.pendingRequests.set(requestId, {
      resolve,
      reject,
      timer,
      signal,
      onAbort: signal ? onAbort : undefined,
    });
    try {
      state.port.postMessage(envelope);
    } catch (err) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      state.pendingRequests.delete(requestId);
      reject(err);
    }
  });
}

async function createNativeEnvelope(
  server: McpServerConfig,
  message: McpJsonRpcRequest<any> | McpJsonRpcNotification,
): Promise<McpNativeEnvelope> {
  const env = await createNativeEnv(server);
  return {
    protocol: MCP_NATIVE_ENVELOPE_PROTOCOL,
    version: MCP_NATIVE_ENVELOPE_VERSION,
    server: {
      id: server.id,
      command: server.transport.command,
      args: server.transport.args,
      cwd: server.transport.cwd,
      env,
    },
    message,
  };
}

function assertNativePayloadSize(nativeHost: string, envelope: McpNativeEnvelope): void {
  if (nativeHost !== SHELL_MCP_NATIVE_HOST) return;
  const writeContent = getLocalFileWriteContent(envelope.message);
  const writesFile = writeContent !== null;
  if (writesFile) {
    const contentBytes = new Blob([writeContent]).size;
    if (contentBytes > MAX_LOCAL_FILE_WRITE_BYTES) {
      throw new McpTransportError(
        'mcp_native_payload_too_large',
        `local_file_write content is too large (${formatBytes(contentBytes)} > ${formatBytes(MAX_LOCAL_FILE_WRITE_BYTES)}). Write the file in chunks: send the first section now, then call local_file_write again with append=true for each remaining section.`,
        { retryable: false },
      );
    }
  }

  // The content cap above is not enough on its own: JSON escaping inflates it
  // (quotes and backslashes double, control characters grow six-fold), so a
  // payload that passes the content check can still overflow the frame. Always
  // measure the real envelope — a frame past the cap is rejected by the browser
  // and the host exits, which drops every open shell session.
  const envelopeBytes = new Blob([JSON.stringify(envelope)]).size;
  if (envelopeBytes > MAX_NATIVE_REQUEST_BYTES) {
    throw new McpTransportError(
      'mcp_native_payload_too_large',
      writesFile
        ? `Native MCP request is too large after escaping (${formatBytes(envelopeBytes)} > ${formatBytes(MAX_NATIVE_REQUEST_BYTES)}). Write the file in chunks: send the first section now, then call local_file_write again with append=true for each remaining section.`
        : `Native MCP request is too large (${formatBytes(envelopeBytes)} > ${formatBytes(MAX_NATIVE_REQUEST_BYTES)}). Reduce the request size or split the work into smaller tool calls.`,
      { retryable: false },
    );
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} bytes`;
}

function getLocalFileWriteContent(message: McpJsonRpcRequest<any> | McpJsonRpcNotification): string | null {
  if (message.method !== 'tools/call') return null;
  const params = message.params as { name?: unknown; arguments?: { content?: unknown } } | undefined;
  if (params?.name !== 'local_file_write') return null;
  const content = params.arguments?.content;
  return typeof content === 'string' ? content : null;
}

async function createNativeEnv(server: McpServerConfig): Promise<Record<string, string> | undefined> {
  const env: Record<string, string> = { ...(server.transport.env ?? {}) };
  return Object.keys(env).length > 0 ? env : undefined;
}
