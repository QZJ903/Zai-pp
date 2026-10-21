/**
 * 续跑链「这一发到底发出去了没有」的**判定规则** —— 零依赖纯函数。
 *
 * ⚠️ **为什么单独成文件**：`zai.content.ts` 加载即执行 `defineContentScript`，
 * 不可 import ⇒ 里面的判定逻辑只能靠「按名字找源码」那类断言盯着，而那种断言
 * **天生有绕过面**（把逻辑包进一个嵌套函数，位置断言照样通过，见下）。
 * 抽到这里之后，规则本身可以被真输入喂满，`zai.content.ts` 只留「在哪调用」这一件事。
 *
 * ⚠️⚠️ **两个计数器都必须在外层同步区涨，这条约束不能破** —— 见 `classifyAugmentRequest`
 * 的说明。它不在这条文件的类型里，靠调用点的位置保证。
 */

import type { ZaiWebRouteName } from './contracts';
import { isZaiContinuationRequestBody } from './continuation-request';

/**
 * 「这一发到底发出去了没有」的三档结论。
 *
 * ⚠️⚠️ **为什么不能是布尔** —— Stop 按钮在实测里**稳定地比请求早 3–5ms 出现**
 * （页面点了发送就先渲染生成中的占位，那个占位里就有 Stop）。所以「看到过 Stop」
 * **不代表这一发发出去了**，它只代表页面进入了生成态。把它当「已发出」的证据，
 * 主判据一失效就会误判。
 *
 * | 档 | 含义 | 调用方该做什么 |
 * |---|---|---|
 * | `sent` | 请求确实发出去了 | 正常推进 |
 * | `unsent` | 确定没发出去 | **可以安全重发**（没有任何副作用） |
 * | `ambiguous` | 证据不足 —— 可能发出去了，也可能没有 | **不许重发**（重发就是双发），起看门狗 |
 */
export type ZaiSendEvidence = 'sent' | 'unsent' | 'ambiguous';

/** 一条桥上的增广请求对两个计数器各贡献多少。 */
export interface ZaiAugmentRequestDelta {
  /** 桥消息总数（`observedAugRequestCount`）的增量：到了就是 1。 */
  requestDelta: 0 | 1;
  /** 其中「认作续跑模板」的增量（`continuationRequestSeq`）：0 或 1。 */
  continuationDelta: 0 | 1;
}

/**
 * 一条 `AUGMENT_REQUEST_BODY` 桥消息该怎么记账。
 *
 * **两个计数器回答的是不同的问题，别合并**：
 * - `requestDelta` = 桥消息到了几条。语义是「主世界说有请求要发出去了」，
 *   **与内容无关** —— 所以它在 `body` 不是字符串时也照样记 1。
 * - `continuationDelta` = 其中几条**认得出是续跑模板**（`isZaiContinuationRequestBody`）。
 *
 * 两者的差值正是「请求出去了、但这一发不是我们注入的模板」这一档 ——
 * 它**同样是发出去了**，不该被当成失败。
 *
 * ⚠️⚠️ **调用点必须在串行队列之外、消息抵达瞬间同步调用。**
 * `waitForSendEvidence` 本身跑在队列里（`settleToolTurn` → `handleResponseComplete`
 * → `advanceContinuationLoop` → 发送链），它占着队列等这两个数变大；
 * 若记账发生在队列内，那次记账永远排不到 ⇒ **自锁**，只能等满 5 秒窗口再判成「没证据」。
 * 这条约束**不在类型里**，由 `zai-content-continuation-submit-contract.test.ts` 的接线断言守着。
 *
 * ⚠️ **`route` 刻意不参与记账** —— 续跑轮走 `completion`、首条走 `chatNew`，
 * 但「是不是续跑」由 body 内容决定（`chatNew` 也可能是自动化注入的续跑首条）。
 * 参数留着是为了让调用点显式表明「我知道自己在记哪条路由」，将来若要按路由分流有落点。
 */
export function classifyAugmentRequest(
  body: unknown,
  _route: ZaiWebRouteName,
): ZaiAugmentRequestDelta {
  const isContinuation = typeof body === 'string' && isZaiContinuationRequestBody(body);
  return {
    requestDelta: 1,
    continuationDelta: isContinuation ? 1 : 0,
  };
}

/**
 * 两个计数器的增量 → 三档结论。
 *
 * | requestDelta | continuationDelta | 档 | 说明 |
 * |---|---|---|---|
 * | > 0 | 任意 | `sent` | 桥通了 —— 请求确实要出去（不论认不认得出是续跑模板） |
 * | ≤ 0 | > 0 | `sent` | 倒退不回去的组合，按「有续跑证据」算已发出 |
 * | ≤ 0 | ≤ 0 | `ambiguous` | 桥挂了，或请求压根没发 |
 *
 * ⚠️ **`continuationDelta > 0` 单独成立也必须判 `sent`** —— 它意味着续跑模板认出来了，
 * 那比「桥消息到了」更强的证据。回头把这两个计数器调换顺序、或合并成一个时，
 * 这一档会先红。
 *
 * ⚠️ **`unsent` 不由这个函数产出** —— 它来自「提交动作本身没做成」
 * （没有输入框、表单没挂上、`requestSubmit` 抛错），那些在调用 `waitForSendEvidence`
 * **之前**就已经返回了。这个函数只判「提交触发之后有没有证据」。
 */
export function classifySendEvidence(
  requestDelta: number,
  continuationDelta: number,
): ZaiSendEvidence {
  if (requestDelta > 0 || continuationDelta > 0) return 'sent';
  return 'ambiguous';
}