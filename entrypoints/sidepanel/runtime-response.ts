import type { LocaleMessageKey, MessageParams } from '../../core/i18n';
import { looksLikeErrorCode } from '../../core/messaging/error-code';
import {
  decodeRuntimeResponse,
  getRuntimeErrorMessage,
  isRuntimeFailure,
  unwrapRuntimeResponse,
} from '../../core/messaging/runtime-response';

export {
  decodeRuntimeResponse,
  getRuntimeErrorMessage,
  isRuntimeFailure,
  unwrapRuntimeResponse,
};

/**
 * 把一次失败渲染成**给用户看的一句话**。
 *
 * 两级：**裸错误码**（`busy` / `automation_not_found` 这类）套一层本地化文案、码放进括号；
 * 其余（自然语言句子、带路径的技术句）**原样返回** —— 它们本身就有信息量，
 * 换成通用文案反而是信息降级。
 *
 * ⚠️⚠️ **为什么必须有这一层**：后台的领域失败是 `{ ok: false, error }`，而 `error`
 * 常常是**蛇形标识符**。`runtime-client.ts` 把它原样塞进 `Error.message`，
 * 于是界面上出现一行只有 `busy` 的红条 —— 用户既不知道发生了什么，也无从处理。
 *
 * ⚠️⚠️ **`bare` 是给「外面已经有一层『X 操作失败：{error}』外壳」的调用点用的**：
 * 那时再返回「操作失败（busy）」会变成「记忆操作失败：操作失败（busy）」——
 * 外壳已经说清是哪一步失败了，内层只需要码本身。
 *
 * ⚠️ **判据与自动化失败卡片共用**（`core/messaging/error-code.ts`）—— 各写一份必然分叉，
 * 而分叉时没有报错。
 */
export function formatRuntimeError(
  error: unknown,
  t: (key: LocaleMessageKey, params?: MessageParams) => string,
  options?: { bare?: boolean },
): string {
  const message = getRuntimeErrorMessage(error);
  if (!looksLikeErrorCode(message)) return message;
  if (options?.bare) return message;
  return t('common.operationFailedWithCode', { code: message });
}