/**
 * main-world ↔ isolated 世界的 postMessage 协议。
 *
 * MAIN world 的 fetch hook 需要两样东西来回：
 * - isolated → main：运行时状态（记忆/技能/预设/工具描述符）→ update hook state
 * - main → isolated：请求体增强请求 + 工具执行中继 + 响应完成通知
 *
 * 协议名沿用 ds++ 的 bridge 思路（BRIDGE_REQUEST/AUGMENT_REQUEST_BODY），
 * 但换成 z.ai 的 source 标识 `zai-pp`。
 */

import { ZAI_MSG_SOURCE } from './contracts';

export const ZAI_MAIN_TO_CONTENT = `${ZAI_MSG_SOURCE}:main-to-content`;
export const ZAI_CONTENT_TO_MAIN = `${ZAI_MSG_SOURCE}:content-to-main`;

/** postMessage 消息信封。 */
export interface ZaiBridgeMessage {
  source: typeof ZAI_MAIN_TO_CONTENT | typeof ZAI_CONTENT_TO_MAIN;
  type: string;
  [key: string]: unknown;
}

export function isZaiBridgeMessage(
  value: unknown,
  expectedSource: typeof ZAI_MAIN_TO_CONTENT | typeof ZAI_CONTENT_TO_MAIN,
): value is ZaiBridgeMessage {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.source === expectedSource && typeof record.type === 'string';
}

/** 主世界向隔离世界发出的动作类型。 */
export const ZAI_MAIN_TO_CONTENT_TYPES = [
  'AUGMENT_REQUEST_BODY',      // 拦到 completion/chats-new 请求 → 请求增强
  'TOOL_CALL',                 // 响应流里识别出工具 XML → 请求本地执行
  'RESPONSE_COMPLETE',         // 一轮响应流结束 → 续跑状态机前进
  'REQUEST_TERMINAL',          // 请求结束/失败 → 关闭授权
  'HEADERS_CAPTURED',          // 捕获 Authorization / X-Signature / X-FE-Version
  'HTML_CHALLENGE',            // completion 返回 text/html → 推进续跑别挂死
  'USAGE_SNAPSHOT',            // 一轮 completion 的用量快照 → 落库统计
] as const;

/** 隔离世界向主世界发出的动作类型。 */
export const ZAI_CONTENT_TO_MAIN_TYPES = [
  'SYNC_HOOK_STATE',           // 同步工具描述符等运行时状态
  'AUGMENT_REQUEST_BODY_RESULT', // 增强结果回传
  'EXECUTE_TOOL_CALL',         // 中继工具执行（经后台）
  'DIAG_SYNC',                 // 把隔离世界的诊断（sendProbe/failures/errors/toolCalls）同步到页面 window
] as const;

export type ZaiMainToContentType = (typeof ZAI_MAIN_TO_CONTENT_TYPES)[number];
export type ZaiContentToMainType = (typeof ZAI_CONTENT_TO_MAIN_TYPES)[number];