/**
 * 续跑 / nudge 模板的**识别判据**与历史占位符 —— **零依赖**。
 *
 * ⚠️ **为什么单独成文件**：这段判据有**四个**消费者，**加载环境不同**：
 * - `core/zai/continuation.ts` —— **隔离世界**（`zai.content.ts`，`document_idle`）—— **写**模板；
 * - `core/zai/history-cleanup.ts` —— **页面主世界**（经 `fetch-hook.ts` 被
 *   `zai-main-world.content.ts` 引用）—— 把历史里的模板换成占位符；
 * - `core/zai/continuation-bubble.ts` —— **隔离世界**（同样只被 `zai.content.ts` 引用）—— 隐藏气泡；
 * - `core/zai/continuation-request.ts` —— **主世界**（桥上请求体的同步探测）—— 判「这一发是不是续跑模板」。
 *
 * ⚠️ **只有 `history-cleanup.ts` 与 `continuation-request.ts` 跑在主世界** —— 别把气泡隐藏
 * 也当成主世界的约束，那是两条不同的加载路径。
 *
 * 抽出来的理由是**主世界那一半**：主世界代码在**每一个 z.ai 页面**上都跑，
 * 多拉一个模块就是页面多一份开销。`continuation.ts` 虽然只有 type-only import，
 * 但里面带着一组「待办话术」大正则（`ZAI_PENDING_STRONG_RE` / `_IMPERSONAL_` / `_WEAK_`
 * 三条合起来约 1.5 KB）—— 那是 nudge 判定用的，与这里的判据无关，不该被拖进主世界。
 * ⚠️ **加关键词不违反这条**：`includes` 是常量级开销，不在「拖一个模块进来」的范畴。
 *
 * ⚠️ **「生产端与判定端同源」在这里是硬要求**：占位符常量（谁写）与识别判据
 * （谁认）必须来自同一处，各写一遍会在改模板时静默分叉。
 * 同理，模板的**开场话术**（`ZAI_TEMPLATE_OPENINGS`）也必须与三个 builder 同源 ——
 * 守卫是「三个 builder 真渲染出来的文本都通过严格档」那条用例。
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
 * 我们自己拼的模板的**固定开场话术** —— 严格档的第二半判据。
 *
 * ⚠️⚠️ **必须取「用户不会说的话」**。上游那组关键词（`工具续跑任务` / `工具结果` /
 * `tool results` / `do not call any tools` …）**不能照搬**：`工具结果` 在中文里太泛，
 * 用户写「根据工具结果分析一下」就命中，等于把误判面从「两个标签」缩到「一个标签」，
 * 没解决问题。这里三条都取到**整句开头**，语义上就是「我们这条模板的身份」：
 *
 * | 模板 | 开场话术 |
 * |---|---|
 * | `buildZaiContinuationPrompt` | `以下是工具续跑任务` |
 * | `buildZaiNudgePrompt` | `上一轮回复没有输出可执行的本地工具 XML` |
 * | `buildZaiMisuseNudgePrompt` | `上一轮你把本地工具` |
 *
 * ⚠️ **与三个 builder 同源，不是手抄**：`tests/zai-continuation-prompt.test.ts` 有一条
 * 「三个 builder 真渲染出来的文本都通过严格档」—— 改模板措辞时它会红，不会静默失配。
 * ⚠️ **只认这三句，不加别的**：多认一句就多一分把用户消息藏掉的风险。
 */
const ZAI_TEMPLATE_OPENINGS = [
  '以下是工具续跑任务',
  '上一轮回复没有输出可执行的本地工具 XML',
  '上一轮你把本地工具',
] as const;

/**
 * 只读地暴露这份清单 —— **给反向守卫用**（`tests/zai-continuation-prompt.test.ts`）。
 *
 * ⚠️ **为什么必须导出**：正向守卫（「三个 builder 的输出都能通过严格档」）只挡住「改模板
 * 措辞后失配」；**反向的失效形态是「清单里多认了一句用户会说的话」** —— 那会让用户消息
 * 被藏掉，而这正是这一档判据要防的事。要守反向，测试必须能逐句拿到清单本身。
 * ⚠️ **它只读**（`readonly` + `as const`）—— 别为了让测试改内容而把它变成可变的。
 */
export const ZAI_TEMPLATE_OPENING_LIST: readonly string[] = ZAI_TEMPLATE_OPENINGS;

/**
 * **结构档**：只认两个结构标签，不认内容。
 *
 * ⚠️ **它现在是严格档的内部实现，不再单独对外承担「这是我们模板」的结论** ——
 * 结构标签太容易出现在**用户在讨论这套机制**的消息里（「请解释 `<original_task>`
 * 和 `<tool_results>`」），把它单独用在原始文本面上会误判。
 */
function hasZaiContinuationStructure(content: string): boolean {
  if (!content.includes('<original_task>')) return false;
  return content.includes('<tool_results>') || content.includes('<tool_results_so_far>');
}

/**
 * 续跑轮识别（**严格档**）：结构标签 + 我们自己的一句固定开场话术。
 *
 * 两个结构标签都要认：`buildZaiContinuationPrompt` 用 `<tool_results>`，
 * `buildZaiNudgePrompt` / `buildZaiMisuseNudgePrompt` 用 `<tool_results_so_far>`。
 * 漏认后者会把 nudge 轮当成原生轮，于是新起一个 `taskId` 为 null 的续跑循环
 * 覆盖掉原循环，原循环再也无人推进，自动化任务收不到终态、一直挂在「运行中」。
 *
 * ## ⚠️⚠️ 为什么必须带关键词（这条判据的输入面决定的）
 *
 * 四个消费者的输入面**全是「原文」，没有一个是「页面渲染过的 DOM」**：
 *
 * | 消费者 | 输入 |
 * |---|---|
 * | `history-cleanup.ts`（主世界） | 服务端历史原文 |
 * | `zai.content.ts` 的 `isContinuationRequest` | 用户原始输入 / 请求体里的 prompt |
 * | `continuation-request.ts` | 桥上的请求体串 |
 * | `continuation-bubble.ts` | 气泡的 `textContent` |
 *
 * 而结构档单独用在原文上时，用户只要在消息里**同时提到**两个标签就会被判成模板：
 * ① 历史清洗把这条消息换成不可见占位符；② 气泡隐藏给它加 `display:none`；
 * ③ 这一轮不增广、`isContinuationTurn` 走 orphan 分支直接 return。
 * ⇒ **用户的消息从对话里消失**，且没有任何东西会报错。
 *
 * ⚠️ **上游就是分档的**（`core/inline-agent/prompt.ts`）：严格档给**原始文本面**
 * （注释原文 *「raw prompt text is intact and false positives are costlier」*），
 * 结构档 `isInlineAgentContinuationStructure` **只给实时 DOM**（页面会插时间戳 /
 * 操作行把关键词拆散）。我们曾把两者合并成一档、还用在最贵的两个面上 —— 那是
 * **移植理解错**，不是「与上游保持一致」。
 *
 * ## ⚠️ 代价（如实记）
 *
 * 页面若把我们的开场话术**拆散**（markdown 渲染在句中插节点），续跑气泡会不再被隐藏
 * —— 失败方向是「用户看见工具结果 JSON」，**可见**，不是静默。
 * 反过来（不加关键词）的失败方向是「用户的消息消失」，**静默**。
 * ⇒ 选可见的那个。
 *
 * ⚠️ **仍然挡不住的一档**：用户**贴一整段真模板**来问「这段为什么被隐藏了」——
 * 里面带着我们的开场话术，严格档照样命中。这个面收窄不掉，只能接受。
 * ⚠️ **另一条已知失效形态**：真机若发现页面把 `<original_task>` 当 HTML 标签吞掉
 * （markdown 渲染），结构档那一半会失效 —— 那时改这里一处即可（四个消费者同源）。
 */
export function isZaiContinuationPrompt(content: string): boolean {
  if (!hasZaiContinuationStructure(content)) return false;
  return ZAI_TEMPLATE_OPENINGS.some((opening) => content.includes(opening));
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
