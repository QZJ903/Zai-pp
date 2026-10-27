/**
 * **工具面板的装配**：把 `core/ui/` 的三个注入式模块接到 z.ai 的真实页面与 runtime 上。
 *
 * ## 它管的四件事
 *
 * | 来源 | 何时到达 | 有锚点 | 有真结果 | 角色 |
 * |---|---|---|---|---|
 * | **L1 实时** | 执行工具时 | ✅ 最后一条消息 | ✅ 内存里有 | 当场就能看见面板 |
 * | **L2 存储** | 刷新 / 打开会话 | ❌ | ✅ | 补上真结果 |
 * | **L3 历史** | 页面拉 `messages/batch` 时 | ✅ 消息 uuid | ❌ | 提供锚点 |
 * | **64 收尾** | 请求终态 | — | — | 把「执行中」那行收成失败 |
 *
 * ⚠️⚠️ **L2 与 L3 必须合流**（见 `core/ui/tool-block-restore.ts` 的说明）：
 * storage 腿没有消息 id，单独渲染不出；history 腿没有真实结果，单独渲染只有工具名。
 *
 * ## 本模块是**内容脚本侧**（隔离世界）
 *
 * 依赖注入的方向：本模块 → `core/ui/*`（纯 DOM）与 `core/zai/tool-block-adapter.ts`
 * （站点事实），**不反向**。runtime 调用留在 `entrypoints/zai.content.ts`（命令字面量
 * 必须在内容脚本里，`tests/runtime-boundary.test.ts` 用 AST 抓它们）。
 */

import type { ToolCardResult, ToolExecutionRecord } from '../types';
import { createLatestSyncGate } from '../tool/latest-sync';
import { sleep } from './async';
import {
  appendToolBlockToMessage,
  applyBlockCollapseDefault,
  createToolBlockShell,
  findToolBlock,
  findToolBlockInMessage,
  retargetToolBlockKey,
  injectToolBlockStyles,
  removeToolBlock,
  updateToolBlockContent,
  type ToolBlockDependencies,
} from '../ui/tool-block';
import {
  createToolBlockRestoreController,
  type ToolBlockRestoreController,
  type ToolBlockRestoreRecord,
} from '../ui/tool-block-restore';
import { hasPendingAction } from '../ui/tool-result-renderer';
import {
  ZAI_ASSISTANT_MESSAGE_SELECTOR,
  ZAI_INJECTED_UI_SELECTOR,
  formatZaiToolDetail,
  formatZaiToolStatus,
  getZaiMessageOwnText,
  listZaiAssistantMessages,
  messageCarriesZaiAnchorId,
  readZaiMessageId,
  resolveZaiResponseHost,
  type ToolBlockStatusLabels,
  type ToolBlockTitleFormatter,
} from './tool-block-adapter';

/** 一条存储腿记录的来源形状（`zai_pp_tool_history` 的 `ToolCallHistoryRecord`）。 */
export interface ToolHistoryRecordLike {
  id: string;
  call: {
    /** 执行时算出的稳定调用 id（`xml:<hash>`）—— 合流去重的首选键。 */
    id?: string;
    name: string;
    raw?: string;
    source?: {
      chatSessionId?: string | null;
      /**
       * 执行那一刻所属的**助手消息 uuid**（`ToolCallSource.assistantMessageId`）。
       *
       * ⚠️ 它是**存储腿自带的锚点** —— 有它就能直接挂到那条消息上、
       * 不必等历史腿来合流（上游 `metadata.assistantMessageId` 同义）。
       */
      assistantMessageId?: string;
    };
  };
  result: ToolCardResult;
  createdAt: number;
}

/** 一条历史腿记录（过桥之后的形状）。 */
export interface HistoryToolRecordLike {
  messageId: string;
  parentMessageId: string | null;
  content: string;
  calls: { name: string; raw: string }[];
}

export interface ToolPanelDependencies {
  /** 状态文案（按当前 locale）。 */
  statusLabels: () => ToolBlockStatusLabels;
  /** 标题文案（按当前 locale）。 */
  formatTitle: ToolBlockTitleFormatter;
  /** 详情渲染器（能画卡片就画，返回 false 退回纯文本）。 */
  renderDetail?: ToolBlockDependencies['renderDetail'];
  /** 取当前会话 id。 */
  getChatSessionId: () => string | null;
  /** 拉一次存储腿记录。**失败返回空数组**（调用方吞掉错误）。 */
  loadToolHistory: () => Promise<readonly ToolHistoryRecordLike[]>;
  /** 取观察根（页面重建我们节点时的判据）。 */
  observeRoot: () => Element | null;
  /**
   * 重试间隔（缺省 250ms）。**只为测试注入** —— 真机上 250ms 是与「页面重建 DOM
   * 需要多久」相称的值，缩短会让重试在 DOM 就绪之前就把次数耗光。
   */
  retryDelayMs?: number;
  document?: Document;
}

export interface ToolPanelController {
  /** 装：注入样式 + 启动恢复编排 + 拉一次存储腿。 */
  install: () => Promise<void>;
  /** 卸。 */
  dispose: () => void;
  /** 接收历史腿记录（来自 `HISTORY_TOOL_RECORDS` 桥消息）。 */
  rememberHistoryRecords: (
    records: readonly HistoryToolRecordLike[],
    chatSessionId: string | null,
  ) => void;
  /**
   * 某个工具**开始执行** —— 往面板里塞一行「执行中」。
   *
   * ⚠️ **这是 64 的落点**：没有它，「执行中」这个视觉状态根本不存在，
   * 而请求中断时就无从「把那一行收成失败」。
   * ⚠️ **`raw` 要传**（调用点手里有 `detected.raw`）—— 它是合流签名的一半，
   * 不传的话实时腿与历史腿永远配不上（见 `LiveSession.rawByCallId`）。
   */
  beginToolCall: (
    requestId: string,
    call: { callId: string; name: string; raw?: string },
  ) => void;
  /**
   * **只登记 `raw`、不画行** —— 给「兜底执行路径」用。
   *
   * ⚠️⚠️ **为什么需要它**：原生轮那条兜底路（`handleResponseComplete` 里
   * `executionsByRequest` 为空时现场 `executeDetected`）**刻意不调 `beginToolCall`**
   * —— 那时这一轮已经快结束，塞一行「执行中」只会给用户一个稍纵即逝的闪烁。
   * 但 `raw` 是**合流签名的一半**，只有 `beginToolCall` 会写 `rawByCallId`
   * ⇒ 那条路上实时腿的签名恒为「工具名 + 空串」，**与历史腿永远配不上**
   * ⇒ **同一轮画两块面板**（一块有结果、一块没有）。
   * ⇒ 把「画不画 pending 行」与「登记不登记 raw」**解耦**。
   */
  noteToolCallRaw: (requestId: string, call: { callId: string; raw: string }) => void;
  /** 某个工具执行完了 —— 把「执行中」那行换成真实结果。 */
  completeToolCall: (requestId: string, execution: ToolExecutionRecord) => void;
  /**
   * 一轮的最终结果批量落地（`RESPONSE_COMPLETE` 时调）。
   *
   * ⚠️ 与 `completeToolCall` 是**互补**的两条路：那条靠 `TOOL_CALL` 通道逐条到达，
   * 这条路在轮次收尾时把 `executionsByRequest` 的整体结果对一遍 ——
   * fetch-hook 只发 `RESPONSE_COMPLETE` 而没发 `TOOL_CALL` 时，只有这条路能补上。
   */
  rememberExecutions: (
    requestId: string,
    executions: readonly ToolExecutionRecord[],
    fullText: string,
  ) => void;
  /**
   * 64：把该请求下所有「执行中」的行收成失败（请求终态时调）。
   */
  finalizePending: (requestId: string, failureSummary: string, message: string) => void;
  /**
   * **一轮结束了** —— 把该轮的块收起来（`RESPONSE_COMPLETE` / `REQUEST_TERMINAL` 时调）。
   *
   * ⚠️⚠️ **与 `finalizePending` 是两个不同的收尾**，两个都要调：那个管「执行中」
   * 那一行的状态，这个管**块的折叠态**。
   * ⚠️ **不调它的后果**：一轮跑完那一大块一直摊着，跑 N 轮就是 N 大块全展开
   * （真机截图里 3 轮 = 3 大块）—— 而正确形态是 **N 行块头**。
   */
  sealTurn: (requestId: string) => void;
  /**
   * **换会话了** —— 丢掉旧会话的全部记录，重新拉一次存储腿。
   *
   * ⚠️⚠️ **必须接**（`zai.content.ts` 的 `onZaiSessionChange`）：不接的话旧会话的
   * 工具记录会挂到新会话的消息上（真机实测：切过会话后旧会话的
   * shell_status 之类出现在新会话里）。
   * 这里与 `resolveTarget` 的会话判据是**两道**：那条挡「挂错」，这条挡「留着」。
   */
  handleSessionChange: () => void;
  /** 全部 drain（生命周期拆除时调）。 */
  finalizeAllPending: (failureSummary: string, message: string) => void;
  /** 当前面板快照（测试用）。 */
  snapshot: () => { records: number; pending: number; livePending: number };
}

/** 实时面板的「本轮」容器 —— 一次请求对应一块。 */
interface LiveSession {
  executions: ToolExecutionRecord[];
  content: string;
  createdAt: number;
  /** 「执行中」的行：callId → 该行在 `executions` 里的位置（按 key 定位，不存索引）。 */
  pendingCallIds: Set<string>;
  /**
   * 这一轮投出去过的**块 id**（收尾时靠它找该收哪些块）。
   *
   * ⚠️ **是个集合而不是单值**：一轮里消息 id 可能从「拿不到」变成「拿到了」
   * （页面先建 wrapper 才给 `message-<uuid>` 类）⇒ 同一轮先后用过
   * `live:<requestId>` 与 `history:<uuid>` 两个 id，两个都得收。
   */
  recordIds: Set<string>;
  /**
   * callId → 该次调用的 **XML 原文**。
   *
   * ⚠️⚠️ **必须带上**：投给编排层的记录里 `calls[].raw` 参与**合流签名**
   * （`signatureOf` = 工具名 + XML 原文）。不带的话实时腿的签名恒为
   * `shell_exec\n`（空 raw），与历史腿的 `shell_exec\n<shell_exec>…` **永远配不上**
   * ⇒ 平时只是靠「两条腿 id 恰好相同」走 refresh 那条路在掩盖问题；
   * 一旦 `readZaiMessageId` 那一刻返回 null（id 退化成 `live:<requestId>`），
   * 两条腿 id 不同、签名又不匹配 ⇒ **同一轮画两块面板**（一块有结果、一块没有）。
   */
  rawByCallId: Map<string, string>;
}

export function createToolPanelController(
  dependencies: ToolPanelDependencies,
): ToolPanelController {
  /**
   * 「这一块画的是**真实结果**，不是按工具名合成的摘要」标记。
   *
   * ⚠️⚠️ **没有它，刷新后面板会退化成只有「已执行」** —— 历史腿的记录 `executions`
   * 恒空、且重投递远比存储腿频繁（每次 `messages/batch` 一批），
   * 用它的空结果重画就会把存储腿带进来的真结果覆盖掉。
   */
  const RICH_CONTENT_ATTR = 'data-zpp-tool-rich';

  /**
   * **本页面会话内收尾过的记录 id** —— 「有按钮就保持展开」只对这些生效。
   *
   * ⚠️⚠️ **它是「刷新后不展开」的关键**：刷新页面 / 切会话时这个 Set 是空的，
   * 从历史 / 存储恢复的记录一个都不在里面 ⇒ 一律按 `collapsedByDefault` 收起；
   * 而「刚刚跑完那一轮」的记录在里面 ⇒ 若还有没点过的按钮就保持展开（用户口径）。
   * ⚠️ **不落库、不进桥** —— 页面重载即归零，这正是想要的语义。
   * ⚠️ 换会话要清（见 `handleSessionChange`），否则旧会话的 id 会误命中。
   */
  const sealedThisSessionIds = new Set<string>();

  const blockDeps: ToolBlockDependencies = {
    resolveHost: resolveZaiResponseHost,
    listMessages: () => listZaiAssistantMessages(dependencies.document ?? document),
    formatStatus: (execution) => formatZaiToolStatus(execution, dependencies.statusLabels()),
    formatDetail: formatZaiToolDetail,
    renderDetail: dependencies.renderDetail,
    // ⚠️ **「还有没点过的按钮」由渲染层回答**（本模块不认识任何渲染器）——
    // 它是「有按钮就保持展开、点过就收起」那条口径的判据。
    detailHasAction: hasPendingAction,
    document: dependencies.document,
  };

  const restore: ToolBlockRestoreController = createToolBlockRestoreController({
    listMessages: () => listZaiAssistantMessages(dependencies.document ?? document),
    getMessageOwnText: getZaiMessageOwnText,
    resolveHost: resolveZaiResponseHost,
    render: (record, message) => renderRecord(record, message),
    ownUiSelector: `${ZAI_INJECTED_UI_SELECTOR}, .zpp-tool-block`,
    // ⚠️ **「比锚点」与「抽锚点」同源**（见 `messageCarriesAnchorId` 的说明）。
    messageCarriesAnchorId: messageCarriesZaiAnchorId,
    // ⚠️ **observer 的另一半**：重试预算耗尽后靠「消息刚被建出来」把记录救回来
    // （见 `tool-block-restore.ts` 的 `start()`）。
    messageSelector: ZAI_ASSISTANT_MESSAGE_SELECTOR,
    observeRoot: dependencies.observeRoot,
    // ⚠️ **兜底定位腿的会话判据**（见 `ToolBlockRestoreDependencies.getChatSessionId`）——
    // 它读「此刻」的地址栏，而记录里冻结的是创建时的值。
    getChatSessionId: dependencies.getChatSessionId,
    // ⚠️ **要真的往下传** —— 声明了却不传是个「看着能调、实际无效」的注入点
    // （测试里压到 1ms 才够得到重试那条路；生产用默认 250ms）。
    retryDelayMs: dependencies.retryDelayMs,
  });

  /** 实时面板：requestId → 本轮的执行收集。 */
  const liveSessions = new Map<string, LiveSession>();

  /**
   * 存储腿读取的「只有最新一次生效」闸门。
   *
   * ⚠️⚠️ **重试引入了新的并发面**：`install()` 与换会话都会调 `loadStorageLeg`，
   * 而重试把一次读取拉长到 250ms+。期间新的一次读取可能已经落地，
   * 不作废的话旧那次会把它**覆盖回旧会话的记录**。
   * ⚠️ `dispose()` 也要 `begin()` 一次 —— 卸载之后落在重试里的那次
   * `restore.remember` 会把块重新挂回新 DOM（测试会跨用例污染）。
   */
  const storageLegGate = createLatestSyncGate();
  /** 存储腿最多读几次（首次 + 一次重试）。 */
  const STORAGE_LEG_ATTEMPTS = 2;
  /** 重试前的等待 —— 与编排层的重试间隔同值（生产 250ms，测试注入 1ms）。 */
  const DEFAULT_STORAGE_LEG_RETRY_MS = 250;

  function getOrCreateSession(requestId: string): LiveSession {
    const existing = liveSessions.get(requestId);
    if (existing) return existing;
    const session: LiveSession = {
      executions: [],
      content: '',
      createdAt: Date.now(),
      pendingCallIds: new Set(),
      recordIds: new Set(),
      rawByCallId: new Map(),
    };
    liveSessions.set(requestId, session);
    return session;
  }

  /** 把一轮的当前状态同步进恢复编排（它负责挂载与重挂）。 */
  function publishLiveSession(requestId: string): void {
    const session = liveSessions.get(requestId);
    if (!session || session.executions.length === 0) return;
    const messages = listZaiAssistantMessages(dependencies.document ?? document);
    const lastMessage = messages[messages.length - 1];
    const messageId = lastMessage ? readZaiMessageId(lastMessage) : null;
    // ⚠️ **id 用 messageId 优先**（与历史腿同 id ⇒ 天然合流、幂等）；
    // 拿不到时退回 requestId（当场仍然能挂，只是刷新后合不上）。
    const recordId = messageId ? `history:${messageId}` : `live:${requestId}`;
    // ⚠️ **记下来**：收尾时（`sealTurn`）要靠它找到该收哪些块。
    // 一轮里消息 id 可能从「拿不到」变成「拿到了」⇒ 两个 id 都留着。
    session.recordIds.add(recordId);
    restore.remember([{
      id: recordId,
      source: 'history',
      messageId,
      parentMessageId: null,
      content: session.content,
      // ⚠️⚠️ **raw 必须带上**（见 `LiveSession.rawByCallId`）：它是合流签名的一半。
      // 写死空串时实时腿的签名恒为 `工具名\n`，与历史腿永远配不上。
      calls: session.executions.map((execution) => ({
        name: execution.name,
        raw: (execution.callId ? session.rawByCallId.get(execution.callId) : undefined) ?? '',
      })),
      executions: [...session.executions],
      // ⚠️⚠️ **这一轮此刻还在飞** ⇒ 块展开（用户当场要看见在跑什么）。
      // 收尾时由 `sealTurn` 清掉，块随之收起 —— 上游同口径。
      live: true,
      // ⚠️ 会话归属取「此刻」的地址栏。首条消息时可能还是 null（地址栏还没切到
      // `/c/<id>`），那时按「不知道」放行；后续同一轮的投递会补上。
      chatSessionId: dependencies.getChatSessionId(),
      createdAt: session.createdAt,
    }]);
  }

  /**
   * 某个工具开始执行 —— 塞一行「执行中」。
   *
   * ⚠️ **判重按 `callId`**：`TOOL_CALL` 通道与 `RESPONSE_COMPLETE` 的兜底解析
   * 都可能到达（两条通道各有防重复执行，但那是在执行层；这里是展示层，
   * 同一 `callId` 出现两次不该画两行）。
   *
   * ⚠️ **`raw` 是合流签名的一半**（见 `LiveSession.rawByCallId`）——
   * 调用点手里就有 `detected.raw`（`callId` 本来就是它的哈希算出来的），
   * 不传的话实时腿与历史腿永远配不上。
   */
  function beginToolCall(
    requestId: string,
    call: { callId: string; name: string; raw?: string },
  ): void {
    const session = getOrCreateSession(requestId);
    if (call.raw) session.rawByCallId.set(call.callId, call.raw);
    if (session.pendingCallIds.has(call.callId)) return;
    if (session.executions.some((execution) => execution.callId === call.callId)) return;
    session.pendingCallIds.add(call.callId);
    session.executions = [
      ...session.executions,
      {
        callId: call.callId,
        pending: true,
        name: call.name,
        // ⚠️ `ok: true` —— 「还没失败」。是 `pending` 那个标记让它显示成「执行中」
        // （见 `formatZaiToolStatus`）。
        result: { ok: true, summary: dependencies.statusLabels().running },
      },
    ];
    publishLiveSession(requestId);
  }

  /**
   * 只登记 `raw`、不画「执行中」行 —— 给原生轮的兜底执行路径用（见接口上的说明）。
   *
   * ⚠️ **不调 `publishLiveSession`** —— 那条路的语义是「这一轮快结束了，别给用户
   * 塞一个稍纵即逝的状态」；登记 raw 只影响**未来**的合流签名，不影响此刻的渲染。
   */
  function noteToolCallRaw(requestId: string, call: { callId: string; raw: string }): void {
    if (!call.callId || !call.raw) return;
    getOrCreateSession(requestId).rawByCallId.set(call.callId, call.raw);
  }

  /**
   * 执行完了 —— 用真实结果替换那一行。
   *
   * ⚠️⚠️ **匹配要按 callId、失败时退回按名字（在 pending 行里找）** ——
   * 两边的 callId 计算口径不同：`beginToolCall` 用的是
   * **`TOOL_CALL` 消息里的原始 XML**，而执行完那条是 `executeDetected` 里
   * **解析后的 `call.raw` 的哈希**。两者在正常形状下相等，但
   * 「解析器重扫一遍」这个前提不该被当成契约（`findZaiToolXmlBlocks` 允许
   * `< name >` 这种带空格的形态，两侧对同一段的切片可能差一个字符）。
   * **只按 callId 匹配的失效方向是「多出一行重复的」**（pending 那行没人替换），
   * 而用户看到的会是「同一个工具显示两遍、一条永远转圈」。
   */
  function completeToolCall(requestId: string, execution: ToolExecutionRecord): void {
    const session = liveSessions.get(requestId);
    if (!session) return;
    const callId = execution.callId ?? '';

    let index = callId
      ? session.executions.findIndex((item) => item.callId === callId)
      : -1;
    if (index < 0) {
      // 退回按名字找**还没完成的那一行**（`pending === true`）。
      // ⚠️ **只找 pending 的** —— 否则会把「上一次同名工具的已完成行」覆盖掉。
      index = session.executions.findIndex(
        (item) => item.pending === true && item.name === execution.name,
      );
    }

    if (index >= 0) {
      const previousCallId = session.executions[index].callId ?? '';
      if (previousCallId) session.pendingCallIds.delete(previousCallId);
      session.executions = [
        ...session.executions.slice(0, index),
        execution,
        ...session.executions.slice(index + 1),
      ];
    } else {
      // 没有对应的「执行中」行（`TOOL_CALL` 先于任何 begin 到达）⇒ 直接追加。
      session.executions = [...session.executions, execution];
    }
    publishLiveSession(requestId);
  }

  /**
   * 渲染一条记录（**已挂过就原地更新，没有才新建**）。
   *
   * ⚠️ **这个判断放在这里而不是编排层** —— 编排层只负责「哪条记录该挂哪条消息」，
   * 而「这条记录在页面上有没有块、块还连着没」是 DOM 知识，属于本模块。
   */
  function renderRecord(record: ToolBlockRestoreRecord, message: Element): boolean {
    // ⚠️⚠️ **块的 DOM 键按「锚点」归一，不按记录 id** —— 两条腿的 id 天生不同
    // （`history:<uuid>` / `storage:<hash>`），合流失败时用各自的 id 去找块必然
    // 都找不到 ⇒ 在同一个宿主里**叠出两块面板**（真机症状：同一条回答上下两个
    // 「已调用工具」，上面那块只有工具名、下面那块才有真结果）。
    // 有锚点时统一用 `history:<uuid>`（历史腿的天然 id）当块键 ⇒ 两条腿落到同一块。
    const blockKey = record.messageId ? `history:${record.messageId}` : record.id;
    // ① 按块键找（两条腿共用一个键 ⇒ 正常合流后的重复投递都能命中）
    // ② 退回按记录 id 找（块键归一之前的旧块）
    // ③ 🔴 **最后按「这条消息里有没有我们一块」兜底** —— ①② 都按 key 找，而合流失败时
    //    两条腿的 key 就是不同 ⇒ 都命中不了，于是往同一个宿主里追加第二块
    //    （真机症状：同一条回答上下两个「已调用工具」）。
    const existing = findToolBlock(blockKey, blockDeps)
      ?? findToolBlock(record.id, blockDeps)
      ?? findToolBlockInMessage(message, blockDeps);
    const executions = record.executions.length > 0
      ? record.executions
      : summarizeCalls(record);
    if (executions.length === 0) return true;

    if (existing && existing.isConnected) {
      // ⚠️ **块键要跟着归一，且必须排在下那个早退之前** —— 兜底命中的那一块带着
      // 另一条腿的 key（`live:<requestId>` / `storage:<hash>`）。不归一的话
      // 「谁接管了这块」这件事在 DOM 上永远看不出来，且每次投递都要重新走兜底。
      retargetToolBlockKey(existing, blockKey);
      // ⚠️⚠️ **没有真实结果的一方不许覆盖已有内容** —— 历史腿的记录 `executions` 恒空
      // （只有工具名），而它的重投递比存储腿更频繁（每次 `messages/batch` 一批）。
      // 覆盖回去的表现是「刷新后面板又退回只有『已执行』、真结果没了」。
      if (record.executions.length === 0 && existing.getAttribute(RICH_CONTENT_ATTR) === 'true') {
        applyBlockCollapseDefault(existing, record.live !== true, sealedThisSessionIds.has(record.id));
        return true;
      }
      // ⚠️ **已挂过的块也要跟着 `live` 走** —— 收尾（`sealLive`）之后重画，
      // 这一步就是把「展开」改成「收起」的地方。不在这里同步的话，
      // 块会一直保持第一次挂上去时的折叠态（`sealLive` 就白调了）。
      updateToolBlockContent(existing, executions, blockDeps, dependencies.formatTitle);
      existing.setAttribute(RICH_CONTENT_ATTR, record.executions.length > 0 ? 'true' : 'false');
      applyBlockCollapseDefault(existing, record.live !== true, sealedThisSessionIds.has(record.id));
      return true;
    }
    if (existing) removeToolBlock(existing);

    // ⚠️⚠️ **块级折叠态三条判据见 `applyBlockCollapseDefault`**：用户亲手开合过 >
    // （本页面会话内刚收尾**且**还有没点过的按钮）> 「在飞展开、收尾 / 恢复收起」。
    // ⚠️ 只按 `live` 是 2.15.39 的缺陷 —— 一轮跑完那一大块一直摊着，跑 N 轮就是 N 大块全展开。
    // ⚠️ 第二档靠 `sealedThisSessionIds`：它只装「**本页面会话内**收尾过」的记录 ⇒
    // **刷新页面 / 切会话后是空集**，那时带按钮的块也一律收起（用户口径）。
    const block = createToolBlockShell(blockDeps, {
      restoreKey: blockKey,
      collapsed: record.live !== true,
    });
    updateToolBlockContent(block, executions, blockDeps, dependencies.formatTitle);
    block.setAttribute(RICH_CONTENT_ATTR, record.executions.length > 0 ? 'true' : 'false');
    applyBlockCollapseDefault(block, record.live !== true, sealedThisSessionIds.has(record.id));
    const appended = appendToolBlockToMessage(message, block, blockDeps);
    if (!appended) {
      // 宿主还没渲染出来 ⇒ 把壳撤掉，让编排层下一轮重试（留着会变成游离节点）。
      removeToolBlock(block);
      return false;
    }
    return true;
  }

  /**
   * 历史腿没有真实结果 ⇒ 按工具名给一行「已执行」的摘要。
   *
   * ⚠️ **刻意不假装有结果**：上游会按 payload 反推细节文本，但那条路要靠
   * 「解析每个工具的入参语义」，每个内置工具一条分支，加一个工具就要加一条
   * ⇒ 那是**会长出来的一坨判断**。这里只给「工具名 + 已执行」，
   * 有真结果时（L2 合流成功）自然显示真结果。
   */
  function summarizeCalls(record: ToolBlockRestoreRecord): ToolExecutionRecord[] {
    const labels = dependencies.statusLabels();
    return record.calls.map((call) => ({
      name: call.name,
      result: { ok: true, summary: labels.executed },
    }));
  }

  async function install(): Promise<void> {
    injectToolBlockStyles(blockDeps);
    restore.start();
    await loadStorageLeg();
  }

  function dispose(): void {
    // ⚠️ **作废在飞的重试** —— 否则卸载后落在重试里的那次 `remember` 会把块挂回新 DOM。
    storageLegGate.begin();
    restore.stop();
    liveSessions.clear();
  }

  /**
   * 拉一次存储腿（L2），按会话过滤后交给编排层。
   *
   * ⚠️ **按会话过滤的判据是 `call.source.chatSessionId`** —— 它由执行当时的
   * `executeDetected` 写入（授权的会话 / requestId 映射 / 地址栏三级回退），
   * 是**唯一**能把记录归到某条会话上的字段（记录里没有消息 id）。
   * ⚠️ **取不到当前会话时整批丢弃**：宁可不显示，也不要「把别的会话的工具
   * 挂到当前会话的消息上」。
   *
   * ⚠️⚠️ **读取失败要重试一次** —— 这条链只在 `install()` 与换会话时各跑一次，
   * 而失败是**静默**的（读不到就只剩历史腿，面板退化成「工具名 + 已执行」、
   * 没有详情、没有「保存 / 导入」按钮）。启动那一刻正是最挤的窗口
   * （页面刚刷新、后台可能正在冷启动、`messages/batch` 同时在打）。
   *
   * ⚠️ **两次尝试之间用 `createLatestSyncGate` 作废** —— 重试是异步的，
   * 期间可能已经换过会话（`handleSessionChange` 会再拉一次）或被卸载；
   * 不作废就会把**旧会话**的记录塞进新会话的表里。
   */
  async function loadStorageLeg(): Promise<void> {
    const lease = storageLegGate.begin();
    const chatSessionId = dependencies.getChatSessionId();
    if (!chatSessionId) return;

    let history: readonly ToolHistoryRecordLike[] | null = null;
    for (let attempt = 0; attempt < STORAGE_LEG_ATTEMPTS; attempt += 1) {
      try {
        history = await dependencies.loadToolHistory();
        break;
      } catch (error) {
        if (attempt + 1 >= STORAGE_LEG_ATTEMPTS) {
          // ⚠️ 两次都失败 ⇒ 与改造前一致：静默降级（历史腿仍能把面板画出来）。
          console.log('[Zai++] tool history read failed twice; keeping the history leg only', error);
          return;
        }
        await sleep(dependencies.retryDelayMs ?? DEFAULT_STORAGE_LEG_RETRY_MS);
      }
    }
    // ⚠️ **这行是类型收窄 + 防御，当前不可达** —— 两次都失败时最后一次尝试已经
    // 在 catch 里 return 了，所以走到这里时 `history` 必然非 null。
    // **别为它写用例**（写不出来），也别删（删了 `for…of` 就对着 `null` 编译不过）。
    if (!history) return;

    const records: ToolBlockRestoreRecord[] = [];
    for (const item of history) {
      if (item.call?.source?.chatSessionId !== chatSessionId) continue;
      records.push({
        id: storageRecordId(item),
        source: 'storage',
        // ⚠️⚠️ **存储腿自带锚点**（`ToolCallSource.assistantMessageId`，执行那一刻
        // 从页面读到的助手消息 uuid）—— 有它就能直接挂到那条消息上，
        // **不必等历史腿来合流**（上游 `metadata.assistantMessageId` 同义）。
        // ⚠️ 读不到那一刻的 uuid 时是 null ⇒ 退回老路（靠签名与历史腿合流）。
        messageId: item.call?.source?.assistantMessageId ?? null,
        parentMessageId: null,
        content: '',
        calls: item.call.raw ? [{ name: item.call.name, raw: item.call.raw }] : [],
        executions: [{
          // ⚠️⚠️ **必须带上 `callId`** —— 合流做的是「并集」，而去重键优先用它。
          // 不带的话退化成「名字 + 摘要」，而**同一个工具多次调用的摘要是相同的**
          // （`shell_exec` 三次都是「MCP 工具已执行」）⇒ 三次执行会被当成一次合并掉，
          // 正是「用了好几次工具、刷新后只显示一次」那个缺陷的另一半。
          callId: item.call.id,
          name: item.call.name,
          result: item.result,
        }],
        // ⚠️ **会话归属就是上面那个过滤判据** —— 这批记录本来就是按它筛出来的。
        chatSessionId,
        createdAt: item.createdAt,
      });
    }
    if (records.length === 0) return;
    // ⚠️ **落地前再验一次** —— 重试那 250ms 里会话可能已经换了，那批记录不再属于当前会话。
    lease.commit(() => restore.remember(records));
  }

  /**
   * 存储腿记录的稳定 id。
   *
   * ⚠️ **必须由内容决定**（不能用每次生成的 uuid）：同一条历史会被反复读回来，
   * 每次新 id 会让编排层认为「又来了一条新记录」、反复重挂。
   */
  function storageRecordId(item: ToolHistoryRecordLike): string {
    return `storage:${hashString(`${item.call.name}\n${item.call.raw ?? ''}\n${item.createdAt}`)}`;
  }

  function rememberHistoryRecords(
    records: readonly HistoryToolRecordLike[],
    chatSessionId: string | null,
  ): void {
    const mapped: ToolBlockRestoreRecord[] = records.map((record) => ({
      // ⚠️ **id 由 messageId 决定**：同一个消息会被反复拉回来，用 messageId 做 id
      // 天然幂等；同一条消息里的多个工具块合成一条记录（它们同属一次回答）。
      id: `history:${record.messageId}`,
      source: 'history',
      messageId: record.messageId,
      parentMessageId: record.parentMessageId,
      content: record.content,
      calls: record.calls,
      executions: [],
      // ⚠️ **会话归属来自请求 URL**（主世界从 `/api/v1/chats/<id>/…` 读出）——
      // 兜底定位腿靠它拒掉「别的会话的记录」（真机实测的错挂场景）。
      chatSessionId,
      createdAt: Date.now(),
    }));
    restore.remember(mapped);
  }

  /**
   * 一轮的最终结果批量落地（`RESPONSE_COMPLETE` 时调）。
   *
   * ⚠️ **与 `completeToolCall` 互补**：那条靠 `TOOL_CALL` 通道逐条到达；
   * 这条路在轮次收尾时把整体结果对一遍 —— fetch-hook 只发 `RESPONSE_COMPLETE`
   * 而没发 `TOOL_CALL` 时（兜底执行那条路），只有这里能补上。
   * ⚠️ **整体替换而不是合并**：传进来的就是这一轮的权威结果数组，
   * 「执行中」那几行如果已经不在里面，说明它们已经被 `finalizePending` 成失败了。
   */
  function rememberExecutions(
    requestId: string,
    executions: readonly ToolExecutionRecord[],
    fullText: string,
  ): void {
    if (executions.length === 0) return;
    const session = getOrCreateSession(requestId);
    session.content = fullText || session.content;
    // 保留仍是 pending 的行（它们代表着「开始了但这一轮没结果」），
    // 其余用新结果覆盖。
    const stillPending = session.executions.filter(
      (execution) => execution.pending === true
        && !executions.some((incoming) => incoming.callId === execution.callId),
    );
    session.executions = [...stillPending, ...executions];
    session.pendingCallIds = new Set(
      stillPending.map((execution) => execution.callId ?? '').filter(Boolean),
    );
    publishLiveSession(requestId);
  }

  /**
   * 64：把某个请求下所有「执行中」的行收成失败。
   *
   * ⚠️ **没有 pending 行时什么都不做** —— 这个函数在**每条**终态路径上都会被调
   * （`RESPONSE_COMPLETE` / `REQUEST_TERMINAL` / 生命周期拆除），绝大多数时候没有
   * pending 要收尾，为那种情况做处理只会引入无意义的写入。
   * ⚠️ **不改输入数组的引用**：收尾要产生一条**新**数组（原 pending 那几条被替换），
   * 原地改会让同一轮的其它消费者看到被改过的数组。
   */
  function finalizePending(requestId: string, failureSummary: string, message: string): void {
    const session = liveSessions.get(requestId);
    if (!session || session.pendingCallIds.size === 0) return;
    session.executions = session.executions.map((execution) => {
      if (execution.pending !== true) return execution;
      return {
        name: execution.name,
        callId: execution.callId,
        descriptorId: execution.descriptorId,
        provider: execution.provider,
        result: {
          ok: false,
          summary: failureSummary,
          detail: message,
          // ⚠️ `ToolError` 的这个字段**是必填的**（判「还能不能重试」）——
          // 漏掉它 tsc 就红。
          error: { code: 'tool_call_incomplete', message, retryable: false },
        },
      };
    });
    session.pendingCallIds.clear();
    publishLiveSession(requestId);
  }

  /** 全部 drain（生命周期拆除时调）—— 循环所有会话。 */
  function finalizeAllPending(failureSummary: string, message: string): void {
    for (const requestId of [...liveSessions.keys()]) {
      finalizePending(requestId, failureSummary, message);
    }
  }

  /**
   * 换会话了 —— 丢掉**不属于当前会话**的记录，重新拉一次存储腿。
   *
   * ⚠️⚠️ **不能一律清空** —— 会话通知是 1 秒轮询驱动的，页面刚加载时必然触发一次
   * 「假变化」（上一次通知的会话 id 初值是 null）；那一刻 `install()` 刚拉到的存储腿
   * 记录连同 `pending` 一起被清掉 ⇒ 面板只剩历史腿那份摘要（没有详情、没有保存按钮），
   * 而且**不会自愈**（存储腿只在这两处拉）。
   * ⇒ 判据用**记录自己冻结的 `chatSessionId`** 与当前会话严格相等：
   * 真换会话时旧记录一条都不匹配（与清空等价），假变化时全都留着。
   *
   * ⚠️ **拿不到当前会话 id 时退回 `clearAll`** —— 不知道不等于都属于当前会话。
   * ⚠️ **顺序是「先清、再拉」** —— 反过来的话，新拉到的记录会被紧接着的清空删掉。
   * ⚠️ **`liveSessions` 无条件清**：那是「本轮」的收集容器，它属于旧会话的那一轮；
   * 留着会让 `snapshot().livePending` 报出已经不存在的轮次。
   */
  function handleSessionChange(): void {
    const current = dependencies.getChatSessionId();
    if (current === null) restore.clearAll();
    else restore.retainRecords((record) => record.chatSessionId === current);
    liveSessions.clear();
    // ⚠️ **切会话等于「刷新页面」** —— 那个会话的块不该再保持展开（用户口径：
    // 只有「刚刚在这一次页面会话里跑完的那一轮」才可能因为按钮而展开）。
    sealedThisSessionIds.clear();
    void loadStorageLeg();
  }

  /**
   * 一轮结束了 —— 把该轮的块收起来。
   *
   * ⚠️⚠️ **顺序是承重的：先 `finalizePending` 再 `sealTurn`**。前者可能改
   * `executions`（把「执行中」那行换成失败）并重发一次记录，那一次重发会带着
   * `live: true` 把块重新画成展开；反过来的话收尾就被它顶掉了。
   * 调用点必须按这个顺序调两个函数（见 `zai.content.ts` 的收尾链）。
   *
   * ⚠️ **会话不从 `liveSessions` 删** —— 它还要被 `snapshot()` 读
   * （`livePending` 是 64 的判据）。这里只清折叠标记。
   */
  function sealTurn(requestId: string): void {
    const session = liveSessions.get(requestId);
    if (!session || session.recordIds.size === 0) return;
    // ⚠️ **先登记「这一轮在本页面会话内收尾过」**，再让编排层重画 ——
    // 重画时 `applyBlockCollapseDefault` 会按这个集合决定「还有没点过的按钮就保持展开」
    // （见 `sealedThisSessionIds`）。顺序反了的话那一刻集合还是空的，块会先收起。
    for (const id of session.recordIds) sealedThisSessionIds.add(id);
    restore.sealLive([...session.recordIds]);
  }

  return {
    install,
    dispose,
    rememberHistoryRecords,
    beginToolCall,
    noteToolCallRaw,
    completeToolCall,
    rememberExecutions,
    finalizePending,
    sealTurn,
    handleSessionChange,
    finalizeAllPending,
    snapshot: () => ({
      ...restore.snapshot(),
      livePending: [...liveSessions.values()].reduce(
        (total, session) => total + session.pendingCallIds.size,
        0,
      ),
    }),
  };
}

/** 与 `entrypoints/zai.content.ts` 的 `djb2Hash` 同算法（那边是私有的，这里要独立一份）。 */
function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}