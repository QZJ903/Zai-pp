/**
 * **工具面板的恢复编排**：把「历史腿」与「存储腿」的记录合流，找回它们各自该挂的
 * 那条助手消息，并在页面重建后重挂。
 *
 * ## 为什么需要这一层
 *
 * 两条腿各自都不完整（实测过的事实）：
 *
 * | 腿 | 有锚点吗 | 有真实结果吗 |
 * |---|---|---|
 * | **history**（打开/刷新会话时从 `messages/batch` 收集） | ✅ 消息 uuid + 正文 + 工具名 | ❌ 只有工具名与入参 |
 * | **storage**（`zai_pp_tool_history`，执行当时落库） | ❌ 没有消息 id、没有正文 | ✅ 有 `result.detail` / `output` |
 *
 * ⇒ **合流不是优化，是必要条件**：storage 腿单独渲染不出来（找不到该挂哪条消息），
 * history 腿单独渲染只有摘要。两者按「工具签名」对齐后，才既知道挂哪儿、又有真结果。
 *
 * ## 三件必须守住的
 *
 * ① **渲染完再挂**：`messages/batch` 到达时页面**还没重建 DOM**（响应先到、DOM 后建），
 *    所以第一次找目标**必然找不到**。调度是「首跑 0ms → 失败则 250ms 重试 → 最多 20 次」。
 * ② **一条消息只被一块占用**（`usedMessages`）：没有它，多条记录会全部挂到最后一条消息上
 *    （兜底腿的判据是「第一个还没被占用的消息」）。
 * ③ **页面重建后要重挂**：实测过 `messages/batch` 到达时页面会清空并重建消息节点，
 *    我们挂进去的东西**会跟着没**。判据是「我们自己的节点被移除」。
 */

import type { ToolCardResult, ToolExecutionRecord } from '../types';

/** 一条待恢复的记录（两条腿合流后的形状）。 */
export interface ToolBlockRestoreRecord {
  id: string;
  source: 'history' | 'storage';
  /** 助手消息 id（uuid）。history 腿有；storage 腿靠合流拿到。 */
  messageId: string | null;
  parentMessageId: string | null;
  /** 助手正文（只用于「按内容片段定位」，不是要显示的东西）。 */
  content: string;
  /** 这条消息里调用过的工具（名字 + XML 原文）—— 合流的对齐依据。 */
  calls: readonly { name: string; raw: string }[];
  /** 真实执行结果。storage 腿有；history 腿为空。 */
  executions: readonly ToolExecutionRecord[];
  /**
   * 这一轮**此刻是不是还在飞**（实时腿正在跑的那一轮）。
   *
   * ⚠️⚠️ **它决定块的折叠态，口径与上游一致**：在飞 ⇒ **展开**（用户当场要看见
   * 在跑什么）；**这一轮结束 / 刷新后** ⇒ **收起**。
   * 上游两个组件都是这个口径 —— `.dpp-tool-block` 实时面板不传 `collapsed`
   * （缺省展开）、恢复面板传 `collapsed: true`；inline-agent 控制台更是有
   * `sealCurrentToolGroup`（narration 把两组隔开时折前一组）与
   * `collapseAllAgentToolGroups`（run 结束时全折）两个显式折叠点。
   *
   * ⚠️ **没有它的话**：一轮跑完那一大块还摊着，跑 N 轮就是 N 大块
   * （真机截图里 3 轮 = 3 块全展开），而正确的形态是 **N 行块头**。
   *
   * ⚠️ **只能由显式收尾清掉，不能被重复投递冲掉**（见 `merge` / `refresh` 的 OR）——
   * 实时轮中途页面会拉 `messages/batch`，历史腿会带**同一个 id** 再投递一次；
   * 若那次投递把它冲成 undefined，块会在轮中途塌下去。
   */
  live?: boolean;
  /**
   * 这条记录属于**哪条会话**（`/c/<id>` 里的 id；读不到时为 null）。
   *
   * ⚠️⚠️ **它挡的是「把旧会话的工具挂到新会话的消息上」** —— 真机实测过：
   * 切过会话之后，旧会话那几条记录的 `messageId` 与正文片段**都匹配不上**
   * （新会话的 DOM 里没有它们），于是走进兜底腿「第一个还没被占用的消息」
   * ⇒ **挂出几个属于别的会话的面板**。
   * 上游 `findRestoredToolTarget` 在兜底腿之前有一句 `if (!isSameRoute) return null;`
   * 就是干这个的（我们的记录原来没有会话字段，等于把那条判据丢了）。
   *
   * ⚠️ **null 是「不知道」而不是「不属于」** —— 读不到会话 id 时不该一律不挂
   * （那会让「首条消息刚发出、地址栏还没切到 /c/<id>」的当场渲染整批失效）。
   * 判据写成「有值且与当前会话不同 ⇒ 拒绝」，null 走原来的路。
   */
  chatSessionId?: string | null;
  createdAt: number;
}

/** 恢复目标的定位结果。 */
export interface RestoreTargetResolution {
  message: Element;
  leg: 'messageId' | 'content' | 'index' | 'fallback';
}

export interface ToolBlockRestoreDependencies {
  /** 取当前会话的全部助手消息（按 DOM 顺序）。 */
  listMessages: () => Element[];
  /**
   * 从消息里取它**自己的**正文 —— **必须排除我们注入的 UI**。
   *
   * ⚠️⚠️ 上游那条腿用的是裸 `message.textContent`，而**我们自己挂进去的面板里的
   * 工具名与详情也在里面** ⇒ 已挂过的消息会「因为包含自己而再次命中」，
   * 表现是卡片被反复重挂或挂到错的记录上。本模块按「排除自身注入」的口径取。
   */
  getMessageOwnText: (message: Element) => string;
  /** 这一块要挂在哪个宿主里（z.ai 上是 `#response-content-container`）。 */
  resolveHost: (message: Element) => Element | null;
  /**
   * 渲染一条记录到某条消息上。
   *
   * ⚠️ **「已挂过就只更新内容」也归它管**：它内部先 `findToolBlock(record.id)`，
   * 找到且还连着就原地更新、找不到才新建并追加。**本模块不做这个判断** ——
   * 那样就要同时持有「块查找」与「块创建」两套知识，分叉风险更高。
   *
   * 返回 `false` 表示**宿主此刻不可用**（DOM 还没建好），本模块会下一轮再试。
   */
  render: (record: ToolBlockRestoreRecord, message: Element) => boolean;
  /** 我们自己的 UI 选择器 —— observer 判「是不是我们被移除了」。 */
  ownUiSelector: string;
  /**
   * 这条消息带不带指定的锚点 id（往上找几层）。
   *
   * ⚠️⚠️ **必须与「抽锚点」同源**（`core/zai/tool-block-adapter.ts` 的
   * `messageCarriesZaiAnchorId` 与 `readZaiMessageId` 放一起、共用类名构造）——
   * 本模块是零依赖的纯 DOM 模块，不能 import 站点模块 ⇒ 走注入。
   * 两处各写一遍 `message-${id}` 会在改格式时**静默分叉**（一边抽得出、另一边比不中）。
   */
  messageCarriesAnchorId: (message: Element, messageId: string) => boolean;
  /**
   * **消息容器**选择器 —— observer 判「页面刚把消息建出来」。
   *
   * ⚠️⚠️ **它是 observer 的另一半，不能省**：重试预算（20 × 250ms ≈ 5 秒）耗尽之后，
   * 记录会一直留在 pending 里；而此时**我们什么都没挂过** ⇒ 「我们自己的节点被移除」
   * 那条判据永远不成立 ⇒ **记录永久卡住**（表现：刷新后偶尔不出面板）。
   * 上游 `getRestoredMessageMutationAction` 正是**两半**：`requeueMountedRecords`
   * 与 `schedulePendingRender`。**只搬前半会漏掉「DOM 迟到」这一整类**。
   */
  messageSelector: string;
  /** 挂在哪个根上观察（z.ai 上用 `#app` 或 `body`）。 */
  observeRoot: () => Element | null;
  /**
   * 取**当前**会话 id（`/c/<id>`；拿不到返回 null）。
   *
   * ⚠️⚠️ **兜底定位腿必须先过这一关**（见 `ToolBlockRestoreRecord.chatSessionId`）——
   * 没有它，切过会话之后旧记录会被兜底挂到新会话的消息上（真机实测）。
   * ⚠️ **要读「此刻」的值**，不是记录创建时的值：换会话后这个函数的返回值会变，
   * 而记录里冻结的那个值不变 —— 两者不等就是「这条记录不属于当前会话」。
   */
  getChatSessionId: () => string | null;
  /** 首跑之后的固定重试间隔。 */
  retryDelayMs?: number;
  /** 最大重试次数。 */
  maxAttempts?: number;
  /** 注入 `requestAnimationFrame`（测试用）。 */
  scheduleFrame?: (callback: () => void) => void;
}

const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_ATTEMPTS = 20;

/** 按内容片段定位时，片段至少要有这么长（太短会误命中）。 */
const MIN_CONTENT_SNIPPET = 12;

/** 取内容片段的前若干字符。 */
const CONTENT_SNIPPET_LENGTH = 80;

export interface ToolBlockRestoreController {
  /** 接收新记录（幂等；已存在的按兼容判据合流）。 */
  remember: (records: readonly ToolBlockRestoreRecord[]) => void;
  /** 跑一轮渲染；返回还没渲染成功的条数。 */
  renderPending: () => number;
  /**
   * **把若干条记录标记为「已收尾」** —— 清掉 `live` 并重画（块因此收起）。
   *
   * ⚠️⚠️ **这是「块在轮结束时自动收起」的唯一入口**。上游对应的是
   * `collapseAllAgentToolGroups`（inline-agent 的 run 结束收尾）与
   * `sealCurrentToolGroup`（narration 把两组隔开时折前一组）。
   * 不调它的话，一轮跑完那一大块会一直摊着，跑 N 轮就是 N 大块全展开。
   *
   * ⚠️ **收的是「记录 id」不是 requestId** —— 本模块不知道 requestId 那层概念
   * （id 由调用方给，可能是 `history:<uuid>` 也可能是 `live:<requestId>`）。
   */
  sealLive: (recordIds: readonly string[]) => void;
  /**
   * **换会话了** —— 丢掉全部记录（调用方随后会重新拉存储腿）。
   *
   * ⚠️ 不 `stop()`：观察器要继续工作，只是记录不再属于当前会话。
   */
  clearAll: () => void;
  /**
   * **只丢不属于当前会话的记录**（`keep` 返回 false 的），其余重新排队等重挂。
   *
   * ⚠️⚠️ **为什么不能一律 `clearAll`** —— 会话通知是 1 秒轮询驱动的，页面刚加载时
   * 必然触发一次「假变化」（上一次通知的会话 id 初值是 null）；而 `install()` 刚拉到的
   * 存储腿记录会连同 `pending` 一起被清掉 ⇒ 真结果只剩历史腿那份摘要（面板退化成
   * 「工具名 + 已执行」、没有详情、没有保存按钮），且**不会自愈**。
   *
   * ⚠️ **保留项要重新入 `pending`** —— 换会话后页面会重建消息节点，块得重挂；
   * 只留着 `records` 而不排队，那一轮就再也没人去渲染它们。
   * ⚠️ **调用方拿不到会话 id 时仍走 `clearAll`**（不知道 ≠ 都属于当前会话）。
   * ⚠️⚠️ **这里的 `null` 口径与 `isRecordOnCurrentSession` 相反，是有意的** ——
   * 那条是「定位腿的放行」（记录说不知道就允许它挂），这条是「表内归属的清理」
   * （不知道属于谁就不留）。两处各回答一个问题，**别为了「统一」把判据合并**。
   */
  retainRecords: (keep: (record: ToolBlockRestoreRecord) => boolean) => void;
  /** 开始观察页面变动（页面重建我们的块时自动重排队）。 */
  start: () => void;
  /** 停止观察并清空全部状态。 */
  stop: () => void;
  /** 当前记录快照（测试用）。 */
  snapshot: () => { records: number; pending: number };
}

export function createToolBlockRestoreController(
  dependencies: ToolBlockRestoreDependencies,
): ToolBlockRestoreController {
  const retryDelayMs = dependencies.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const scheduleFrame = dependencies.scheduleFrame
    ?? ((callback: () => void) => { requestAnimationFrame(() => callback()); });

  const records = new Map<string, ToolBlockRestoreRecord>();
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let observer: MutationObserver | null = null;
  let observerScheduled = false;

  /**
   * 两条腿能不能算「同一次调用」。
   *
   * 判据按**优先级**从上往下试，任一条成立即认为相同：
   * ① 两条都有 `messageId` 且相等 —— 最硬；
   * ② **工具签名一致**（两条都至少有一个调用）—— storage 腿没有消息 id，
   *    所以对「history ↔ storage」这一对，**只有这条能用**。
   *
   * ⚠️ **第 ② 条是承重的**：它是两条腿唯一的公共维度。少了它，
   * storage 腿的真结果永远合流不进来（表现：刷新后只看得见工具名、看不见结果）。
   * ⚠️ 签名用「工具名 + XML 原文」—— 同一次调用的 XML 在两条腿上**逐字相同**
   * （都来自服务端存的那份正文）。
   *
   * ⚠️ **曾有过一条「父消息 id 相同 + 签名一致」的中间判据，已删除**：它形式上排在
   * 签名判据之前，但**成立时下面那条签名判据必然也成立**（它的条件是「签名一致」的
   * 超集）⇒ 原实现等价于 `if (X && Y) return true; return Y;` —— 分支触发时 `Y` 必真、
   * 不触发时唯一出口仍是 `Y`，**对任意输入返回值恒等**（另按 messageId × parentMessageId
   * × calls 的取值组合穷举比对过一遍，无一处不同）。删掉不影响任何行为；
   * `parentMessageId` 字段本身仍在 `merge` / `refresh` 里用来跨腿保留锚点。
   */
  function isCompatible(a: ToolBlockRestoreRecord, b: ToolBlockRestoreRecord): boolean {
    if (a.messageId && b.messageId) return a.messageId === b.messageId;
    return haveMatchingSignatures(a, b);
  }

  function haveMatchingSignatures(a: ToolBlockRestoreRecord, b: ToolBlockRestoreRecord): boolean {
    if (a.calls.length === 0 || b.calls.length === 0) return false;
    const left = new Set(a.calls.map(signatureOf));
    return b.calls.some((call) => left.has(signatureOf(call)));
  }

  /** 签名里参与比对的 raw 上限 —— 与写库时的 `sanitizeCall` 上限同值。 */
  const SIGNATURE_RAW_LIMIT = 4_000;

  /**
   * 一条调用的签名：`工具名 + XML 原文`。
   *
   * ⚠️⚠️ **两边必须对称截断到同一个上限** —— 写库时 `core/tool/history.ts` 的
   * `sanitizeCall` 把 `raw` 截到 4000 字符 + `\n...[truncated]`，而**历史腿拿的是全文**
   * ⇒ 超过 4000 字符的调用**两条腿的签名必然不等**、合流彻底失败。
   * 实测：一个 5000 字符的 `local_file_write` 会让存储腿那条**永不渲染**
   * （`records: 2`、只画出 history 那条且 `exec=0`）⇒「写了大文件、刷新后看不到结果」。
   * 截断后：存储腿的前 4000 字符与历史腿的前 4000 字符**逐字相同**，重新对上。
   *
   * ⚠️ **不要改成「签名用 payload」**（上游 `getToolRecordSignature` 那样）——
   * 我们的 payload 截断是 `truncateRecord` → `{truncated: true, preview: "前4000字符"}`，
   * **形状都变了**，与历史腿的完整 payload 比对同样不等。换维度不解决问题，
   * 问题真身是**不对称**。
   */
  function signatureOf(call: { name: string; raw: string }): string {
    return `${call.name}\n${call.raw.trim().slice(0, SIGNATURE_RAW_LIMIT)}`;
  }

  /**
   * 这批候选里**有没有歧义** —— 有就别并。
   *
   * ⚠️⚠️ **判据是「候选里出现了两个不同的锚点」**：那说明它们分属**不同的助手消息**，
   * 而 incoming 之所以与它们全都兼容，只是因为签名恰好相同（同一条命令被跑过两次）。
   * 此时无论并成哪一条都是猜，猜错的表现是**一条消息的面板整个消失**
   * （并全部）或**另一条永远拿不到结果**（只并第一条）。
   *
   * ⚠️ **只有「有锚点」的候选参与判歧义**：
   * - `1 条 history + N 条 storage`（真机那个「只显示 1 次」的形态）⇒ 只有 1 个锚点
   *   ⇒ 无歧义 ⇒ 照常全并；
   * - `N 条 storage`（都还没合流）⇒ 0 个锚点 ⇒ 无歧义 ⇒ 照常全并；
   * - `2 条 history（不同消息）+ 1 条 storage` ⇒ 2 个不同锚点 ⇒ **拒绝**。
   *
   * ⚠️ **拒绝的代价要说清**：incoming 会**作为独立记录留下**，它多半没有锚点
   * （storage 腿），而 `resolveTarget` 不给 storage 腿用兜底腿 ⇒ **它不会渲染**。
   * 也就是说这一格里「存储腿的真结果暂时看不到」—— 比「挂到错的回答上」轻得多
   * （失败方向安全）。**第二批（存储腿自带 `assistantMessageId`）会消掉这一格**：
   * 那时它自己就有锚点，不再需要签名猜。
   */
  function hasAmbiguousCandidates(
    compatibleIds: readonly string[],
    incoming: ToolBlockRestoreRecord,
  ): boolean {
    const anchors = new Set<string>();
    for (const id of compatibleIds) {
      const messageId = records.get(id)?.messageId;
      if (messageId) anchors.add(messageId);
    }
    if (incoming.messageId) anchors.add(incoming.messageId);
    return anchors.size > 1;
  }

  /**
   * 合流两条**不同 id** 的记录（= 两条腿各给了同一件事的一半）。
   *
   * ⚠️ **锚点取「有的那一方」** —— 它只来自 history 腿，不能按「谁更新」决定。
   *
   * ⚠️⚠️ **`calls` 与 `executions` 必须取「并集」，不是「非空的那一方」** ——
   * 真机报出的缺陷：一轮用了 3 次工具，刷新后只显示「已调用工具（1 次）」。
   * 成因是两条腿的**粒度不同**：
   * - **history 腿**：一条消息一条记录（3 个 `calls`、0 个 `executions`）；
   * - **storage 腿**：**一次调用一条记录**（各 1 个 call / 1 个 execution）——
   *   因为 `zai_pp_tool_history` 是按调用落库的。
   * 取「非空的那一方」时，第一条 storage 记录带进 1 个 execution 之后，
   * 后面两条的 execution **全被挡住**（`existing` 非空就永远胜出）⇒ 只剩 1 行。
   *
   * ⚠️ **上游没有这个问题，但原因不是它写得更对，而是它的存储腿粒度不同**：
   * 上游 `persistToolBlockSession` 把整轮的 `session.executions` **一起写进一条块**
   * ⇒ 两条腿天然 1:1，`mergeToolRestoreRecords` 用替换语义就够了。
   * **我们是按调用粒度的存储腿，所以合流必须是并集** —— 这条不能照搬上游。
   */
  function merge(existing: ToolBlockRestoreRecord, incoming: ToolBlockRestoreRecord): ToolBlockRestoreRecord {
    return {
      id: existing.id,
      // 锚点：谁有就用谁（history 腿有、storage 腿没有）
      messageId: existing.messageId ?? incoming.messageId,
      parentMessageId: existing.parentMessageId ?? incoming.parentMessageId,
      // 正文同理（用于内容片段定位）
      content: existing.content || incoming.content,
      // ⚠️ `source` 取「任一方是 storage 就是 storage」—— storage 腿的结果更全，
      // 而下游靠这个决定「找不找兜底目标」（storage 腿没有锚点时不该乱挂）。
      source: existing.source === 'storage' || incoming.source === 'storage' ? 'storage' : 'history',
      calls: unionCalls(existing.calls, incoming.calls),
      executions: unionExecutions(existing.executions, incoming.executions),
      // ⚠️ **OR，不是「取新的」** —— `live` 一旦为真就保持真：实时轮中途历史腿
      // 会带同一个 id 再投递（它没有 live），冲掉它会让块在轮中途塌下去。
      live: existing.live === true || incoming.live === true,
      // ⚠️ **会话归属取「有的那一方」**（理由同 `refresh`）。
      chatSessionId: existing.chatSessionId ?? incoming.chatSessionId ?? null,
      createdAt: Math.min(existing.createdAt, incoming.createdAt),
    };
  }

  /**
   * 两份调用列表的**并集**（按 `signatureOf` 去重，保留先出现的那份的顺序）。
   *
   * ⚠️ **history 腿通常已经有全部调用**，所以这条多半是恒等；留着是因为
   * 「storage 腿先到、history 腿后到」的顺序下，先到的那些调用也得留着。
   */
  function unionCalls(
    left: readonly { name: string; raw: string }[],
    right: readonly { name: string; raw: string }[],
  ): { name: string; raw: string }[] {
    const seen = new Set<string>();
    const merged: { name: string; raw: string }[] = [];
    for (const call of [...left, ...right]) {
      const signature = signatureOf(call);
      if (seen.has(signature)) continue;
      seen.add(signature);
      merged.push(call);
    }
    return merged;
  }

  /**
   * 两份执行结果的**并集**。
   *
   * ⚠️ **去重键优先 `callId`**（`executeDetected` 算的 `xml:<hash>`，存储腿带着它），
   * 拿不到时退回「名字 + 摘要」—— 两者都拿不到就按「每次都不同」处理，
   * 宁可多留一行也不静默吞掉一次执行。
   */
  function unionExecutions(
    left: readonly ToolExecutionRecord[],
    right: readonly ToolExecutionRecord[],
  ): ToolExecutionRecord[] {
    const seen = new Set<string>();
    const merged: ToolExecutionRecord[] = [];
    for (const execution of [...left, ...right]) {
      const key = execution.callId
        ? `id:${execution.callId}`
        : `name:${execution.name}:${execution.result.summary ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(execution);
    }
    return merged;
  }

  /**
   * 同一个 id 被再次投递 —— **以新的为准**，但**不丢掉只有旧记录才有的锚点**。
   *
   * ⚠️⚠️ **这条与 `merge` 的区别是承重的**：同一个 id 的重复投递是**常态**
   * （实时面板每执行一步重发一次、历史端点每次刷新重发一批、存储腿每次启动重读一遍）。
   * 若走 `merge`（那条「结果取非空的那一方」），第二次投递的新数据会被**旧数据挡住**
   * —— 表现是**「执行中」那一行永远不被真实结果替换**（旧的那份非空、于是永远胜出）。
   */
  function refresh(existing: ToolBlockRestoreRecord, incoming: ToolBlockRestoreRecord): ToolBlockRestoreRecord {
    return {
      id: existing.id,
      messageId: incoming.messageId ?? existing.messageId,
      parentMessageId: incoming.parentMessageId ?? existing.parentMessageId,
      content: incoming.content || existing.content,
      source: existing.source === 'storage' || incoming.source === 'storage' ? 'storage' : 'history',
      calls: incoming.calls.length > 0 ? incoming.calls : existing.calls,
      executions: incoming.executions.length > 0 ? incoming.executions : existing.executions,
      // ⚠️ **OR，与 `merge` 同理** —— 重复投递不能把「还在飞」这个事实冲掉。
      live: existing.live === true || incoming.live === true,
      // ⚠️ **会话归属取「有的那一方」**：历史腿从请求 URL 读得到、实时腿从地址栏读，
      // 两条腿都可能拿不到（首条消息时地址栏还没切）。取到过就一直留着 ——
      // 它是「这条记录属于哪条会话」的冻结值，被冲成 null 会让兜底腿失去这一关。
      chatSessionId: existing.chatSessionId ?? incoming.chatSessionId ?? null,
      createdAt: existing.createdAt,
    };
  }

  function remember(incoming: readonly ToolBlockRestoreRecord[]): void {
    let changed = false;
    for (const record of incoming) {
      if (!record.id) continue;

      // ⚠️⚠️ **顺序是承重的：先判「同 id」，再找「跨腿兼容」** ——
      // 反过来的话，同 id 的重复投递会被 `isCompatible` 抢先判成「兼容」，
      // 于是走进 `merge`（结果取非空的那一方）⇒ **新的结果被旧的挡住**。
      // 实测症状：「执行中」那一行永远不被真实结果替换（旧的那份非空、永远胜出）。
      if (records.has(record.id)) {
        records.set(record.id, refresh(records.get(record.id)!, record));
        pending.add(record.id);
        changed = true;
        continue;
      }

      // 不同 id 才去找「这两条说的是不是同一件事」（history 腿 ↔ storage 腿）。
      //
      // ⚠️⚠️ **必须收「全部」兼容的记录，不能只收第一条** —— 真机缺陷的根因就在这里。
      // 两条腿的粒度不同：**history 腿一条消息一条记录**（含该消息的全部 calls），
      // 而 **storage 腿一次调用一条记录**。所以「一条 history 记录」与「N 条 storage
      // 记录」**每一条都兼容**（签名交集非空）。
      // 只 `find` 第一条时：存储腿先到（`install()` 里先 `loadStorageLeg()`）、
      // 历史腿后到 ⇒ 只有第一条 storage 记录被并进去，**其余 N-1 条永远留在表里**
      // 且因为「storage 腿没有锚点、兜底腿又不给它用」而**永不渲染**；
      // 而并进去的那条只带进 1 个 execution（history 腿的 executions 是空的）
      // ⇒ **面板只剩 1 行**（真机报的「用了好几次工具、刷新后只显示一次」）。
      //
      // ⚠️⚠️ **但「并全部」有前提：候选不能有歧义**。签名在「同一条命令被跑过两次」
      // 时必然重复 ⇒ 当**两条不同消息**都调过同一条命令时，「没有锚点的那一方」
      // 与它们**每一条都兼容**。此时并全部会把两条消息并成一块、
      // **其中一条的面板整个消失**（实测 `records: 2 → 1`）；只并第一条则让另一条
      // 变孤儿（`exec=0`）。两种都错 ⇒ **有歧义就不并**（见 `hasAmbiguousCandidates`）。
      const compatibleIds = [...records.entries()]
        .filter(([, existing]) => isCompatible(existing, record))
        .map(([id]) => id);
      if (compatibleIds.length > 0 && !hasAmbiguousCandidates(compatibleIds, record)) {
        const baseId = compatibleIds[0];
        // ⚠️ **先把 incoming 并进去，再把其余兼容记录逐条并进来** —— 顺序不影响结果
        // （`merge` 是并集语义），但先并 incoming 能让 `id` 保持 `baseId`。
        let merged = merge(records.get(baseId)!, record);
        for (const otherId of compatibleIds.slice(1)) {
          merged = merge(merged, records.get(otherId)!);
          records.delete(otherId);
          pending.delete(otherId);
        }
        records.set(baseId, merged);
        pending.add(baseId);
        changed = true;
        continue;
      }

      records.set(record.id, record);
      pending.add(record.id);
      changed = true;
    }
    if (changed) schedule();
  }

  function schedule(): void {
    if (pending.size === 0) return;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const missing = renderPending();
      if (missing > 0 && attempts < maxAttempts) {
        attempts += 1;
        schedule();
        return;
      }
      attempts = 0;
    }, attempts === 0 ? 0 : retryDelayMs);
  }

  /**
   * 跑一轮渲染，返回**还没成功的条数**。
   *
   * ⚠️ **`usedMessages` 必须在这里创建、整轮共享** —— 它是「一轮之内不互相抢目标」
   * 的唯一保证。放到循环里每次新建就等于没有。
   * ⚠️⚠️ **但它只活一轮，而两条腿是分两批到达的**（存储腿先、历史腿后）——
   * 「同一条回答里叠两块面板」就出在这里。本模块**不**用跨轮占用去挡（那会让后到的
   * 那条永久不渲染、真结果丢掉），而是靠 ``render`` 侧按**宿主**找块并合并
   * （`findToolBlockInMessage`）：后到的那条照常交给它，由它并进已有的块。
   * ⚠️ **成功的那一轮要把 `attempts` 归零**（由 `schedule` 的收尾做）——
   * 否则「先失败 20 次、之后又来一条新记录」时，新记录会被旧计数卡住直接放弃。
   */
  function renderPending(): number {
    if (pending.size === 0) return 0;
    const messages = dependencies.listMessages();
    if (messages.length === 0) return pending.size;

    const usedMessages = new Set<Element>();

    for (const id of [...pending]) {
      const record = records.get(id);
      if (!record) {
        pending.delete(id);
        continue;
      }

      // 已经从别的记录那里占过一条消息的，不再参与本轮（避免互相抢目标）。
      const resolution = resolveTarget(record, messages, usedMessages);
      if (!resolution) continue;

      if (dependencies.render(record, resolution.message)) {
        usedMessages.add(resolution.message);
        pending.delete(id);
      }
      // render 返回 false（宿主暂时不可用）⇒ 留在 pending 里等下一轮重试。
    }

    return pending.size;
  }

  /**
   * 把若干条记录标记为「已收尾」并重画（块因此收起）。
   *
   * ⚠️ **只清 `live`、不动别的** —— 记录本身要留着（刷新后还得靠它渲染）。
   * ⚠️ **收完必须重排队**：块的折叠态只在 `render` 时决定，不重画就还是展开的。
   */
  function sealLive(recordIds: readonly string[]): void {
    let changed = false;
    for (const id of recordIds) {
      const record = records.get(id);
      if (!record || record.live !== true) continue;
      records.set(id, { ...record, live: false });
      pending.add(id);
      changed = true;
    }
    if (changed) schedule();
  }

  /**
   * **换会话了** —— 丢掉全部记录（页面上的块由调用方或下一次重建自然消失）。
   *
   * ⚠️⚠️ **它挡的是「旧会话的工具挂到新会话」的另一半**（第一半是
   * `resolveTarget` 的会话判据）：切会话后旧记录的三条定位腿全 miss，
   * 兜底腿会把它挂到新会话的消息上 —— 真机实测过（旧会话的
   * shell_status 之类出现在新会话里）。
   * ⚠️ **为什么还要清**：会话判据只挡住「挂错」，但旧记录会一直躺在表里，
   * 每次 `requeueAll` 都要重跑一遍（白扫），且切回原会话时会与新拉到的历史
   * 记录混在一起。**清掉是「不该留的别留」**。
   * ⚠️ **不清 `observer` / 不 `stop()`** —— 面板还要继续工作，调用方随后会
   * 重新拉一次存储腿（见 `tool-panel.ts` 的 `handleSessionChange`）。
   */
  function clearAll(): void {
    records.clear();
    pending.clear();
    attempts = 0;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * 只丢不属于当前会话的记录，其余重新排队等重挂。
   *
   * ⚠️ **保留项必须重新入 `pending`** —— 换会话后页面会重建消息节点，已经挂好的块
   * 跟着没了；只留着 `records` 而不排队，它们就再也没人去渲染。
   * ⚠️ **被丢弃的项要连 `pending` 一起删** —— 只删 `records` 的话，
   * `renderPending` 会因为 `records.get(id)` 取不到而静默跳过，留下永不消费的 pending。
   */
  function retainRecords(keep: (record: ToolBlockRestoreRecord) => boolean): void {
    for (const [id, record] of [...records]) {
      if (keep(record)) {
        pending.add(id);
        continue;
      }
      records.delete(id);
      pending.delete(id);
    }
    // ⚠️ 与 `requeueAll` 同形：预算归零 + 重新排一次（否则要等下一次 observer 唤醒）。
    attempts = 0;
    schedule();
  }

  /**
   * 找这条记录该挂哪条消息。四条腿按优先级试。
   *
   * ⚠️ **前三条都可能miss**（消息还没渲染出来），届时**返回 null 让它下轮再试** ——
   * 不要在这里「随便找一条挂上去」，那会把块挂到错的回答上。
   * ⚠️⚠️ **兜底腿之前必须过「这条记录属不属于当前会话」这一关**（上游
   * `findRestoredToolTarget` 的 `if (!isSameRoute) return null;`）——
   * 没有它，切过会话之后旧记录的三条腿全 miss、被兜底挂到**新会话的消息**上
   * （真机实测：旧会话的 shell_status 挂到了新会话）。
   * ⚠️ **兜底腿只在 `source !== 'storage'` 时用**：storage 腿没有锚点信息，
   * 挂到哪里都是猜的；history 腿至少有顺序可依。
   */
  function resolveTarget(
    record: ToolBlockRestoreRecord,
    messages: Element[],
    usedMessages: Set<Element>,
  ): RestoreTargetResolution | null {
    if (record.messageId) {
      const byId = messages.find(
        (message) => !usedMessages.has(message) && messageHasMessageId(message, record.messageId!),
      );
      if (byId) return { message: byId, leg: 'messageId' };
    }

    const snippet = normalizeText(record.content).slice(0, CONTENT_SNIPPET_LENGTH);
    if (snippet.length >= MIN_CONTENT_SNIPPET) {
      const byContent = messages.find(
        (message) => !usedMessages.has(message) && normalizeText(dependencies.getMessageOwnText(message)).includes(snippet),
      );
      if (byContent) return { message: byContent, leg: 'content' };
    }

    // ⚠️ **锚点与内容都匹配不上时，先问「这条记录还属于当前会话吗」**。
    // 前三条腿对「别的会话的记录」必然全 miss（那些消息不在这个 DOM 里），
    // 而兜底腿只看「谁还没被占用」⇒ 会把它挂到当前会话的第一条消息上。
    if (!isRecordOnCurrentSession(record)) return null;

    if (record.source === 'storage') return null;

    // ⚠️⚠️ **有锚点的记录不许用兜底腿** —— 它本该挂在**某一条具体的消息**上，
    // 那一条不在（还没渲染 / 已被占用）时**应该等**，而不是「随便找一条还没被占用的」。
    //
    // 真机形状的失效：同一轮里 `readZaiMessageId` 先返回 null、后返回 uuid
    // ⇒ 先后产生 `live:<requestId>` 与 `history:<uuid>` 两条记录（签名对不上时不会合流）。
    // 前者没有锚点、走兜底腿**占住了正确的那条消息**；后者带着精确锚点来的时候
    // `usedMessages` 已经把那条挡掉了 ⇒ 落到兜底腿 ⇒ **挂到另一条回答上**
    // （实测：`rendered = [{live:req-1 → msg0}, {history:<UUID_A> → msg1}]`，
    // 而 msg1 属于另一条消息）。
    // ⚠️ **代价**：这条记录会留在 `pending` 等重试（20 × 250ms + observer 的
    // 「消息刚出现」那一半），最终可能不渲染。**那是安全的失败方向** ——
    // 宁可不显示，也不要把工具面板挂到错的回答下面。
    if (record.messageId) return null;

    const fallback = messages.find((message) => !usedMessages.has(message));
    return fallback ? { message: fallback, leg: 'fallback' } : null;
  }

  /**
   * 这条记录属不属于**当前**会话。
   *
   * ⚠️ **null（不知道）一律放行** —— 见 `ToolBlockRestoreRecord.chatSessionId` 的说明：
   * 首条消息刚发出、地址栏还没切到 `/c/<id>` 时两边都可能是 null，
   * 一律拒绝会让当场渲染整批失效。
   * ⚠️ **只在兜底腿之前判**：锚点 / 内容匹配上的那些（`messageId` 逐字相等、
   * 正文片段逐字相等）本身就是强判据，不必再过这一关 —— 那也保住了
   * 「同一条消息的 uuid 在两个会话里不可能相同」这个前提不被削弱。
   */
  function isRecordOnCurrentSession(record: ToolBlockRestoreRecord): boolean {
    const recordSession = record.chatSessionId ?? null;
    if (!recordSession) return true;
    const current = dependencies.getChatSessionId();
    if (!current) return true;
    return current === recordSession;
  }

  /**
   * 消息身上带没带这个 id。
   *
   * ⚠️ 判据**委托给注入进来的 `messageCarriesAnchorId`**（见接口上的说明）——
   * 本模块不再自己拼 `message-${id}`。
   */
  function messageHasMessageId(message: Element, messageId: string): boolean {
    return dependencies.messageCarriesAnchorId(message, messageId);
  }

  /** 把所有记录排回待渲染（观察器发现我们的块被移除时调）。 */
  function requeueAll(): void {
    if (records.size === 0) return;
    for (const id of records.keys()) pending.add(id);
    attempts = 0;
    schedule();
  }

  /**
   * 观察页面变动。**两个触发条件，缺一不可**（对应上游那两半）：
   *
   * ① **我们自己的块被移除** ⇒ `requeueAll()`（页面重建了那块 DOM，要重挂）；
   * ② **还有 pending 记录、而页面刚把消息建出来** ⇒ 只跑一轮 `renderPending()`
   *    （**不重排队** —— 那些记录本来就在 pending 里；重排队只是白扫一遍）。
   *
   * ⚠️⚠️ **② 是必需的，不是优化**：重试预算耗尽后我们什么都没挂过 ⇒ ① 永远不成立
   * ⇒ 记录会**永久卡在 pending**（表现：刷新后偶尔不出面板，刷新第二次又好了）。
   * 上游 `getRestoredMessageMutationAction` 就是这两半，**只搬前半会漏掉「DOM 迟到」这一整类**。
   *
   * ⚠️ **判据必须收窄**，不能是「任何 DOM 变动」—— 流式输出期间页面每秒产生大量变动，
   * 每帧全量重扫会把主线程吃掉。
   * ⚠️ **按帧合流**：一次变动潮里可能连着几十条记录，用 rAF 合并成一次重扫。
   */
  function start(): void {
    if (observer) return;
    const root = dependencies.observeRoot();
    if (!root) return;
    observer = new MutationObserver((mutations) => {
      if (observerScheduled) return;
      const invalidated = mutations.some(mutationRemovesOurUi);
      // ⚠️ **没有 pending 时不看消息容器那条** —— 那是常态（面板已挂好、页面在流式输出），
      // 每帧都判一次纯属浪费。
      const messageAppeared = pending.size > 0 && mutations.some(mutationAddsMessage);
      if (!invalidated && !messageAppeared) return;
      observerScheduled = true;
      scheduleFrame(() => {
        observerScheduled = false;
        if (invalidated) {
          requeueAll();
          return;
        }
        // 消息刚出现 ⇒ 只补跑一轮（记录已在 pending 里）。
        attempts = 0;
        schedule();
      });
    });
    // ⚠️ **必须同时观察 `class`** —— 见 `mutationAddsMessage` 的说明
    // （`message-<uuid>` 可能**迟到到既有的 wrapper 上**，那条路不产生新 childList 节点）。
    // ⚠️ **`attributeFilter` 收窄到 `class`**：流式期间页面每秒大量变动，全量属性观察
    // 会把主线程吃掉；而这里只关心「锚点类挂上来了」。
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  function mutationRemovesOurUi(mutation: MutationRecord): boolean {
    if (mutation.type !== 'childList') return false;
    return [...mutation.removedNodes].some(
      (node) => node instanceof Element && (
        node.matches(dependencies.ownUiSelector)
        || Boolean(node.querySelector(dependencies.ownUiSelector))
      ),
    );
  }

  /**
   * 这次变动有没有「把一条消息建出来」。（上游的 `mutationMayAffectRestoredMessageTarget`。）
   *
   * ⚠️⚠️ **三种都要判，缺一条就有哑等风险**：
   * - `childList`：消息节点被**新建**（最常见）；
   * - `characterData`：正文在长（消息刚出现时的形态）；
   * - **`attributes`（只看 `class`）**：`message-<uuid>` 锚点**迟到到既有的 wrapper 上** ——
   *   这条**不产生任何新节点**，只改 `class`。⚠️ 它是「有锚点的记录禁用兜底腿」
   *   （`resolveTarget` 的 `record.messageId` 那一判）引入的新等待窗口：
   *   那条记录在等「自己那条消息**带锚点地**出现」，而页面完全可能先建 wrapper、
   *   后挂类 ⇒ 只盯 `childList` 时**永远唤不醒它**（重试预算耗尽后停表）。
   */
  function mutationAddsMessage(mutation: MutationRecord): boolean {
    if (mutation.type === 'attributes') {
      return nodeIsOrContainsMessage(mutation.target);
    }
    if (mutation.type === 'characterData') {
      return nodeIsOrContainsMessage(mutation.target);
    }
    return [...mutation.addedNodes].some(nodeIsOrContainsMessage);
  }

  function nodeIsOrContainsMessage(node: Node): boolean {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return false;
    // 我们自己的 UI 里不会长出消息来 —— 排除掉，免得自己挂的块触发自己重扫。
    if (element.closest(dependencies.ownUiSelector)) return false;
    return element.matches(dependencies.messageSelector)
      || Boolean(element.closest(dependencies.messageSelector))
      || Boolean(element.querySelector(dependencies.messageSelector));
  }

  function stop(): void {
    observer?.disconnect();
    observer = null;
    observerScheduled = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    attempts = 0;
    records.clear();
    pending.clear();
  }

  return {
    remember,
    renderPending,
    sealLive,
    clearAll,
    retainRecords,
    start,
    stop,
    snapshot: () => ({ records: records.size, pending: pending.size }),
  };
}

/** 归一化文本（去空白）—— 片段比对与上游同口径。 */
function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, '');
}