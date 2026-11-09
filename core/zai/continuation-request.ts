/**
 * 「这条请求体是不是我们自己注入的续跑模板」—— 桥的**同步探测**专用判据。
 *
 * ⚠️ **为什么单独成文件、不放进 `request-codec.ts`**：那一层是**纯 codec**
 * （只准 import `./contracts`，见 `tests/zai-pure-codec-import-boundary.test.ts` 的四条），
 * 它不认识「续跑模板」这个概念。而这个判据必须**可测** —— 它由内容脚本在
 * **串行队列之外同步**调用，结果决定「这一次发送算不算成功」，放进 `zai.content.ts`
 * 就只能靠「按名字找源码」那类断言盯着，而那种断言天生有绕过面。
 *
 * ⚠️⚠️ **判据分两级，两级的关系是「主判据能判就以它为准」**：
 *
 * ① **主判据：按解析结果认** —— 与增广侧走同一份判据（`parseZaiBody` →
 *    `readZaiLastUserMessageText` → 模板识别）。**只要解析成功、且取到了最后一条
 *    user 文本，它给出的就是一个确定结论**（是 / 不是），不再往下走粗判。
 * ② **兜底粗判：只在主判据不可用时生效** —— 两种不可用：`parseZaiBody` 失败，
 *    或取不到最后一条 user 文本（形状变了）。`parseZaiBody` 失败意味着**增广也会被跳过**、
 *    请求按原样发出去，那一轮仍然是正常发出的。此时若这里跟着认不出来，
 *    「已经发出去」会被判成「没发出去」，调用方随后会**把同一段 prompt 再发一遍**
 *    （重复的用户消息 ⇒ 同一批工具会被再跑一次）。
 *    粗判成立的前提是结构标签在 body 这个 JSON 串里是**字面量**
 *    （`JSON.stringify` 不转义 `<`），而普通请求的正文里不会同时出现它们。
 *
 * ⚠️⚠️ **粗判不能在主判据给出「不是模板」之后还跑一次** —— `body` 里包含**整段
 * messages**，会话历史里只要留着上一轮的续跑模板，整串里就有模板的标签与开场话术
 * ⇒ 用户这一条**普通提问**也会被判成续跑（实测复刻确认）。而主判据明明已经说了不是。
 *
 * ⚠️⚠️ **「主判据」有两条腿，缺一条就漏一条路由** —— 两个路由的 body 形状**完全不同**
 * （真机抓包）：
 *
 * | 路由 | user 消息在哪 | 读法 |
 * |---|---|---|
 * | `completion` | **顶层 `messages[]`** | `readZaiLastUserMessageText` |
 * | `/chats/new` | **顶层只有 `chat`**，消息在 `chat.history.messages.<id>.content` | `parseZaiChatNewBody` |
 *
 * ⚠️ **只写 completion 那一条腿的后果**：`/chats/new` 的 `readZaiLastUserMessageText`
 * 恒返回 `''`（顶层没有 `messages`）⇒ 恒落粗判 ⇒ **历史里有旧模板时照样误判成续跑**。
 * 实测复现：同一个「历史含旧模板 + 最后一条是普通提问」的输入，completion 形状答 `false`（对）、
 * **chatNew 形状答 `true`（错）**。
 * ⚠️ 影响面：本函数的唯一消费者是 `classifyAugmentRequest`，而它下游是 OR 合并
 * （两个增量任一 > 0 都判 `sent`）⇒ 只让 `continuationDelta` 这个诊断计数虚高，
 * **不改变发送分档**。所以这条腿漏了是 P3 级、不是行为缺陷 —— 但**判据该补就补**。
 */

import { isZaiContinuationPrompt } from './continuation-marker';
import { parseZaiBody, parseZaiChatNewBody, readZaiLastUserMessageText } from './request-codec';

export function isZaiContinuationRequestBody(bodyStr: string): boolean {
  try {
    const parsed = parseZaiBody(bodyStr);
    if (parsed) {
      // ① completion 路由：顶层 `messages[]`。
      const lastUserText = readZaiLastUserMessageText(parsed);
      // 主判据可用（解析成功 + 取到了 user 文本）⇒ 它的结论就是最终结论。
      if (lastUserText) return isZaiContinuationPrompt(lastUserText);
      // ② `/chats/new` 路由：顶层只有 `chat`，消息在 `chat.history.messages.<id>.content`。
      // ⚠️ **`userMessageTexts` 非空才算「这条腿可用」** —— 数组为空表示这个形状不对
      // （或它其实不是 chatNew body），继续往下落粗判。
      const chatNew = parseZaiChatNewBody(parsed);
      const firstText = chatNew?.userMessageTexts[0];
      if (firstText) return isZaiContinuationPrompt(firstText);
    }
  } catch {
    /* 解析抛错也落到下面的原文粗判 */
  }
  return isZaiContinuationPrompt(bodyStr);
}