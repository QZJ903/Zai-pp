/**
 * 「这条请求体是不是我们自己注入的续跑模板」—— 桥的**同步探测**专用判据。
 *
 * ⚠️ **为什么单独成文件、不放进 `request-codec.ts`**：那一层是**纯 codec**
 * （只准 import `./contracts`，见 `tests/zai-pure-codec-import-boundary.test.ts` 的四条），
 * 它不认识「续跑模板」这个概念。而这个判据必须**可测** —— 它由内容脚本在
 * **串行队列之外同步**调用，结果决定「这一次发送算不算成功」，放进 `zai.content.ts`
 * 就只能靠「按名字找源码」那类断言盯着，而那种断言天生有绕过面。
 *
 * ⚠️⚠️ **判据分两级，缺一不可**：
 *
 * ① **按解析结果认** —— 与增广侧走同一份判据（`parseZaiBody` →
 *    `readZaiLastUserMessageText` → 结构标签）。
 * ② **认不出来时退回原文粗判** —— `parseZaiBody` 失败意味着**增广也会被跳过**、
 *    请求按原样发出去，那一轮仍然是正常发出的。此时若这里跟着认不出来，
 *    「已经发出去」会被判成「没发出去」，调用方随后会**把同一段 prompt 再发一遍**
 *    （重复的用户消息 ⇒ 同一批工具会被再跑一次）。
 *    粗判成立的前提是那两个结构标签在 body 这个 JSON 串里是**字面量**
 *    （`JSON.stringify` 不转义 `<`），而普通请求的正文里不会出现它们。
 */

import { isZaiContinuationPrompt } from './continuation-marker';
import { parseZaiBody, readZaiLastUserMessageText } from './request-codec';

export function isZaiContinuationRequestBody(bodyStr: string): boolean {
  try {
    const parsed = parseZaiBody(bodyStr);
    if (parsed && isZaiContinuationPrompt(readZaiLastUserMessageText(parsed))) return true;
  } catch {
    /* 解析抛错也落到下面的原文粗判 */
  }
  return isZaiContinuationPrompt(bodyStr);
}