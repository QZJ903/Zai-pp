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
import {
  ZAI_CONTENT_TO_MAIN,
  ZAI_MAIN_TO_CONTENT,
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

function requestAugmentedBody(
  body: string,
  requestId: string,
  route: 'completion' | 'chatNew',
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
  const data = event.data as Record<string, unknown> | undefined;
  if (!data || data.source !== ZAI_CONTENT_TO_MAIN) return;

  if (data.type === 'AUGMENT_REQUEST_BODY_RESULT') {
    const id = typeof data.id === 'string' ? data.id : '';
    const pending = pendingRequests.get(id);
    if (pending) {
      pendingRequests.delete(id);
      clearTimeout(pending.timeout);
      pending.resolve((data.result as ZaiRequestBodyModification) ?? null);
    }
    return;
  }
  if (data.type === 'SYNC_HOOK_STATE') {
    const names = Array.isArray(data.toolDescriptorNames)
      ? (data.toolDescriptorNames as string[])
      : [];
    updateZaiHookState({ toolDescriptorNames: new Set(names) });
    return;
  }
  if (data.type === 'TITLE_LOOKUP') {
    // 会话标题解析的**逐条上报**（不是整数组同步）—— 那条链路的触发很密，
    // 走 DIAG_SYNC 的「整数组 + 追加合并」语义会平方级重复。
    const target = (window as unknown as Record<string, unknown>);
    // 主世界的诊断对象由 fetch-hook 建立，但它可能还没跑到 —— 这里兜一下，
    // 否则「页面刚打开就发生的标题解析」会被静默丢掉。
    const existing = (target['__GLMPP_DIAG__'] ??= {}) as Record<string, unknown>;
    const current = Array.isArray(existing.titleLookups) ? (existing.titleLookups as unknown[]) : [];
    // 只留最近 50 条：每次发消息都会问一次标题。
    existing.titleLookups = [...current, data.entry].slice(-50);
    return;
  }
  if (data.type === 'DIAG_SYNC') {
    // isolation world 的诊断对象和页面 window 是隔离的，直接读不到。
    // 这里把 isolation 侧 push 的诊断合并进页面共享的 __GLMPP_DIAG__（MAIN world 侧写入）。
    const target = (window as unknown as Record<string, unknown>);
    const existing = target['__GLMPP_DIAG__'] as Record<string, unknown> | undefined;
    if (existing) {
      const mergeArray = (key: string) => {
        const incoming = Array.isArray(data[key]) ? (data[key] as unknown[]) : [];
        const current = Array.isArray(existing[key]) ? (existing[key] as unknown[]) : [];
        if (incoming.length > 0) existing[key] = [...current, ...incoming];
      };
      mergeArray('sendProbe');
      mergeArray('failures');
      mergeArray('errors');
      mergeArray('toolCalls');
      mergeArray('responses');
      mergeArray('turnLog');
      mergeArray('injectLog');
      mergeArray('ssaFatal');
      mergeArray('composerSnap');
      mergeArray('augRequests');
      mergeArray('chatNewLog');
    }
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
    });

    installZaiFetchHook();
  },
});