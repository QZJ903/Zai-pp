/**
 * 主世界 ↔ 隔离世界的 postMessage 协议。
 *
 * MAIN world 的 fetch hook 需要两样东西来回：
 * - isolated → main：运行时状态（工具标签名）+ 增广结果
 * - main → isolated：请求体增强请求 + 工具调用通知 + 响应完成通知
 *
 * 协议名沿用 ds++ 的 bridge 思路（BRIDGE_REQUEST/AUGMENT_REQUEST_BODY），
 * 但换成 z.ai 的 source 标识 `zai-pp`。
 *
 * ⚠️⚠️ **这两个清单是「声明」，不是「约束」** —— 它们描述**实际经 `window.postMessage`
 * 往返的类型**。信封级校验只有 `isZaiBridgeMessage`（source 相等 + type 是字符串）；
 * **载荷级校验**另有一份 decoder 表（见文件末尾），加类型时**必须显式决定**
 * 「写 decoder」还是「进豁免清单」，`tests/zai-bridge-protocol-contract.test.ts` 守着这件事。
 * 加类型时还必须**同时**在发送点与接收点接上，否则清单会与实际漂移，而**漂移没有任何报错**；
 * 那部分由同一个测试用 AST 双向比对。
 *
 * ⚠️⚠️ **经 `chrome.runtime` 的命令不属于这里** —— 例如 `EXECUTE_TOOL_CALL`：它虽然叫
 * 「中继工具执行」，实际是隔离世界直接发给后台的 runtime 消息（`entrypoints/zai.content.ts`
 * 的 `executeToolCall`），**不过桥**。曾经被误列进下面这份清单。
 */

import { ZAI_MSG_SOURCE } from './contracts';
import type { ZaiDetectedToolCall, ZaiResponseCompletePayload } from './fetch-hook';

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
  'SYNC_HOOK_STATE',           // 同步工具标签名 → update hook state
  'AUGMENT_REQUEST_BODY_RESULT', // 增强结果回传
] as const;

export type ZaiMainToContentType = (typeof ZAI_MAIN_TO_CONTENT_TYPES)[number];
export type ZaiContentToMainType = (typeof ZAI_CONTENT_TO_MAIN_TYPES)[number];

/**
 * 转出 decoder 的载荷类型，供两个 entrypoint 直接用 —— 这样调用方只需要
 * `core/zai/messages` 一个 import 源，不必各自再去 `core/zai/fetch-hook` 取类型。
 */
export type { ZaiDetectedToolCall, ZaiResponseCompletePayload } from './fetch-hook';

// ---------------------------------------------------------------------------
// 载荷级 decoder
// ---------------------------------------------------------------------------

/**
 * 载荷校验的**单一真源**。
 *
 * 两个 listener 只做信封校验（`event.source` + `isZaiBridgeMessage`），
 * **信封相等不等于载荷合法** —— 页面与主世界共享同一个 `window`，任何脚本都能
 * postMessage 一条 `source` / `type` 全对、载荷却是任意形状的消息。
 * 之前这些分支直接写 `data.data as {...}`：类型看着对，运行时**没有任何保证**，
 * 非法载荷会一路走到深处才炸出一个难定位的错误（或者更糟 —— 被当成合法指令执行）。
 *
 * ⚠️⚠️ **这不改变安全上限。** 页面能读自己的响应流（hook 把字节原样透传），
 * 所以它能构造出**形状完全合法**的伪造消息 —— 真伪不可区分这条不变
 * （上游对此的定性：*MAIN-world identity is routing, not authentication*）。
 * 这里挡的是「**形状非法**的伪造被当成合法指令执行」，以及消掉 `as` 断言这个模式。
 *
 * ⚠️⚠️ **失败方向一律是「丢弃该条消息」，不是「拒绝/中断」** ——
 * 与 `decodeAugmentResult` 的既有约定一致（增广是可选增强，判错代价必须小于卡住请求）。
 * **不要在这些 decoder 外面新造拒绝分支**，让调用方走它原本就有的降级路径。
 *
 * ⚠️ **必须按本项目的实际形状写，不要照抄上游 `core/messaging/schema.ts`** ——
 * 上游的 `isAugmentResult` 要求 `agentTaskPrompt` 是字符串，我们**没有这个字段**；
 * 照抄会把每一条正常结果都判成非法、所有请求静默退化成不增广（2.15.15 已踩过一次）。
 */

/** 主世界 → 隔离世界：工具调用通知。 */
export function decodeZaiToolCallMessage(
  value: unknown,
): ZaiDetectedToolCall | null {
  if (!isPlainRecord(value)) return null;
  if (typeof value.name !== 'string' || !value.name) return null;
  if (typeof value.raw !== 'string') return null;
  if (typeof value.requestId !== 'string') return null;
  return { name: value.name, raw: value.raw, requestId: value.requestId };
}

/**
 * 主世界 → 隔离世界：一轮响应流结束。
 *
 * ⚠️ **`assistantText` 是必需字段** —— `handleResponseComplete` 会在
 * `executionsByRequest` 为空时拿它跑 `parseToolXml` **兜底执行工具**，
 * 也就是说这条消息**同样有执行语义**（不只是「通知一轮结束」）。
 */
export function decodeZaiResponseCompleteMessage(
  value: unknown,
): ZaiResponseCompletePayload | null {
  if (!isPlainRecord(value)) return null;
  if (typeof value.requestId !== 'string' || !value.requestId) return null;
  if (typeof value.originalPrompt !== 'string') return null;
  if (typeof value.agentTaskPrompt !== 'string') return null;
  if (typeof value.assistantText !== 'string') return null;

  return {
    requestId: value.requestId,
    originalPrompt: value.originalPrompt,
    agentTaskPrompt: value.agentTaskPrompt,
    assistantText: value.assistantText,
  };
}

/**
 * 「只用到 `requestId`」类载荷的共用校验：带非空请求 id 的纯对象。
 *
 * `REQUEST_TERMINAL` 与 `HTML_CHALLENGE` 两个 decoder 的形状完全相同，
 * 抽成私有函数，避免两份逐字节相同的实现各自演化。
 */
function decodeRequestIdPayload(value: unknown): { requestId: string } | null {
  if (!isPlainRecord(value)) return null;
  if (typeof value.requestId !== 'string' || !value.requestId) return null;
  return { requestId: value.requestId };
}

/** 主世界 → 隔离世界：请求结束/失败。只用到 `requestId`。 */
export function decodeZaiRequestTerminalMessage(value: unknown): { requestId: string } | null {
  return decodeRequestIdPayload(value);
}

/** 主世界 → 隔离世界：completion 返回 HTML 挑战页。只用到 `requestId`。 */
export function decodeZaiHtmlChallengeMessage(value: unknown): { requestId: string } | null {
  return decodeRequestIdPayload(value);
}

/**
 * 隔离世界 → 主世界：工具标签名同步。
 *
 * ⚠️⚠️ **这条必须校验元素类型，不能只判 `Array.isArray`** ——
 * 主世界把名字收进 `Set` 后逐个数喂给 `escapeRegExp`（`core/zai/fetch-hook.ts`），
 * 而它是 `value.replace(...)`：**非字符串元素会直接抛 TypeError**。
 * 那个调用点在 `ReadableStream.pull` 的 try 里，抛错会走到 `controller.error(error)` ——
 * 而这个 stream **就是回给页面的那个 Response 的 body**，页面自己的 `reader.read()`
 * 会 reject，**用户正在看的这一轮回答被从中间掐断**；同一个 catch 里的
 * `notifyTerminal()` 还会让隔离世界给自动化任务回一条假的 `DOM_TASK_FAILED`。
 * ⚠️ `new Set()` **不做任何类型收敛**（`[...new Set(['a', 123])]` 仍是 `['a', 123]`）。
 */
export function decodeZaiSyncHookStateMessage(
  value: unknown,
): { toolDescriptorNames: string[] } | null {
  if (!isPlainRecord(value)) return null;
  const names = value.toolDescriptorNames;
  if (!Array.isArray(names)) return null;
  if (!names.every((name): name is string => typeof name === 'string')) return null;
  return { toolDescriptorNames: names };
}

/**
 * 载荷校验的豁免名单 —— 每项都要写明理由。
 *
 * ⚠️ **豁免不等于「没人管」**：如果这个类型**另有一个 decoder**（写在别的模块里），
 * 必须用 `decoder` 字段点名，`tests/zai-bridge-protocol-contract.test.ts` 会去
 * 断言它**真的在接收文件里被调用** —— 否则「有专门的 decoder」只是一句注释，
 * 哪天调用点被删掉不会有任何东西变红。
 */
export interface ZaiBridgePayloadDecoderExemption {
  /** 为什么这个类型不需要进 `ZAI_BRIDGE_PAYLOAD_DECODERS`。 */
  reason: string;
  /** 另有的 decoder（可选）。给了就必须真的在 `file` 里被调用。 */
  decoder?: { name: string; file: string };
}

export const ZAI_BRIDGE_PAYLOAD_DECODER_EXEMPTIONS = {
  // 主世界 → 隔离世界
  AUGMENT_REQUEST_BODY: {
    reason: '逐字段取值 + 默认值（handleAugmentRequestBody 里 typeof 取每一项），比抛错的 decoder 更宽容',
  },
  HEADERS_CAPTURED: {
    reason: '载荷是任意 header 键值对，形状本身没有约束；消费者已有真值判据（token/user_id/Authorization 至少一个）',
  },
  USAGE_SNAPSHOT: {
    reason: '载荷形状复杂（用量 + 速度 + 来源标记），单独放在它自己的模块里',
    decoder: { name: 'decodeZaiUsageSnapshot', file: 'entrypoints/zai.content.ts' },
  },
  // 隔离世界 → 主世界
  AUGMENT_REQUEST_BODY_RESULT: {
    reason: '形状由主世界的请求上下文决定，校验与消费都在同一个文件里',
    decoder: { name: 'decodeAugmentResult', file: 'entrypoints/zai-main-world.content.ts' },
  },
} as const satisfies Partial<Record<ZaiMainToContentType | ZaiContentToMainType, ZaiBridgePayloadDecoderExemption>>;

/** 载荷 decoder 表 —— 与两个类型清单互补，`tests/zai-bridge-protocol-contract.test.ts` 守着覆盖率。 */
export const ZAI_BRIDGE_PAYLOAD_DECODERS = {
  SYNC_HOOK_STATE: decodeZaiSyncHookStateMessage,
  TOOL_CALL: decodeZaiToolCallMessage,
  RESPONSE_COMPLETE: decodeZaiResponseCompleteMessage,
  REQUEST_TERMINAL: decodeZaiRequestTerminalMessage,
  HTML_CHALLENGE: decodeZaiHtmlChallengeMessage,
} as const satisfies Partial<Record<ZaiMainToContentType | ZaiContentToMainType, (value: unknown) => unknown>>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}