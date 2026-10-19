/**
 * 续跑 / nudge 模板的**结构判据**与历史占位符 —— **零依赖**。
 *
 * ⚠️ **为什么单独成文件**：这段判据有三个消费者，**加载环境不同**：
 * - `core/zai/continuation.ts` —— **隔离世界**（`zai.content.ts`，`document_idle`）—— **写**模板；
 * - `core/zai/history-cleanup.ts` —— **页面主世界**（经 `fetch-hook.ts` 被
 *   `zai-main-world.content.ts` 引用）—— 把历史里的模板换成占位符；
 * - `core/zai/continuation-bubble.ts` —— **隔离世界**（同样只被 `zai.content.ts` 引用）—— 隐藏气泡。
 *
 * ⚠️ **只有 `history-cleanup.ts` 跑在主世界** —— 别把气泡隐藏也当成主世界的约束，
 * 那是两条不同的加载路径。
 *
 * 抽出来的理由是**主世界那一半**：主世界代码在**每一个 z.ai 页面**上都跑，
 * 多拉一个模块就是页面多一份开销。`continuation.ts` 虽然只有 type-only import，
 * 但里面带着一组「待办话术」大正则（`ZAI_PENDING_STRONG_RE` / `_IMPERSONAL_` / `_WEAK_`
 * 三条合起来约 1.5 KB）—— 那是 nudge 判定用的，与这里的判据无关，不该被拖进主世界。
 *
 * ⚠️ **「生产端与判定端同源」在这里是硬要求**：占位符常量（谁写）与识别判据
 * （谁认）必须来自同一处，各写一遍会在改模板时静默分叉。
 */

/**
 * 历史里替换续跑模板用的**不可见占位符**。
 *
 * ⚠️ **必须非空** —— 服务端按 parent/child 链组织消息，空内容会让那条链断掉。
 * 用三个不可见字符（invisible separator + invisible plus + invisible separator）：
 * 保留链路、但页面上看不见。与上游同值。
 * ⚠️ **写成转义而不是字面量** —— 字面量在编辑器/工具链里看不见、极易被误删或吞掉，
 * 而删掉它就等于把「链不断」这个前提悄悄拿掉（表现是刷新后那条消息整个消失）。
 */
export const ZAI_CONTINUATION_PLACEHOLDER = '\u2063\u2064\u2063';

/**
 * 续跑轮识别：带 `<original_task>`，且带 `<tool_results>` 或 `<tool_results_so_far>`。
 *
 * 两个标签都要认：`buildZaiContinuationPrompt` 用 `<tool_results>`，
 * `buildZaiNudgePrompt` 用 `<tool_results_so_far>`。漏认后者会把 nudge 轮当成原生轮，
 * 于是新起一个 `taskId` 为 null 的续跑循环覆盖掉原循环，原循环再也无人推进，
 * 自动化任务收不到终态、一直挂在「运行中」。
 *
 * ⚠️ **判据刻意只用结构、不加关键词** —— 上游有两档：严格档（结构 + 关键词，用于
 * 历史 API 清洗）与结构档（`isInlineAgentContinuationStructure`，用于**实时 DOM**，
 * 因为页面会在文本里插入自己的时间戳/操作行等 chrome、关键词可能被拆散）。
 * 我们的模板是**我们自己拼的**、两处拿到的都是同一份原文 ⇒ 结构档一处就够，
 * 多一层关键词检查只会多一条会漂移的判据。
 * ⚠️ **代价**：真机若发现页面把 `<original_task>` 当 HTML 标签吞掉（markdown 渲染），
 * 这条判据在 DOM 侧会失效 —— 那时**改这里一处**即可（两个消费者同源）。
 */
export function isZaiContinuationPrompt(content: string): boolean {
  if (!content.includes('<original_task>')) return false;
  return content.includes('<tool_results>') || content.includes('<tool_results_so_far>');
}

/**
 * 这条内容**已经是**占位符（幂等判据）。
 *
 * ⚠️ **幂等是必须的**：历史清洗会被反复调用（切会话、每轮回答结束），
 * 第二次拿到的是已替换过的内容。占位符不含任何标签 ⇒ `isZaiContinuationPrompt`
 * 对它返回 false，所以「已替换」不会被再替换一次；这条函数只是给**显式**判据用
 * （例如统计里区分「本次替换了」与「本来就已经是占位符」）。
 */
export function isZaiContinuationPlaceholder(content: string): boolean {
  return content.trim() === ZAI_CONTINUATION_PLACEHOLDER;
}

/**
 * **气泡侧**判据：这段 DOM 文本里**含**占位符（不要求整段等于它）。
 *
 * ⚠️⚠️ **为什么气泡侧不能复用上面那条严格判据** —— 严格判据拿到的可能是**消息原文**
 * （历史清洗那边就是），也可能是一整条气泡的 `textContent`，而后者**带页面自己的 chrome**：
 * 实测一只占位符气泡的文本是「占位符 3 字符 + 14 个空白字符」。那些 chrome **当前恰好
 * 全是空白**，所以严格判据眼下也命中 —— 但只要它哪天变成任何可见文字（操作按钮的标签、
 * 时间戳、辅助文本节点），严格判据就会**静默漏判**，表现是页面上留一只空白气泡、
 * 而没有任何东西会报错。
 *
 * ⚠️ **反过来不担心误判**：占位符是三个不可见格式字符（Cf），普通消息里出现的概率
 * 约等于零。两种失败方向的代价不对称 —— 漏判只是维持原状，误判会把用户的真实消息藏掉。
 */
export function containsZaiContinuationPlaceholder(content: string): boolean {
  return content.includes(ZAI_CONTINUATION_PLACEHOLDER);
}
