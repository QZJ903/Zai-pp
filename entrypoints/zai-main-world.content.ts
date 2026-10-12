/**
 * GLM++ MAIN world content script（chat.z.ai）。
 *
 * 在页面主世界里安装 fetch/XHR hook，把 z.ai 的 completion + /chats/new 请求
 * 交给隔离世界增广，并把隔离世界回传的结果、以及响应流里识别出的本地工具
 * XML 通知回来。响应的 SSE 字节原样透传回页面（扩展只「读」流，不改页面渲染）。
 *
 * 与隔离世界（zai.content.ts）之间用 window.postMessage 打通，
 * source 用 `zai-pp:main-to-content` / `zai-pp:content-to-main`。
 */

import {
  installZaiFetchHook,
  updateZaiHookState,
  type ZaiDetectedToolCall,
  type ZaiRequestBodyModification,
  type ZaiResponseCompletePayload,
} from '../core/zai/fetch-hook';
import type { ZaiWebRouteName } from '../core/zai/contracts';
import {
  ZAI_CONTENT_TO_MAIN,
  ZAI_MAIN_TO_CONTENT,
  decodeZaiSyncHookStateMessage,
  isZaiBridgeMessage,
} from '../core/zai/messages';

interface PendingRequest {
  resolve: (value: ZaiRequestBodyModification | null) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 8_000;
const pendingRequests = new Map<string, PendingRequest>();

function postToContent(message: Record<string, unknown>): void {
  try {
    window.postMessage({ source: ZAI_MAIN_TO_CONTENT, ...message }, '*');
  } catch (error) {
    console.error('[GLM++] post to content failed', error);
  }
}

/**
 * 校验并解出隔离世界回传的增广结果，**形状不对一律当「没增广」放行**。
 *
 * ⚠️ **必须校验**：主世界与页面共享同一个 window，任何脚本都能 postMessage 一条
 * 伪造的 `AUGMENT_REQUEST_BODY_RESULT`。不校验时 `data.result` 会被原样当成增广结果
 * 塞进请求体 —— 而它要的只是一句 `body: string`。
 *
 * ⚠️ **按本项目的实际形状写，不要照抄上游的 `isAugmentResult`** —— 上游还要求
 * `agentTaskPrompt` 是字符串，我们没有这个字段；照抄会把每一条正常结果都判成非法，
 * 于是所有请求都退化成「不增广」，且**没有任何报错**。
 *
 * ⚠️ **校验失败的方向是「放行原始请求」而不是「拒绝请求」** —— 增广是可选增强，
 * 判错的代价必须小于「把请求卡住」。这与 `requestAugmentedBody` 超时的处理一致。
 *
 * ⚠️ **这只是「形状合法」，不是「来源可信」** —— 页面能看见我们的消息，也能抢先应答，
 * 所以它挡不住伪造。它挡的是「形状非法的伪造被当成合法增广塞进请求体」。
 */
function decodeAugmentResult(data: Record<string, unknown>): ZaiRequestBodyModification | null {
  // `ok` 必须显式为 true；失败与缺省都放行原始请求。
  if (data.ok !== true) return null;
  const result = data.result;
  if (result === null || result === undefined) return null;
  if (!isPlainRecord(result)) return null;

  const value = result;
  // `body` 是唯一必需字段：`prepareRequest` 会用它替换请求体。
  if (typeof value.body !== 'string') return null;
  // 其余两个是可选的，但出现时类型必须对 —— `prepareRequest` 会直接消费它们
  // （`requestId` 用于请求上下文、`toolDescriptorNames` 用于工具标签识别）。
  if (value.requestId !== undefined && typeof value.requestId !== 'string') return null;
  if (value.toolDescriptorNames !== undefined) {
    if (!Array.isArray(value.toolDescriptorNames)) return null;
    if (!value.toolDescriptorNames.every((name) => typeof name === 'string')) return null;
  }

  return {
    body: value.body,
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
    ...(value.toolDescriptorNames === undefined
      ? {}
      : { toolDescriptorNames: value.toolDescriptorNames }),
  };
}

/**
 * 原型必须是 `Object.prototype` 或 `null` —— 排掉数组、`Date`、`Map` 这类
 * 「`typeof` 是 object 但结构不是我们要的」的值。与上游 `isPlainRecord` 同口径。
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requestAugmentedBody(
  body: string,
  requestId: string,
  route: ZaiWebRouteName,
): Promise<ZaiRequestBodyModification | null> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      resolve(null);
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, timeout });
    postToContent({ type: 'AUGMENT_REQUEST_BODY', id, requestId, route, body });
  });
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  // 信封校验（source + type 形状）走共用判定，与协议清单同源。
  if (!isZaiBridgeMessage(event.data, ZAI_CONTENT_TO_MAIN)) return;
  const data = event.data;

  if (data.type === 'AUGMENT_REQUEST_BODY_RESULT') {
    const id = typeof data.id === 'string' ? data.id : '';
    const pending = pendingRequests.get(id);
    if (pending) {
      pendingRequests.delete(id);
      clearTimeout(pending.timeout);
      pending.resolve(decodeAugmentResult(data));
    }
    return;
  }
  if (data.type === 'SYNC_HOOK_STATE') {
    // ⚠️ **元素类型必须校验**：这些名字会被逐个喂给 `escapeRegExp`（`value.replace`），
    // 非字符串会抛 TypeError → 走到 `controller.error` → **打断回给页面的响应流**。
    // `new Set()` 不做类型收敛，别指望它兜。
    const state = decodeZaiSyncHookStateMessage(data);
    if (!state) return;
    updateZaiHookState({ toolDescriptorNames: new Set(state.toolDescriptorNames) });
    return;
  }
});

export default defineContentScript({
  matches: ['*://chat.z.ai/*'],
  world: 'MAIN',
  runAt: 'document_start',
  async main() {
    updateZaiHookState({
      onRequestBody: requestAugmentedBody,
      onHeadersCaptured(headers) {
        postToContent({ type: 'HEADERS_CAPTURED', headers });
      },
      onToolCall(call: ZaiDetectedToolCall) {
        postToContent({ type: 'TOOL_CALL', data: call });
      },
      onResponseComplete(complete: ZaiResponseCompletePayload) {
        postToContent({ type: 'RESPONSE_COMPLETE', payload: complete });
      },
      onRequestTerminal(terminal) {
        postToContent({ type: 'REQUEST_TERMINAL', payload: terminal });
      },
      onHtmlChallenge(payload) {
        postToContent({ type: 'HTML_CHALLENGE', payload });
      },
      onUsageSnapshot(snapshot) {
        postToContent({ type: 'USAGE_SNAPSHOT', payload: snapshot });
      },
      onHistoryToolRecords(records, chatSessionId) {
        // ⚠️ **`chatSessionId` 平铺在信封上**（与 `records` 同级）—— decoder 读
        // `value.chatSessionId`，两边必须同层（桥的载荷层次是踩过的坑）。
        postToContent({ type: 'HISTORY_TOOL_RECORDS', records, chatSessionId });
      },
    });

    installZaiFetchHook();
  },
});