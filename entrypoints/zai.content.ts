/**
 * Zai++ isolated-world content script（chat.z.ai）。
 *
 * 职责：
 * 1. 运行时状态同步：从后台拉记忆/技能/预设/工具描述符，推给 MAIN world 的 hook。
 * 2. 请求增广：completion + /chats/new 的 body 增强（记忆 + 工具目录 + 沙盒提示词），
 *    续跑请求透传不重灌。
 * 3. 工具执行中继：MAIN world 识别出的 XML 工具 → 后台 EXECUTE_TOOL_CALL。
 * 4. 续跑循环状态机：原生轮执行了可续跑工具 → 用 DOM 注入让页面自己发下一轮。
 */

import type {
  Memory,
  ToolCall,
  ToolCardResult,
  ToolDescriptor,
  ToolAuthorizationGrantSummary,
  ToolExecutionRecord,
  Skill,
  SystemPromptPreset,
  BackgroundConfig,
} from '../core/types';
import { buildPromptAugmentation } from '../core/prompt';
import { extractVisibleUserPrompt } from '../core/prompt/visibility';
import {
  DEFAULT_PROMPT_INJECTION_SETTINGS,
  normalizePromptInjectionSettings,
  shouldInjectPresetForTurn,
  type PromptInjectionSettings,
} from '../core/prompt/settings';
import {
  areMemoriesImported,
  isSkillDraftSaved,
} from '../core/ui/tool-result-saved-state';
import { LOCALE_READ_TIMEOUT_MS, getResolvedLocaleState } from '../core/i18n/store';
import {
  DEFAULT_LOCALE,
  translate,
  type SupportedLocale,
} from '../core/i18n/background';
import { parseSkillCommand } from '../core/skill/parser';
import {
  buildLocalSkillSystemContext,
  composeLocalSkillPrompt,
  isLocalIndexSkill,
  selectImplicitLocalSkill,
  resolveSkills,
  type AugmentationSkill,
} from '../core/interceptor/request-augmentation';
import {
  DEFAULT_SKILL_AUTO_ACTIVATION_SETTINGS,
  normalizeSkillAutoActivationSettings,
  type SkillAutoActivationSettings,
} from '../core/skill/auto-activation-settings';
import { filterZaiModelFacingToolDescriptors } from '../core/zai/model-facing';
import {
  applyZaiModelOverrideForRoute,
  parseZaiBody,
  parseZaiChatNewBody,
  readZaiCurrentUserMessageParentId,
  readZaiLastUserMessageText,
  rewriteZaiChatNewUserMessages,
  rewriteZaiLastUserMessage,
} from '../core/zai/request-codec';
import {
  CONTINUATION_RETRYABLE_REASONS,
  ZAI_CONTINUATION_LOOP_MISSING_CODE,
  ZAI_CONTINUATION_SEND_UNCONFIRMED_CODE,
  classifyAugmentRequest,
  classifyContinuationSendFailure,
  classifySendEvidence,
  type ContinuationSendOutcome,
  type ContinuationSendReason,
  type ZaiSendEvidence,
} from '../core/zai/send-evidence';
import {
  buildZaiContinuationPrompt,
  buildZaiMisuseNudgePrompt,
  buildZaiNudgePrompt,
  isZaiContinuationPrompt,
  shouldNudgeZai,
  ZAI_CONTINUATION_DELAY_MS,
  ZAI_INLINE_AGENT_MAX_NUDGES,
  ZAI_INLINE_AGENT_MAX_STEPS,
} from '../core/zai/continuation';
import { installContinuationBubbleHider } from '../core/zai/continuation-bubble';
import {
  createWaiterRegistry,
  waitForDomCondition,
  waitForNotified,
} from '../core/zai/event-wait';
import {
  ZAI_CONTENT_TO_MAIN,
  ZAI_MAIN_TO_CONTENT,
  decodeZaiHistoryToolRecordsMessage,
  decodeZaiHtmlChallengeMessage,
  decodeZaiRequestTerminalMessage,
  decodeZaiResponseCompleteMessage,
  decodeZaiToolCallMessage,
  isZaiBridgeMessage,
  type ZaiDetectedToolCall,
  type ZaiResponseCompletePayload,
} from '../core/zai/messages';
import { decodeZaiUsageSnapshot } from '../core/zai/stream-metrics';
import {
  applyBackground,
  isBackgroundActive,
  patchContainerBackgrounds,
} from '../core/zai/page-background';
import { readZaiChatSessionId } from '../core/zai/chat-session';
import { findZaiToolXmlBlocks } from '../core/zai/tool-xml';
import { isRuntimeFailure, RuntimeCommandError } from '../core/messaging/runtime-response';
import {
  BACKGROUND_RUNTIME_PATHNAMES,
  createExtensionRuntimeMessageContext,
  decodeRuntimeMessageEnvelope,
  RuntimeBoundaryError,
  type RuntimeMessageSenderLike,
} from '../core/messaging/runtime-boundary';
import {
  ZAI_CHAT_INPUT_SELECTOR as CHAT_INPUT_SELECTOR,
  ZAI_DOM_TASK_CANCELLED_CODE,
  ZAI_WEB_ORIGIN,
  resolveZaiSiteOrigin,
} from '../core/zai/contracts';
import { rememberActiveZaiSite } from '../core/zai/active-site';
import { sleep } from '../core/zai/async';
import { createSerialOperationQueue } from '../core/persistence/serial-operation-queue';
import { createToolInvocationCatalog } from '../core/tool/invocation';
import { createLatestSyncGate } from '../core/tool/latest-sync';
import { MCP_CAPABILITY_TOOL_PROVIDER_ID } from '../core/mcp/capability-contract';
import {
  registerDefaultToolResultRenderers,
  renderToolResultWithRegistry,
} from '../core/ui/tool-result-renderer';
import { injectInjectedThemeStyles, syncInjectedTheme } from '../core/ui/injected-theme';
import { initSkillPopup, stopSkillPopup } from '../core/ui/skill-popup';
import { wireSkillPopup } from '../core/ui/skill-popup-wiring';
import { disposeZaiCapabilities, installZaiCapabilities, installZaiSessionWatch, notifyZaiSessionChange, syncRuntimeStateBeforeUse } from '../core/zai/capability-install';
import { resolveZaiComposerInput, resolveZaiComposerShell } from '../core/zai/composer';
import {
  listZaiAssistantMessages,
  readZaiMessageId,
} from '../core/zai/tool-block-adapter';
import {
  createToolPanelController,
  type ToolHistoryRecordLike,
} from '../core/zai/tool-panel';
import {
  mergeZaiAuthFromCapture,
  readZaiUserIdFromToken,
} from '../core/zai/auth';

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let currentMemories: Memory[] = [];
let currentToolDescriptors: ToolDescriptor[] = [];
let currentCatalogNames: string[] = [];
let currentSkills: Skill[] = [];
let currentSkillAutoActivation: SkillAutoActivationSettings = DEFAULT_SKILL_AUTO_ACTIVATION_SETTINGS;
let currentActivePreset: SystemPromptPreset | null = null;
let currentPromptSettings: PromptInjectionSettings = DEFAULT_PROMPT_INJECTION_SETTINGS;
let currentContentLocale: SupportedLocale = DEFAULT_LOCALE;
let currentRequestMessageCount = 0;
/**
 * 收到的 `AUGMENT_REQUEST_BODY` 消息数（页面每发一次 completion / chats-new 请求 +1）。
 *
 * ⚠️ **这是两个发送链的判据，不是诊断**：
 * - `submitAutomationPromptViaPage`（自动化首条）靠它判断「请求到底发出去了没有」；
 * - `waitForSendEvidence`（续跑 / nudge）用它区分「桥通了但 body 不是续跑模板」
 *   与「桥挂了」—— 前者请求确实出去了，后者才该收尾。
 * **删它会同时打断这两条链。**
 * ⚠️ **自增点在 `dispatchMainWorldMessage` 的同步区（串行队列之外）** ——
 * 语义是「消息到了」，与那一次增广成功与否无关；而放进队列内会让续跑链自锁
 * （等它的代码自己就占着队列）。
 */
let observedAugRequestCount = 0;
/**
 * **等这两个计数器变化的唤醒者**（消费者是 `waitForNewAugRequest` / `waitForSendEvidence`，
 * 都走 `waitForNotified` + `augProgressWaiters`）。
 *
 * ⚠️⚠️ **为什么不能靠轮询读它们**：等它们的代码（`waitForNewAugRequest` /
 * `waitForSendEvidence`）跑在串行队列里，而后台标签的定时器被节流到每秒一次 ——
 * 5 秒证据窗口只剩 5 个采样点，而桥消息的真实延迟是几十毫秒级 ⇒ 采样太粗会让
 * 「确实发出去了」被判成 `ambiguous`，进而起看门狗、回收循环。
 *
 * ⚠️ **唤醒点必须在计数器自增的那一刻**（`dispatchMainWorldMessage` 的同步区），
 * 那个位置本来就在串行队列之外 —— 在队列内 notify 的话，被唤醒者自己占着队列，
 * 永远排不到 ⇒ 自锁（与那两个计数器必须写在队列外是同一条理由）。
 */
const augProgressWaiters = createWaiterRegistry();
/**
 * 自动化发送链最后一次致命错误的 kind（`no_textarea` / `form_not_connected` / `agent_not_idle`）。
 *
 * ⚠️ **这是失败码的来源，不是诊断** —— `submitDomTaskPrompt` 读它决定回给后台的 `error`，
 * 而 `RETRYABLE_PRE_SEND_ERRORS` 里那三个码决定后台**要不要自动重跑**。删了会让这些
 * pre-send 失败全部退化成 `composer_inject_failed`（不再重试），且**静默**。
 */
let lastAutomationSendErrorKind: string | null = null;
let extensionContextValid = true;
/**
 * requestId → 该请求已执行过的 toolCall 签名（防 TOOL_CALL 通道重复执行同一 XML）。
 *
 * ⚠️ **按 requestId 分桶**，而不是一个扁平 Set —— 签名里含 XML 原文（`local_file_write`
 * 的 content 上限 900KB），扁平结构既没法按请求释放、又会让每轮各留一份大串。
 * 释放见 `releaseRequestState`。
 */
const executedToolCallSignatures = new Map<string, Set<string>>();
/** requestId → chatSessionId 映射：执行时补全 source.chatSessionId 用。 */
const chatSessionIdByRequestId = new Map<string, string | null>();
/**
 * requestId → 本轮激活的本地 Skill 目录（只在真有激活时写入）。
 *
 * ⚠️ **建授权时已经用了它，这里再记一份是给续跑循环用的** —— 续跑轮会**重新建授权**
 * （防上一轮 grant 被关掉），而续跑 prompt 是模板、不是用户输入，重新跑一遍 Skill 激活
 * 只会得到 null。所以要把「启动该循环的那一轮」的目录带到循环上（与 `model`
 * 同一类状态）。少了它，续跑轮里 `shell_exec` 的初始 cwd
 * 就不再被归一到 Skill 目录，而**提示词里那句软约束照样在** ⇒ 静默退化。
 */
const localSkillDirByRequestId = new Map<string, string>();
/** requestId → 本轮已完成的工具执行记录（TOOL_CALL 通道执行后写入，response 里读取续跑判定）。 */
const executionsByRequest = new Map<string, ToolExecutionRecord[]>();
/**
 * requestId → 本轮**实际注入提示词**的那份工具描述符（= 授权返回的 `descriptors`）。
 *
 * ⚠️ **兜底 `parseToolXml` 必须用这份、而不是全局 `currentToolDescriptors`** ——
 * 后者是「内容脚本最后一次同步」，用户刚加 MCP 工具、`TOOL_DESCRIPTORS_UPDATED` 广播
 * 未落地时会与提示词分叉（提示词列了 A、识别器不认 A → 静默不执行）。这份与提示词严格同源。
 * 释放见 `releaseRequestState`。
 */
const requestToolDescriptorsByRequestId = new Map<string, ToolDescriptor[]>();

/**
 * 释放某个请求的全部请求级状态。**由终态收尾函数 `tryFinalizeRequest` 调用一次**。
 *
 * 选那个点的依据：收尾要等三条同时成立（终态已到 / 执行已齐 / 响应已消费），
 * 而这几条恰好保证**它们各自的最后一个读者都已经跑完** —— 即「读完才删」，
 * 不会让某次执行被判成重复而跳过。`tryFinalizeRequest` 由 `REQUEST_TERMINAL` 分支
 * 与会合点两处共同触发、但自身幂等（收尾成功即删状态条目），所以仍**每条请求恰好释放一次**。
 *
 * ⚠️ **`respondedRequestIds` 刻意不在这里释放。** 它有一个**延迟读者**：
 * `armManualStopDetection` 会遍历在跑的任务，把「不在这个集合里」的 requestId 挂上
 * 4 秒的宽限窗口，到期判为「用户手动停止」并回 `DOM_TASK_FAILED`。一旦在这里删掉条目，
 * 之后任何一次扫描都会把**已经正常完成**的请求重新当成待挂窗口 —— 若那个任务正在
 * 续跑循环里，就会被误杀。它每轮只占一个 UUID，泄漏量与其他几项不在一个量级。
 * 要清也得按时间老化（等宽限窗口确定跑完），不能按 requestId 删。
 *
 * ⚠️ **没有 `REQUEST_TERMINAL` 的两条路径会留下残余**：HTML 挑战页与响应直接 reject
 * （fetch hook 在这两条路上只发各自的回调）。但这两条路都没有流、也就没有工具执行，
 * 所以 `executedToolCallSignatures` / `executionsByRequest` 两个大容器根本不会被写；
 * 残留的是 `chatSessionIdByRequestId` /
 * `localSkillDirByRequestId` 两个 UUID / 短串级小条目，**外加 `requestToolDescriptorsByRequestId`**
 * （增广已成功、已写入，但它不是小条目 —— 是整份 `descriptors` 数组）。**这是有意接受的**：
 * 让 terminal 在这两条路上也发出会连带触发 `armManualStopDetection`，可能给高峰挑战
 * 误报一次 `DOM_TASK_FAILED` —— 那是行为改动，不该混在内存清理里。
 */
function releaseRequestState(requestId: string): void {
  executedToolCallSignatures.delete(requestId);
  executionsByRequest.delete(requestId);
  chatSessionIdByRequestId.delete(requestId);
  localSkillDirByRequestId.delete(requestId);
  requestToolDescriptorsByRequestId.delete(requestId);
}
/**
 * 主世界消息串行队列：保证 TOOL_CALL → RESPONSE_COMPLETE → REQUEST_TERMINAL 按顺序执行。
 *
 * ⚠️ **它提供的是「串行化」，不是「纠正乱序」** —— 主世界 `postToContent` 全程是同步
 * `window.postMessage`，同一 tick 内的多条消息本来就是 FIFO（fetch hook 的 done 分支里
 * `TOOL_CALL` 与 `RESPONSE_COMPLETE` 之间没有 await）；队列的作用是防止并发处理交错。
 *
 * ⚠️ **「双条件会合点」（`settleToolTurn`）也走这条队列** —— 它必须回到同一条串行线上，
 * 否则会与队列内正在跑的处理并发改 `continuationLoop` / `executionsByRequest` / 面板状态。
 */
const mainWorldQueue = createSerialOperationQueue();

/**
 * requestId → 本轮的「双条件会合」状态 —— 把「响应到达」与「工具执行完成」拆成两条
 * 互不阻塞的推进，两者都就绪时才只触发一次续跑判定（`settleToolTurn`）。
 *
 * ⚠️ **它刻意不进 `releaseRequestState`** —— 本模块自己的收尾函数 `tryFinalizeRequest`
 * 负责删除（同 `respondedRequestIds` 的「有延迟读者」理由：这里也有延迟消费）。
 * ⚠️ **chatNew 分支不得写它** —— chatNew 请求没有终态事件（`fetch-hook` 只在 completion
 * 路由发 `onRequestTerminal`），写进去就是永不释放的孤儿（见 `handleAugmentRequestBody`
 * 里 chatNew 段的说明）。
 */
interface ToolTurnState {
  /** 还有几个工具执行在飞（计数：一条回复可能有多个工具）。 */
  pendingExecutions: number;
  /** 响应已到达、但还没被 `handleResponseComplete` 消费。 */
  response: ZaiResponseCompletePayload | null;
  /** 会合任务已入队 —— 防重复消费（多工具的 finally 会各触发一次会合）。 */
  settleScheduled: boolean;
  /** `REQUEST_TERMINAL` 已到达。 */
  terminalSeen: boolean;
  /** 本请求的执行串行链 —— 保住「同一条回复里的多个工具**串行**执行」这一既有行为。 */
  executionChain: Promise<void>;
}
const toolTurnStates = new Map<string, ToolTurnState>();

/** 取/建某个 requestId 的会合状态。**终态收尾由 `tryFinalizeRequest` 删除**。 */
function ensureToolTurnState(requestId: string): ToolTurnState {
  let state = toolTurnStates.get(requestId);
  if (!state) {
    state = {
      pendingExecutions: 0,
      response: null,
      settleScheduled: false,
      terminalSeen: false,
      executionChain: Promise.resolve(),
    };
    toolTurnStates.set(requestId, state);
  }
  return state;
}

/**
 * **双条件会合点**：执行已齐 ⇒ 消费响应（若有）并尝试终态收尾。
 *
 * ⚠️ **它必须重新入队**（`mainWorldQueue.run`）—— 不入队就会与队列里正在跑的处理
 * 并发改 `continuationLoop` / `executionsByRequest` / 面板状态。
 * ⚠️ **唯一性靠 `settleScheduled`**：多工具的 `finally` 会各触发一次会合，
 * 不去重会让 `handleResponseComplete` 被调两次（续跑会被注入两轮）。
 * ⚠️ **「没有响应」也要继续往下走** —— 响应可能已被上一次会合消费掉，而这次触发的
 * 是「执行刚落地」；直接 return 会让终态收尾失去这个唤醒源（状态永不释放）。
 * ⚠️ **`state.response` 要到任务真正执行时才清** —— 在这里同步清会让终态收尾
 * 把还没消费的响应当成「已消费」而提前释放状态。
 * ⚠️ **无事可做时也会排一个空任务**（只调 `tryFinalizeRequest`）—— 它自身幂等
 * （收尾成功即删条目，再来就找不到），换来的是「每个唤醒源都必然推进一步」。
 */
function settleToolTurn(requestId: string): void {
  const state = toolTurnStates.get(requestId);
  if (!state) return;
  if (state.pendingExecutions > 0 || state.settleScheduled) return;
  state.settleScheduled = true;
  void mainWorldQueue.run(async () => {
    state.settleScheduled = false;
    const payload = state.response;
    state.response = null;
    if (payload) {
      try {
        await handleResponseComplete(payload);
      } catch (error) {
        // ⚠️ **这里的 catch 是队列外调用的替代品** —— 之前 `handleResponseComplete`
        // 由 `dispatchMainWorldMessageInner` 调用，错误由那个函数的 catch 兜住；现在改由
        // 会合任务调，得自己接。文案与分发器那句**刻意不同**：看日志时要能一眼分出
        // 「消息分发阶段炸的」还是「会合消费阶段炸的」。
        if (isExtensionInvalidatedError(error)) invalidateExtensionContext();
        else console.error('[Zai++] handleResponseComplete failed inside the tool-turn rendezvous', error);
      }
    }
    // ⚠️ **`tryFinalizeRequest` 也要单独接住**：上面那个 `try` 只包
    // `handleResponseComplete`，而这里一旦抛出就会从 `mainWorldQueue.run` 的
    // promise 里漏出去（调用方是 `void`）⇒ **unhandled rejection 会进
    // `chrome://extensions` 的错误列表**，且比 `console.error` 更难压。
    // 现在的实现里它不会抛（`closeToolAuthorizationGrant` 只 rethrow 非失效错误、
    // `sendRuntimeMessage` 自己吞光），但 `toolPanel.finalizePending` / `sealTurn`
    // 是同步 DOM 操作 —— 属于「将来加一条会抛的实现」那一类。
    try {
      await tryFinalizeRequest(requestId);
    } catch (error) {
      if (isExtensionInvalidatedError(error)) invalidateExtensionContext();
      else console.error('[Zai++] request finalize failed inside the tool-turn rendezvous', error);
    }
  });
}

/**
 * 请求的**终态收尾** —— 由 `REQUEST_TERMINAL` 分支与会合点两处共同触发，
 * **最后满足条件的那个把它做完**（另一个进来时会提前返回）。
 *
 * 收尾条件三条同时成立：① 终态已到；② 执行已齐（`pendingExecutions === 0`）；
 * ③ 响应要么没到、要么已消费完（`response === null` 且没有在排队的会合任务）。
 *
 * ⚠️⚠️ **②③ 是「关授权不能打断在飞执行」与「`releaseRequestState` 不能早于
 * `handleResponseComplete` 读表」这两条不变式的全部依据**（`executionsByRequest` /
 * `chatSessionIdByRequestId` 的最后一个读者都在 `handleResponseComplete` 里）。
 * ⚠️ **`finalizePending` 必须排在 `sealTurn` 之前** —— 前者可能重发一次带 `live: true`
 * 的记录把块画回展开，反过来收尾就被顶掉（与 `handleResponseComplete` 内部同一条理由）。
 */
async function tryFinalizeRequest(requestId: string): Promise<void> {
  const state = toolTurnStates.get(requestId);
  if (!state?.terminalSeen) return;
  if (state.pendingExecutions > 0) return;
  if (state.response || state.settleScheduled) return;
  toolTurnStates.delete(requestId);
  if (activeToolAuthorizations.has(requestId)) {
    await closeToolAuthorization(requestId);
  }
  // 流终止但这一轮从未产出 RESPONSE_COMPLETE = 页面侧把读取流 abort 了
  // （用户点 Stop，或读取中途出错）。这比「等 Stop 按钮消失」更直接，
  // 这里立刻挂上手动停止宽限窗口，不必再等 180s 执行租约超时。
  // 正常结束的轮次不走这里：`respondedRequestIds` 已在响应到达时登记。
  if (!respondedRequestIds.has(requestId)) {
    armManualStopDetection();
    // 手动轮的「这一轮被中止」收尾：自动化轮靠上面那个 4 秒宽限走到
    // `terminateDomTaskAsStopped`（它先摘 taskId 再回 FAILED），而**手动轮没有 taskId**，
    // 上面那条宽限路径一条也命中不了 ⇒ 不收的话 `continuationLoop` 会一直停在 running、
    // `activeRequestId` 指着一个已经中止的请求，直到下一条带工具的回复把它顶掉。
    // ⚠️ **只收手动轮**：自动化轮若在这里提前收，`loop.taskId` 还在，
    // `finishContinuationLoop` 会把它当成「正常跑完」回 `DOM_TASK_COMPLETE`。
    if (
      continuationLoop?.status === 'running' &&
      continuationLoop.activeRequestId === requestId &&
      continuationLoop.taskId === null
    ) {
      console.log('[Zai++] continuation aborted; reclaiming the manual loop', { requestId });
      finishContinuationLoop(continuationLoop);
    }
  }
  // 64：请求终态到了 —— 该请求下还标着「执行中」的行收成失败。
  // ⚠️ **排在 `releaseRequestState` 之前**：那个函数会清掉本请求的所有请求级状态。
  // ⚠️ **正常结束的轮次这里什么都不做** —— `RESPONSE_COMPLETE` 已经收过一遍了，
  // `finalizePending` 在没有 pending 行时是 no-op。
  toolPanel.finalizePending(
    requestId,
    translate(currentContentLocale, 'content.toolBlock.summaries.failed'),
    translate(currentContentLocale, 'content.toolBlock.summaries.incomplete'),
  );
  toolPanel.sealTurn(requestId);
  // 释放这一轮的请求级状态。放最后：上面的判定都读完了才清。
  releaseRequestState(requestId);
}
/** 续跑请求观察计数：AUGMENT_REQUEST_BODY 收到续跑请求时 +1，用于检测 DOM 注入是否真的发出了请求。 */
let continuationRequestSeq = 0;
/** DOM 注入发送锁：注入进行中置 true，请求发出后置 false。防止双击/重试/弹窗自动重发并发触发。 */
let domSendInFlight = false;
/**
 * 自动化发送链里「可安全重试」的 pre-send 失败码（尚未产生任何副作用：没点联网、
 * 没写输入框、没发请求）。命中这些码时，后台才标 retrySafe + externalOutcome='not_started'，
 * 让 scheduler 自动重跑；其它失败一律视为 ambiguous（可能已建会话/已发消息）。
 */
const RETRYABLE_PRE_SEND_ERRORS: ReadonlySet<string> = new Set([
  'no_textarea',
  'form_not_connected',
  'agent_not_idle',
]);
/** 注入期间保存的用户输入文字（注入前复制，注入完成后恢复）。 */
let pendingUserComposerRestore: string | null = null;

/**
 * 后台发起的 DOM 任务登记：
 * taskId 由后台生成、唯一贯穿支付请求 → 响应 → 续跑 → 收尾。
 */
interface ActiveDomTask {
  taskId: string;
  kind: string;
  prompt: string;
  chatSessionId: string | null;
  /** 该任务选定的模型 id（两种模式下都覆写请求体的 model）；null = 跟随页面默认。 */
  model: string | null;
  status: 'pending' | 'injected' | 'running' | 'done' | 'failed' | 'cancelled';
}
/** taskId → 任务现场。一 tab 同一时刻只跑一个后台任务（busy 锁）。 */
const activeDomTasks = new Map<string, ActiveDomTask>();
/** requestId → taskId：请求增广命中归属后登记，RESPONSE_COMPLETE 按此回传。 */
const taskIdByRequestId = new Map<string, string>();
/** prompt 原文 → taskId：DOM 注入前登记，handleAugmentRequestBody 命中后即删。 */
const taskIdByPromptText = new Map<string, string>();

interface ContinuationLoop {
  loopId: string;
  chatSessionId: string | null;
  originalTask: string;
  toolExecutions: ToolExecutionRecord[];
  stepCount: number;
  status: 'running' | 'idle';
  activeRequestId: string | null;
  pendingPrompt: string | null;
  /** 已用掉的 nudge（无工具调用纠偏）次数。 */
  nudgeCount: number;
  /** 上一轮模型回复正文（供 nudge 时回看）。 */
  lastVisibleText: string;
  /** 归属的后台 DOM 任务 id（手动聊天续跑为 null）。 */
  taskId: string | null;
  /** 续跑收尾时回传给后台的最终回复正文。 */
  finalAssistantText: string;
  /** 归属任务选定的模型 id：续跑轮也要把同一模型写回请求体。 */
  model: string | null;
  /**
   * 启动该循环的那一轮激活的本地 Skill 目录（没激活则为 null）。
   *
   * ⚠️ **续跑轮必须复用它** —— 续跑 prompt 是模板、不是用户输入，重新跑一遍 Skill 激活
   * 只会得到 null（`parseSkillCommand` 匹配不到 `/名字`、隐式打分也对不上模板文本）。
   * 少了它，续跑轮建的 grant 就没有 `localSkillDir`，`shell_exec` 的初始 cwd 不再被归一
   * 到 Skill 目录 —— 而**提示词里那句软约束照旧在**，所以是静默退化。
   */
  localSkillDir: string | null;
  /**
   * 「这一发没拿到发出证据」的看门狗句柄（没有看门狗在挂则为 null）。
   *
   * ⚠️ **收尾时必须撤掉**（`finishContinuationLoop` 会做）—— 否则它到点会对着
   * 一个已收尾的循环再跑一遍，把已经完成的任务标成失败。
   */
  pendingWatchdog: ReturnType<typeof setTimeout> | null;
}

let continuationLoop: ContinuationLoop | null = null;
const activeToolAuthorizations = new Map<string, ToolAuthorizationGrantSummary>();

// ---------------------------------------------------------------------------
// 会话/请求辅助
// ---------------------------------------------------------------------------

/** 当前会话 id：从地址栏 `/c/<id>` 读（`core/zai/chat-session` 是唯一核心实现）。 */
function getCurrentChatSessionId(): string | null {
  return readZaiChatSessionId(location.pathname);
}

/**
 * **当前页所属站点**的 origin（认不出时回落默认站）。
 *
 * ⚠️ **内容脚本里一切「拼本页 URL」的地方都用它** —— 会话 id 在两站之间不通用，
 * 用错站的 origin 拼出来的链接会打开 401 或「会话不存在」。
 * ⚠️ 与 `fetch-hook.ts` 的 `readPageOrigin` 是同一件事的两份实现（那边跑在主世界、
 * 不能 import 本模块的东西）—— 判据都走 `resolveZaiSiteOrigin`，改口径要两处同改。
 *
 * ⚠️⚠️ **那个回落分支（`?? ZAI_WEB_ORIGIN`）在生产里不可达，而这条依赖一个前提**：
 * 两条 content script（本文件与 `zai-main-world.content.ts`）的 `matches` 只声明两个站点，
 * 且**没有开 `all_frames`**（MV3 默认 false）⇒ 只注入顶层帧 ⇒ `location.origin`
 * 必然是站点表里的一员。**若将来为别的功能打开 `all_frames`**，iframe 里的 origin
 * 可能落在站点表之外，这个回落就会真的生效 —— 那时它会把别处的 origin 当成默认站，
 * 写入侧（按本页 origin 分桶）也会跟着挪到默认站的桶。改 `all_frames` 前先看这里。
 */
function currentSiteOrigin(): string {
  return resolveZaiSiteOrigin(location.origin) ?? ZAI_WEB_ORIGIN;
}

/**
 * 这一轮所属的**助手消息 uuid**（取最后一条助手消息、往上找 `message-<uuid>` 类）。
 *
 * ⚠️ **与 `core/zai/tool-panel.ts` 的 `publishLiveSession` 同口径** ——
 * 那边用同一对函数算块 id，所以「块 id 是 `history:<uuid>`」与「这条工具记录的
 * `assistantMessageId` 是同一个 uuid」天然一致（真机已验证读得到）。
 *
 * ⚠️ **读不到返回 null**（首条消息流式期间、页面还没挂类）⇒ 调用方**不写**这个字段。
 */
function readCurrentAssistantMessageId(): string | null {
  const messages = listZaiAssistantMessages(document);
  const lastMessage = messages[messages.length - 1];
  return lastMessage ? readZaiMessageId(lastMessage) : null;
}

function isContinuationRequest(text: string): boolean {
  return isZaiContinuationPrompt(text);
}

function hasLiveExtensionContext(): boolean {
  return extensionContextValid;
}

function isExtensionInvalidatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Extension context invalidated') ||
    message.includes('Extension context removed') ||
    message.includes('message port closed')
  );
}

function invalidateExtensionContext(): void {
  extensionContextValid = false;
  // 扩展被重载 / 卸载后这个内容脚本已经死了，但它挂在页面上的东西还活着 ——
  // 补全的**捕获阶段** keydown 监听会一直掐断 Enter、面板的 MutationObserver
  // 会一直观察一个再也无人消费的 DOM。两者都不报错，用户看到的是
  // 「扩展重载后输入框打不了字 / 回车没反应」。
  disposeZaiCapabilities({
    disposeSkillPopup: stopSkillPopup,
    disposeToolPanel: () => toolPanel.dispose(),
  });
}

// ---------------------------------------------------------------------------
// runtime 消息
// ---------------------------------------------------------------------------

async function sendRuntimeMessage<T>(message: unknown): Promise<T | undefined> {
  if (!hasLiveExtensionContext()) return undefined;
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch (error) {
    if (isExtensionInvalidatedError(error)) invalidateExtensionContext();
    return undefined;
  }
}

/**
 * 发命令并**要求成功**。后台以 `{ ok: false, error }` 表示领域失败而**不是抛错**，
 * 这里统一转成异常 —— 否则调用点会把失败当成功（表现：界面只是重绘一次、
 * 什么都没变、也没有任何提示）。
 */
async function sendRuntimeMessageStrict<T>(
  message: unknown,
): Promise<T> {
  if (!hasLiveExtensionContext()) throw new Error('Extension context unavailable.');
  const response = await chrome.runtime.sendMessage(message);
  if (isRuntimeFailure(response)) {
    const code = response.error === undefined ? 'runtime_command_failed' : String(response.error);
    throw new RuntimeCommandError(code);
  }
  return response as T;
}

/**
 * 入站 runtime 消息的**来源闸门**：只放行后台发来的那几条。
 *
 * **它拦什么**：内容脚本的 `onMessage` 只要不过闸门，任何能到达它的消息都会走完整条
 * 分支链 —— 其中包括 `RUN_DOM_TASK`（真的去驱动页面发消息）与 `INSERT_PROMPT_TEXT`
 * （真的往输入框写文本）。闸门把这些收窄成「只认后台发的」。
 *
 * ⚠️ **上游在同一位置做了这件事**（`entrypoints/content.ts` 的
 * `handleContentRuntimeMessage`），它的注释是：
 * *「runtime.sendMessage reaches every extension context. A content receiver must not
 * answer a content-to-background RPC before the background does.」*
 *
 * ⚠️⚠️ **但上游那条理由与 Chrome 官方文档对不上，我如实记录**：
 * 文档明确写 *「extensions cannot send messages to content scripts using this method
 * [runtime.sendMessage]. To send messages to content scripts, use tabs.sendMessage.」*
 * ⇒ 按文档，内容脚本**只会**收到 `tabs.sendMessage` 来的消息（即后台发的），
 * 「抢答」场景不成立。**两种说法我没有实测过哪一种对**（上游已发布运行、文档是规范，
 * 而这类投递面差异历史上有过浏览器实现分歧）。**这里按「闸门本身有正当性」来做**：
 * 收窄入站来源是防御纵深，与「抢答」这条理由成立与否无关。
 *
 * ⚠️ 判据与后台侧**同源**：`createExtensionRuntimeMessageContext` +
 * `BACKGROUND_RUNTIME_PATHNAMES`，不另写一份 —— 两处各写一遍必然分叉。
 *
 * ⚠️⚠️ **拒绝时静默 `return`、不回响应**（与后台侧的 `createRuntimeBoundaryErrorResponse` 相反）：
 * 回一条错误响应**同样算「应答」**，会让本内容脚本在应答竞速里赢过后台。
 *
 * ⚠️⚠️ **它依赖一条我没有实测的假设**：后台发消息时 `sender.url` 落在
 * `BACKGROUND_RUNTIME_PATHNAMES` 那两条里（`/background.js`）。**若假设不成立，闸门会拒掉
 * 所有广播**（表现：侧边栏改了记忆/技能/背景，页面不更新、要刷新才生效）。
 * 上游用同一套校验且已发布运行 ⇒ 假设应成立；**真机出现上述症状时，第一个查这里。**
 */
function isAuthorizedInboundRuntimeMessage(
  message: unknown,
  sender: RuntimeMessageSenderLike,
): boolean {
  try {
    decodeRuntimeMessageEnvelope(message);
    createExtensionRuntimeMessageContext(sender, {
      runtimeId: chrome.runtime.id,
      extensionOrigin: chrome.runtime.getURL('/'),
      allowedPathnames: BACKGROUND_RUNTIME_PATHNAMES,
    });
    return true;
  } catch (error) {
    // 只吞「边界拒绝」这一类；真出别的错要让它冒出来，别把 bug 静默掉。
    if (error instanceof RuntimeBoundaryError) return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 状态同步（isolated → main）
// ---------------------------------------------------------------------------

function postToMainWorld(message: Record<string, unknown>): void {
  try {
    window.postMessage({ source: ZAI_CONTENT_TO_MAIN, ...message }, '*');
  } catch (error) {
    console.error('[Zai++] post to main failed', error);
  }
}

/**
 * 记录自动化发送链的致命错误 kind。
 *
 * ⚠️ **这不是诊断** —— `submitDomTaskPrompt` 读它决定回给后台的 `error` 码，
 * 而 `RETRYABLE_PRE_SEND_ERRORS` 里那三个码决定后台要不要自动重跑。
 */
function recordAutomationSendError(kind: string): void {
  lastAutomationSendErrorKind = kind;
  // 本机可见性：这三个码决定后台要不要自动重跑，而失败本身只在后台侧可见
  // （`submitDomTaskPrompt` 回 `DOM_TASK_FAILED`，侧边栏有对应文案）⇒ 用户能看到失败。
  // 这一行是页面 console 里唯一的根因，但**不进 `chrome://extensions` 面板**。
  console.log('[Zai++] automation send fatal', { kind });
}

function catalogNamesFor(descriptors: readonly ToolDescriptor[]): string[] {
  const catalog = createToolInvocationCatalog(descriptors);
  return catalog.invocationNames;
}

/**
 * 本请求的**模型可见工具目录** —— 提示词、标签识别、兜底解析三处**必须共用这一份**。
 *
 * ⚠️⚠️ **为什么要有这个函数**：`filterZaiModelFacingToolDescriptors` 曾经只在
 * `augmentPrompt` 内部调用一次，结果只喂给了提示词；而**标签识别**（回传给主世界的
 * `toolDescriptorNames`）与**兜底解析**（`requestToolDescriptorsByRequestId`）用的都是
 * **授权返回的完整目录**。两份名单分叉的后果是**静默的**：提示词里没有的工具，
 * 模型照**会话历史里首条注入的示例**照样吐标签 —— 而识别名单里有它、执行侧无人拦，
 * **于是真的执行了**。
 */
function modelFacingDescriptorsFor(
  descriptors: readonly ToolDescriptor[],
): ToolDescriptor[] {
  return filterZaiModelFacingToolDescriptors(descriptors);
}

/**
 * 按 requestId 取本请求的模型可见目录 —— 供**执行期**的读点用（那时只有 requestId）。
 */
function modelFacingForRequest(requestId: string): ToolDescriptor[] {
  return modelFacingDescriptorsFor(
    requestToolDescriptorsByRequestId.get(requestId) ?? currentToolDescriptors,
  );
}

function syncHookState(): void {
  const names = catalogNamesFor(currentToolDescriptors);
  currentCatalogNames = names;
  postToMainWorld({ type: 'SYNC_HOOK_STATE', toolDescriptorNames: names });
  syncSkillPopup();
}

/**
 * 把技能候选喂给输入框的斜杠命令补全。
 *
 * ⚠️ **候选只列启用中的技能** —— 与 `resolveActiveLocalSkill` 的口径一致：
 * 禁用技能被补全出来也用不了（`parseSkillCommand` 那条路同样会把它滤掉），
 * 列出来只会让人白点一次。
 *
 * ⚠️ **描述缺失时留空串而不是丢掉这一条** —— 名字本身才是可用的那部分；
 * 上游同样只做「字段是字符串」的过滤。
 *
 * ⚠️ **由本文件注入依赖，模块本身不 import 技能清单也不 import i18n**：
 * 写输入框复用自动化发送链那个真机验证过的原语（`setTextareaValue`），
 * 锚点复用真机实测过的外壳解析（`resolveZaiComposerShell`）。
 */
function syncSkillPopup(): void {
  wireSkillPopup(currentSkills, {
    hint: translate(currentContentLocale, 'content.skillPopup.hint'),
    init: initSkillPopup,
    resolveInput: resolveZaiComposerInput,
    resolveAnchor: resolveZaiComposerShell,
    setInputValue: setTextareaValue,
  });
}

/**
 * 运行时状态同步（记忆 / 技能 / 工具目录 / 预设 / 界面语言）。
 *
 * ⚠️ **两次同步并发时，必须只有最新那次能落到模块状态上。** 触发源分布在两条不同的
 * 时间线上：`chrome.runtime.onMessage` 的广播监听（`STATE_UPDATED` 与
 * `TOOL_DESCRIPTORS_UPDATED` 落进同一个分支，而后台侧这两条是**背靠背**发的）、
 * 自动化发送前、启动、以及主世界消息串行队列内的续跑/纠偏注入。它们各自的
 * `GET_TOOL_DESCRIPTORS` 往返顺序**没有保证** —— 先发起的后返回时，旧目录会盖掉新目录；
 * 更糟的是**过期的失败会把更新的成功清掉**（失败路径落成空数组 = fail-closed 清空目录，
 * 方向本身是对的，但由过期结果触发就是错的）。
 *
 * ⚠️ **需要「这次拿到的就一定算数」的调用方，请用返回值，不要去读模块状态** ——
 * 模块状态按「最新一次生效」的闸门落地，某一次调用的结果可能被更新的同步顶掉。
 * 返回值永远是本次调用的结果（见 `requestToolAuthorization` 的授权重试）。
 */
const toolDescriptorSyncGate = createLatestSyncGate();

interface LoadedRuntimeState {
  descriptors: ToolDescriptor[];
  /**
   * 本次拿到的目录是否**可用作「新目录」**（`false` = 不可用，调用方别拿它当「最新」）。
   *
   * ⚠️ **只有「必须拿到一份新的」的调用方需要读它** —— 目前是
   * `requestToolAuthorization` 的授权重试：它进这条路的唯一原因就是
   * `unknown_tool_authorization_descriptor`（= 我们这份目录过期了），所以它要的是**新目录**。
   *
   * ⚠️⚠️ **它的判据是「取数没抛错 **且** 目录非空」，不只是「没抛错」** ——
   * `GET_TOOL_DESCRIPTORS` 失败时 `sendRuntimeMessage` 返回 `undefined`、被
   * `.then(v => Array.isArray(v) ? v : [])` **收敛成空数组**，这条路上不会抛。
   * 若只看「没抛错」，那个空目录会被当成新目录 ⇒ 授权重试带 `descriptorIds: []` 重发，
   * 后台按 id 过滤后 `0 === 0` 判不出异常，**安静地建成一个不含任何工具的 grant** ——
   * 正是这个字段要挡的事。
   * ⚠️ 代价：**后台确实一个工具都没有**时也会判成 `false` ⇒ 重试直接抛错而非重发。
   * 方向是安全的（fail-fast 优于建空 grant）。
   *
   * ⚠️ **列提示词清单的调用方（续跑轮 / nudge 轮）不要读它** —— 它们要的是
   * 「有一份能用的目录」，沿用值正好。
   */
  fresh: boolean;
}

async function loadAndSyncRuntimeState(): Promise<LoadedRuntimeState> {
  const syncLease = toolDescriptorSyncGate.begin();
  let loaded: [
    Memory[],
    ToolDescriptor[],
    Skill[],
    SkillAutoActivationSettings,
    SystemPromptPreset | null,
    PromptInjectionSettings,
    Awaited<ReturnType<typeof getResolvedLocaleState>>,
  ];
  try {
    loaded = await Promise.all([
      sendRuntimeMessage<Memory[]>({ type: 'GET_MEMORIES' }).then((v) => (Array.isArray(v) ? v : [])),
      sendRuntimeMessage<ToolDescriptor[]>({ type: 'GET_TOOL_DESCRIPTORS' }).then((v) => (Array.isArray(v) ? v : [])),
      sendRuntimeMessage<Skill[]>({ type: 'GET_SKILLS' }).then((v) => (Array.isArray(v) ? v : [])),
      sendRuntimeMessage<SkillAutoActivationSettings>({ type: 'GET_SKILL_AUTO_ACTIVATION_SETTINGS' }).then(
        (v) => normalizeSkillAutoActivationSettings(v),
      ),
      sendRuntimeMessage<SystemPromptPreset | null>({ type: 'GET_ACTIVE_PRESET' }).then(
        (v) => (v && typeof v === 'object' ? (v as SystemPromptPreset) : null),
      ),
      sendRuntimeMessage<PromptInjectionSettings>({ type: 'GET_PROMPT_INJECTION_SETTINGS' }).then(
        (v) => normalizePromptInjectionSettings(v),
      ),
      getResolvedLocaleState(LOCALE_READ_TIMEOUT_MS),
    ]);
  } catch (error) {
    // ⚠️⚠️ **这里刻意不往外抛，也刻意不 commit。**
    //
    // ⚠️ **当前静态不可达** —— 七条腿里唯一可能 reject 的 `getResolvedLocaleState`
    // 已收敛为**永不 reject**（读失败吞成默认值、超时只 resolve），
    // 其余六条走 `sendRuntimeMessage`（自带 try/catch 成 `undefined`），
    // 两个 `normalize*` 都是纯函数。**所以这是防御性兜底，不是活路径** ——
    // 留着是为了「将来有人给某条腿加一个会抛的实现」时不至于把整个同步炸掉。
    // ⚠️ 下面两条决策的**理由**仍然成立（它们说的是「万一抛了会怎样」）：
    //
    // 不抛：调用方里有三处是「状态同步失败也不该中断主流程」的 ——
    // `advanceContinuationLoop` 在取数之后还要注入下一轮 / 收尾，抛出去会让
    // `continuationLoop` 停在 `running`、只能等后台 180s 执行租约兜底；
    // `submitDomTaskPrompt` 抛出去会让这一次自动化运行直接失败。
    // 把一次状态同步失败放大成「自动化卡 180 秒」不划算。
    //
    // 不 commit：模块状态与 `currentCatalogNames` 停在**上一次成功的值**，
    // 而不是被清空。⚠️ 这条是有意的 —— `currentCatalogNames` 会推到主世界供
    // fetch hook 识别工具标签，而 `extractAndNotifyToolCalls` 在名字集合为空时
    // **直接 return、一个工具都不识别**。清空等于把「识别」整条关掉。
    // 沿用旧值的口径与 `currentToolDescriptors` 一致（「读取失败时沿用上一次的值」）。
    console.error('[Zai++] runtime state sync failed', error);
    return {
      descriptors: currentToolDescriptors,
      fresh: false,
    };
  }
  const [memories, descriptors, skills, skillAutoActivation, activePreset, promptSettings, resolvedLocale] = loaded;
  // 只有最新一次同步能落地；被顶掉时静默放弃（旧数据不该覆盖新数据）。
  syncLease.commit(() => {
    currentMemories = memories;
    currentToolDescriptors = descriptors;
    currentSkills = skills;
    currentSkillAutoActivation = skillAutoActivation;
    currentActivePreset = activePreset;
    currentPromptSettings = promptSettings;
    currentContentLocale = resolvedLocale.locale;
    syncHookState();
  });
  // ⚠️ `fresh` 的判据是「取数没抛错**且**目录非空」—— 只看「没抛错」不够：
  // `GET_TOOL_DESCRIPTORS` 失败会被收敛成空数组、这条路上不会抛（见 `fresh` 字段的说明）。
  return { descriptors, fresh: descriptors.length > 0 };
}

// ---------------------------------------------------------------------------
// 工具授权 + 执行中继
// ---------------------------------------------------------------------------

/** 工具授权创建失败的语义化错误（带后台给的原因码，便于诊断）。 */
class ToolAuthorizationRequestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Tool authorization request failed: ${code}`);
    this.name = 'ToolAuthorizationRequestError';
    this.code = code;
  }
}

/**
 * 建授权。**必须校验响应形状** —— 后台在参数不合法 / 描述符对不上时会返回
 * `{ ok: false, error }` 而**不是抛错**；不校验就会把这个对象当成授权存进
 * `activeToolAuthorizations`，之后 `authorization.id` 恒为 undefined，
 * 表现为「工具一直执行不了、日志里只有一句 [object Object]」。
 */
async function createToolAuthorization(input: {
  requestId: string;
  chatSessionId: string | null;
  descriptorIds?: string[];
  toolIntent?: string;
  /**
   * 本轮激活的本地 Skill 目录（由 `resolveActiveLocalSkill` 算出）。
   * 后台**不会直接采信**它 —— 先过 `validateLocalSkillDirectory` 确认是某个已导入
   * 本地 Skill 的目录，不是就丢弃。带上它的唯一作用：让执行期把
   * `shell_exec` / `shell_session_begin` 的初始 cwd 归一到 Skill 目录。
   */
  localSkillDir?: string;
}): Promise<ToolAuthorizationGrantSummary> {
  const response = await sendRuntimeMessageStrict<unknown>({
    type: 'CREATE_TOOL_AUTHORIZATION',
    payload: { trigger: 'manual_chat', ...input },
  });
  const grant = response as { id?: unknown } | null | undefined;
  if (grant && typeof grant === 'object' && typeof grant.id === 'string' && grant.id) {
    return response as ToolAuthorizationGrantSummary;
  }
  const code = response && typeof response === 'object'
    && typeof (response as { error?: unknown }).error === 'string'
    ? (response as { error: string }).error
    : 'unrecognized_tool_authorization_response';
  throw new ToolAuthorizationRequestError(code);
}

/**
 * 只关后台那份 grant，**不碰内容脚本的 Map**。给「grant 从来没进过 Map」的路径用
 * （chatNew 就是：它收不到 `REQUEST_TERMINAL`，进 Map 就是永不释放的孤儿）。
 */
async function closeToolAuthorizationGrant(authorizationId: string): Promise<void> {
  try {
    await sendRuntimeMessage({
      type: 'CLOSE_TOOL_AUTHORIZATION',
      payload: { authorizationId },
    });
  } catch (error) {
    if (!isExtensionInvalidatedError(error)) throw error;
    invalidateExtensionContext();
  }
}

async function closeToolAuthorization(requestId: string): Promise<void> {
  const authorization = activeToolAuthorizations.get(requestId);
  if (!authorization) return;
  try {
    await closeToolAuthorizationGrant(authorization.id);
  } finally {
    activeToolAuthorizations.delete(requestId);
  }
}

async function executeToolCall(
  call: ToolCall,
  authorizationId?: string,
): Promise<ToolCardResult> {
  if (call.parseError) {
    return {
      ok: false,
      summary: '工具格式无效',
      detail: call.parseError.message,
      error: call.parseError,
    };
  }
  const result = await sendRuntimeMessage<ToolCardResult>({
    type: 'EXECUTE_TOOL_CALL',
    payload: { ...call, authorizationId },
  });
  if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
    return result;
  }
  console.log('[Zai++] execute_tool_call returned an invalid result', {
    call: call.invocationName ?? call.name,
    requestId: call.source?.requestId ?? null,
    authorizationId: authorizationId ?? null,
    result: result === undefined ? 'undefined' : String(result),
  });
  return {
    ok: false,
    summary: '工具执行失败',
    detail: '后台未返回有效结果。',
  };
}

/**
 * 从响应文本里解析 XML 工具调用，用注入的工具目录识别。
 * 返回 `{ call, payload }` 供执行：找 `<tool>JSON</tool>` 块，body 为 JSON。
 *
 * ⚠️⚠️ **块扫描必须走线性扫描器（`findZaiToolXmlBlocks`），绝不能用 `[\s\S]*?` 正则。**
 * 那族正则在「开标签后跟**连续空白**、且全文没有配对闭合标签」时**灾难性回溯** ——
 * 实测 4,000 空白 6.5s / 8,000 空白 **49s**。而本函数的输入是 `assistantText`
 * （`handleResponseComplete` 兜底路径）与 `detected.raw`，**两者都来自桥消息、都没有长度上限**
 * ⇒ 模型输出一段「`<shell_exec>` + 大段缩进/空行」就能让内容脚本卡死数十秒。
 * 触发条件与修法见 `core/zai/tool-xml.ts` 的说明。
 */
function parseToolXml(
  text: string,
  descriptors: readonly ToolDescriptor[],
): ToolCall[] {
  const catalog = createToolInvocationCatalog(descriptors);
  const calls: ToolCall[] = [];
  const blocks = findZaiToolXmlBlocks(text, catalog.invocationNames);

  for (const block of blocks) {
    const matchedTag = block.name;
    const descriptor =
      catalog.descriptorByInvocationName.get(matchedTag) ??
      catalog.descriptorByName.get(matchedTag);
    // 关键：call.invocationName 必须是 descriptor 的权威 invocationName（长名），
    // 不能是扫描到的短名/别名。授权快照里存的是 descriptor.invocationName，
    // 短名会触发 tool_descriptor_mismatch（claims do not match authorized descriptor）。
    const invocationName = descriptor?.invocationName ?? matchedTag;
    // id 用「正文里出现的序号」而非全局 index，保证同一条消息里多个 memory_save 的
    // callId 稳定且唯一（否则三条 memory_save 全拿到 xml:0，被授权防重当成同一个调用，只执行第一条）。
    const id = `xml:${calls.length}`;
    let payload: Record<string, unknown> = {};
    let parseError;
    if (block.body) {
      try {
        const parsed = JSON.parse(block.body);
        payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (error) {
        parseError = {
          code: 'tool_call_json_invalid',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        };
      }
    }
    calls.push({
      id,
      name: descriptor?.name ?? invocationName,
      invocationName,
      payload,
      raw: block.raw,
      descriptorId: descriptor?.id,
      provider: descriptor?.provider,
      ...(parseError ? { parseError } : {}),
    });
  }
  return calls;
}

function isContinuableExecution(execution: ToolExecutionRecord): boolean {
  // 与 ds++ 的 selectContinuableToolExecutions 对齐：所有 MCP 工具（含用户自配）
  // + mcp capability + browser 都算可续跑；本地执行类工具（shell_/local_file_/python_）
  // 也一并算（它们在 z.ai 里是 Shell Local MCP server 的工具，provider.kind 是 mcp）。
  // 终态工具（memory_save/update/delete、skill_draft_create、memory_import_preview 等）
  // 不在此列 → 自然不可续跑。
  //
  // ⚠️⚠️ **这里的「按名字」是刻意的，不是漏改的身份判据 —— 别顺手删。**
  // 它问的不是「这个工具属于哪个 provider」，而是**「这一轮还值不值得继续跑」** ——
  // 方向是**向宽**：判错成「可续跑」只是多跑一轮，判错成「不可续跑」会让续跑循环
  // 提前收尾（自动化那边表现为卡到租约超时）。
  // 所以保留按名字的那几条作为**缺 provider 记录的安全网**：`provider` 在
  // `ToolExecutionRecord` 上是可选字段（工具历史编解码明确允许缺省），
  // 只认 provider 会在那种记录上恒 false。
  // ⚠️ `web` 那几条对应的扩展自带联网工具已删除，留下是为了**老会话里的历史记录**
  // 仍按「可续跑」处理 —— 它们可能出现在 `zai_pp_tool_history` 与页面历史里。
  return Boolean(
    !execution.pending &&
      (execution.provider?.kind === 'mcp' ||
        execution.provider?.id === MCP_CAPABILITY_TOOL_PROVIDER_ID ||
        execution.provider?.id === 'web' ||
        execution.provider?.id === 'browser_control' ||
        execution.name === 'web_search' ||
        execution.name === 'web_fetch' ||
        execution.name.startsWith('browser_') ||
        execution.name.startsWith('shell_') ||
        execution.name.startsWith('local_file_') ||
        execution.name.startsWith('python_')),
  );
}

// ---------------------------------------------------------------------------
// 请求增广
// ---------------------------------------------------------------------------

/**
 * 简单字符串哈希（djb2），用于给同一条消息里多个同类型工具生成稳定且唯一的 callId。
 *
 * ⚠️ 名字带算法：`core/tool/restore-block.ts` 另有一个同用途但**算法不同**的哈希
 * （`hash * 31`）。两者都只在本文件内使用、输出不落库，因此不需要统一 ——
 * 但名字必须能区分，否则读代码的人会以为改一处等于改另一处。
 */
function djb2Hash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

interface ActiveLocalSkill {
  resolved: ReturnType<typeof resolveSkills>;
  /** 激活的本地索引 Skill 的盘上目录；没激活则为 `undefined`。 */
  activeLocalSkillDir: string | undefined;
}

/**
 * 解析本轮激活的本地索引 Skill：显式 `/技能名` 触发优先；无触发词时按描述打分隐式激活
 * （受 `skillAutoActivation` 门控）。
 *
 * ⚠️ **必须在建授权之前调用** —— 它算出的 `activeLocalSkillDir` 要随
 * `CREATE_TOOL_AUTHORIZATION` 上报给后台，后台才可能在执行期把
 * `shell_exec` / `shell_session_begin` 的初始 cwd 归一到 Skill 目录
 * （`core/tool/local-skill-cwd.ts` 的 `enforceLocalSkillCwd`）。少了它，提示词里那句
 * 「Run commands with the initial cwd set to the Skill directory path」只是**软约束**。
 *
 * ⚠️ **值来自扩展自己算出的激活结果**，不是页面/模型声明的字段；后台仍会再校验一次它
 * 是不是某个已导入本地 Skill 的目录（`validateLocalSkillDirectory`），不是就丢弃。
 *
 * ⚠️ **抽成独立函数是因为建授权与提示词增广都要它，而两者顺序不能互换**（增广要授权返回的
 * descriptors，授权要这里的 dir）⇒ 只能先算好、再分别喂给两边。**同一件事算两遍必然分叉。**
 */
function resolveActiveLocalSkill(
  originalPrompt: string,
  isFirstMessage: boolean,
): ActiveLocalSkill {
  const locale = currentContentLocale ?? DEFAULT_LOCALE;
  const invocation = parseSkillCommand(originalPrompt);
  let resolved: ReturnType<typeof resolveSkills> = null;
  let activeLocalSkillDir: string | undefined;
  const skills: AugmentationSkill[] = currentSkills.filter((skill) => skill.enabled !== false);

  if (invocation) {
    const primarySkill = skills.find((skill) => skill.name === invocation.skillName);
    if (primarySkill && isLocalIndexSkill(primarySkill)) {
      activeLocalSkillDir = primarySkill.remote?.localDirectory || undefined;
    }
    resolved = resolveSkills(skills, invocation.skillName, invocation.args, locale);
  } else {
    const auto = currentSkillAutoActivation ?? DEFAULT_SKILL_AUTO_ACTIVATION_SETTINGS;
    const implicitAllowed = auto.everyMessage || (auto.firstMessage && isFirstMessage);
    if (implicitAllowed) {
      const picked = selectImplicitLocalSkill(skills, originalPrompt);
      if (picked) {
        activeLocalSkillDir = picked.remote?.localDirectory || undefined;
        resolved = { combinedPrompt: composeLocalSkillPrompt(picked), memoryEnabled: picked.memoryEnabled, skillName: picked.name };
      }
    }
  }
  return { resolved, activeLocalSkillDir };
}

function augmentPrompt(
  originalPrompt: string,
  options: {
    /**
     * **必须传已经过 `modelFacingDescriptorsFor` 的目录** —— 提示词里的工具清单就是
     * 模型「看不看得见」某个工具的唯一判据，所以这里**不再自己过滤**：
     * 过滤只发生在调用点那一处，同一份结果同时喂给提示词、标签识别与兜底解析。
     * ⚠️ 曾经的形态是「本函数内部过滤、只喂提示词」，而识别与解析用的是未过滤目录 ⇒
     * 两份名单分叉（见 `modelFacingDescriptorsFor` 的说明）。
     */
    toolDescriptors: readonly ToolDescriptor[];
    isFirstMessage?: boolean;
    /** 本轮的 Skill 激活结果，由调用方经 `resolveActiveLocalSkill` 算出（见其说明）。 */
    skillActivation: ActiveLocalSkill;
  },
): string {
  const isFirstMessage = options?.isFirstMessage ?? true;
  const modelFacing = options.toolDescriptors;
  const locale = currentContentLocale ?? DEFAULT_LOCALE;
  const scopedMemories = currentMemories;

  // 预设 + 强制回复语言：对齐 ds++ 的 augmentDecodedRequestBody 逻辑。
  const promptSettings = currentPromptSettings ?? DEFAULT_PROMPT_INJECTION_SETTINGS;
  const messageCount = isFirstMessage ? 1 : currentRequestMessageCount + 1;
  const shouldInjectPreset = shouldInjectPresetForTurn({
    hasActivePreset: Boolean(currentActivePreset),
    isFirstMessage,
    messageCount,
    cadence: promptSettings.presetCadence,
  });
  const presetContent = shouldInjectPreset ? currentActivePreset?.content ?? null : null;
  const forceResponseLanguage = promptSettings.forceResponseLanguage === 'auto'
    ? null
    : promptSettings.forceResponseLanguage;
  const memoryEnabled = promptSettings.memoryEnabled;
  const systemPromptEnabled = promptSettings.systemPromptEnabled;

  // Skill 激活：由调用方在建授权之前算好传进来（它同时要拿去建授权，见函数说明）。
  const { resolved, activeLocalSkillDir } = options.skillActivation;

  // local index skill → 激活指令 + index 注入 system context（强制先读 SKILL.md）。
  // custom/builtin skill → 指令作为「可见用户输入」注入（原用户输入压进 metadata），
  // 不走「读 SKILL.md」指令（custom skill 没有盘上定义文件）。
  // identityOnly：skill 声明 memoryEnabled=false 时只注入身份/禁用记忆（ds++ 语义）。
  if (resolved) {
    const identityOnly = !resolved.memoryEnabled;
    if (activeLocalSkillDir !== undefined) {
      const result = buildPromptAugmentation(originalPrompt, {
        memories: scopedMemories,
        identityOnly,
        toolDescriptors: modelFacing,
        skillSystemContext: buildLocalSkillSystemContext(resolved, activeLocalSkillDir, locale),
        presetContent,
        locale,
        memoryEnabled,
        systemPromptEnabled,
        forceResponseLanguage,
      });
      return result.augmented;
    }
    const result = buildPromptAugmentation(resolved.combinedPrompt, {
      memories: scopedMemories,
      identityOnly,
      toolDescriptors: modelFacing,
      visibleUserPrompt: originalPrompt,
      presetContent,
      locale,
      memoryEnabled,
      systemPromptEnabled,
      forceResponseLanguage,
    });
    return result.augmented;
  }

  const result = buildPromptAugmentation(originalPrompt, {
    memories: scopedMemories,
    toolDescriptors: modelFacing,
    presetContent,
    locale,
    memoryEnabled,
    systemPromptEnabled,
    forceResponseLanguage,
  });
  return result.augmented;
}

async function handleAugmentRequestBody(
  message: Record<string, unknown>,
): Promise<void> {
  const id = typeof message.id === 'string' ? message.id : '';
  const mainRequestId = typeof message.requestId === 'string' ? message.requestId : '';
  const route = message.route === 'chatNew' ? 'chatNew' : 'completion';
  const bodyStr = typeof message.body === 'string' ? message.body : '';

  if (!id) return;
  if (!bodyStr) {
    postToMainWorld({ type: 'AUGMENT_REQUEST_BODY_RESULT', id, ok: true, result: null });
    return;
  }

  const body = parseZaiBody(bodyStr);
  if (!body) {
    postToMainWorld({ type: 'AUGMENT_REQUEST_BODY_RESULT', id, ok: true, result: null });
    return;
  }

  const requestId = mainRequestId || crypto.randomUUID();
  const chatSessionId = getCurrentChatSessionId();
  // ⚠️ **`chatSessionIdByRequestId` 不在这里写** —— chatNew 请求收不到 `REQUEST_TERMINAL`
  // （`fetch-hook` 只在 completion 路由发 `onRequestTerminal`），写进去就是**永不释放的孤儿**；
  // 而它的唯一读点在 `executeDetected`，那条路只可能由 completion 轮的 requestId 走到。
  // 写入点放在下面的 completion 段（见「记下 requestId → chatSessionId」）。

  try {
    if (route === 'chatNew') {
      const parsed = parseZaiChatNewBody(body);
      if (!parsed) {
        postToMainWorld({ type: 'AUGMENT_REQUEST_BODY_RESULT', id, ok: true, result: null });
        return;
      }
      // 先建授权（走 toolIntent → 后台 projectMcpCapabilityDescriptors 做 MCP capability 投影），
      // 再拿授权返回的 descriptors 做增广。首条消息 isFirstMessage=true。
      const firstText = parsed.userMessageTexts[0] ?? '';

      // 任务归属提前：在任何 await（尤其 createToolAuthorization）之前就按
      // 原文认领 task 并置 running。授权失败/抛错时认领依然生效，避免自动化发送回调
      // waitForDomTaskRecognized 误判「未发出」→ sendPromptViaPage retry 再发第二条
      // chatNew → 双会话 → 页面状态错乱不跳 /c/<id>。**不 delete prompt 映射、不占
      // requestId**：正式归属（set taskIdByRequestId / delete）仍留给随后的 completion。
      const firstTaskId = taskIdByPromptText.get(firstText);
      if (firstTaskId) {
        const task = activeDomTasks.get(firstTaskId);
        if (task && (task.status === 'pending' || task.status === 'injected')) {
          task.status = 'running';
          task.chatSessionId = chatSessionId;
          void sendRuntimeMessage({
            type: 'DOM_TASK_STARTED',
            taskId: firstTaskId,
            chatSessionId,
          });
        }
      }

      // ⚠️ **Skill 激活必须早于建授权** —— 它算出的 `activeLocalSkillDir` 要随授权一起
      // 上报给后台，后台才可能在执行期把 `shell_exec` 的初始 cwd 归一到 Skill 目录。
      // 顺序反过来（先建授权再激活）就只能拿到一份没有 dir 的 grant，而**表现是静默的**：
      // 提示词里照样写着「initial cwd set to the Skill directory path」，只是没人强制它。
      const skillActivation = resolveActiveLocalSkill(firstText, true);

      const authorization = await createToolAuthorization({
        requestId,
        chatSessionId,
        toolIntent: firstText.slice(0, 16_000),
        localSkillDir: skillActivation.activeLocalSkillDir,
      });
      // ⚠️ **这份 grant 既不进 `activeToolAuthorizations`、也不写
      // `requestToolDescriptorsByRequestId`** —— chatNew 请求**没有终态事件**
      // （`fetch-hook` 只在 completion 路由发 `onRequestTerminal`），而它与随后的 completion
      // 是**两次独立 fetch、两个不同 requestId** ⇒ 写进任何一个 Map 都**无人释放**（孤儿增长）。
      // 两个 Map 的读点读的也都是 completion 的 requestId ⇒ 写了**还无人读**：首条的工具标签
      // 识别靠 completion 轮那份，`executeDetected` 也只可能被 completion 轮的 requestId 调到。
      // ⚠️ 但 grant 本身**必须还**：它已经用来取 `authorization.descriptors`（再过滤成
      // `modelFacing`）做增广，而且它占着后台的 grant 名额（`MAX_ACTIVE_GRANTS = 32`，
      // 满了会让**之后所有**建授权抛 `tool_authorization_grant_limit`）。
      // 所以增广结果回传之后**显式关掉**它 —— 走 `closeToolAuthorizationGrant`（只关后台、不碰 Map）。
      // 本请求的模型可见目录：**提示词、标签识别、兜底解析共用这一份**（见
      // `modelFacingDescriptorsFor`）。这里由授权返回的完整目录过滤而来。
      const modelFacing = modelFacingDescriptorsFor(authorization.descriptors);
      // 首条（chats/new）始终增强：把工具目录 + 记忆注入，让模型在建会话
      // 那一刻就学会工具用法（shell 写文件、memory 等）。首条注入不会污染
      // parent 链（首条是会话起点，无 parent）。
      const augmented = parsed.userMessageTexts.map((text) =>
        augmentPrompt(text, {
          toolDescriptors: modelFacing,
          isFirstMessage: true,
          skillActivation,
        }),
      );
      const nextBody = rewriteZaiChatNewUserMessages(body, augmented);

      const chatNewTask = firstTaskId ? activeDomTasks.get(firstTaskId) : undefined;
      // 模型覆写（chatNew 阶段）：会话模型在**建会话那一刻**定下 —— 落点是
      // `chat.models`（与首条 user 消息的 `models` 同值），由路由决定，见
      // `applyZaiModelOverrideForRoute`。这一步不能省：只在 completion 阶段写
      // 改不动已有会话。
      // ⚠️ **agent 轮同样覆写** —— 真机实测 agent 的请求体里模型字段是活的
      // （同一会话不同轮次会带不同 id），用户选的模型能进 body；挡着它的只有
      // 「服务端按 general_agent 装配」这个从未验证过的假设。
      // 写函数自带「只在字段已存在时覆写」的守卫 ⇒ 页面发哪个字段就改哪个。
      applyZaiModelOverrideForRoute(nextBody, 'chatNew', chatNewTask?.model ?? null);
      postToMainWorld({
        type: 'AUGMENT_REQUEST_BODY_RESULT',
        id,
        ok: true,
        result: {
          body: JSON.stringify(nextBody),
          requestId,
          // ⚠️ **回传本请求实际注入提示词的那份描述符名**（就是上面那份过滤后的
          // `modelFacing`），不是全局 `currentCatalogNames`、也不是未过滤的
          // `authorization.descriptors` —— 主世界识别 XML 标签时用这份，才能与提示词
          // 严格同源。⚠️ 用未过滤的授权目录会让「模型可见目录里没有的工具」仍被识别并执行。
          toolDescriptorNames: catalogNamesFor(modelFacing),
        },
      });
      // 增广结果已经回传（主世界的 pending 请求在那一刻就 resolve 了），所以这里**不 await** ——
      // 关 grant 是一次后台往返，没必要压在请求热路径上。
      void closeToolAuthorizationGrant(authorization.id).catch((error: unknown) => {
        console.error('[Zai++] closing the chatNew tool authorization failed', error);
      });
      return;
    }

    // completion 路由
    const originalPrompt = readZaiLastUserMessageText(body);
    if (!originalPrompt) {
      postToMainWorld({ type: 'AUGMENT_REQUEST_BODY_RESULT', id, ok: true, result: null });
      return;
    }

    // 记下 requestId → chatSessionId，执行工具时补全 source.chatSessionId。
    // ⚠️ **只写 completion 路由**（含续跑轮）：这两条都会收到 `REQUEST_TERMINAL`，
    // 由 `releaseRequestState` 释放；chatNew 收不到，写进去就是孤儿（见上面的说明）。
    chatSessionIdByRequestId.set(requestId, chatSessionId);

    // 任务归属：DOM 任务的首条注入不是续跑模板、isContinuationRequest 不命中，
    // 必须在这里按 prompt 原文显式登记 requestId → taskId，并发出 DOM_TASK_STARTED。
    let matchedTask: ActiveDomTask | undefined;
    const matchedTaskId = taskIdByPromptText.get(originalPrompt);
    if (matchedTaskId) {
      taskIdByRequestId.set(requestId, matchedTaskId);
      taskIdByPromptText.delete(originalPrompt);
      const task = activeDomTasks.get(matchedTaskId);
      if (task && (task.status === 'pending' || task.status === 'injected')) {
        task.status = 'running';
        task.chatSessionId = chatSessionId;
        void sendRuntimeMessage({
          type: 'DOM_TASK_STARTED',
          taskId: matchedTaskId,
          chatSessionId,
        });
      }
      matchedTask = task;
    }

    // 续跑请求：透传 body 不重灌工具目录，但每轮新建授权（防上一轮 grant 被关掉）。
    if (isContinuationRequest(originalPrompt)) {
      // 续跑轮同样登记 requestId → taskId：手动停止检测（armManualStopDetection）与
      // HTML_CHALLENGE 推进都靠这两个登记项定位「在飞的那一轮」。此前这里直接 return，
      // 导致续跑期间点 Stop 完全检测不到 → 只能等 180s 执行租约超时。
      if (continuationLoop?.status === 'running') {
        continuationLoop.activeRequestId = requestId;
        if (continuationLoop.taskId) {
          taskIdByRequestId.set(requestId, continuationLoop.taskId);
        }
      }
      const auth = await createToolAuthorization({
        requestId,
        chatSessionId,
        descriptorIds: currentToolDescriptors.map((d) => d.id),
        // 续跑轮不重跑 Skill 激活（prompt 是模板，重跑必然拿不到），沿用启动该循环那轮记下的。
        // ⚠️ **循环已不在时（`continuationLoop` 为 null）这一轮退化为「只保留提示词软约束」**，
        // 与改动前一致 —— 此刻无法凭空造出 dir，可选动作只有「放行」或「让这一轮显式失败」，
        // 而后者会把「用户手打一段形似续跑模板的文本」从正常回答变成工具全不可用，属行为改动。
        localSkillDir: continuationLoop?.localSkillDir ?? undefined,
      });
      activeToolAuthorizations.set(requestId, auth);
      // 本请求的模型可见目录（续跑轮）：**与提示词、识别、解析共用同一份**。
      const modelFacing = modelFacingDescriptorsFor(auth.descriptors);
      requestToolDescriptorsByRequestId.set(requestId, modelFacing);
      // 续跑轮同样把任务选定的模型写回请求体：页面每轮都会重新带 model，
      // 只在首条写会退回到页面默认。
      // ⚠️ **agent 轮同样写** —— 真机实测 agent 的 completion body 带顶层 `model`，
      // 且不同轮次是不同的 id ⇒ 模型字段是活的，不是「服务端自己装配」。
      const loopTask = continuationLoop?.taskId != null
        ? activeDomTasks.get(continuationLoop.taskId)
        : undefined;
      const continuationModel: string | null =
        matchedTask?.model ?? loopTask?.model ?? continuationLoop?.model ?? null;
      let nextBodyStr = bodyStr;
      if (continuationModel) {
        const parsedBody = parseZaiBody(bodyStr);
        if (parsedBody) {
          // 续跑轮走 completion 端点 → 落点是顶层 `model`，由路由决定。
          applyZaiModelOverrideForRoute(parsedBody, 'completion', continuationModel);
          nextBodyStr = JSON.stringify(parsedBody);
        }
      }
      postToMainWorld({
        type: 'AUGMENT_REQUEST_BODY_RESULT',
        id,
        ok: true,
        result: {
          body: nextBodyStr,
          requestId,
          // 回传本请求实际注入提示词的那份描述符名（上面过滤后的 `modelFacing`），
          // 理由同 chatNew 分支 —— 用未过滤目录会让关掉的工具仍被识别并执行。
          toolDescriptorNames: catalogNamesFor(modelFacing),
        },
      });
      return;
    }

    // 首条判定只读 body（纯函数、无 await），提前到这里 ——
    // 因为 **Skill 激活要用 `isFirstMessage`**（隐式激活的 `firstMessage` 门控依赖它），
    // 而 Skill 激活必须早于建授权（见下）。
    const parentId = readZaiCurrentUserMessageParentId(body);
    const isFirstMessage = parentId === null || parentId === undefined;

    // ⚠️ **Skill 激活必须早于建授权** —— `activeLocalSkillDir` 要随授权上报给后台，
    // 后台才可能把 `shell_exec` / `shell_session_begin` 的初始 cwd 归一到 Skill 目录。
    // 顺序反了只会得到一份没有 dir 的 grant，而表现是静默的（提示词里的软约束照旧在）。
    const skillActivation = resolveActiveLocalSkill(originalPrompt, isFirstMessage);

    // 先建授权（toolIntent → MCP capability 投影），再用授权返回的 descriptors 增广。
    const auth = await createToolAuthorization({
      requestId,
      chatSessionId,
      toolIntent: originalPrompt.slice(0, 16_000),
      localSkillDir: skillActivation.activeLocalSkillDir,
    });
    activeToolAuthorizations.set(requestId, auth);
    // 记下本轮的 Skill 目录：续跑循环要用（续跑 prompt 是模板，重跑激活只会得到 null）。
    if (skillActivation.activeLocalSkillDir !== undefined) {
      localSkillDirByRequestId.set(requestId, skillActivation.activeLocalSkillDir);
    }
    // 本请求的模型可见目录：**提示词、标签识别、兜底解析共用这一份**（见
    // `modelFacingDescriptorsFor`）。⚠️ 存进 Map 的必须是**过滤后**的这份 ——
    // 它同时是「主世界认不认这个标签」与「兜底解析认不认这个块」的判据。
    const modelFacing = modelFacingDescriptorsFor(auth.descriptors);
    requestToolDescriptorsByRequestId.set(requestId, modelFacing);
    // 每轮都增强（含续写轮）。
    //
    // 这里历史上曾按「本轮是否联网」跳过续写轮注入（`searchMode === 'off' || isFirstMessage`），
    // 那是为了让页面原生联网能正常工作 —— 原生通道在续写轮会因 messages.content 被替换而
    // 不再装配工具。原生通道后来不再由扩展接管，那个前提不复存在，跳过的理由也随之作废。
    const augmented = augmentPrompt(originalPrompt, {
      toolDescriptors: modelFacing,
      isFirstMessage,
      skillActivation,
    });
    currentRequestMessageCount = isFirstMessage ? 1 : currentRequestMessageCount + 1;
    const nextBody = rewriteZaiLastUserMessage(body, augmented);
    // 关键：signature_prompt 是服务端权威 prompt、参与续写链 parent 校验与历史存储，
    // 必须始终是「用户原文」。而模型读的是 messages.content（系统注入 + 标记包裹原文）。
    const visibleOriginal = extractVisibleUserPrompt(augmented) ?? originalPrompt;
    (nextBody as Record<string, unknown>).signature_prompt = visibleOriginal;

    // 模型覆写：请求归属到自动化任务时覆写 body 的 model。
    // ⚠️ **agent 轮同样覆写** —— 真机实测 agent 的 completion body 带顶层 `model`，
    // 且不同轮次是不同的 id ⇒ 模型字段是活的，不是「服务端自己装配」。
    applyZaiModelOverrideForRoute(nextBody, 'completion', matchedTask?.model ?? null);

    // 记忆命中 → 后台 touch。
    await sendRuntimeMessage({ type: 'TOUCH_MEMORIES', payload: { ids: [] } }).catch(() => undefined);

    postToMainWorld({
      type: 'AUGMENT_REQUEST_BODY_RESULT',
      id,
      ok: true,
      result: {
        body: JSON.stringify(nextBody),
        requestId,
        // 回传本请求实际注入提示词的那份描述符名（上面过滤后的 `modelFacing`），
        // 理由见 chatNew 分支的说明。
        toolDescriptorNames: catalogNamesFor(modelFacing),
      },
    });
  } catch (error) {
    if (isExtensionInvalidatedError(error)) invalidateExtensionContext();
    postToMainWorld({
      type: 'AUGMENT_REQUEST_BODY_RESULT',
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// 主世界消息分发
// ---------------------------------------------------------------------------

async function dispatchMainWorldMessage(data: Record<string, unknown>): Promise<void> {
  // 两个请求计数器**都必须在串行队列之外涨** —— `waitForSendEvidence` 本身就跑在队列里
  // （`settleToolTurn` → `handleResponseComplete` → `advanceContinuationLoop` → 发送链），
  // 它占着队列等这两个数变大；若增量发生在队列内，那个增量永远排不到 ⇒ **自锁**，
  // 只能等满 5 秒窗口再判成「没证据」。这就是这两个自增放在这里而不是各自处理函数里的原因。
  //
  // ⚠️ **两件事、两个计数器，别合并**：
  // ① `observedAugRequestCount` = 桥消息到了几条（语义是「请求要发出去了」，与内容无关）；
  // ② `continuationRequestSeq` = 其中几条是**续跑模板**（`waitForSendEvidence` 的主判据）。
  // 两者的差值说明「请求出去了、但这一发不是我们注入的模板」—— 那也算发出去了。
  if (data.type === 'AUGMENT_REQUEST_BODY') {
    // 记账规则本身在 `core/zai/send-evidence.ts`（纯函数、可被真输入喂满）；
    // 这里只负责「在队列外同步调用」这一件事 —— 而它恰恰是那条约束的全部。
    const delta = classifyAugmentRequest(
      data.body,
      data.route === 'chatNew' ? 'chatNew' : 'completion',
    );
    observedAugRequestCount += delta.requestDelta;
    continuationRequestSeq += delta.continuationDelta;
    // ⚠️ **必须在这里叫醒**（同步区、串行队列之外）—— 等它们的代码正占着串行队列，
    // 在队列内 notify 等于让它等自己。见 `augProgressWaiters` 的说明。
    augProgressWaiters.notify();
  }
  // 「响应已到达」的登记同样必须在串行队列**之外**、消息抵达瞬间完成。
  // ⚠️ **它是「是否用户手动停止」的判据**（`armManualStopDetection` 挂窗口时与窗口到期时各读一次
  // `respondedRequestIds`），而那个判定只有 4 秒宽限窗口；`RESPONSE_COMPLETE` 却常常排在一段
  // 十几秒的工具执行之后（`TOOL_CALL` 分支要 await 整条执行链，MCP 工具默认 120 秒上界）⇒ 在队列内
  // 登记会让慢工具被误判成「用户手动停止」，并连带摘掉 taskId、回收续跑循环。
  // 与上面那段同一个坑、同一处落点：判据的源头必须在队列外。
  // ⚠️ **解码一并前置**：主世界发的 `RESPONSE_COMPLETE` 载荷本就只有一个信封层
  // （`data.payload`），一次解码即可；解出的结果经参数传进队列内的分发器，
  // 队列内**不再解第二遍** —— 否则同一个类型会有两个接收块，与桥契约里
  // 「每个类型恰好一个接收块」的判据冲突（那种形状下契约守卫会把两处都收进去）。
  let decodedResponseComplete: ZaiResponseCompletePayload | null = null;
  if (data.type === 'RESPONSE_COMPLETE') {
    const complete = decodeZaiResponseCompleteMessage(data.payload);
    decodedResponseComplete = complete;
    if (complete) {
      respondedRequestIds.add(complete.requestId);
      const timer = manualStopTimers.get(complete.requestId);
      if (timer) {
        clearTimeout(timer);
        manualStopTimers.delete(complete.requestId);
      }
    }
  }
  // 串行队列：`TOOL_CALL` / `RESPONSE_COMPLETE` / `REQUEST_TERMINAL` 之间要串行，
  // 消除「响应先完成、授权后被关」这类交错。队列本体见 `mainWorldQueue` 的说明。
  await mainWorldQueue.run(() => dispatchMainWorldMessageInner(data, decodedResponseComplete));
}

/**
 * ⚠️ **`decodedResponseComplete` 由调用方在队列之外解好传进来**（见 `dispatchMainWorldMessage`）——
 * 「响应已到达」的登记（`respondedRequestIds` / 清 timer）必须在队列外完成，判据才有意义；
 * 解码跟着一起来是为了**同一个类型只留一个接收块**，不是解码必须在队列外。
 */
async function dispatchMainWorldMessageInner(
  data: Record<string, unknown>,
  decodedResponseComplete: ZaiResponseCompletePayload | null = null,
): Promise<void> {
  try {
    switch (data.type) {
      case 'AUGMENT_REQUEST_BODY': {
        await handleAugmentRequestBody(data);
        return;
      }
      case 'HEADERS_CAPTURED': {
        // 主世界把 token/user_id/fe 版本/设备指纹抓到这里，写进 chrome.storage 供
        // automation 后台复用（后台 service worker 拿不到页面 localStorage/performance）。
        const captured = data.headers as Record<string, string> | undefined;
        if (captured && (captured.token || captured.user_id || captured.Authorization)) {
          // ⚠️ **写进本页所属站的桶** —— 内容脚本就在页面上，`location.origin` 是
          // 「这个 token 属于哪一站」的直接证据，不需要任何推断。
          void mergeZaiAuthFromCapture({
            token: captured.token,
            userId: captured.user_id,
            feVersion: captured['X-FE-Version'] ?? captured.feVersion,
            deviceId: captured['x-device-id'] ?? captured.deviceId,
          }, currentSiteOrigin());
        }
        return;
      }
      case 'TOOL_CALL': {
        // 载荷必须过 decoder：这条**有执行语义**（→ parseToolXml → executeDetected，
        // 而那里查不到 grant 会现场建一个）。非法载荷一律丢弃，不新造拒绝分支。
        const call = decodeZaiToolCallMessage(data.data);
        if (!call) {
          console.error('[Zai++] rejected a malformed TOOL_CALL payload');
          return;
        }
        // ⚠️ **不 await** —— 执行会跑十几秒（MCP 工具默认 120 秒上界），await 会把它后面
        // 的 `RESPONSE_COMPLETE` / `REQUEST_TERMINAL` 全堵在这条串行队列里
        // ⇒ 慢工具被误判成「用户手动停止」、8 秒的增广超时也会连带触发。
        // 执行改由 `startDetectedToolCall` 挂到本请求的执行串行链上，队列只做记账。
        startDetectedToolCall(call);
        return;
      }
      case 'RESPONSE_COMPLETE': {
        // ⚠️ 这条**同样有执行语义** —— handleResponseComplete 会在
        // executionsByRequest 为空时拿 assistantText 跑 parseToolXml 兜底执行工具。
        // 载荷由调用方在队列之外解好传进来（见 `dispatchMainWorldMessage`），这里不再解第二遍。
        if (!decodedResponseComplete) {
          console.error('[Zai++] rejected a malformed RESPONSE_COMPLETE payload');
          return;
        }
        // 响应到达**不是**在这里消费 —— 先存进会合状态，等工具执行也齐了再一次性消费
        // （见 `settleToolTurn`）。执行已在 TOOL_CALL 通道跑完时，会合点会立刻消费。
        ensureToolTurnState(decodedResponseComplete.requestId).response = decodedResponseComplete;
        settleToolTurn(decodedResponseComplete.requestId);
        return;
      }
      case 'HISTORY_TOOL_RECORDS': {
        // 历史清洗剥出工具块时顺手送来的归属记录 —— 面板跨刷新恢复的**锚点来源**。
        // ⚠️ 形状不对一律丢弃（同其它 decoder）：这几条会变成页面上的可见内容。
        // ⚠️⚠️ **传的是整条信封 `data`，不是 `data.records`** —— 主世界把数组**平铺**
        // 挂在信封上（`postToContent({ type, records })`），而 decoder 读的是 `value.records`
        // ⇒ 传数组进去会让 `isPlainRecord` 判否、**整批记录被静默丢弃**。
        // 这个坑的成因是 decoder 的调用口径在两种形状之间摇摆：
        // `TOOL_CALL` 那几条传的是嵌套载荷（`data.data` / `data.payload`），
        // 而 `SYNC_HOOK_STATE` 与这条一样是**平铺**在信封上 ⇒ 传 `data`。
        // **判据是「字段长在哪一层」，不是「别人怎么传」。**
        const decoded = decodeZaiHistoryToolRecordsMessage(data);
        if (!decoded) {
          console.error('[Zai++] rejected a malformed HISTORY_TOOL_RECORDS payload');
          return;
        }
        toolPanel.rememberHistoryRecords(decoded.records, decoded.chatSessionId);
        return;
      }
      case 'USAGE_SNAPSHOT': {
        await handleUsageSnapshot(data.payload);
        return;
      }
      case 'REQUEST_TERMINAL': {
        const terminal = decodeZaiRequestTerminalMessage(data.payload);
        if (!terminal) {
          console.error('[Zai++] rejected a malformed REQUEST_TERMINAL payload');
          return;
        }
        const requestId = terminal.requestId;
        // ⚠️ **收尾不在这里直接做** —— 先标记「终态已到」，再由 `tryFinalizeRequest`
        // 判断此刻能不能收（它还要求执行已齐、响应已消费）。
        // ⚠️ **即使本请求一个工具都没跑过也要建条目** —— 否则 `tryFinalizeRequest`
        // 会在第一行直接返回，收尾整块不执行（授权永不关、请求级状态永不释放）。
        // decoder 已保证 requestId 是非空字符串，下面的判定不必再判空。
        ensureToolTurnState(requestId).terminalSeen = true;
        await tryFinalizeRequest(requestId);
        return;
      }
      case 'HTML_CHALLENGE': {
        // completion 返回 HTML：推进续跑而不是干等。
        const challenge = decodeZaiHtmlChallengeMessage(data.payload);
        if (!challenge) {
          console.error('[Zai++] rejected a malformed HTML_CHALLENGE payload');
          return;
        }
        const requestId = challenge.requestId;
        if (continuationLoop?.status === 'running' && continuationLoop.activeRequestId === requestId) {
          const expectedLoop = continuationLoop;
          setTimeout(() => {
            // 延迟到期时复检：期间可能已被别的 RESPONSE_COMPLETE 推进过、
            // 或整个循环已收尾 —— 不复检会重复注入同一轮。
            if (continuationLoop !== expectedLoop || expectedLoop.status !== 'running') return;
            if (expectedLoop.activeRequestId !== requestId) return;
            // ⚠️⚠️ **必须接住 rejection**：这条链是 `advanceContinuationLoop` →
            // `submitContinuationViaPage` → 注入原语，整条只有 try/finally、**没有 catch**。
            // 它跑在 `setTimeout` 里，**不在** `dispatchMainWorldMessage` 的外层 catch 之内
            // （也不在 `settleToolTurn` 的 catch 之内）⇒ 一次抛错就是 **unhandled rejection**，
            // 而未处理的拒绝同样会进 `chrome://extensions` 的错误列表，且比 `console.error` 更难压。
            // `handleResponseComplete` 那两条 `advanceContinuationLoop` 调用点有 `settleToolTurn`
            // 兜着，只有这一条没有。
            advanceContinuationLoop().catch((error: unknown) => {
              // 与分发器/会合点两处文案**刻意不同**：看日志时要能一眼分出是挑战页这条路径。
              if (isExtensionInvalidatedError(error)) invalidateExtensionContext();
              else console.error('[Zai++] continuation advance after HTML challenge failed', error);
            });
          }, ZAI_CONTINUATION_DELAY_MS);
        }
        return;
      }
    }
  } catch (error) {
    if (isExtensionInvalidatedError(error)) invalidateExtensionContext();
    else console.error('[Zai++] main-world message handling failed', error);
  }
}

// ---------------------------------------------------------------------------
// 工具执行 + 续跑状态机
// ---------------------------------------------------------------------------

/**
 * 登记一条工具调用，并**在串行队列之外**执行它。
 *
 * ⚠️⚠️ **`pendingExecutions += 1` 必须是同步的、且在启动执行之前** ——
 * `RESPONSE_COMPLETE` 排在队列里、紧随这条消息之后；若计数还没加，
 * 会合点会以为「执行已齐」而**提前消费响应** ⇒ `handleResponseComplete` 读到空的
 * `executionsByRequest` ⇒ 走兜底解析再执行一遍（被签名去重挡掉）⇒ 续跑判定当场收尾。
 *
 * ⚠️ **执行挂在本请求的执行串行链上**，而不是各自起跑 —— 现状里同一回复的多个工具
 * 由串行队列**逐条 await**、天然串行；踢出队列后若并发起跑，会改变这一既有行为
 * （同文件两次写、两次 shell 命令这类组合）。
 *
 * ⚠️ **`-1` 放在链条末尾而不是 `executeDetected` 内部** —— 执行有两条调用路
 * （这条通道、`handleResponseComplete` 的兜底），把计数放内部会让兜底路径重复计数。
 * 兜底那条路全程在队列内被 await，此刻计数恒为 0、无人观察其中间态，因此不需要计数。
 *
 * 面板那行「执行中」也在这里落 —— ⚠️ **不能挪进 `executeDetected`**：它同样会被
 * 兜底路径调到，而那条路是「补执行」，再塞一行会给用户一个稍纵即逝的闪烁。
 */
function startDetectedToolCall(detected: ZaiDetectedToolCall): void {
  // 载荷已过 `decodeZaiToolCallMessage`（name / raw / requestId 都是字符串、name 非空），
  // 这里的判空只作为防御性兜底保留。
  if (!detected?.name) return;
  // 面板：先落一行「执行中」（64 要收尾的就是它）。
  // ⚠️ **callId 用 `detected.raw` 的哈希** —— 与 `executeDetected` 里算 `stableCallId`
  // 的输入一致（同一条 raw 两个通道拿到的 id 相同），否则替换那一步会找不到行。
  toolPanel.beginToolCall(detected.requestId, {
    callId: `xml:${djb2Hash(detected.raw || detected.name)}`,
    name: detected.name,
    // ⚠️ **raw 也传下去** —— 它是面板记录合流签名的一半。不传的话实时腿的签名
    // 恒为「工具名 + 空串」，与历史腿的「工具名 + XML 原文」永远配不上
    // ⇒ 一旦消息 uuid 读不到（id 退化成 `live:<requestId>`），同一轮会画两块面板。
    raw: detected.raw,
  });
  const state = ensureToolTurnState(detected.requestId);
  state.pendingExecutions += 1;
  state.executionChain = state.executionChain
    .then(() => executeDetectedFromDetected(detected))
    .catch((error) => {
      console.log('[Zai++] executing a detected tool call failed', {
        name: detected.name,
        requestId: detected.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      // ⚠️ **减计数必须在 `finally`** —— 只在成功分支减的话，一次执行抛错就会让计数
      // 永久 > 0 ⇒ 终态收尾永不执行 ⇒ 授权与请求级状态一起泄漏，而**表现是静默的**
      // （不报错，只是后台 grant 名额被慢慢占满）。
      state.pendingExecutions -= 1;
      // 执行落地 = 会合点的第二个唤醒源（第一个是 `RESPONSE_COMPLETE` 到达）。
      settleToolTurn(detected.requestId);
    })
    // ⚠️ **链条自身必须永不 reject** —— 否则一次异常会毒化后续所有工具的执行
    // （下一条接的是只带 onFulfilled 的 `.then`，rejection 会直接穿透过去、跳过执行）。
    .catch(() => undefined);
}

async function executeDetectedFromDetected(
  detected: ZaiDetectedToolCall,
): Promise<void> {
  // 注意：不能用 requestId 粒度去重！fetch-hook 对同一条模型回复里的每个工具
  // 单独发一条 TOOL_CALL 消息（requestId 相同、raw 不同）。若按 requestId 去重，
  // 第二个工具（如 memory_save 之后的 shell_status）会被误判「已执行」而跳过，
  // 导致「记住+看桌面」这类多工具回复只执行第一个工具。
  // 真正的重复由 executeDetected 内部的 executedToolCallSignatures（requestId+name+callId）兜底。
  // ⚠️ 用**本请求实际注入的那份描述符**（`modelFacingForRequest`），不是全局
  // `currentToolDescriptors` —— 后者是「上次同步」、且**未过滤**，与提示词会分叉。
  // 未增广的请求（拿不到本请求名单）退回全局目录，但**仍然过一遍过滤** ——
  // 保住「老会话里的 XML 仍能执行」，同时保住「关掉的工具不被识别」。
  const calls = parseToolXml(detected.raw, modelFacingForRequest(detected.requestId));
  if (calls.length === 0) {
    console.log('[Zai++] a detected tool call could not be parsed', {
      name: detected.name,
      requestId: detected.requestId,
      catalogNames: currentCatalogNames,
    });
    return;
  }
  for (const call of calls) {
    await executeDetected(call, detected.requestId);
  }
}

/**
 * 建授权，**描述符对不上时先刷新再重试一次**。
 *
 * `unknown_tool_authorization_descriptor` 表示我们这份工具目录已经过期
 * （用户中途加了 skill / MCP，或后台重启后重算了 id）—— 把陈旧列表原样重发
 * 只会得到同一个错，所以这里先同步一次运行时状态、拿最新清单再试一次。
 *
 * ⚠️ **重试用的是本次同步的返回值，不是 `currentToolDescriptors`** —— 模块状态按
 * 「最新一次同步生效」落地，而本次同步完全可能被一条更新的同步顶掉；那时去读模块状态
 * 会拿到别的东西（可能还是旧清单），重试就白做了，且失败是静默的（第二次照样报同一个错）。
 * 这条重试在串行队列内，它要的是「我这次拿到的这一份」。
 *
 * ⚠️ `localSkillDir` 由调用方给 —— 它决定后台的 cwd 门禁要不要把这个 grant 的 shell 调用
 * 归一到 Skill 目录（见 `core/tool/local-skill-cwd.ts`）。传 `undefined` 等于「这一轮没有
 * 激活本地 Skill」，`enforceLocalSkillCwd` 会原样放行 cwd。**别在这里凭空兜底一个值**：
 * 来源只有两个（本轮激活结果 / 续跑循环记下的），拿不到就是真的没有。
 */
async function requestToolAuthorization(
  requestId: string,
  chatSessionId: string | null,
  localSkillDir: string | undefined,
): Promise<ToolAuthorizationGrantSummary> {
  try {
    return await createToolAuthorization({
      requestId,
      chatSessionId,
      descriptorIds: currentToolDescriptors.map((d) => d.id),
      localSkillDir,
    });
  } catch (error) {
    if (!(error instanceof ToolAuthorizationRequestError)
      || error.code !== 'unknown_tool_authorization_descriptor') {
      throw error;
    }
    const { descriptors, fresh } = await loadAndSyncRuntimeState();
    // ⚠️ **重试的前提是「这次真的拿到了一份可用的新目录」** —— 进这个分支的唯一原因就是
    // 后台说我们这份目录过期了。取数失败时返回的是**沿用值**（旧目录），再发一遍
    // 只会拿到同一个错、或者更糟：安静地建成一个**不含新工具**的 grant
    // （后台按 id 过滤，`descriptors.length === requestedDescriptorIds.size` 判不出差异）。
    // ⚠️ `fresh` 同时挡住「取数没抛错、但目录是空数组」那条 —— 它同样是残缺目录。
    // 所以这里把那个错原样抛回去 —— 它本来就会被 `executeDetected` 的 catch
    // 归类成 `tool_authorization_create_failed`，回到「显式失败」那条路上。
    if (!fresh) throw error;
    return createToolAuthorization({
      requestId,
      chatSessionId,
      descriptorIds: descriptors.map((d) => d.id),
      localSkillDir,
    });
  }
}

async function executeDetected(call: ToolCall, requestId: string): Promise<ToolExecutionRecord | null> {
  // 授权：正常情况下每条路由在请求增广时就建好了 grant（chatNew / completion / 续跑各一处）。
  // 查不到时这里现场新建一个，保证工具仍能执行。
  //
  // 走到这里的原因只有一类：这一轮的增广没能建授权。具体是 `handleAugmentRequestBody`
  // 的几条提前返回（id / body 缺失、body 解析失败）与外层 catch（增广抛错 → 主世界收到
  // `ok:false` → 原样放行请求）。这些情况下请求带着**未经增广的 body** 发出，模型没有
  // 我们的工具目录，但仍可能照会话历史里的标签名吐出 XML。
  //
  // ⚠️ 不能拿「续跑轮的 grant 被 requestTerminal 提前关掉」解释这条路径：
  // 关授权现在由 `tryFinalizeRequest` 做，而它要先看到「执行已齐」——
  // 本函数本身就跑在那条执行链上，所以走到这里时 grant 必然还在。
  //
  // ⚠️ 这条懒建等价于**在内容脚本里给自己发许可**；上游没有它（上游查不到 grant 时把空的
  // authorizationId 交给后台，由后台拒绝）。它同时是「伪造一条桥消息即可执行任意工具」的放大器。
  let authorization = activeToolAuthorizations.get(requestId);
  const authId = authorization?.id;
  if (!authId) {
    const chatSessionId =
      chatSessionIdByRequestId.get(requestId) ?? getCurrentChatSessionId();
    try {
      // ⚠️ `localSkillDir` **只从 `localSkillDirByRequestId` 取**（completion 轮增广成功时记下的）：
      // 走到懒建说明这一轮增广没跑完，此刻没有任何别的来源能给出「本轮激活了哪个 Skill」。
      // 拿不到就传 `undefined` —— 后台的 cwd 门禁会原样放行 cwd，与改动前一致。
      // ⚠️ **chatNew 轮不写那个 Map**（它没有终态事件，刻意不碰任何请求级状态）⇒ 那一档
      // 仍然拿不到 dir。这属已知残余，补它需要另找来源，代价高于收益。
      authorization = await requestToolAuthorization(
        requestId,
        chatSessionId,
        localSkillDirByRequestId.get(requestId),
      );
      activeToolAuthorizations.set(requestId, authorization);
      // 懒建路径也记一份（走的是 `currentToolDescriptors`，那是此刻唯一可得的目录）。
      //
      // ⚠️⚠️ **这里刻意存「未过滤」的 `authorization.descriptors`，与另外两处不同。**
      // 理由：这条路的增广压根没跑完（id / body 缺失、body 解析失败、或外层 catch），
      // 请求级状态都不存在 ⇒ 存原样，把过滤留给读侧：`modelFacingForRequest` 统一过一次判据。
      // 可接受：模型没有拿到我们的目录，能吐出的标签只可能来自会话历史里的旧示例，
      // 而那正是「过滤而非删除」有意保留的能力（见 `modelFacingForRequest` 的说明）。
      requestToolDescriptorsByRequestId.set(requestId, authorization.descriptors);
    } catch (error) {
      const code = error instanceof ToolAuthorizationRequestError
        ? error.code
        : (error instanceof Error ? error.message : String(error));
      console.error('[Zai++] creating a tool authorization failed', { name: call.name, requestId, code });
      return null;
    }
  }

  // 补全 source.chatSessionId：优先授权记的会话，其次 requestId 映射。
  const boundSessionId = authorization?.chatSessionId ?? null;
  const chatSessionId =
    (boundSessionId !== null && boundSessionId !== undefined ? boundSessionId : undefined) ??
    chatSessionIdByRequestId.get(requestId) ??
    getCurrentChatSessionId();

  // 这一轮所属的**助手消息 uuid**（存储腿自带锚点用，见 `ToolCallSource.assistantMessageId`）。
  //
  // ⚠️ **与 `publishLiveSession` 同口径**：取最后一条助手消息、往上找
  // `message-<uuid>` 类。**真机已验证那一刻读得到**（面板出生时的块 id 是
  // `history:<uuid>` 而不是 `live:<requestId>`）。
  // ⚠️ **读不到就不写**（首条消息流式期间、或页面还没把类挂上）—— 下游按「没有锚点」
  // 处理、退回签名合流，与改造前行为一致。
  const assistantMessageId = readCurrentAssistantMessageId();

  // 关键：callId 必须是「本条 raw 内容的稳定且唯一」的 id。
  // parseToolXml 对「单条 raw」解析时 id 恒为 xml:0，三条 memory_save 会撞同一个
  // callId，background 授权层 grant 里 callId 去重（tool_call_replayed）就把后面两条拦截。
  // 用 raw 的哈希作 id：同一条 raw 在 TOOL_CALL 通道和 response 通道拿到的 id 一致（可复用），
  // 不同 raw 拿到的 id 不同（不误判 replay）。
  const stableCallId = `xml:${djb2Hash(call.raw || call.invocationName || crypto.randomUUID())}`;
  const callWithSource: ToolCall = {
    ...call,
    id: stableCallId,
    source: {
      trigger: 'manual_chat',
      requestId,
      chatSessionId,
      // ⚠️ 读不到时是 `undefined`（不是 null）—— 见上面那段说明。
      ...(assistantMessageId ? { assistantMessageId } : {}),
    },
  };
  // 同一 toolCall 签名重复执行保护（TOOL_CALL 通道 + response 通道可能并发，二者 requestId 相同）。
  // 关键：签名必须含 raw（XML 原文）。TOOL_CALL 通道对同一条回复里的每个工具分别发一条
  // 消息、raw 各自不同，但 parseToolXml 对「单条 raw」重解析时 id 恒为 xml:0 —— 若签名只用
  // id，三条 memory_save 会撞同一个签名、只剩第一条执行。用 raw 区分，每个工具天然唯一。
  const signature = `${requestId}:${callWithSource.raw ?? callWithSource.invocationName}:${callWithSource.id}`;
  const signaturesForRequest = executedToolCallSignatures.get(requestId) ?? new Set<string>();
  if (signaturesForRequest.has(signature)) {
    return null;
  }
  signaturesForRequest.add(signature);
  executedToolCallSignatures.set(requestId, signaturesForRequest);

  const effectiveAuthId = authorization?.id;
  if (!effectiveAuthId) {
    console.error('[Zai++] no grant for this request; skipping the tool call', {
      name: call.name,
      requestId,
    });
    return null;
  }
  const result = await executeToolCall(callWithSource, effectiveAuthId);
  const execution: ToolExecutionRecord = {
    callId: callWithSource.id,
    // 关键：用短名（call.name，来自 descriptor.name）而非后台返回的 result.name。
    // result.name 可能是 MCP 长名（mcp_xxx_shell_status），会让 isContinuableExecution 误判。
    name: call.name ?? result.name,
    result,
    provider: result.provider ?? call.provider,
    descriptorId: result.descriptorId ?? call.descriptorId,
  };
  // 记下本轮执行（供 response 的续跑判定读取）。
  const list = executionsByRequest.get(requestId) ?? [];
  list.push(execution);
  executionsByRequest.set(requestId, list);
  // 面板：**只登记 raw**（不画「执行中」行）—— 覆盖「兜底执行路径没调过 `beginToolCall`」
  // 那一格（见 `ToolPanelController.noteToolCallRaw` 的说明）。
  // ⚠️ **幂等**：正常路径上 `beginToolCall` 已经登记过同一条 raw，重复写没有副作用。
  toolPanel.noteToolCallRaw(requestId, { callId: stableCallId, raw: call.raw ?? '' });
  // 面板：把「执行中」那行换成真实结果。
  // ⚠️ **必须在 `executionsByRequest` 落账之后** —— 面板读的是同一份结果，
  // 顺序反了会让「面板显示成功、续跑判定看到空」这种分叉出现。
  toolPanel.completeToolCall(requestId, execution);
  return execution;
}

/**
 * 一轮 completion 的用量落库。
 *
 * 每个 completion 请求就是一次真实计费，所以**每轮各记一条**（`id` 用 requestId，
 * 重复写入由后台按 id 合并）。中断的轮次也记 —— 消耗已经发生。
 *
 * ⚠️ `RECORD_USAGE_TURN` 必须写成**内联的对象字面量**：`tests/runtime-boundary.test.ts`
 * 用 AST 从本文件抓「content 实际发出的命令字面量」，再与 `ZAI_CONTENT_RUNTIME_COMMANDS`
 * 做双向比对。抽成变量会让它抓不到 → 白名单不变式红。
 */
async function handleUsageSnapshot(raw: unknown): Promise<void> {
  const snapshot = decodeZaiUsageSnapshot(raw);
  if (!snapshot) return;
  try {
    await sendRuntimeMessage({
      type: 'RECORD_USAGE_TURN',
      payload: {
        id: snapshot.requestId,
        recordedAt: Date.now(),
        source: 'glm-web',
        // 会话 id 唯一真源是地址栏 `/c/<id>`（请求体里的 chat_id 与 URL 是否同值未经验证）。
        chatSessionId: getCurrentChatSessionId(),
        // z.ai 的流里没有消息 id 概念，恒 null。
        assistantMessageId: null,
        modelType: snapshot.modelType,
        totalTokens: snapshot.totalTokens,
        tokenSource: snapshot.tokenSource,
        tps: snapshot.tps,
        speedSource: snapshot.speedSource,
        elapsedMs: snapshot.elapsedMs,
        // 与 ds++ 一致：每条记录固定算一问一答。
        messageCount: 2,
      },
    });
  } catch (error) {
    console.log('[Zai++] usage record failed', error);
  }
}

/**
 * 工具结果卡片（Skill 起草 / 记忆导入预览）的两条落库通道。
 *
 * ⚠️ **命令字面量必须留在本文件**：`tests/runtime-boundary.test.ts` 用 AST 从内容脚本
 * 抓「实际发出的命令」，与白名单做双向比对。这两个字面量若挪进 `core/ui/`，AST 抓不到
 * → 白名单不变式红。所以这里只做一层转发，不把命令写进 UI 模块。
 *
 * ⚠️ **两者都要判 `ok`，不能只 try/catch** —— 后台的领域失败返回 `{ok:false,error}`
 * 而不是抛错（见 `sendRuntimeMessageStrict` 那条注释），不判就会把失败当成功。
 */
/**
 * **长窗口保活**是否已开启 —— 由 `startSustainedKeepAliveWatch` 在循环跑了
 * {@link SUSTAINED_KEEPALIVE_AFTER_MS} 之后置位，`finishContinuationLoop` 复位。
 *
 * ⚠️⚠️ **它拦的是 `releaseTabKeepAlive`，不是 `wantTabKeepAlive`** ——
 * 每次发送的 `finally` 都会调 release，若不拦，长窗口会被第一个发完的轮次摘掉。
 */
let sustainedKeepAlive = false;
/** 长窗口的定时器（循环结束时清掉）。 */
let sustainedKeepAliveTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * 此刻「谁」要的保活（`ContinuationLoop.loopId`）。
 *
 * ⚠️⚠️ **它是 release 的所有权凭据** —— 一条循环被顶替时，旧那条的
 * `submitContinuationViaPage` 可能还挂在 await 上（最长 5 秒证据等待），
 * 它的 `finally` 会调 release。没有这道判据的话，那次 release 会把**新循环**
 * 刚挂上的会话摘掉（新循环还没跑满 3 分钟 ⇒ `sustainedKeepAlive` 仍是 false，
 * 长窗口那道早退拦不住），而保活失效是**静默**的。
 * ⚠️ **`null` = 没有任何循环在要**（启动清理、收尾兜底走的就是这一档）。
 */
let keepAliveOwner: string | null = null;

/**
 * 标签保活：**告诉后台「这个标签现在需要防节流」/「不需要了」**。
 *
 * ⚠️ **为什么需要它**：续跑链活在页面里（扩展写输入框、页面自己发请求、页面 fetch-hook 读流），
 * 而浏览器会把后台标签的定时器节流到「每秒一次」甚至每分钟一次 ⇒ 发送链的等待会超时
 * ⇒ 判「没发出去」⇒ 收尾。表现是「只打开了网页、没有后续」。
 *
 * ⚠️⚠️ **页面这里只说「要不要」，挂不挂由后台判** —— 判据是 `chrome.tabs.active` +
 * `windows.focused`，**不是 `document.hidden`**。后者会被保活自己发的
 * `Emulation.setFocusEmulationEnabled` 改成 false（页面自报前台）⇒ 用它当判据会在
 * attach / detach 之间无限来回跳，横幅反复出现且保活等于没起作用。
 *
 * ⚠️ **调用窗口要尽量短**（横幅是**全局**可见的，Chrome 走 `ShowGlobally`）——
 * 短任务只有**发送链那几秒**需要它：`submitContinuationViaPage` 进去时 `want`、
 * `finally` 里 `release`；跑超过 {@link SUSTAINED_KEEPALIVE_AFTER_MS} 的长任务才转常驻。
 *
 * ⚠️ **开关是用户的**（设置 → 通用 → 后台保活，默认关）—— 这里照发不误，
 * 拦在后台的 `TabKeepAliveSession.want()`。内容脚本不该读开关状态。
 *
 * ⚠️ **失败方向必须是「静默降级」**：挂不上只是退回改造前的行为（前台能跑），
 * 不能让续跑链因为保活失败而中断。
 */
async function wantTabKeepAlive(owner: string | null = null): Promise<void> {
  // ⚠️ **登记所有权** —— 只有「此刻要它的那条循环」的 release 才算数，见 `keepAliveOwner`。
  if (owner) keepAliveOwner = owner;
  try {
    await sendRuntimeMessage({ type: 'START_TAB_KEEPALIVE' });
  } catch {
    /* 降级：保活不可用，续跑链照旧跑（前台没问题，后台可能被节流） */
  }
}

/**
 * 告诉后台「这个标签不再需要防节流」。
 *
 * ⚠️⚠️ **必须带所有权判据，不能无条件 release** —— 见 `keepAliveOwner`：
 * 旧循环的 `finally` 晚于新循环的 `want` 落地时，无条件 release 会把新循环刚挂上的
 * 会话摘掉，而那时新循环还没跑满 3 分钟（长窗口那道早退拦不住）。
 *
 * ⚠️ **`owner` 为 `null` = 强制 release**：启动清理（页面刚加载，必然没有任何循环）
 * 与收尾兜底（循环已经收掉、所有权已交还）走这一档。
 */
async function releaseTabKeepAlive(owner: string | null = null): Promise<void> {
  // ⚠️ **长窗口期间不卸** —— 每个发送轮次的 `finally` 都会走到这里，
  // 只拦 `want` 而不拦 `release` 的话，长窗口会被第一轮发送完就摘掉。
  if (sustainedKeepAlive) return;
  // ⚠️ **带 owner 时只放掉自己的**：所有权已经换人（含已被交还成 null）就什么都不做。
  // ⚠️⚠️ **不能要求 `keepAliveOwner !== null`** —— 顶替场景把 owner 置 null 之后，
  // 旧循环挂在 await 上的那次 release 会因此通过判据、照发 STOP，
  // 而它与新循环的 START 没有顺序保证 ⇒ 正是这个 token 当初要挡的那件事。
  if (owner !== null && keepAliveOwner !== owner) return;
  // ⚠️ **所有出口都要复位**（含强制档）—— 否则正常收尾后 `keepAliveOwner`
  // 会停在一个已死循环的 `loopId` 上，与「`null` = 没有任何循环在要」的声明冲突。
  keepAliveOwner = null;
  try {
    await sendRuntimeMessage({ type: 'STOP_TAB_KEEPALIVE' });
  } catch {
    /* 同上：卸不掉最多让横幅多挂一会儿，不该影响收尾 */
  }
}

/**
 * 循环跑够 {@link SUSTAINED_KEEPALIVE_AFTER_MS} 之后转成**长窗口保活**。
 *
 * ## 为什么要分两档
 *
 * 短任务（绝大多数）只需要发送链那几秒的保护 —— 那时横幅只是闪一下。
 * 长任务则要全程挂着，否则「发送成功之后、下一轮注入之前」那段（等响应 + 模型思考，
 * 常常几分钟）会掉回被节流的状态，而**那段时间正是页面自己想要动的时候**。
 *
 * ## 阈值为什么是 3 分钟
 *
 * Chrome 的强化节流在**隐藏超过 5 分钟**后才生效（`setTimeout` 降到每分钟一次），
 * 3 分钟留出 2 分钟余量。而隐藏不满 5 分钟时定时器仍是每秒一次 ⇒
 * **这个定时器本身的误差在 1 秒内，不会拖到节流之后才触发**。
 * 它从**循环创建**开始算，不从「切到后台」开始算 —— 更保守，也不增加复杂度。
 *
 * ⚠️ **这是「挂不挂 debugger」的时长决策，与用户开关正交**：开关关掉时
 * `want()` 在后台就被拦掉了（`TabKeepAliveSession`），这里置位也没用。
 */
const SUSTAINED_KEEPALIVE_AFTER_MS = 3 * 60_000;

function startSustainedKeepAliveWatch(loop: ContinuationLoop): void {
  clearSustainedKeepAliveTimer();
  // ⚠️⚠️ **已经在长窗口里就直接继承** —— 一个跑了 20 分钟的循环被顶替后，
  // 新循环不该从 3 分钟重新计时（那会有最长 3 分钟的保护缺口，而顶替的典型成因
  // 正是**用户手发一条消息**，也就是新任务马上要发东西）。
  // ⚠️ 这里**不重新 `want`** —— 会话本来就挂在那条标签上（保活按标签），
  // 再发一次 START 没有意义，还可能和 `finishContinuationLoop` 的收尾撞。
  //
  // ⚠️⚠️ **已知残余：没跑到 3 分钟就被顶替时，时钟会重置。**
  // 旧循环跑了 2 分 50 秒、被顶替（`preserveKeepAlive` 保留了**标记**，但那时
  // `sustainedKeepAlive` 还是 false）⇒ 上面那个 `clearSustainedKeepAliveTimer()`
  // 把旧计时清掉、新循环重新起一个满 3 分钟的 ⇒ **最长多出 3 分钟没有长窗口**。
  //
  // ⚠️ **刻意不改**：要接管旧定时器的剩余时间，就得把「这个定时器属于哪条循环、
  // 还剩多久」也做成跨循环传递的状态 —— 而顶替本身是异常路径（前一条已判失败），
  // 多等 3 分钟的代价小于那份复杂度。**别再提议「继承剩余时间」。**
  if (sustainedKeepAlive) {
    console.log('[Zai++] sustained keep-alive inherited', { step: loop.stepCount });
    return;
  }
  sustainedKeepAliveTimer = setTimeout(() => {
    sustainedKeepAliveTimer = null;
    // ⚠️ 到期时复检：循环可能早已收尾（那个过程中 `finishContinuationLoop` 会清定时器，
    // 但万一先到的是这个回调，就得自己判）。
    if (continuationLoop !== loop || loop.status !== 'running') return;
    sustainedKeepAlive = true;
    // ⚠️ **长窗口也要登记所有权** —— 否则收尾那次 `releaseTabKeepAlive(loopId)` 会因为
    // 「所有权为空」被当成强制 release 放过去，与短窗口那一档的口径不一致。
    void wantTabKeepAlive(loop.loopId);
    console.log('[Zai++] sustained keep-alive engaged', {
      step: loop.stepCount,
      afterMs: SUSTAINED_KEEPALIVE_AFTER_MS,
    });
  }, SUSTAINED_KEEPALIVE_AFTER_MS);
}

/**
 * **只清定时器，不动标记** —— 顶替场景专用。
 *
 * ⚠️⚠️ **它与 `stopSustainedKeepAliveWatch` 必须分开**：循环被 `supersedeRunningLoop`
 * 顶替时（用户手发一条消息就会发生），长窗口应该**原样交给新循环**，
 * 而不是「先卸再挂」—— 那两次 `sendRuntimeMessage`（STOP / START）**没有顺序保证**，
 * STOP 后到会把 START 摘掉，而保活失效是**静默**的（横幅不出现，没人知道为什么）。
 */
function clearSustainedKeepAliveTimer(): void {
  if (sustainedKeepAliveTimer !== null) {
    clearTimeout(sustainedKeepAliveTimer);
    sustainedKeepAliveTimer = null;
  }
}

/** 停掉长窗口：清定时器 + 复位标记（**不发 STOP** —— 由调用方决定要不要卸）。 */
function stopSustainedKeepAliveWatch(): void {
  clearSustainedKeepAliveTimer();
  sustainedKeepAlive = false;
}

async function saveSkillDraftViaRuntime(
  draft: Skill,
): Promise<{ ok?: boolean; error?: string } | undefined> {
  try {
    const result = await sendRuntimeMessage<{ ok?: boolean; error?: string }>({
      type: 'SAVE_SKILL',
      payload: draft,
    });
    if (result?.ok === true) refreshLocalSnapshot();
    return result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function importMemoryDraftsViaRuntime(
  memories: unknown[],
): Promise<{ ok?: boolean; count?: number; error?: string } | undefined> {
  try {
    const result = await sendRuntimeMessage<{ ok?: boolean; count?: number; error?: string }>({
      type: 'IMPORT_MEMORY_DRAFTS',
      payload: { memories },
    });
    if (result?.ok === true) refreshLocalSnapshot();
    return result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 卡片动作成功后**主动刷新本标签的快照**。
 *
 * ⚠️⚠️ **不能指望 `STATE_UPDATED` 广播**：后台的 `broadcastStateUpdate(context.tabId)`
 * 把**发送方标签**排除掉了（`broadcastRuntimeUpdate` 里 `tab.id !== excludeTabId`），
 * 那是刻意的回声抑制；而 `chrome.runtime.sendMessage` 那条腿只到扩展页面、不到内容脚本
 * ⇒ **发起保存的这张标签根本收不到自己的那次更新**。
 * 后果正好落在「已保存/已导入」这套判据上：`currentSkills` / `currentMemories` 停在保存前的值
 * ⇒ 下一次整块重画时按钮又回来；记忆侧更糟 —— `importMemoriesAtomically` 按 `syncId` 去重、
 * **不按内容去重**，再点一次会真的写进重复条目。
 *
 * ⚠️ **刷新失败不该影响动作本身** —— 库里已经写成功了，这里只是让界面跟上。
 */
function refreshLocalSnapshot(): void {
  void loadAndSyncRuntimeState().catch(() => undefined);
}

/**
 * 这份 Skill 草稿**是否已经在技能库里** —— 决定卡片上还给不给「保存」按钮。
 *
 * ⚠️ **读的是 `currentSkills` 这份内存快照，不发请求** —— 渲染是同步的，
 * 而它是启动时与每次 `STATE_UPDATED` 广播时同步下来的。
 * ⚠️⚠️ **卡片自己触发的那次保存收不到广播**（后台把发送方标签排除了，见 `refreshLocalSnapshot`）
 * ⇒ 那条路径靠它自己回填后的刷新。**别指望「保存完广播会来」** —— 那是回声抑制的必然结果。
 * 判据本身在 `core/ui/tool-result-saved-state.ts`（纯函数，可单测）。
 */
function isSkillDraftSavedNow(draft: Skill): boolean {
  return isSkillDraftSaved(draft, currentSkills);
}

/**
 * 这批记忆**是否全部已在记忆库里** —— 决定卡片上还给不给「导入」按钮。
 *
 * ⚠️ **归一化必须与后台判重同源**（`memoryDedupeKey`）—— 两处各写一遍会让
 * 「预览说没有重复、卡片说已经导入过」同时出现。
 */
function areMemoriesImportedNow(memories: unknown[]): boolean {
  return areMemoriesImported(memories, currentMemories);
}

async function handleResponseComplete(complete: ZaiResponseCompletePayload): Promise<void> {
  if (!complete?.requestId) return;
  // ⚠️ **「响应已到达」的两件事不在这里做** —— `respondedRequestIds.add` 与清手动停止 timer
  // 由调用方在**串行队列之外**完成（见 `dispatchMainWorldMessage` 的同步探测区）。
  // 挪进来的话，它们会被排在这个分支前面的慢工具执行堵住，而 `armManualStopDetection`
  // 只有 4 秒宽限窗口 ⇒ 慢工具被误判成「用户手动停止」。
  // 首条请求发出后，页面 SPA 可能已经从首页跳到 /c/<id>（新建会话场景）。
  // 把任务的最新会话 id 同步下来，这样回传 backend 的才是真实 id，而非首条注入时的 null。
  const liveTaskId = taskIdByRequestId.get(complete.requestId);
  const liveChatSessionId = getCurrentChatSessionId();
  if (liveTaskId && liveChatSessionId) {
    const liveTask = activeDomTasks.get(liveTaskId);
    if (liveTask) {
      liveTask.chatSessionId = liveChatSessionId;
      void sendRuntimeMessage({
        type: 'DOM_TASK_STARTED',
        taskId: liveTaskId,
        chatSessionId: liveChatSessionId,
      });
    }
  }

  const isContinuationTurn =
    isContinuationRequest(complete.originalPrompt) ||
    isContinuationRequest(complete.agentTaskPrompt) ||
    (continuationLoop?.status === 'running' &&
      continuationLoop.activeRequestId === complete.requestId);

  if (isContinuationTurn) {
    // 续跑轮：绝不能回退到原生轮分支。续跑轮没有 running loop 时不能裸 return ——
    // 归属在这个 requestId 上的后台任务会永远等不到终态（一直显示「运行中」，直到
    // 180s 执行租约超时）。这里直接回 FAILED 让任务立即收尾。
    if (!continuationLoop || continuationLoop.status !== 'running') {
      const orphanTaskId = taskIdByRequestId.get(complete.requestId);
      if (orphanTaskId) {
        clearActiveDomTask(orphanTaskId);
        console.log('[Zai++] continuation turn without a running loop; failing the task', {
          taskId: orphanTaskId,
          requestId: complete.requestId,
        });
        void sendRuntimeMessage({
          type: 'DOM_TASK_FAILED',
          taskId: orphanTaskId,
          error: ZAI_CONTINUATION_LOOP_MISSING_CODE,
        });
      }
      return;
    }
    // ⚠️⚠️ **本分支后续的一切都只认 `loop`** —— `continuationLoop` 是模块变量，
    // 中间的 await（工具执行上界 120 秒）期间它可能被取消路径置空、或被新循环顶替。
    const loop = continuationLoop;
    loop.activeRequestId = null;
    // 本轮已完成，摘掉它的归属登记（收尾时 clearActiveDomTask 会兜底清剩下的）。
    taskIdByRequestId.delete(complete.requestId);

    // 关键：这轮的工具 XML 可能已经通过 TOOL_CALL 通道执行过了（fetch-hook 既发 TOOL_CALL
    // 又发 RESPONSE_COMPLETE，两条消息同 requestId）。先读回已执行记录复用，别再重新执行
    // ——否则会被 executedToolCallSignatures 防重挡住，误判「无可续跑工具」→ 提前收尾。
    const alreadyExecutedThisTurn = executionsByRequest.get(complete.requestId) ?? [];
    const executedThisTurn: ToolExecutionRecord[] = [...alreadyExecutedThisTurn];

    if (alreadyExecutedThisTurn.length === 0) {
      // TOOL_CALL 通道没先到：兜底在这里解析并执行。用本请求注入的那份描述符（与提示词同源）。
      const calls = parseToolXml(
        complete.assistantText,
        modelFacingForRequest(complete.requestId),
      );
      for (const call of calls) {
        const execution = await executeDetected(call, complete.requestId);
        if (execution) executedThisTurn.push(execution);
      }
    }

    // ⚠️ **执行期间循环可能已经被收掉**（取消 / 手动停止宽限都跑在串行队列之外）——
    // 那一轮的终态已由收掉它的路径负责，这里只把结果交给面板（面板只认 requestId），
    // 绝不能写进一条已经结束的循环。
    const loopAlive = continuationLoop === loop;
    if (loopAlive) {
      // 复用已执行结果时也要补进 `loop.toolExecutions`（如果还没被 TOOL_CALL 通道 push 过）。
      for (const execution of executedThisTurn) {
        if (!loop.toolExecutions.includes(execution)) loop.toolExecutions.push(execution);
      }
      // 更新上一轮可见正文，供 nudge 回看。
      loop.lastVisibleText = complete.assistantText;
      // ⚠️ **只在有正文时更新** —— 纯工具轮（模型只吐 XML）的 `assistantText` 是空串，
      // 无条件覆盖会让「跑到步数上限 / 纠错用尽」的收尾把最终正文写成空。
      if (complete.assistantText) loop.finalAssistantText = complete.assistantText;
    }

    // 工具调用面板（本节所有执行过的工具收成一块）。**尽力而为** ——
    // 找不到锚点就不挂，不影响执行链与续跑判定。
    toolPanel.rememberExecutions(complete.requestId, executedThisTurn, complete.assistantText);
    // 64：这一轮到此为止，仍标着「执行中」的行收成失败（正常收尾时通常一条都没有）。
    toolPanel.finalizePending(
      complete.requestId,
      translate(currentContentLocale, 'content.toolBlock.summaries.failed'),
      translate(currentContentLocale, 'content.toolBlock.summaries.incomplete'),
    );
    // ⚠️ **本轮到此为止 ⇒ 把这一轮的块收起来**（顺序：先 finalize 再 seal）。
    // ⚠️ **必须在这里、不能只放在 run 收尾** —— 本分支下面还有两条早返回
    // （`advanceContinuationLoop()` 推进下一轮、nudge 分支），
    // 只放收尾的话中间那些轮的块会一直摊着。
    toolPanel.sealTurn(complete.requestId);

    // 循环在工具执行期间已被收掉 ⇒ 面板已经画完，这一轮到此为止（不推进、不再收尾）。
    if (!loopAlive) return;

    // 核心判定：本轮模型有没有「可续跑」的工具。
    const continuable = executedThisTurn.filter(isContinuableExecution);
    if (continuable.length > 0) {
      // 还有工具可跑 → 注入下一轮续跑。
      await advanceContinuationLoop();
      return;
    }

    // ⚠️⚠️ **误用纠错必须排在面板收尾之后、普通 nudge 之前**：
    // ① **排在面板收尾之后** —— 同一轮里可能既有误用的 `tool_call` 帧、又有**合法的** XML 执行
    //    （`executedThisTurn` 非空）。先生效的话，真实执行结果既不进面板也不参与续跑判定，
    //    模型还会收到一条「你什么都没执行」的错误提示。
    // ② **排在普通 nudge 之前** —— 误用轮的 `assistantText` 是空串 ⇒ `shouldNudgeZai('')`
    //    会命中「文本为空 ⇒ 需要 nudge」那一档、走通用提示，模型未必知道该改什么。
    // ③ **前置条件是「本轮无可续跑工具」**（走到这里已经成立）—— 与原生轮同口径。
    if (complete.misusedNativeToolNames?.length) {
      if (loop.nudgeCount >= ZAI_INLINE_AGENT_MAX_NUDGES) {
        console.log('[Zai++] misuse correction limit reached; failing the task', {
          step: loop.stepCount,
        });
        failContinuationLoop(loop, ZAI_CONTINUATION_LOOP_MISSING_CODE);
        return;
      }
      await submitMisuseCorrection(loop, complete);
      return;
    }

    // 没有可续跑工具：引入 ds++ 的 shouldNudge —— 模型末尾还有「待办」
    // （比如「接下来读文件」却没吐工具），就发 nudge 让它继续，而不是直接收尾。
    // 这就是「记忆+建文件分两步」不会烂尾的关键。
    const shouldNudgeNow =
      loop.nudgeCount < ZAI_INLINE_AGENT_MAX_NUDGES &&
      shouldNudgeZai(
        loop.originalTask,
        loop.toolExecutions,
        complete.assistantText,
      );
    if (shouldNudgeNow) {
      // 实时拉取最新工具目录，nudge 轮注入的「可用工具清单」同样实时。
      // ⚠️ 用返回值而不是模块状态：模块状态按「最新一次同步生效」落地，本次可能被顶掉。
      const nudgeState = await loadAndSyncRuntimeState();
      // ⚠️⚠️ **await 之后必须验身份再用** —— 这期间取消分支（不在串行队列上）
      // 可能已经把循环收掉或顶替。此后一律用 `loop`，不再读模块变量，
      // 否则会把「另一条循环的任务」与「这一轮的正文」拼进同一条 nudge。
      if (continuationLoop !== loop || loop.status !== 'running') return;
      if (!isSessionStillCurrent(loop.chatSessionId)) {
        console.log('[Zai++] nudge continuation session changed; failing the task', {
          step: loop.stepCount,
        });
        failContinuationLoop(loop, ZAI_CONTINUATION_LOOP_MISSING_CODE);
        return;
      }
      loop.nudgeCount += 1;
      const nudgeToolNames = catalogNamesFor(modelFacingDescriptorsFor(nudgeState.descriptors));
      const nudgePrompt = buildZaiNudgePrompt(
        loop.originalTask,
        complete.assistantText,
        loop.toolExecutions,
        loop.nudgeCount,
        nudgeToolNames,
      );
      const nudgeStepAtArm = loop.stepCount;
      const nudgeAtArm = loop.nudgeCount;
      const { evidence: nudgeEvidence, reason: nudgeReason } =
        await submitContinuationWithRetry(nudgePrompt, loop);
      if (continuationLoop !== loop || loop.status !== 'running') return;
      if (nudgeEvidence === 'unsent') {
        reportContinuationSendNotObserved(
          loop,
          '[Zai++] nudge continuation was not observed',
          { step: nudgeStepAtArm, reason: nudgeReason },
        );
        failContinuationLoop(loop, classifyContinuationSendFailure(nudgeReason));
        return;
      }
      if (nudgeEvidence === 'ambiguous') {
        // 与 `advanceContinuationLoop` 同口径：可能发出去了 ⇒ 不重发，挂看门狗。
        console.log('[Zai++] nudge continuation left no evidence; arming the watchdog', {
          step: nudgeStepAtArm,
        });
        armAmbiguousSendWatchdog(loop, nudgeStepAtArm, nudgeAtArm);
      }
      return;
    }

    // 无可续跑工具、也没有待办 → 收尾。
    finishContinuationLoop(loop);
    return;
  }

  // 原生轮：工具若已在 TOOL_CALL 通道执行过（executionsByRequest 有记录），
  // 这里不重复执行，只读回执行结果判定是否要续跑。
  const alreadyExecuted = executionsByRequest.get(complete.requestId) ?? [];
  const calls = parseToolXml(
    complete.assistantText,
    modelFacingForRequest(complete.requestId),
  );
  const executions: ToolExecutionRecord[] = [...alreadyExecuted];
  if (alreadyExecuted.length === 0) {
    // 工具没在 TOOL_CALL 通道跑过（可能是 fetch-hook 只发 RESPONSE_COMPLETE 没发 TOOL_CALL），
    // 兜底：这里解析并执行。但先检查授权是否还在。
    for (const call of calls) {
      const execution = await executeDetected(call, complete.requestId);
      if (execution) executions.push(execution);
    }
  }

  // 工具调用面板（与续跑轮同一入口）。
  toolPanel.rememberExecutions(complete.requestId, executions, complete.assistantText);
  toolPanel.finalizePending(
    complete.requestId,
    translate(currentContentLocale, 'content.toolBlock.summaries.failed'),
    translate(currentContentLocale, 'content.toolBlock.summaries.incomplete'),
  );
  // ⚠️ **一轮结束就把这一轮的块收起来**（顺序：先 `finalizePending` 再 `sealTurn`）。
  // 上游同口径（sealed group 收起、当前 group 展开）⇒ 跑 N 轮看到的是
  // 「N 行块头 + 最后一行展开」，而不是 N 大块全摊着。
  // ⚠️ **这里就要收，不能等到整个 run 收尾** —— 续跑轮还有早返回（推进 / nudge）。
  toolPanel.sealTurn(complete.requestId);

  const continuable = executions.filter(isContinuableExecution);
  if (continuable.length === 0) {
    // ⚠️⚠️ **首轮误用的纠正入口** —— 模型把本地工具写进了原生 tool_call，
    // 那一轮什么也没执行（`assistantText` 是空串、`executions` 也是空）。
    // 不在这里拦的话下面就直接回传终态收尾了，用户只看到页面上一句
    // `tool call failed: <名>`，没有任何东西告诉他「重发一次就能成」。
    //
    // ⚠️ **必须先于下面的收尾**，且**要能建出一个续跑循环** —— 纠错轮走的就是续跑通道。
    if (complete.misusedNativeToolNames?.length && await startMisuseCorrectionLoop(complete)) {
      return;
    }
    // 无续跑工具，结束。有 XML 但没续跑（如 memory_save）也算完成。
    // 后台 DOM 任务：单轮无工具就要回传，不能悬挂。
    const nativeTaskId = taskIdByRequestId.get(complete.requestId);
    if (nativeTaskId) {
      const task = activeDomTasks.get(nativeTaskId);
      taskIdByRequestId.delete(complete.requestId);
      if (task) {
        task.status = 'done';
        activeDomTasks.delete(nativeTaskId);
        // 固定会话：回传前 re-read 真实 /c/<id>（新建会话下 task.chatSessionId 可能还是 null）。
        const liveSessionId = getCurrentChatSessionId();
        void sendRuntimeMessage({
          type: 'DOM_TASK_COMPLETE',
          taskId: nativeTaskId,
          chatSessionId: liveSessionId ?? task.chatSessionId,
          assistantText: complete.assistantText,
          toolExecutions: executions,
          steps: 0,
        });
      }
    }
    return;
  }

  const chatSessionId = getCurrentChatSessionId();
  if (!chatSessionId) {
    // 读不到 /c/<id> 就没法建续跑循环。若这个 requestId 归属着后台任务，
    // 必须回 FAILED 收尾，否则任务一直挂在「运行中」直到 180s 租约超时。
    const orphanTaskId = taskIdByRequestId.get(complete.requestId);
    if (orphanTaskId) {
      clearActiveDomTask(orphanTaskId);
      console.log('[Zai++] no chat session id; failing the task instead of starting a loop', {
        taskId: orphanTaskId,
        requestId: complete.requestId,
        pathname: location.pathname,
      });
      void sendRuntimeMessage({
        type: 'DOM_TASK_FAILED',
        taskId: orphanTaskId,
        error: 'continuation_session_id_missing',
      });
    }
    return;
  }

  // 覆盖前先处理已在跑的上一个循环：它若归属着后台任务，一旦被下面这行覆盖，
  // 它的 taskId 就再也没人推进 → 那个任务永远收不到终态。这里先判失败收尾。
  supersedeRunningLoop(complete.requestId);

  continuationLoop = {
    loopId: crypto.randomUUID(),
    chatSessionId,
    originalTask: complete.agentTaskPrompt || complete.originalPrompt,
    toolExecutions: executions,
    stepCount: 0,
    status: 'running',
    activeRequestId: null,
    pendingPrompt: null,
    nudgeCount: 0,
    lastVisibleText: complete.assistantText,
    taskId: taskIdByRequestId.get(complete.requestId) ?? null,
    finalAssistantText: complete.assistantText,
    model: resolveLoopModel(complete.requestId),
    localSkillDir: localSkillDirByRequestId.get(complete.requestId) ?? null,
    pendingWatchdog: null,
  };
  // ⚠️ **建循环时不挂保活** —— 只有「发送链那几秒」真的需要它（见
  // `submitContinuationViaPage`）。整轮常驻挂着会让调试横幅（**全局可见**）
  // 一直显示在用户眼前，而等响应那段是网络事件驱动的、不吃定时器。
  //
  // ⚠️ **但要起一个「跑久了就转长窗口」的计时** —— 见 `startSustainedKeepAliveWatch`：
  // 短任务维持现状（横幅只闪一下），跑超过 3 分钟才全程挂载。
  startSustainedKeepAliveWatch(continuationLoop);
  await advanceContinuationLoop();
}

/** 取「这一轮该用的模型」：从请求归属的 DOM 任务上读（未归属则为 null）。 */
function resolveLoopModel(requestId: string): string | null {
  const taskId = taskIdByRequestId.get(requestId);
  return taskId ? activeDomTasks.get(taskId)?.model ?? null : null;
}

async function advanceContinuationLoop(): Promise<void> {
  const loop = continuationLoop;
  if (!loop || loop.status !== 'running') return;

  // 本轮无任何可续跑工具就别再推进——直接收尾，避免空转注入。
  const continuable = loop.toolExecutions.filter(isContinuableExecution);
  if (continuable.length === 0) {
    finishContinuationLoop(loop);
    return;
  }
  // ⚠️ **步数用尽与「没有可续跑工具」是两件事**：前者是**截断**（模型还没收口就被切断），
  // 按成功上报会让自动化显示「跑完了」而正文往往是空串。
  if (loop.stepCount >= ZAI_INLINE_AGENT_MAX_STEPS) {
    console.log('[Zai++] continuation step limit reached; failing the task', {
      step: loop.stepCount,
    });
    failContinuationLoop(loop, ZAI_CONTINUATION_LOOP_MISSING_CODE);
    return;
  }

  // ⚠️ **这里不再挂保活** —— 发送链自己会在注入前后 `want` / `unwant`
  // （见 `submitContinuationViaPage`）。常驻挂着只会让调试横幅一直显示。

  // 实时拉取最新工具目录，续跑轮注入的「可用工具清单」始终是当前真实状态
  // （用户新增 skill / MCP 后，续跑轮立刻能用到，而非首条消息时的快照）。
  // ⚠️ 用返回值而不是模块状态：模块状态按「最新一次同步生效」落地，本次可能被顶掉。
  const loopState = await loadAndSyncRuntimeState();
  // ⚠️⚠️ **await 之后必须验身份** —— 这期间 `CANCEL_DOM_TASK` / 手动停止宽限
  // 都可能把这条循环收掉（两者都跑在串行队列之外）。不验就会给一条已经结束的循环
  // 再注入一轮：页面上多出一轮没人认领的对话，而它的完成事件只会走 orphan 分支静默返回。
  if (continuationLoop !== loop || loop.status !== 'running') return;
  // 会话已切走 ⇒ 这一轮不能再发（发送原语里还有一道紧贴提交的同类判据）。
  if (!isSessionStillCurrent(loop.chatSessionId)) {
    console.log('[Zai++] continuation session changed; failing the task', {
      step: loop.stepCount,
    });
    failContinuationLoop(loop, ZAI_CONTINUATION_LOOP_MISSING_CODE);
    return;
  }
  // ⚠️⚠️ **这份 `toolNames` 与续跑分支的 `modelFacing` 必须同源** —— 前者写进提示词、
  // 后者决定识别与解析。
  const toolNames = catalogNamesFor(modelFacingDescriptorsFor(loopState.descriptors));
  const prompt = buildZaiContinuationPrompt(
    loop.originalTask,
    loop.toolExecutions,
    toolNames,
  );
  loop.pendingPrompt = prompt;
  loop.stepCount += 1;
  /** 看门狗要认「挂上时是哪一步」——见 `armAmbiguousSendWatchdog` 的五条复检。 */
  const armedAtStep = loop.stepCount;
  const armedAtNudge = loop.nudgeCount;

  // 续跑注入策略（不丢弃用户输入）：
  // 1. 注入前复制用户已有的输入文字；2. 注入时覆盖为续跑 prompt；3. 注入后恢复用户文字。
  // 注入期间锁定输入，避免用户打字和注入交错。
  const composerInput = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
  if (composerInput && composerInput.value && composerInput.value.trim()) {
    pendingUserComposerRestore = composerInput.value;
  }

  // 主路：复用页面原生 form submit（send 函数路线）；兜底：DOM 点按钮（只在 unsent 时）。
  // 外层再包一层「只在瞬时出口上重试一次」——见 `submitContinuationWithRetry`。
  const { evidence, reason } = await submitContinuationWithRetry(prompt, loop);
  const injected = pendingUserComposerRestore;
  pendingUserComposerRestore = null;

  // 注入完成后，恢复用户之前输入的草稿（如果有）。恢复时不要触发输入事件，避免误发。
  if (injected !== null) {
    const textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
    if (textarea) {
      setTextareaValue(textarea, injected);
    }
  }

  // 发送期间循环可能已被收掉或顶替 —— 那一轮的终态已经由收掉它的那条路径负责。
  if (continuationLoop !== loop || loop.status !== 'running') return;

  if (evidence === 'unsent') {
    // 确定没发出去 ⇒ 收尾。**不能按成功上报**（见 `failContinuationLoop`）。
    reportContinuationSendNotObserved(
      loop,
      '[Zai++] continuation submit was not observed',
      { step: loop.stepCount, reason },
    );
    failContinuationLoop(loop, classifyContinuationSendFailure(reason));
    return;
  }
  if (evidence === 'ambiguous') {
    // 可能发出去了、也可能没有 ⇒ **不许重发**，挂看门狗等一小段再判。
    console.log('[Zai++] continuation submit left no evidence; arming the watchdog', {
      step: loop.stepCount,
    });
    armAmbiguousSendWatchdog(loop, armedAtStep, armedAtNudge);
  }
}

/**
 * 续跑提交：主路 trySubmitViaFormRequestSubmit（原生 form submit，send 函数路线），
 * **只在确定没发出去时**才回退 sendPromptViaDom（点 #send-message-button，DOM 兜底）。
 *
 * ⚠️⚠️ **只有 `unsent` 能重发，`ambiguous` 不能** —— 后者的意思是「可能已经发出去了」，
 * 再发一遍就是同一段 prompt 发两次（同一批工具再跑一次、用户看到两条一样的消息）。
 * 这正是不允许用布尔判据的原因：布尔只有「发出去了 / 没发出去」两档，
 * 而现实有第三档。
 *
 * ⚠️⚠️ **这一层刻意不看 Stop 按钮** —— 它拿不到「提交已经触发过」这个前提：
 * `trySubmitViaFormRequestSubmit` 的提前返回里有一档是「上一轮没答完」
 * （`waitForAgentIdle` 超时），那种情况下页面**正在生成、而我们根本没注入**，
 * 看 Stop 会把它误判成「已经发出去了」⇒ 续跑等一个不会来的响应 ⇒ 只能等 180s 租约。
 */
async function submitContinuationViaPage(
  prompt: string,
  loop: ContinuationLoop,
): Promise<ContinuationSendOutcome> {
  // ⚠️⚠️ **保活只在「发送链」这一段要** —— 这里是三条注入链的唯一汇合点
  // （续跑推进 / 普通 nudge / 误用纠错），所以一处覆盖三条。
  //
  // ⚠️ **为什么窗口这么短**：挂上 debugger 会让 Chrome 在**所有窗口**顶部画
  // 「Zai++ started debugging this browser」（`ShowGlobally`，不是只画在被调试的那个窗口）。
  // 而发送链的等待已全部改成事件驱动（`core/zai/event-wait.ts`），
  // **只有观察器覆盖不到的那几条兜底定时器仍吃节流** ⇒ 发完就能卸。
  // **等响应是网络事件驱动的、不吃定时器**（实测：桥上 postMessage 后台间隔 p50 = 0.2ms）。
  // ⚠️ 跑超过 3 分钟的循环会转成**长窗口**（`startSustainedKeepAliveWatch`），
  // 那时这条 `release` 会被 `sustainedKeepAlive` 拦下 —— 见该函数的说明。
  //
  // ⚠️ **用户没开开关时这里照发不误** —— 拦在后台（`TabKeepAliveSession.want` 直接丢）。
  // 内容脚本不该知道开关状态：它可能读到旧值，而多一层判断就多一个失效点。
  //
  // ⚠️⚠️ **`want` / `release` 都要带 `loop.loopId`** —— 这条循环被顶替时，
  // 它的发送链可能还挂在 await 上，`finally` 里那次 release 会把**新循环**刚挂上的
  // 会话摘掉（那时新循环还没跑满 3 分钟，长窗口那道早退拦不住）。判据见 `keepAliveOwner`。
  //
  // ⚠️ **必须 `finally` 卸** —— 中间任何一处抛错（注入原语 / 证据等待）都不能把横幅留在那儿。
  // ⚠️ **不 await `want`**：挂不上只是退回改造前的行为，不该拖住注入。
  void wantTabKeepAlive(loop.loopId);
  try {
    const viaForm = await trySubmitViaFormRequestSubmit(prompt, loop.chatSessionId);
    if (viaForm.evidence !== 'unsent') return viaForm;

    // ⚠️ 兜底路返回的仍然是三态（它自己也会区分）；这里**不能**再压成布尔。
    return await sendPromptViaDom(prompt, loop.chatSessionId);
  } finally {
    void releaseTabKeepAlive(loop.loopId);
  }
}

/** 「确定没发出去」之后再等这么久试一次。 */
const CONTINUATION_SEND_RETRY_MS = 500;

/**
 * 发送一次续跑，**只在「下一秒可能自己好」的出口上重试一次**。
 *
 * ⚠️⚠️ **`unsent` 允许重试、`ambiguous` 绝不允许** —— 前者的全部出口都在提交动作
 * **之前**（`form.requestSubmit()` / `sendButton.click()` 都没执行过），重试的是
 * 「没有发生的动作」；后者是「可能已经发出去了」，再发一遍就是同一段 prompt 进两次。
 * 这条边界由 `submitContinuationViaPage` 内部那条唯一的 `'unsent'` 守卫守着。
 *
 * ⚠️ **只重试白名单里的三类出口**（见 `CONTINUATION_RETRYABLE_REASONS`）——
 * 没有输入框 / 表单脱连 / 提交抛错这三类等再久也一样，而重试一轮最长要再等 12 秒。
 */
async function submitContinuationWithRetry(
  prompt: string,
  loop: ContinuationLoop,
): Promise<ContinuationSendOutcome> {
  const first = await submitContinuationViaPage(prompt, loop);
  if (first.reason === null || !CONTINUATION_RETRYABLE_REASONS.has(first.reason)) return first;
  // ⚠️ **第二次尝试之前再验一次身份** —— 两次尝试之间夹着 500ms + 第二轮最长 12 秒，
  // 这期间循环可能已被收掉或顶替。不验的话会把注定无人认领的 prompt 再发一遍。
  if (continuationLoop !== loop || loop.status !== 'running') return first;
  console.log('[Zai++] continuation submit failed; retrying once', { reason: first.reason });
  await sleep(CONTINUATION_SEND_RETRY_MS);
  if (continuationLoop !== loop || loop.status !== 'running') return first;
  return submitContinuationViaPage(prompt, loop);
}

// ---------------------------------------------------------------------------
// 误用纠错（模型把本地工具写进 agent 原生 tool_call）
// ---------------------------------------------------------------------------

/** 等地址栏切到 `/c/<id>` 的上限。首轮误用时那一刻通常已经到了，这里只兜极端时序。 */
const MISUSE_SESSION_ID_WAIT_MS = 2_000;

/**
 * 在**已有循环**里发一次误用纠错轮。
 *
 * ⚠️ **`nudgeCount` 要自增** —— 它同时是「已经纠错过几次」的闸门（与普通 nudge 共用
 * `ZAI_INLINE_AGENT_MAX_NUDGES`），也是 `armAmbiguousSendWatchdog` 的复检令牌之一
 * （那个函数靠「stepCount 与 nudgeCount 都没变」判「这一发没有产生任何进展」）。
 * 不自增的话看门狗会把一次合法的纠错轮误判成「仍然卡着」。
 */
async function submitMisuseCorrection(
  loop: ContinuationLoop,
  complete: ZaiResponseCompletePayload,
): Promise<void> {
  const toolName = complete.misusedNativeToolNames?.[0] ?? '';
  const descriptors = modelFacingForRequest(complete.requestId);
  const descriptor = descriptors.find(
    (item) => item.name === toolName || item.invocationName === toolName,
  );
  loop.nudgeCount += 1;
  const prompt = buildZaiMisuseNudgePrompt(
    loop.originalTask,
    toolName,
    descriptor,
    loop.toolExecutions,
  );
  const stepAtArm = loop.stepCount;
  const nudgeAtArm = loop.nudgeCount;
  // ⚠️ **发送前两道判据**：循环还在不在（取消分支跑在串行队列之外）、会话有没有切走。
  if (continuationLoop !== loop) return;
  if (!isSessionStillCurrent(loop.chatSessionId)) {
    console.log('[Zai++] misuse correction session changed; failing the task', {
      tool: toolName,
    });
    failContinuationLoop(loop, ZAI_CONTINUATION_LOOP_MISSING_CODE);
    return;
  }
  const { evidence, reason } = await submitContinuationWithRetry(prompt, loop);
  if (continuationLoop !== loop) return;
  if (evidence === 'unsent') {
    reportContinuationSendNotObserved(
      loop,
      '[Zai++] misuse correction was not observed',
      { tool: toolName, reason },
    );
    failContinuationLoop(loop, classifyContinuationSendFailure(reason));
    return;
  }
  if (evidence === 'ambiguous') {
    armAmbiguousSendWatchdog(loop, stepAtArm, nudgeAtArm);
  }
}

/**
 * **首轮**误用：建一个只跑纠错轮的续跑循环。
 *
 * 首轮踩中时现在的路径是「无可续跑工具 ⇒ 直接回传终态收尾」，纠错轮根本起不来。
 * 所以这里先建循环、再复用 `submitMisuseCorrection`。
 *
 * ⚠️ **拿不到会话 id 就放弃纠错**（返回 false，调用方按原样收尾）——
 * 续跑通道依赖 `/c/<id>`，硬凑会让后续归属全错。
 * ⚠️ **最多等 {@link MISUSE_SESSION_ID_WAIT_MS}** —— 首轮此刻通常已经在 `/c/<id>`，
 * 这一等只兜「页面刚跳转、地址栏还没更新」那一小段时序。
 * ⚠️⚠️ **建循环之前必须先走一次 `supersedeRunningLoop`** —— 这条路径比原生轮那段守卫
 * **更早**（它在 `continuable.length === 0` 分支里就 `return` 了），而它自己无条件覆盖
 * `continuationLoop`。不先收掉旧循环的话，旧循环归属的后台任务会一直显示「运行中」
 * 直到 180s 租约超时 —— 与原生轮那段注释描述的是同一个失效形态。
 */
async function startMisuseCorrectionLoop(
  complete: ZaiResponseCompletePayload,
): Promise<boolean> {
  const chatSessionId = await waitForChatSessionId(MISUSE_SESSION_ID_WAIT_MS);
  if (!chatSessionId) return false;

  // ⚠️ **放在 await 之后**：那 2 秒里不会有新的完成事件抢 `continuationLoop`
  // （它们走同一条串行队列），但把它放这儿能覆盖「等之前就有一个在跑」的全部窗口。
  supersedeRunningLoop(complete.requestId);

  const executions = executionsByRequest.get(complete.requestId) ?? [];
  continuationLoop = {
    loopId: crypto.randomUUID(),
    chatSessionId,
    originalTask: complete.agentTaskPrompt || complete.originalPrompt,
    toolExecutions: [...executions],
    stepCount: 0,
    status: 'running',
    activeRequestId: null,
    pendingPrompt: null,
    nudgeCount: 0,
    lastVisibleText: '',
    taskId: taskIdByRequestId.get(complete.requestId) ?? null,
    finalAssistantText: '',
    model: resolveLoopModel(complete.requestId),
    localSkillDir: localSkillDirByRequestId.get(complete.requestId) ?? null,
    pendingWatchdog: null,
  };
  const loop = continuationLoop;
  startSustainedKeepAliveWatch(loop);
  await submitMisuseCorrection(loop, complete);
  return true;
}

/**
 * **覆盖前先收掉在跑的旧循环** —— 摘 `taskId`、清归属、回 `DOM_TASK_FAILED`、`finish`。
 *
 * ⚠️⚠️ **两条建循环的路径都必须先调它**：原生轮那条（`handleResponseComplete` 里）
 * 与**首轮误用纠错**那条（`startMisuseCorrectionLoop`）。后者比前者更早返回，
 * 漏掉的后果是**旧循环的后台任务永远收不到终态**（一直显示「运行中」到 180s 租约超时）。
 * ⚠️ **`requestId` 只用于日志**（定位是哪一次完成事件触发的覆盖）。
 */
function supersedeRunningLoop(requestId: string): void {
  if (continuationLoop?.status !== 'running') return;
  const staleLoop = continuationLoop;
  if (staleLoop.taskId) {
    const staleTaskId = staleLoop.taskId;
    staleLoop.taskId = null;
    clearActiveDomTask(staleTaskId);
    console.log('[Zai++] superseding a running continuation loop; failing its task', {
      taskId: staleTaskId,
      requestId,
    });
    void sendRuntimeMessage({
      type: 'DOM_TASK_FAILED',
      taskId: staleTaskId,
      error: 'continuation_loop_superseded',
    });
  }
  // ⚠️ **长窗口原样交给下一条循环** —— 顶替的典型成因是「用户手发一条消息」，
  // 那条新循环马上就要发送，不该从 3 分钟重新计时。见 `preserveKeepAlive`。
  finishContinuationLoop(staleLoop, { preserveKeepAlive: true });
}

/** 等地址栏出现 `/c/<id>`；超时返回 null。 */
async function waitForChatSessionId(timeoutMs: number): Promise<string | null> {
  const existing = getCurrentChatSessionId();
  if (existing) return existing;
  const endAt = Date.now() + timeoutMs;
  while (Date.now() < endAt) {
    await sleep(100);
    const current = getCurrentChatSessionId();
    if (current) return current;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 后台 DOM 任务（任务归属 + 结束回传，不接后台协调器）
// ---------------------------------------------------------------------------

/** 当前是否有后台 DOM 任务正在跑（busy 判定，一 tab 一任务）。 */
function hasActiveDomTaskRunning(): boolean {
  for (const task of activeDomTasks.values()) {
    if (task.status === 'pending' || task.status === 'injected' || task.status === 'running') {
      return true;
    }
  }
  return false;
}

/**
 * 自动化首条注入：把后台任务的 prompt 注入页面让页面自己发。
 *
 * 这是自动化自己的发送模块（独立于核心续跑状态机 continuationLoop）：
 * 发送动作走「自动化发送链（sendPromptViaPage）」，命中后续跑/工具执行仍由
 * 核心续跑状态机自闭环（handleResponseComplete 里 continuationLoop 接手）。
 * 内部先同步一次运行时状态（记忆/技能/工具目录），再走自动化发送链。
 */
async function submitDomTaskPrompt(taskId: string, prompt: string): Promise<boolean> {
  await loadAndSyncRuntimeState();
  const submitted = await sendPromptViaPage(taskId, prompt);
  if (!submitted) {
    const task = activeDomTasks.get(taskId);
    if (task) {
      clearActiveDomTask(taskId);
      const lastError = lastAutomationSendErrorKind;
      const code = lastError && RETRYABLE_PRE_SEND_ERRORS.has(lastError)
        ? lastError
        : 'composer_inject_failed';
      void sendRuntimeMessage({ type: 'DOM_TASK_FAILED', taskId, error: code });
    }
  }
  return submitted;
}

// ---------------------------------------------------------------------------
// 自动化独立发送链（与续跑发送链分离）
//
// 自动化只复用核心续跑（continuationLoop）的续跑能力，其余功能自成模块：
// 自动化为首条注入维护一条自己的「写值 → 点发送 → 归属确认 → 失败退避重试」
// 循环，与 submitContinuationViaPage / advanceContinuationLoop 完全解耦，
// 命中后交给核心续跑状态机接手。改自动化时不得影响核心续跑。
//
// 发送法采用真机验证过的「模拟用户发送」路径：点 #send-message-button 优先，
// form.requestSubmit 兜底；setTextareaValue 同时派发 input + change 让
// Svelte 双向绑定彻底刷新。
// ---------------------------------------------------------------------------

/**
 * 一趟「写值 + requestSubmit + 归属自检」。
 *
 * 发送法采用真机验证过的「模拟用户发送」路径：
 *   1. 原生 value setter 写 prompt；
 *   2. 派发 input 事件让 Svelte bound-value 同步；
 *   3. 短稳定期后 form.requestSubmit()（页面自己发 /chats/new → 跳 /c/<id>）。
 * 关键：**不 disable 输入框、不等 send 按钮 enabled**。disable 会让首页的 Svelte 把
 * bound-value 判空 → send 按钮恒 disabled、requestSubmit 变空提交 → 不跳转。
 * 归属自检（waitForDomTaskRecognized）是 Zai++ 自己加的「成功判据」，取代不可信的
 * 「输入框是否清空」。
 */
async function submitAutomationPromptViaPage(
  taskId: string,
  prompt: string,
): Promise<boolean> {
  if (domSendInFlight) return false;
  domSendInFlight = true;
  try {
    // 原 6s 快速就绪（页面已加载时 textarea 立刻有，不误伤正常发送时序）
    await waitForComposerReady();
    let textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
    if (!textarea) {
      // 兜底长等待：网卡/SPA 慢加载最多再等 60s（只兜底慢加载，不改变「textarea 出现后」的发送节奏）
      const ready = await waitForAutomationComposer(60_000);
      if (!ready) {
        recordAutomationSendError('no_textarea');
        return false;
      }
      textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
    }
    if (!textarea) {
      recordAutomationSendError('no_textarea');
      return false;
    }

    // 关键：等 form 真正挂到文档（isConnected）且 Svelte 反应式就绪后，才允许提交。
    // 「Form submission canceled because the form is not connected」= 提交发生在 form 被
    // Svelte 短暂 detach / 尚未挂载的窗口期。手动不受影响因为人点的时候页面早稳定了；
    // 自动化注入太快，必须显式等这个窗口过去。
    const formReady = await waitForFormConnected(textarea);
    if (!formReady) {
      recordAutomationSendError('form_not_connected');
      return false;
    }

    // 提交前等上一轮生成结束（只读判定 Stop 按钮，不推进/不读写 continuationLoop）。
    if (!(await waitForAgentIdle())) {
      recordAutomationSendError('agent_not_idle');
      return false;
    }

    // 原生 setter + input 事件（真机验证过的写法）。不 disable 输入框。
    setTextareaValue(textarea, '');
    setTextareaValue(textarea, prompt);

    // 短稳定期：给 Svelte 时间把 bound-value 刷到 send 按钮态 / 反应式状态。
    await sleep(AUTOMATION_SUBMIT_SETTLE_MS);

    const sendButton = document.querySelector<HTMLButtonElement>(SEND_BUTTON_SELECTOR);
    const observedBefore = observedAugRequestCount;
    // 关键判据：「有没有请求真的发出」用 `observedAugRequestCount`（页面每发一次
    // completion / chats-new 请求 +1，chatNew 和 completion 都计入）。
    const hasNewRequest = () => observedAugRequestCount > observedBefore;

    // 主路：form.requestSubmit()（真机验证过的「让 z.ai 自己发」路径，
    // 触发面最小、原子，Z.ai 自己的 JS 处理后续 chatNew → 跳 /c/<id> → completion）。
    // 兜底：点 #send-message-button（type=submit，.click() 最终也走表单提交）。
    let submitPath = 'requestSubmit';
    // 提交前重新取 textarea 与 form：写值后 Svelte 可能已重建这一小块 DOM，
    // 早先抓到的引用会变成脱连节点（对它提交只报「form is not connected」且不发请求）。
    const liveTextarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR) ?? textarea;
    submitFormViaRequestSubmit(liveTextarea);
    // requestSubmit 触发了，等桥上那条 AUGMENT_REQUEST_BODY 把计数推上去（不一味 sleep）。
    // ⚠️ 计数在**串行队列之外**自增（见 `dispatchMainWorldMessage` 的同步区），不是等队列加工。
    const submitted = await waitForNewAugRequest(observedBefore);

    if (!submitted) {
      // 兜底：按钮可点/点击能触发 → 点 send 按钮。
      // 同样现取按钮：写值后 Svelte 可能已重建，早先抓到的引用会是脱连节点（点了没反应）。
      const liveButton = document.querySelector<HTMLButtonElement>(SEND_BUTTON_SELECTOR);
      if (liveButton && liveButton.isConnected && !liveButton.disabled) {
        submitPath = 'button-click';
        try {
          liveButton.click();
        } catch {
          /* ignore */
        }
        await waitForNewAugRequest(observedBefore);
      }
    }

    const requestFired = hasNewRequest();

    // 请求已发出 → 直接按「归属确认」等最终结果（不用管输入框/按钮的 UI 态了）。
    if (requestFired) {
      const recognized = await waitForDomTaskRecognized(taskId);
      if (recognized) return true;
      console.log('[Zai++] automation send fired a request but it was never recognized', {
        taskId,
        submitPath,
        jumped: getCurrentChatSessionId() !== null,
        hasStop: isAgentCurrentlyRunning(),
      });
      return false;
    }

    // 三类发送动作都触发不了任何请求：这条链路在页面侧被完全拦截。
    console.log('[Zai++] automation send fired no request at all', {
      taskId,
      submitPath,
      sendBtnExists: !!sendButton,
      sendBtnDisabled: sendButton?.disabled ?? null,
      jumped: getCurrentChatSessionId() !== null,
      hasStop: isAgentCurrentlyRunning(),
    });
    return false;
  } finally {
    domSendInFlight = false;
  }
}

/** 自动化发送循环：归属确认失败就退避重试，直到发送成功或超出尝试上限。 */
async function sendPromptViaPage(taskId: string, prompt: string): Promise<boolean> {
  let lastObserved = false;
  for (let attempt = 0; attempt < AUTOMATION_SEND_MAX_ATTEMPTS; attempt += 1) {
    const recognizedBefore = await waitForDomTaskRecognized(taskId, 0);
    if (recognizedBefore) return true;
    const sent = await submitAutomationPromptViaPage(taskId, prompt);
    if (sent) return true;
    lastObserved = sent;
    await sleep(AUTOMATION_SEND_RETRY_DELAY_MS);
    // 上一发若真的在生成（Stop 按钮可见），说明请求已出去、只是归属稍慢 → 别再重发，
    // 改为多等一段时间归属确认，避免首页双提交（double message）。
    if (isAgentCurrentlyRunning()) {
      if (await waitForDomTaskRecognized(taskId, AUTOMATION_RECOGNIZE_TIMEOUT_MS)) return true;
    }
  }
  return lastObserved;
}

/** 等这条 prompt 被 completion 请求归属（task.status === 'running'），最多等 timeoutMs。 */
async function waitForDomTaskRecognized(taskId: string, timeoutMs = AUTOMATION_RECOGNIZE_TIMEOUT_MS): Promise<boolean> {
  const endAt = Date.now() + timeoutMs;
  while (Date.now() < endAt) {
    const task = activeDomTasks.get(taskId);
    if (!task) return false;
    if (task.status === 'running') return true;
    await sleep(150);
  }
  return false;
}

/** 等 `observedAugRequestCount` 变大（首条 chatNew 从发送到桥上广播有延迟，与串行队列无关）。 */
async function waitForNewAugRequest(beforeCount: number, timeoutMs = 1_200): Promise<boolean> {
  return waitForNotified(() => observedAugRequestCount > beforeCount, timeoutMs, augProgressWaiters);
}

/**
 * 等 textarea 所在的 form 真正挂载到文档（`isConnected`）并给一个反应式稳定期。
 *
 * ⚠️ **原来的实现是 `await sleep(60)` / `sleep(80)` 轮询** —— 后台标签里定时器被压到
 * 每秒一次，4 秒预算只剩 4 个采样点，「连续两帧 DOM 不变」这个判据基本凑不齐
 * ⇒ 白等到超时 ⇒ 提交撞上「节点刚被替换」的窗口。现在改成观察器驱动：
 * 每次 DOM 变动后重取 form 并重做那两项检查，稳定期的判断也随之落在事件上。
 */
/**
 * 表单首次挂载后的**反应式稳定期**：连续两帧 `outerHTML` 长度不变才算稳定。
 *
 * ⚠️ 60ms 是老实现里 `sleep(60)` 的值，原样搬过来 —— 它要覆盖的是 Svelte 一次
 * 反应式刷新，不是任意的 DOM 活动。
 */
const FORM_SETTLE_MS = 60;

async function waitForFormConnected(
  textarea: HTMLTextAreaElement,
  timeoutMs = 4_000,
): Promise<boolean> {
  /** 上一次观察到的 form 快照长度；两次采样之间长度相同才算「稳定」。 */
  let lastSnapshotLength: number | null = null;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    /** 稳定期采样定时器 —— **必须自己有一个**，见下面的说明。 */
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      settled = true;
      observer.disconnect();
      if (settleTimer !== null) clearTimeout(settleTimer);
      if (deadline !== null) clearTimeout(deadline);
      settleTimer = null;
      deadline = null;
    };
    const finish = (value: boolean) => {
      if (settled) return;
      cleanup();
      resolve(value);
    };

    /**
     * 采一次样：`true` = 已稳定，`false` = 还没，`null` = 先把当前长度记下来。
     *
     * ⚠️⚠️ **稳定期不能只靠「等下一次 DOM 变动」**（这是上一版的缺陷）——
     * 页面安静下来之后就没有下一次变动了，那样只能等到 4 秒超时、然后走
     * `isConnected` 兜底放行 ⇒ **既白等 4 秒、又完全跳过了「连续两帧不变」这项检查**，
     * 而这项检查正是为防「提交撞上节点被替换」加的。
     * ⇒ 由 `settleTimer` 在 `FORM_SETTLE_MS` 后**主动**再采一次。
     */
    const sample = (): boolean | null => {
      const form = textarea.closest('form');
      if (!form || !form.isConnected) {
        lastSnapshotLength = null;
        return null;
      }
      // ⚠️ **只比长度、不比节点身份** —— Svelte 换成一个 `outerHTML` 长度相同的新 form
      // 会被判「稳定」。⚠️ 这是**旧实现就有的口径**（老代码也是 `form.outerHTML.length`），
      // 不是本轮引入；改成「同时比 form 引用」是行为改动，留待真机确认是否有必要。
      const length = form.outerHTML.length;
      if (lastSnapshotLength === null) {
        lastSnapshotLength = length;
        return null;
      }
      // ⚠️ 长度与上次不同 = 页面还在改它（Svelte 反应式未收敛）⇒ 重新等一轮。
      if (length !== lastSnapshotLength) {
        lastSnapshotLength = length;
        return null;
      }
      return true;
    };

    /** 采一次样并按结果决定「结束 / 再等一轮」。 */
    const evaluate = () => {
      if (settled) return;
      const verdict = sample();
      if (verdict === true) {
        finish(true);
        return;
      }
      // 还没稳定（或刚记下长度）⇒ 挂一个稳定期定时器，到点再采。
      scheduleSettle();
    };

    const scheduleSettle = () => {
      if (settled || settleTimer !== null) return;
      settleTimer = setTimeout(() => {
        settleTimer = null;
        evaluate();
      }, FORM_SETTLE_MS);
    };

    const observer = new MutationObserver(() => {
      // DOM 在动 ⇒ 之前的采样作废，立刻重采（不必等稳定期定时器）。
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      evaluate();
    });

    deadline = setTimeout(() => finish(false), timeoutMs);

    const root = document.body ?? document.documentElement;
    if (!root) {
      finish(false);
      return;
    }
    try {
      // ⚠️ **这一档刻意比 `waitForDomCondition` 宽**（含 `characterData` / `attributes`，
      // 且没有 `attributeFilter`）—— 它要判断的是「form 的 `outerHTML` 长度是否还在变」，
      // 而长度可以被**任何**一类变动影响（子节点增删 / 文本变化 / 属性变化）。
      // 收窄任何一档都会漏掉一类「还在变」的情形。
      //
      // ⚠️ **代价是每次变动都要跑一次 `form.outerHTML.length`（整段序列化）**。
      // 实测（jsdom）无感；真实 z.ai 的表单更大、流式期变动更密，若真机发现掉帧，
      // 优化方向是「去掉 length 比较、只比 form 引用 + 用 settleTimer 兜稳定」，
      // **不是**加 `attributeFilter`（那会让「只改属性」那一类变动不再重置稳定期，
      // 于是把「页面还在改」误判成「已稳定」）。
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    } catch {
      finish(false);
      return;
    }

    // 立刻采第一次。
    // ⚠️ **不是「零等待返回」** —— `sample()` 首次必然只记下长度、返回 `null`，
    // 最快也要过一个 `FORM_SETTLE_MS`（60ms）才可能判稳定。
    // 这一步的价值是「已经在稳定态时不必等**第二次 DOM 变动**」（旧实现的缺陷），
    // 不是「不必等时间」。
    evaluate();
  }).then((ready) => {
    if (ready) return true;
    // 兜底：超时仍按当前状态放行（`isConnected` 那次检查给了最大把握）。
    const form = textarea.closest('form');
    return !!form && form.isConnected;
  });
}

/**
 * 提交 textarea 所在的表单，**提交前重新取一次 form**。
 *
 * 不能提前把 form 存进变量：Svelte 会在输入框写值后重建这一小块 DOM，旧引用随即
 * 变成「已脱连」的节点，对它 `requestSubmit()` 只会让浏览器报
 * 「Form submission canceled because the form is not connected」且**不发出请求**。
 * 所以每次提交都按 textarea 现取当前那个 form，并确认它仍在文档里。
 *
 * **异常在这里吞掉、转成 `'threw'`**：`requestSubmit()` 会同步跑页面的 submit 处理函数，
 * 它抛错时异常若穿出去，会跳过调用方的按钮兜底点击（以及自动化的退避重试）。
 * 提交没成功是要靠兜底补的，不是靠冒泡。
 *
 * 返回 `ok` 表示提交已触发；其余是失败码，供诊断与兜底分支使用。
 */
function submitFormViaRequestSubmit(
  textarea: HTMLTextAreaElement,
): 'ok' | 'no_form' | 'form_not_connected' | 'threw' {
  const form = textarea.closest('form');
  if (!form) return 'no_form';
  if (!form.isConnected) return 'form_not_connected';
  try {
    form.requestSubmit();
  } catch {
    return 'threw';
  }
  return 'ok';
}

const AUTOMATION_SEND_MAX_ATTEMPTS = 3;
const AUTOMATION_SUBMIT_SETTLE_MS = 120;
const AUTOMATION_RECOGNIZE_TIMEOUT_MS = 5_000;
const AUTOMATION_SEND_RETRY_DELAY_MS = 800;

/**
 * RUN_DOM_TASK onMessage 分支的处理体。
 * - busy 判定：续跑循环在跑 / DOM 注入在飞 / 任一后台任务非终态，一律 `busy` 拒绝。
 * - 会话一致性：后台指定的 chatSessionId 与当前页面会话不符 → `wrong_conversation` 拒绝。
 * - 登记 activeDomTasks + taskIdByPromptText 后注入；成功不立即结束（等待
 *   handleAugmentRequestBody 命中后发 DOM_TASK_STARTED），直接回 {ok:true}。
 */
async function runDomTask(input: {
  taskId: string;
  kind: string;
  prompt: string;
  chatSessionId: string | null;
  model: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  if (!input.taskId || !input.prompt) {
    return { ok: false, error: 'missing_task_id_or_prompt' };
  }
  if (activeDomTasks.has(input.taskId)) {
    return { ok: false, error: 'task_already_registered' };
  }
  if (
    continuationLoop?.status === 'running' ||
    domSendInFlight ||
    hasActiveDomTaskRunning()
  ) {
    return { ok: false, error: 'busy' };
  }
  // 会话一致性：后台指定要续用的会话必须等于当前页面会话（新会话时 chatSessionId 为 null）。
  const currentSessionId = getCurrentChatSessionId();
  if (input.chatSessionId && input.chatSessionId !== currentSessionId) {
    return { ok: false, error: 'wrong_conversation' };
  }

  const task: ActiveDomTask = {
    taskId: input.taskId,
    kind: input.kind,
    prompt: input.prompt,
    chatSessionId: currentSessionId,
    model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null,
    status: 'pending',
  };
  activeDomTasks.set(input.taskId, task);
  taskIdByPromptText.set(input.prompt, input.taskId);

  // 返回 ok:true 只表示「注入已发出」；最终结果由进入续跑循环 / 单轮完成后的
  // DOM_TASK_COMPLETE 统一回传，任务不被当作「已完成」。
  const submitted = await submitDomTaskPrompt(input.taskId, input.prompt);
  if (!submitted) return { ok: false, error: 'composer_inject_failed' };
  return { ok: true };
}

/** 一个「确定没发出去」的结果。所有 `unsent` 出口都必须带上原因。 */
function unsentSend(reason: ContinuationSendReason): ContinuationSendOutcome {
  return { evidence: 'unsent', reason };
}

/** 提交动作的三种失败 → 出口原因。 */
function submitFailureReason(
  outcome: 'no_form' | 'form_not_connected' | 'threw',
): ContinuationSendReason {
  if (outcome === 'no_form') return 'submit_no_form';
  if (outcome === 'form_not_connected') return 'submit_form_not_connected';
  return 'submit_threw';
}

/**
 * 页面是否还停在**这一轮续跑所属的会话**上。
 *
 * ⚠️⚠️ **「读不到会话 id」不等于「不知道」** —— 首页 / 新会话页（`https://zchat.z.ai/`，
 * pathname 是 `/`）**没有会话 id**，那是「明确不在任何会话里」，不是「读不出来」。
 * 所以这里**不能放行**：放行的话续跑 prompt 会被提进一个全新对话
 * （`readZaiChatSessionId` 的正则是 `^/c/<id>`，对 `/` 必然返回 null）。
 * ⚠️ **调用方传进来的 `expectedSessionId` 恒非空**（循环只在 `/c/<id>` 之后才建），
 * 所以「预期为空」这一档不存在、不需要为它留口子。
 * ⚠️ 判的是「地址栏是否还是那个会话」—— 发送链最长会等 12 秒
 * （8 秒等空闲 + 4 秒等发送按钮），这期间用户完全可能切走。
 */
function isSessionStillCurrent(expectedSessionId: string | null): boolean {
  if (!expectedSessionId) return true;
  return getCurrentChatSessionId() === expectedSessionId;
}

/**
 * send 函数路线（Svelte 页面里唯一可复用的「原生发送」= form.requestSubmit()）。
 * 与 DOM 点按钮同层（都要先设 textarea value + dispatch input 让 bound-value 同步），
 * 区别只在「触发提交」这一步走原生 submit 事件链而非模拟点击。
 */
async function trySubmitViaFormRequestSubmit(
  prompt: string,
  expectedSessionId: string | null,
): Promise<ContinuationSendOutcome> {
  if (domSendInFlight) return unsentSend('send_in_flight');
  domSendInFlight = true;
  /** 注入期间对输入框做的那层「看不见」的撤销函数（任何出口都要走 finally 还原）。 */
  let restoreComposerAppearance: (() => void) | null = null;
  /**
   * 我们锁过的那个输入框与它原来的 `disabled`。
   *
   * ⚠️⚠️ **必须在 `finally` 里恢复** —— 中间任何一处抛错（`setTextareaValue` 的
   * `dispatchEvent`、`submitFormViaRequestSubmit`、证据等待）都会跳过正常出口的恢复，
   * 输入框会**永久停在 `disabled = true`**，用户只能刷新页面。这条与遮罩那条同性质：
   * 都是「注入期间改了页面状态、离开时必须还回去」。
   */
  let lockedTextarea: HTMLTextAreaElement | null = null;
  let wasDisabled = false;
  try {
    await waitForComposerReady();
    let textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
    if (!textarea) return unsentSend('no_textarea');

    // 等上一轮生成结束，避免首页双提交（首条消息卡在首页的根因）。
    if (!(await waitForAgentIdle())) {
      return unsentSend('agent_not_idle');
    }

    // ⚠️⚠️ **等完必须重取** —— 上一轮生成结束时页面会把这一小块 DOM 重建掉，
    // 等待之前抓的引用可能已经脱连：往里写值页面收不到 ⇒ 发送按钮永远不亮 ⇒
    // 这一发被判成失败。取不到就退回旧引用（写不进去时后面的出口会自己失败）。
    textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR) ?? textarea;

    // 注入期间锁定输入框，避免用户打字与注入交错。
    wasDisabled = textarea.disabled;
    textarea.disabled = true;
    lockedTextarea = textarea;

    // ⚠️ 注入这段文本期间让它「看起来空着」（文字透明 + 高度冻住）—— 见
    // `maskComposerForInjection`：那段文本**必须**存在于 DOM 里（页面读的状态就是从它来的），
    // 但用户不需要看见它。撤销走本函数的 `finally`。
    restoreComposerAppearance = maskComposerForInjection(textarea);

    setTextareaValue(textarea, '');
    setTextareaValue(textarea, prompt);

    // 关键：等 send 按钮从 disabled 变 enabled（Svelte bound-value 先更新按钮态）。
    // 不等就 requestSubmit 会读到旧（空）值 → 空提交 → 输入框被清空但页面不发请求、
    // 不跳 /c/<id>（自动化卡在首页的根因，与页面的 60ms 提交延迟窗口同义）。
    const sendButton = await waitForSendButtonEnabled();
    if (!sendButton) {
      clearInjectedComposerText();
      textarea.disabled = wasDisabled;
      return unsentSend('send_button_disabled');
    }

    // ⚠️ **提交前再取一次** —— 写值之后页面还可能重建这一小块，旧引用会脱连
    // （对它提交只报 `form is not connected`、不发请求）。页面会把输入内容从
    // 自己的状态里写回新节点，所以提交新节点是安全的。
    const submitTarget = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR) ?? textarea;

    // ⚠️ **会话判据必须紧贴提交** —— 上面两次等待合计最长 12 秒，用户可能已经切走；
    // 此刻提交会把这一轮的续跑 prompt 送进**另一个对话**。
    if (!isSessionStillCurrent(expectedSessionId)) {
      clearInjectedComposerText();
      textarea.disabled = wasDisabled;
      return unsentSend('session_changed');
    }

    // 异常已在 `submitFormViaRequestSubmit` 内部吞掉并转成 `'threw'`，这里只判结果。
    const outcome = submitFormViaRequestSubmit(submitTarget);
    if (outcome !== 'ok') {
      clearInjectedComposerText();
      textarea.disabled = wasDisabled;
      return unsentSend(submitFailureReason(outcome));
    }

    // 提交已触发 ⇒ 页面已经读过值（见 `clearInjectedComposerText` 的说明）⇒ 立刻清掉，
    // 不必等页面自己清（它在约 180ms 后才清，那一段里注入的 prompt 一直挂在输入框上）。
    clearInjectedComposerText();
    // ⚠️⚠️ **遮罩必须在这一刻撤，不能等到函数末尾** —— 下一行一执行，输入框就归用户了，
    // 而后面还有一段最长 5 秒的证据等待（链路异常时）。遮罩留着的话，用户在这段里打的字
    // 是**透明的、还被 `max-height` 裁着**：字不会丢，但敲键盘看不到任何东西。
    // （点按钮那条路不需要这一手：它整段等待期间输入框一直是 `disabled` 的。）
    restoreComposerAppearance?.();
    textarea.disabled = wasDisabled;

    // 成功判据见 `waitForSendEvidence` —— 不能用「输入框被清空」（上面那行替页面满足了它）。
    // ⚠️ 这里**不再把三态压成布尔** —— 压掉之后调用方就分不清「能不能重发」了。
    const { evidence } = await waitForSendEvidence();
    return { evidence, reason: null };
  } finally {
    // ⚠️ **任何出口都要撤销那层「看不见」** —— 漏一次，用户的输入框会一直是透明的。
    restoreComposerAppearance?.();
    // ⚠️ **输入框的 `disabled` 同理** —— 正常出口在提交触发后就恢复了，但中间抛错会跳过它。
    if (lockedTextarea) lockedTextarea.disabled = wasDisabled;
    domSendInFlight = false;
  }
}

/** 清理后台 DOM 任务痕迹：从三个 map 删除该 taskId 的全部记录。 */
function clearActiveDomTask(taskId: string): void {
  activeDomTasks.delete(taskId);
  for (const [promptText, mappedTaskId] of [...taskIdByPromptText]) {
    if (mappedTaskId === taskId) taskIdByPromptText.delete(promptText);
  }
  for (const [requestId, mappedTaskId] of [...taskIdByRequestId]) {
    if (mappedTaskId === taskId) taskIdByRequestId.delete(requestId);
  }
}

/**
 * 会话 id 的出现时机：新会话**不是发出请求就有的** —— 要等模型开始回答、
 * SPA 把地址切到 `/c/<id>`，地址栏里才带得出会话 id。
 *
 * 只靠 `DOM_TASK_STARTED` 不够：那条事件依赖 `RESPONSE_COMPLETE`（模型答完），
 * 用户在模型回答前暂停就永远等不到 → 自动化停在会话「未创建」。
 * 这里直接盯地址变化，`/c/<id>` 一出现就补报给后台。
 */
let sessionWatchInstalled = false;
/** 订阅「地址里的会话变了」的页面侧消费者（如项目面板的当前对话归属）。 */
const sessionChangeListeners = new Set<() => void>();

/** 把当前地址里的会话 id 补给所有还没拿到它的在跑任务（幂等：id 相同就跳过）。 */
function reportLiveSessionToActiveTasks(): void {
  // 没有在跑的后台任务时直接返回。
  if (activeDomTasks.size === 0) return;
  const sessionId = getCurrentChatSessionId();
  if (!sessionId) return;
  for (const task of activeDomTasks.values()) {
    if (task.status !== 'pending' && task.status !== 'injected' && task.status !== 'running') continue;
    // 已有别的会话 id = 页面被导航到了另一条对话，不是本次运行的目标会话，不覆盖。
    if (task.chatSessionId !== null && task.chatSessionId !== sessionId) continue;
    if (task.chatSessionId === sessionId) continue;
    task.chatSessionId = sessionId;
    void sendRuntimeMessage({
      type: 'DOM_TASK_STARTED',
      taskId: task.taskId,
      chatSessionId: sessionId,
    });
  }
}

/**
 * 盯地址变化。用 wxt 的 `wxt:locationchange`（它走 Navigation API、拿不到时才
 * 退回 1s 轮询）—— 不用手包 `history.pushState`：内容脚本跑在隔离世界，
 * 包不到页面自己那个 `history` 对象。
 *
 * 兜底再挂 popstate / hashchange，并把 1s 轮询留着：地址切换的时机是「模型开始
 * 回答前后」，远早于用户能按下暂停，1s 粒度足够；有任务在跑时才有开销。
 *
 * 两条消费者：后台任务归属（`reportLiveSessionToActiveTasks`，无任务时自短路）
 * 与页面侧 UI（`notifySessionChange`，例如项目面板要跟着换「当前对话」）。
 */
function installSessionWatch(ctx: { addEventListener: (t: Window, type: string, h: () => void) => void }): void {
  if (sessionWatchInstalled) return;
  sessionWatchInstalled = true;
  // 三个监听源 + 一个轮询的编排搬到了 `core/zai/capability-install.ts`
  // （依赖注入、可被测试直接调用，见那边的说明）。
  installZaiSessionWatch({
    reportLiveSession: reportLiveSessionToActiveTasks,
    notifySessionChange,
    addLocationChangeListener: (handler) => {
      ctx.addEventListener(window, 'wxt:locationchange', handler);
    },
    intervalMs: SESSION_WATCH_INTERVAL_MS,
  });
}

/** 订阅「地址里的会话变了」。返回取消订阅函数。 */
function onZaiSessionChange(listener: () => void): () => void {
  sessionChangeListeners.add(listener);
  return () => {
    sessionChangeListeners.delete(listener);
  };
}

function notifySessionChange(): void {
  notifyZaiSessionChange({
    getCurrentSessionId: getCurrentChatSessionId,
    listeners: sessionChangeListeners,
    readLastNotified: () => lastNotifiedSessionId,
    writeLastNotified: (value) => {
      lastNotifiedSessionId = value;
    },
  });
}

/** 上一次通知出去的会话 id（含 null：从会话页回到首页也算一次变化）。 */
let lastNotifiedSessionId: string | null = null;

const SESSION_WATCH_INTERVAL_MS = 1_000;

/**
 * 自定义背景：拉一次已保存的配置并应用，同时订阅 DOM 变更持续把新出现的
 * 页面容器标成透明（聊天页是 SPA，切会话/渲染消息都会重建容器）。
 *
 * 变更回调按帧合并：流式回答时 DOM 每秒会变更上百次，而
 * `patchContainerBackgrounds` 要读 `getComputedStyle` + `getBoundingClientRect`
 * （强制布局），逐次触发会明显掉帧。
 */
async function installBackgroundCapability(): Promise<void> {
  try {
    const config = await sendRuntimeMessage<BackgroundConfig | null>({ type: 'GET_BACKGROUND' });
    applyBackground(config ?? null);
  } catch (error) {
    console.log('[Zai++] background config load failed', error);
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled || !isBackgroundActive()) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      patchContainerBackgrounds();
    });
  });
  const root = document.body ?? document.documentElement;
  if (root) observer.observe(root, { childList: true, subtree: true });
}


/**
 * 工具调用面板（一轮回答里执行过的工具收成一块可折叠列表）。
 *
 * ⚠️ **模块级单例**：它内部持有「已恢复记录」的 map 与待渲染集合 ——
 * 每次新建会让那些状态丢掉，表现是「刷新后卡片出现又消失」。
 * ⚠️ **依赖全部在此注入**（站点选择器 / 文案 / runtime 读取），
 * `core/zai/tool-panel.ts` 自己不 import 任何 i18n 或 runtime 命令。
 */
const toolPanel = createToolPanelController({
  statusLabels: () => ({
    running: translate(currentContentLocale, 'content.toolBlock.summaries.running'),
    executed: translate(currentContentLocale, 'content.toolBlock.summaries.executed'),
    failed: translate(currentContentLocale, 'content.toolBlock.summaries.failed'),
  }),
  formatTitle: (count) => translate(
    currentContentLocale,
    'content.toolBlock.title',
    { count },
  ),
  renderDetail: (target, result) => renderToolResultWithRegistry({
    target,
    result,
    locale: currentContentLocale,
  }),
  getChatSessionId: getCurrentChatSessionId,
  // ⚠️ **命令字面量必须留在本文件**（`tests/runtime-boundary.test.ts` 用 AST 从内容脚本
  // 抓「实际发出的命令」做双向比对）；所以这里只做一层转发，不把命令写进 `core/`。
  loadToolHistory: async () => {
    const history = await sendRuntimeMessage<ToolHistoryRecordLike[]>({
      type: 'GET_TOOL_CALL_HISTORY',
      payload: { limit: TOOL_PANEL_HISTORY_LIMIT },
    });
    // ⚠️⚠️ **读失败必须抛、不能收敛成 `[]`** —— `sendRuntimeMessage` 在
    // 「扩展上下文没了」与「sendMessage 抛错」两条路上都返回 `undefined`，
    // 而 `[]` 与「读到了但一条记录都没有」在下游**无法区分**：面板会静默退化成
    // 「工具名 + 已执行」（没有详情、没有保存按钮），且没有任何重试。
    // 抛出去之后 `loadStorageLeg` 会重试一次（见那边的说明）。
    if (!Array.isArray(history)) throw new Error('tool_history_read_failed');
    return history;
  },
  observeRoot: () => document.getElementById('app') ?? document.body,
});

/**
 * 一次读多少条存储腿记录。
 *
 * ⚠️ **不是「越多越好」**：这些记录每条都带 `detail` / 输出快照（写入时截到
 * 4k / 8k），读回来要逐条按会话过滤并渲染。100（存储上限）在长会话里够用，
 * 而更大只会拖慢会话切换。**失败方向是安全的** —— 读少了只是「较早的那几轮
 * 没有真结果」，面板仍会由历史腿画出来（只是摘要）。 */
const TOOL_PANEL_HISTORY_LIMIT = 100;

/**
 * 注入 UI 的主题跟随：把 z.ai 页面的 `html.light` / `html.dark` 投影成
 * `body.zpp-theme-dark` / `zpp-theme-light`。
 *
 * ⚠️ **不能只靠 `prefers-color-scheme`** —— 页面主题与系统主题会分叉（页面深色 +
 * 系统浅色是最常见的一种）。此时若走浅色变量块，卡片用近黑的字配近透明的底，
 * 落在深色页面上就看不见了。
 *
 * ⚠️ **只盯 `class` 属性** —— `attributeFilter: ['class']` 让 observer 忽略页面上
 * 每秒几十次的其它 DOM 变动（消息流式输出），代价可忽略。
 */
function installInjectedThemeWatch(): void {
  injectInjectedThemeStyles();
  syncInjectedTheme();
  const root = document.documentElement;
  if (!root) return;
  new MutationObserver(syncInjectedTheme).observe(root, {
    attributes: true,
    attributeFilter: ['class'],
  });
}

/**
 * 「这一发可能发出去了、也可能没有」的看门狗：到点还不前进就把循环收掉。
 *
 * **为什么需要它**：`waitForSendEvidence` 返回 `ambiguous` 时，调用方既不能重发
 * （可能已经发出去了 ⇒ 双发）也不能就此放手（万一真没出去，这一轮永远等不到响应）。
 * 没有看门狗的话，`continuationLoop` 会**永久停在 `running`** ——
 * 而 `submitDomTaskPrompt` 的 busy 判据读的就是它 ⇒ **那之后的每一次自动化都会被拒**，
 * 且 `busy` 不在 `RETRYABLE_PRE_SEND_ERRORS` 里，后台不会重试。切会话也不清它
 * （`handleSessionChange` 只清工具面板）。
 *
 * **为什么不能直接调 `finishContinuationLoop`**：它内部 `if (loop.taskId)` 会发
 * `DOM_TASK_COMPLETE` —— 那是「续跑正常跑完」的语义，而这里的事实是「可能根本没发出去」。
 * 回 COMPLETE 会让自动化显示成功、正文却是空的。所以照 `terminateDomTaskAsStopped`
 * 的形状：**先摘 `taskId`**（它就不再进 COMPLETE 那一支）→ 收尾 → 自己发 FAILED。
 *
 * ⚠️ **刻意不复用 `terminateDomTaskAsStopped`** —— 那个函数会往 `respondedRequestIds`
 * 里塞 requestId，而我们此刻**没有 requestId**（请求可能压根没发出去）。
 *
 * ⚠️⚠️ **复检必须是四条，缺一条都能误收正在进行的循环**：
 * ① 同一个 loop；② `status === 'running'`；③ `activeRequestId === null`
 * （null = 还没有请求被认领成续跑轮）；④ **`stepCount` 与 `nudgeCount` 都没变**。
 *
 * ⚠️ **④ 为什么要带 `nudgeCount`** —— `advanceContinuationLoop` 会先 `stepCount += 1` 再挂看门狗，
 * 所以「步数」对它是有效令牌；但 **nudge 分支不推进 `stepCount`**（只递增 `nudgeCount`）。
 * 只看步数时，连续两次 nudge 各自挂的看门狗会成为对方的「合法收尾者」——
 * 第一个到点时四条判据全过，而第二个那一发可能正在发送。
 *
 * ⚠️ **重新武装前必须先 `clearTimeout` 旧的** —— `pendingWatchdog` 是单数字段、
 * 承担「一个 loop 至多一个看门狗」的语义；直接覆盖会让旧 timer 留在事件循环里
 * （它到点后靠复检自我消音，但那是**泄漏**，不是设计）。
 */
function armAmbiguousSendWatchdog(
  loop: ContinuationLoop,
  stepAtArm: number,
  nudgeAtArm: number,
): void {
  // ⚠️ 覆盖前先撤旧的 —— 同一个 loop 至多一个看门狗，旧的不撤就是泄漏。
  if (loop.pendingWatchdog !== null) {
    clearTimeout(loop.pendingWatchdog);
    loop.pendingWatchdog = null;
  }
  const timer = setTimeout(() => {
    // 期间可能已被正常推进（下一轮已经来了）、已被取消、或被新循环顶替。
    if (continuationLoop !== loop) return;
    if (loop.status !== 'running') return;
    if (loop.activeRequestId !== null) return;
    // 步数与纠偏次数任一变了 ⇒ 已经推进过一轮，正在注入下一轮。
    if (loop.stepCount !== stepAtArm || loop.nudgeCount !== nudgeAtArm) return;

    console.log('[Zai++] continuation send left no evidence; reclaiming the loop', {
      step: loop.stepCount,
      taskId: loop.taskId,
    });
    failContinuationLoop(loop, ZAI_CONTINUATION_SEND_UNCONFIRMED_CODE);
  }, ZAI_CONTINUATION_SEND_WATCHDOG_MS);
  loop.pendingWatchdog = timer;
}

/**
 * 看门狗时长：从 `waitForSendEvidence` 返回 `ambiguous` 之后再等这么久。
 *
 * 依据（实测）：桥上那条 `AUGMENT_REQUEST_BODY` 在**真实请求之前**
 * 几十毫秒就到了（按最外层计时的口径会晚 13–16ms，那是包一层测出来的偏差）。
 * 所以「5 秒证据窗口里一条桥消息都没来」之后，再等 5 秒已经足够宽松 ——
 * 正常情况只需要几十毫秒。上限 10 秒的依据是 Stop 存活最短 5.1 秒：
 * 超过这个还没动静就不可能是正常轮。对照原来的 180 秒租约，降到十八分之一。
 */
const ZAI_CONTINUATION_SEND_WATCHDOG_MS = 5_000;

/**
 * 「这一发没拿到发出证据」的日志。
 *
 * ⚠️ **一律 `console.log`** —— 续跑失败是最常见、也最容易恢复的一类，把它打成
 * `console.error` 会让扩展的错误面板长期挂着一条红字。用户可见的那一面由
 * `failContinuationLoop` 回传的 `DOM_TASK_FAILED` 承担（自动化卡片与运行记录），
 * 日志只负责给出成因。
 * ⚠️ **刻意保留第一个形参**（不叫、也不读）：三处调用点都传 `loop`，
 * 去掉它会让调用点看不出「这条日志属于哪条循环」。`noUnusedParameters` 用下划线前缀豁免。
 */
function reportContinuationSendNotObserved(
  _loop: ContinuationLoop,
  message: string,
  detail: Record<string, unknown>,
): void {
  console.log(message, detail);
}

/**
 * **把这一轮续跑判为失败并收尾。**
 *
 * ⚠️⚠️ **必须走这个函数，不能直接 `finishContinuationLoop`** —— 后者在 `loop.taskId`
 * 存在时无条件回传 `DOM_TASK_COMPLETE`（= 成功），协调器按 `ok: true` 收、
 * scheduler 记成 `succeeded` ⇒ **多步任务在第 N 轮静默中断，界面上却是绿的**。
 *
 * ⚠️ **顺序是承重的**：先摘 `taskId`，`finishContinuationLoop` 才不进「回 COMPLETE」那一支；
 * 而 `clearActiveDomTask` 那句写在 `finishContinuationLoop` 的 `if (loop.taskId)` 块里，
 * 摘掉之后就不会执行 ⇒ 必须在这里自己清（不清会在 `activeDomTasks` 里留一条僵尸，
 * 把后续所有自动化判成 `busy`）。
 *
 * ⚠️ **手动轮（`taskId` 为 null）只收尾、不回报** —— 它本来就没有回传通道。
 */
function failContinuationLoop(loop: ContinuationLoop, code: string): void {
  const taskId = loop.taskId;
  loop.taskId = null;
  finishContinuationLoop(loop);
  if (!taskId) return;
  clearActiveDomTask(taskId);
  void sendRuntimeMessage({
    type: 'DOM_TASK_FAILED',
    taskId,
    // ⚠️ 报**这一轮真正跑的那个会话**，不是此刻地址栏里的 —— 用户切走之后
    // 地址栏已经指向别的对话，取现值会把运行记录记到别人头上。
    chatSessionId: loop.chatSessionId,
    error: code,
  });
}

/**
 * **页面切到了别的会话（或回到首页 / 新会话页）** ⇒ 这一轮续跑再也推进不下去，收掉它。
 *
 * ⚠️⚠️ **判据必须是地址栏，不能是「页面 abort 了那一轮」** —— 后者只能覆盖
 * 「正在流式接收、且 `activeRequestId` 还没被清」这一窄窗口。实际最容易卡住的三段它都盖不到：
 * ① **答完 → 等证据 → 注入**（没有请求、没有终态，`activeRequestId` 已经是 null）；
 * ② **HTML 挑战页**（`fetch-hook` 只发 `onHtmlChallenge`，不发终态）；
 * ③ **发送链正在 await**（最长 12 秒，没有请求可 abort）。
 * 这三种情况下循环会永久停在 `running`，而 `runDomTask` 的 busy 判据读的正是它
 * ⇒ **之后这个标签页上所有自动化都会被静默拒掉**（`busy` 不在 `RETRYABLE_*` 里、不重试）。
 *
 * ⚠️⚠️ **回到首页也算「不在这个会话里」** —— 首页（`https://zchat.z.ai/`）与新会话页
 * pathname 都是 `/`，`readZaiChatSessionId` 对它返回 null。所以判据写成
 * **`current !== loop.chatSessionId`**（不是「`current` 非空且不等」）：
 * 放行 null 会让续跑 prompt 被提进一个**全新对话**（多一条没人认领的对话 + 一次真实计费）。
 *
 * ⚠️⚠️ **`loop.chatSessionId !== null` 是必需的守卫** —— `onZaiSessionChange` 是
 * 1 秒轮询驱动的，而页面刚加载时 `lastNotifiedSessionId` 的初值是 null、必然触发一次
 * 「假变化」；那一刻若循环刚建好，缺这条会被误杀。两条建循环路径都保证它非空，
 * 所以这条守卫不会挡住任何真实场景。
 *
 * ⚠️ **不设宽限窗口**：续跑只能活在它自己那条会话里 —— 切走那一刻，下一轮注入就会
 * 打进**另一个对话**，不存在「切回来继续」的状态。所以这里只有「立刻判失败」一个选项。
 */
function reclaimLoopOnSessionChange(): void {
  const loop = continuationLoop;
  if (!loop || loop.status !== 'running') return;
  if (!loop.chatSessionId) return;
  const current = getCurrentChatSessionId();
  if (current === loop.chatSessionId) return;
  console.log('[Zai++] continuation session changed; reclaiming the loop', {
    from: loop.chatSessionId,
    to: current,
    step: loop.stepCount,
  });
  failContinuationLoop(loop, ZAI_CONTINUATION_LOOP_MISSING_CODE);
}

function finishContinuationLoop(
  loop: ContinuationLoop,
  options?: {
    /**
     * **顶替场景**：把长窗口与它挂着的会话**原样交给下一条循环**。
     *
     * ⚠️⚠️ 为什么不能「先卸再挂」：`release` 与随后的 `want` 是两条独立的
     * `sendRuntimeMessage`，**没有顺序保证** —— STOP 后到会把 START 摘掉，
     * 而保活失效是静默的。
     * ⚠️ 只有 `supersedeRunningLoop` 会传它；正常收尾（任务跑完 / 循环自己结束）
     * 一律不传，必须卸干净。
     */
    preserveKeepAlive?: boolean;
  },
): void {
  // ⚠️ **这里刻意不停保活**：早退说明 `continuationLoop` 已经是**另一条循环**
  // （被 `supersedeRunningLoop` 顶替、或新的建循环抢先落地）。保活是**按标签**的，
  // 同一标签只有一条会话 ⇒ 那条会话此刻归新循环用，停掉等于把新循环的保护摘了。
  // 真正要清的孤儿是「页面刷新后旧会话留在 SW 里」，由内容脚本启动时的 STOP 收口。
  if (continuationLoop !== loop) return;
  // 收尾时撤销还没触发的看门狗 —— 否则它到点会对着一个已收尾的循环再跑一遍逻辑。
  if (loop.pendingWatchdog !== null) {
    clearTimeout(loop.pendingWatchdog);
    loop.pendingWatchdog = null;
  }
  // ⚠️ **先复位长窗口标记，再卸保活** —— 反过来的话 `releaseTabKeepAlive`
  // 会因为 `sustainedKeepAlive` 还是 true 而直接返回，那条会话就留在那儿了。
  // ⚠️ 顶替场景**跳过**这两步（见 `preserveKeepAlive`）：长窗口原样留给新循环。
  if (!options?.preserveKeepAlive) stopSustainedKeepAliveWatch();
  loop.status = 'idle';
  loop.activeRequestId = null;
  loop.pendingPrompt = null;
  continuationLoop = null;
  // 循环结束了就把保活卸掉 —— 留一条挂着的 debugger 会话会让调试横幅一直挂着。
  // （正常情况下 `submitContinuationViaPage` 的 `finally` 已经卸过，这里兜底。）
  // ⚠️ **顶替场景必须交还所有权、但不发 STOP** —— 新循环马上就要 `want`；
  // 这里发 STOP 与它的 START 没有顺序保证，STOP 后到会把新循环的会话摘掉。
  if (!options?.preserveKeepAlive) {
    void releaseTabKeepAlive();
  } else if (keepAliveOwner === loop.loopId) {
    keepAliveOwner = null;
  }
  // 后台 DOM 任务：续跑收尾 → 回传终态成功并清理归属。
  if (loop.taskId) {
    const task = activeDomTasks.get(loop.taskId);
    // ⚠️ **会话 id 取这一轮自己跑的那个**（建循环时抓的），不是此刻地址栏里的 ——
    // 用户中途切走会话时，读现值会把这次运行记到**另一个对话**上。
    // 地址栏只作兜底（循环的会话 id 在两条建循环路径上都必然非空，这一档是防御）。
    const finalSessionId = loop.chatSessionId ?? getCurrentChatSessionId() ?? task?.chatSessionId ?? null;
    clearActiveDomTask(loop.taskId);
    void sendRuntimeMessage({
      type: 'DOM_TASK_COMPLETE',
      taskId: loop.taskId,
      chatSessionId: finalSessionId,
      assistantText: loop.finalAssistantText || loop.lastVisibleText,
      toolExecutions: loop.toolExecutions,
      steps: loop.stepCount,
    });
  }
}

// ---------------------------------------------------------------------------
// DOM 注入发送（共享原语 + Stop 按钮观察器，见 sendPromptPrimitive）
// ---------------------------------------------------------------------------

const SEND_BUTTON_SELECTOR = '#send-message-button';

/**
 * Stop 按钮（`[aria-label="Stop"]`）出现/消失观察器。
 *
 * z.ai 页面没有暴露「正在生成」的标志位，唯一可靠的是 Stop 按钮：它只在 agent
 * 生成期间出现（真机观察到的判定点）。DOM 注入发送前必须等它
 * 消失，否则注入会被当作「用户抢答」丢弃 —— 这是「首条消息卡在首页」的根因之一：
 * 点击 send 后页面先渲染一个生成中的占位、紧接着才发 /chats/new，此时若再 requestSubmit
 * 一次就会被拒绝，输入框被清空但页面不跳 /c/<id>。
 */
let stopObserverInstalled = false;
let lastStopButtonAppearedAt = 0;
let lastStopButtonGoneAt = 0;
let stopObserver: MutationObserver | null = null;
/**
 * 手动停止检测：
 * z.ai 的 Stop 按钮被点后，前端 abort 掉读取流（`Aborted on reading stream`），
 * 扩展永远收不到那条请求的 RESPONSE_COMPLETE → pending 条目 settle 不掉 → 后台 run
 * 卡在 running。这里在「Stop 消失」后开一个宽限窗口，窗口内若仍收不到对应
 * RESPONSE_COMPLETE，就判定为「用户手动停止」，回传 DOM_TASK_FAILED 收尾。
 * `respondedRequestIds` 记录已收到过响应的 requestId，用来区分「正常完成（Stop 消失后
 * 响应马上到）」和「手动停止（响应永不到）」。
 */
const MANUAL_STOP_GRACE_MS = 4_000;
const respondedRequestIds = new Set<string>();
const manualStopTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Stop 出现/消失的**稳定期**（`waitForAgentIdle` 用）。
 *
 * ⚠️ **不能用「再睡 150ms 然后重判」的轮询写法** —— 后台标签里定时器被压到每秒一次，
 * 那样会让每次等待都白等一整秒。改成「观察到消失后挂一个一次性定时器」：
 * 它被压到 1000ms 只是**多等一会儿**（失败方向安全），不是漏判。
 */
const STOP_IDLE_GRACE_MS = 150;

/**
 * **等 Stop 状态变化**的唤醒者（`waitForAgentIdle` 注册）。
 *
 * ⚠️ 与 `augProgressWaiters` 同性质：等待方跑在串行队列里，唤醒必须在
 * `stopObserver` 的回调里同步发生（那个回调不在队列上）。
 */
const stopStateWaiters = createWaiterRegistry();

/** 停止按钮的候选 aria-label（z.ai 中文界面是「停止」，英文是「Stop」）。 */
const STOP_BUTTON_SELECTORS = [
  '[aria-label="Stop"]',
  '[aria-label="停止"]',
  '[aria-label="停止生成"]',
];

function findStopButton(): HTMLElement | null {
  for (const selector of STOP_BUTTON_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) return el;
  }
  return null;
}

function installStopObserver(): void {
  if (stopObserverInstalled) return;
  /**
   * ⚠️⚠️ **`document.body` 拿不到时不能把「已安装」置位** —— 置了之后
   * 这个函数永远直接 return，观察器**再也不会被装上**。
   *
   * ⚠️ 本轮改动把这一格的后果**放大了**：原来 `waitForAgentIdle` 是每 120ms
   * 轮询 DOM 的，观察器没装上它照样能判；改成事件驱动之后，**观察器是唯一的唤醒源**
   * ⇒ 装不上就等于 `waitForAgentIdle` 只能等满 deadline。
   * `runAt: 'document_idle'` 下 `document.body` 通常非空，所以这条路径很难触发 ——
   * 但「很难触发」和「触发了就永远坏」不该共存。
   */
  if (!document.body) return;
  stopObserverInstalled = true;
  stopObserver = new MutationObserver(() => {
    const stop = findStopButton();
    if (stop) {
      lastStopButtonAppearedAt = Date.now();
    } else if (lastStopButtonAppearedAt > 0) {
      const goneAt = Date.now();
      lastStopButtonGoneAt = goneAt;
      // Stop 消失 = 一轮生成结束。若这轮有「还没收到响应的请求」，开宽限窗口：
      // 窗口内等不到 RESPONSE_COMPLETE 就判定手动停止。
      armManualStopDetection();
    }
    // 叫醒 `waitForAgentIdle` 的等待者 —— 见 `stopStateWaiters` 的说明。
    stopStateWaiters.notify();
  });
  // ⚠️ **`observe()` 也可能抛**（body 在判断之后被换掉 / 被分离）——
  // 抛了就回滚「已安装」，让下一次调用重试，理由同上。
  //
  // ⚠️⚠️ **只观察 `childList`，不观察 `attributes`** —— 真机实测：
  // Stop 消失那一刻 `childList` 记录 662 条、`attributes` 只有 3 条，**倾向删节点**。
  // ⇒ 节点增删这一档就够用。
  //
  // ⛔ **曾经加过 `attributes` + `attributeFilter: ['class','style','aria-label']`，已撤回**：
  // 那份依据（「`childHits: 0` 说明不是删节点」）是**假的** —— 探针当时装的是英文选择器
  // `[aria-label="Stop"]`，而界面是中文（真实元素是 `[aria-label="停止"]`），
  // **从头到尾没匹配到过元素**，`childHits: 0` 只是「什么都没测到」。
  // 加上的实际后果是**把无关属性变动也纳入触发面**：`lastStopButtonGoneAt` 会被
  // hover / 面板重画 / Svelte 收尾反复重盖章 ⇒ 150ms 稳定期永远满足不了 ⇒
  // `waitForAgentIdle` 白等满 deadline（实测：安静页 152ms，有 25ms 无关 churn 时 >2s 未完成）。
  //
  // ⚠️ **代价（如实记）**：若哪天站点改成「切 class 隐藏 Stop」，这一档不会触发 ⇒
  // 等待者只能等各自的 deadline（`waitForAgentIdle` 是 8 秒）。**失败方向是「慢」不是「错」**，
  // 而加了它换来的是**必然的慢**。届时先复查这里的实测结论再决定。
  try {
    stopObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  } catch {
    stopObserver = null;
    stopObserverInstalled = false;
    return;
  }
  // 初始快照（防止 observer 装上时 Stop 已经在页面里）。
  lastStopButtonAppearedAt = findStopButton() ? Date.now() : 0;
  lastStopButtonGoneAt = lastStopButtonAppearedAt > 0 ? 0 : Date.now();
}

/**
 * 对「已发出请求但还没收到 RESPONSE_COMPLETE 的 task」各挂一个手动停止宽限窗口。
 * 窗口到期时若对应 requestId 仍未收到响应，判定为手动停止 → 回传 cancelled 收尾。
 */
function armManualStopDetection(): void {
  for (const [requestId, taskId] of [...taskIdByRequestId]) {
    if (respondedRequestIds.has(requestId)) continue;
    if (manualStopTimers.has(requestId)) continue;
    const timer = setTimeout(() => {
      manualStopTimers.delete(requestId);
      if (respondedRequestIds.has(requestId)) return;
      const task = activeDomTasks.get(taskId);
      if (!task || task.status !== 'running') return;
      void terminateDomTaskAsStopped(taskId, requestId);
    }, MANUAL_STOP_GRACE_MS);
    manualStopTimers.set(requestId, timer);
  }
}

/**
 * 把 task 判为「用户手动停止」并清理归属：摘掉 requestId→taskId 映射、清 timer、
 * 回传 DOM_TASK_FAILED（error='cancelled'，coordinator 归为 ambiguous 不重试）。
 *
 * 带上此刻页面的会话 id：首轮生成中途被暂停时，两次 DOM_TASK_STARTED 都还没读到
 * `/c/<id>`，只有这里能补上真值 —— 否则自动化会一直显示会话「未创建」。
 */
async function terminateDomTaskAsStopped(taskId: string, requestId: string): Promise<void> {
  const liveSessionId = getCurrentChatSessionId();
  taskIdByRequestId.delete(requestId);
  respondedRequestIds.add(requestId);
  manualStopTimers.delete(requestId);
  // 若它已演化成运行中的续跑循环，先摘 taskId 让收尾不再回 COMPLETE。
  if (continuationLoop?.status === 'running' && continuationLoop.taskId === taskId) {
    continuationLoop.taskId = null;
    finishContinuationLoop(continuationLoop);
  }
  clearActiveDomTask(taskId);
  void sendRuntimeMessage({
    type: 'DOM_TASK_FAILED',
    taskId,
    error: ZAI_DOM_TASK_CANCELLED_CODE,
    chatSessionId: liveSessionId,
  });
}

function isAgentCurrentlyRunning(): boolean {
  const stop = findStopButton();
  if (stop) {
    // 只要 Stop 按钮存在就视为生成中（真机验证过的判定语义）。
    if (stop.offsetParent || stop.getClientRects().length > 0) return true;
    const rect = stop.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  }
  return false;
}

/** 等待上一轮生成结束（Stop 按钮消失），最多等 `timeoutMs`。 */
async function waitForAgentIdle(timeoutMs = 8_000): Promise<boolean> {
  installStopObserver();

  /**
   * 此刻是否「空闲」。**150ms 稳定期**的语义原样保留 —— 它防的是 Svelte 收尾未完成。
   * ⚠️ `lastStopButtonGoneAt === 0` 表示 observer 从没记录到「消失」事件
   * （Stop 从没出现过，或 observer 刚装好）⇒ 直接按当前 DOM 判定。
   */
  const isIdleNow = (): boolean => {
    if (isAgentCurrentlyRunning()) return false;
    const goneAt = lastStopButtonGoneAt;
    if (goneAt === 0) return true;
    // ⚠️⚠️ **必须是 `>=`，不能是 `>`** —— `graceTimer` 用的正是 `STOP_IDLE_GRACE_MS`
    // （150ms），定时器到点时差值**恰好 150**，`> 150` 为假 ⇒ 回调里判否、
    // **而它不再重挂** ⇒ 只能等满 8 秒的 deadline。
    // 实测（40 次）：`>` 只命中 24/40，`>=` 命中 39/40。
    // ⚠️ **只在「前台」发作**：后台标签的定时器被压到 ≥1000ms，回调时差值远超 150 所以为真
    // ⇒ 症状是「用户盯着的时候反而卡 8 秒，切走再回来就好了」，最难归因的那种。
    // ⚠️ 这个 `>` 是原来就有的字面量，但那时代码是死路径（缺 `check()` 首调，从没执行过）；
    // 事件驱动之后它成了唯一判据，容差问题才暴露出来。
    return Date.now() - goneAt >= STOP_IDLE_GRACE_MS;
  };

  if (isIdleNow()) return true;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      settled = true;
      unsubscribe();
      if (deadline !== null) clearTimeout(deadline);
      if (graceTimer !== null) clearTimeout(graceTimer);
      graceTimer = null;
      deadline = null;
    };
    const finish = (value: boolean) => {
      if (settled) return;
      cleanup();
      resolve(value);
    };

    /**
     * 每次 Stop 出现/消失时跑一遍。
     *
     * ⚠️ **稳定期那一段必须有自己的定时器** —— 它是「再等一会儿」而不是「轮询」：
     * 后台标签里它可能被压到 1000ms，但那只是**多等一会儿**（失败方向安全），
     * 不是漏判。这跟原来每 120ms 无脑重试整段逻辑是两回事。
     */
    const check = () => {
      if (settled) return;
      if (isIdleNow()) {
        finish(true);
        return;
      }
      if (!isAgentCurrentlyRunning() && graceTimer === null) {
        graceTimer = setTimeout(() => {
          graceTimer = null;
          if (settled) return;
          if (isIdleNow()) finish(true);
        }, STOP_IDLE_GRACE_MS);
      }
    };

    deadline = setTimeout(() => finish(!isAgentCurrentlyRunning()), timeoutMs);
    unsubscribe = stopStateWaiters.add(check);
    // ⚠️⚠️ **登记完必须立刻跑一次** —— 否则「已经停下、但距 `lastStopButtonGoneAt`
    // 不足 150ms」这一格**没有任何定时器在跑**（`graceTimer` 只在 `check` 里才建），
    // 只能等下一次 Stop 观察器回调或整个 `timeoutMs` 的 deadline。
    // 而首调场景**必然命中**：`installStopObserver()` 会把 `lastStopButtonGoneAt`
    // 初始化成 `Date.now()`，所以装完观察器后第一次调用一定走进等待分支；
    // 页面上再没有 Stop 节点增删时一次 notify 都不会来 ⇒ **白等满一个 deadline**。
    // 旧实现靠每 120ms 轮询自愈，事件驱动之后必须显式补这一下。
    check();
  });
}

/**
 * 续跑链的「点按钮」发送原语：把一段 prompt 注入输入框并让页面自己发出。
 *
 * ⚠️ **只有续跑链用它**（`sendPromptViaDom` ← `submitContinuationViaPage` 的兜底）；
 * 自动化的首条注入走另一条 `submitAutomationPromptViaPage`，不经过这里。
 * 它负责：等输入框就绪 → 等上一轮生成结束 → 写 value → 派发 input → 点 send 按钮
 * → 判定「已发出」（见 `waitForSendEvidence`：两个请求计数分三态，Stop 只作诊断、不参与分档）。
 *
 * 注意：这里只管「发送动作是否成功发出」，**不管**后续的请求归属/续跑/收尾，
 * 那些是调用方（续跑状态机 / 自动化任务状态机）各自的职责。续跑机制不被本函数改动。
 */
async function sendPromptPrimitive(
  prompt: string,
  expectedSessionId: string | null,
): Promise<ContinuationSendOutcome> {
  if (domSendInFlight) return unsentSend('send_in_flight');
  domSendInFlight = true;
  /** 注入期间对输入框做的那层「看不见」的撤销函数（任何出口都要走 finally 还原）。 */
  let restoreComposerAppearance: (() => void) | null = null;
  /**
   * 我们锁过的那个输入框与它原来的 `disabled` —— **必须在 `finally` 里恢复**。
   * 理由同 `trySubmitViaFormRequestSubmit` 的同名变量：中间抛错会跳过正常出口的恢复，
   * 输入框永久停在 `disabled = true`，用户只能刷新页面。
   */
  let lockedTextarea: HTMLTextAreaElement | null = null;
  let wasDisabled = false;
  try {
    await waitForComposerReady();
    let textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
    if (!textarea) return unsentSend('no_textarea');

    // 等上一轮生成结束，避免注入被当作用户抢答丢弃（首页首条尤其重要）。
    if (!(await waitForAgentIdle())) {
      return unsentSend('agent_not_idle');
    }

    // ⚠️⚠️ **等完必须重取**（理由同 `trySubmitViaFormRequestSubmit`）：生成结束时
    // 页面会重建这一小块 DOM，旧引用可能已经脱连，写进去的内容页面收不到。
    textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR) ?? textarea;

    wasDisabled = textarea.disabled;
    textarea.disabled = true;
    lockedTextarea = textarea;

    // 与表单主路同一层「看不见」（见 `maskComposerForInjection`）—— 它只动外观，
    // 不碰任何读写语义，所以这条路也照用；撤销走本函数的 `finally`。
    restoreComposerAppearance = maskComposerForInjection(textarea);

    setTextareaValue(textarea, '');
    setTextareaValue(textarea, prompt);

    const sendButton = await waitForSendButtonEnabled();
    if (!sendButton) {
      clearInjectedComposerText();
      textarea.disabled = wasDisabled;
      return unsentSend('send_button_disabled');
    }

    // ⚠️ **会话判据必须紧贴点击** —— 会话已切走时点下去，这一轮的工具结果会落进另一个对话。
    if (!isSessionStillCurrent(expectedSessionId)) {
      clearInjectedComposerText();
      textarea.disabled = wasDisabled;
      return unsentSend('session_changed');
    }

    sendButton.click();

    // 成功判据见 `waitForSendEvidence`（同样不能再用「输入框被清空」）。
    const { evidence } = await waitForSendEvidence();
    // ⚠️ **提交触发之后不再清空，一档都不清** ——
    // `sent`：页面自己会清；
    // `ambiguous`：那一发**可能已经发出去了**，页面还没读走值，清了会把这次发送打空
    //   且失败方向静默（请求照发、正文是空的）；
    // `unsent`：**这个函数拿不到这一档** —— `classifySendEvidence` 只产出 `sent` / `ambiguous`，
    //   `unsent` 的四个出口（无 textarea / agent 不空闲 / 点前无发送按钮 / 会话已切走）
    //   都在点击**之前**，那几处已各自清过。
    textarea.disabled = wasDisabled;
    return { evidence, reason: null };
  } finally {
    // ⚠️ **任何出口都要撤销那层「看不见」** —— 漏一次，用户的输入框会一直是透明的。
    restoreComposerAppearance?.();
    // ⚠️ **输入框的 `disabled` 同理** —— 正常出口在证据等待之后才恢复，中间抛错会跳过它。
    if (lockedTextarea) lockedTextarea.disabled = wasDisabled;
    domSendInFlight = false;
  }
}

async function sendPromptViaDom(
  prompt: string,
  expectedSessionId: string | null,
): Promise<ContinuationSendOutcome> {
  // 收敛到共享发送原语：等上一轮生成结束 → 写 value → 点 send → 判定已发出。
  return sendPromptPrimitive(prompt, expectedSessionId);
}

/**
 * 写输入框并派发 `input` 事件（自动化发送链的共享原语）。
 *
 * ⚠️ **本写法已在 z.ai 真机验证有效**（原生 value setter + 冒泡的 `input` 事件，
 * 页面据此更新 Svelte bound-value）。不 disable 输入框。
 *
 * ⚠️ **`inputType` / `data` 在本站点无人读**（真机验证：写完后 `value` 完整保留、
 * 全程没有 `beforeinput` 监听）⇒ 这里写 `insertText` + 占位 `data` 与上游的
 * `insertFromPaste` + 真实文本**等价**，不必为了「对齐上游」去改。
 */
function setTextareaValue(textarea: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (setter) setter.call(textarea, text);
  else textarea.value = text;
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
}

/**
 * 把**注入进输入框的那份文本**清掉。
 *
 * ⚠️⚠️ **只能在「提交已经触发」之后调** —— 页面是在提交事件里**同步**读走值的
 * （实测：在 `requestSubmit()` 返回后的同一个同步块里改写 value，都进不了它发出去的
 * 那条 body）。**在提交之前清空会把这一次发送打空**，而且失败方向是静默的：
 * 请求照发、请求计数照涨，自检全绿，只有正文内容是错的。
 *
 * ⚠️ **走 `setTextareaValue` 而不是直接赋 value** —— 与写入侧同一原语，
 * 让页面的 bound-value 一起同步成空，免得留下「DOM 空了、页面状态里还有值」的错配。
 *
 * ⚠️ **已经空就不要走** —— 页面自己清完（约 180ms 后）再调到这个函数是常态，
 * 多派发一次 `input` 只是让页面白跑一遍响应式。
 *
 * ⚠️ **注入期间想「让用户看不见」要用的是 `maskComposerForInjection`** ——
 * 这里是把值真的清掉（连页面那份状态一起），在提交之前调用会把这一发打空。
 */
function clearInjectedComposerText(): void {
  const textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
  if (!textarea || textarea.value === '') return;
  setTextareaValue(textarea, '');
}

/**
 * 注入期间让输入框**看起来是空的**：文字透明 + 高度冻住。返回**撤销函数**。
 *
 * ⚠️⚠️ **为什么不干脆把那段值清掉** —— 页面的 `bind:value` 有一条**反向同步**（状态 → DOM）。
 * 实测：与写值同一条同步块里把 DOM 静默清掉之后，
 * 页面在下一次刷新里**又把那段文本原样写了回来**。也就是说「状态里有、DOM 里没有」
 * 这个状态**维持不住** —— 那段文本必须存在于 DOM 里（页面提交时读的状态就是从它来的），
 * 所以只能让它**看不见**，不能让它**不存在**。
 *
 * ⚠️ **高度也要一起冻住** —— 注入的是几 KB 的工具结果，textarea 会自增高；
 * 只把文字变透明的话，「撑高再缩回」那一下照样看得见。（拿不到高度时跳过这一项，
 * 只做透明 —— 失败方向是「看得见撑高」，不是「藏不住文字」。）
 *
 * ⚠️⚠️ **撤销必须走 `finally`** —— 漏掉一次还原，用户的输入框会一直是透明的。
 * 另外**把输入框交还给用户之前要再撤一次**：那之后还挂着证据等待，遮罩留着会让用户
 * 打的字看不见（`finally` 那次只是兜底，两次调用是安全的）。
 *
 * ⚠️ **自动化的首条注入刻意不加这层遮罩** —— 那条注入的是**用户自己的任务文本**，
 * 不是工具结果，闪一下没有影响。
 */
function maskComposerForInjection(textarea: HTMLTextAreaElement): () => void {
  const height = Math.round(textarea.getBoundingClientRect().height);
  const saved = [
    'color',
    'caret-color',
    '-webkit-text-fill-color',
    'max-height',
    'overflow',
  ].map((name) => ({
    name,
    value: textarea.style.getPropertyValue(name),
    priority: textarea.style.getPropertyPriority(name),
  }));
  /** 这次真正写进去的那几项（还原时用来判断「当前值还是不是我们那份」）。 */
  const written: Array<{ name: string; value: string }> = [];
  let released = false;

  const restore = (): void => {
    // ⚠️ **可重复调用**：释放点在两处（清空之后 / 函数 finally），后者是兜底。
    if (released) return;
    released = true;
    for (const item of saved) {
      // ⚠️⚠️ **只撤「当前值仍是我们写进去的那一份」** —— 遮罩窗口里页面自己可能改过其中某项
      // （切主题改 `color`、自动增高改 `max-height`）；无条件写回会把它的改动覆回我们保存的旧值。
      const mine = written.find((entry) => entry.name === item.name);
      if (mine && textarea.style.getPropertyValue(item.name) !== mine.value) continue;
      if (item.value) textarea.style.setProperty(item.name, item.value, item.priority);
      else textarea.style.removeProperty(item.name);
    }
  };

  // ⚠️⚠️ **先把 `restore` 建好，再写样式**：写样式的中间某一步若抛错，调用方就拿不到撤销函数，
  // 输入框会**永久透明**。这里失败就先自己还原。
  // ⚠️ 但这层是纯外观 ⇒ **失败不能连累发送**：还原之后吞掉错误（打一条日志），
  // 让注入照常进行（退化成「看得见」，即改动前的样子）。
  try {
    // 每一项都「写进去 + 记账」—— 还原时靠 `written` 判断「当前值还是不是我们那一份」。
    textarea.style.setProperty('color', 'transparent', 'important');
    written.push({ name: 'color', value: 'transparent' });
    textarea.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
    written.push({ name: '-webkit-text-fill-color', value: 'transparent' });
    textarea.style.setProperty('caret-color', 'transparent', 'important');
    written.push({ name: 'caret-color', value: 'transparent' });
    if (height > 0) {
      const heightValue = `${height}px`;
      textarea.style.setProperty('max-height', heightValue, 'important');
      written.push({ name: 'max-height', value: heightValue });
      textarea.style.setProperty('overflow', 'hidden', 'important');
      written.push({ name: 'overflow', value: 'hidden' });
    }
  } catch (error) {
    restore();
    console.log('[Zai++] composer mask failed, injecting without it', error);
  }

  return restore;
}

/**
 * 插入文本到聊天输入框。
 * 走原生 value setter + input/change 事件，让 Svelte bound-value 同步，返回
 * { ok, insertedLength } 或 { ok:false, error }。供保存项「插入到对话」复用。
 *
 * ⚠️ **InputEvent 的 `data` / `inputType` 在本站点无人读**（真机验证过）——
 * 所以这里写 `insertText` + 占位 `data` 与上游的 `insertFromPaste` + 真实文本等价，
 * 不必为了「对齐上游」去改。见 `setTextareaValue`。
 */
function insertPromptText(text: string): { ok: true; insertedLength: number } | { ok: false; error: string } {
  if (text.length === 0) return { ok: false, error: 'empty_prompt_text' };
  const textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR)
    ?? document.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) return { ok: false, error: 'prompt_input_not_found' };

  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const nextValue = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
  setTextareaValue(textarea, nextValue);
  const caret = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = caret;
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  textarea.focus();
  return { ok: true, insertedLength: text.length };
}

function waitForSendButtonEnabled(): Promise<HTMLButtonElement | null> {
  return waitForDomCondition<HTMLButtonElement | null>({
    probe: () => {
      const button = document.querySelector<HTMLButtonElement>(SEND_BUTTON_SELECTOR);
      if (!button) return null;
      if (button.disabled) return null;
      if (getComputedStyle(button).pointerEvents === 'none') return null;
      return button;
    },
    timeoutMs: 4_000,
    fallback: () => null,
  });
}

function waitForComposerReady(): Promise<void> {
  // ⚠️ **`probe` 返回 `true` 而不是 `undefined`** —— `waitForDomCondition` 的判据是
  // `!== null`，用 `undefined` 当「成立」会让「探针忘了写 return」这种错变成
  // 静默的立即成功。返回值在这里没意义，只用来表达「成立 / 未成立」。
  // ⚠️ **超时也 resolve**（不是 reject、也不是无限等）—— 调用方紧接着会自己
  // `querySelector` 一次并判空，所以「超时」与「就绪」在这里**不需要区分**。
  return waitForDomCondition<boolean>({
    probe: () => (document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR) ? true : null),
    timeoutMs: 6_000,
    fallback: () => false,
  }).then(() => undefined);
}

/** 自动化专用：等 #chat-input 出现，最多 timeoutMs（默认 60s）。不碰续跑用的 waitForComposerReady。 */
async function waitForAutomationComposer(timeoutMs = 60_000): Promise<boolean> {
  const endAt = Date.now() + timeoutMs;
  while (Date.now() < endAt) {
    const textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
    if (textarea) return true;
    await sleep(300);
  }
  return document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR) !== null;
}

/*
 * 三档的含义与调用方该怎么处置（类型定义在 `core/zai/send-evidence.ts`）：
 *
 * | 档 | 含义 | 该做什么 |
 * |---|---|---|
 * | `sent` | 请求确实发出去了 | 正常推进 |
 * | `unsent` | 确定没发出去 | **可以安全重发**（没有任何副作用） |
 * | `ambiguous` | 证据不足 —— 可能发出去了，也可能没有 | **不许重发**（重发就是双发），起看门狗 |
 */
/**
 * 等「这一发确实发出去了」的证据，最多 5 秒。
 *
 * 判据有两个**独立的**计数器，它们回答的是不同的问题：
 *
 * ① `observedAugRequestCount` —— **桥消息到了几次**。它在 `dispatchMainWorldMessage`
 *    的**串行队列之外**就 +1，语义是「主世界说有请求要发出去了」。
 * ② `continuationRequestSeq` —— **其中几次是续跑模板**。它只在
 *    `isZaiContinuationRequestBody` 判 true 时 +1。
 *
 * 两者都在**串行队列之外**涨（`dispatchMainWorldMessage` 的同步区），
 * 所以我们占着队列也读得到。⚠️ **不能用 `continuationLoop.status` 判定**：
 * `RESPONSE_COMPLETE` 在串行队列里被本函数阻塞，而本函数又在等 status 变化 ⇒ 自锁。
 *
 * **两个计数器的组合决定档位**（这是区分 `ambiguous` 两种成因的唯一办法：
 * 「桥挂了」与「桥通了但 body 不是续跑模板」代价完全不同，前者这一轮真的不会前进，
 * 后者请求正常发出、回答照常回来，只是主判据没涨）：
 *
 * | ① count | ② seq | 档 | 说明 |
 * |---|---|---|---|
 * | 涨 | 涨 | `sent` | 正常：桥通了、而且认得出是续跑模板 |
 * | 涨 | 没涨 | `sent` | 桥通了，但这一发的 body 不是续跑模板（注入没被采纳等）—— **请求确实出去了** |
 * | 没涨 | 没涨 | `ambiguous` | 桥挂了，或请求压根没发 |
 *
 * ⚠️ **「看到过 Stop」不再参与分档** —— 它只作为**诊断字段**留在返回值里。
 * 理由是实测：Stop 早于请求 3–5ms、存活 5–7 秒，把它当证据等于「只要页面在生成就算发出去了」。
 *
 * ⚠️ **调用点必须在「提交已经触发」之后** —— 两个计数器都只反映「提交之后」发生的事，
 * 在提交之前读会拿上一轮的残留。
 */
async function waitForSendEvidence(): Promise<{
  evidence: ZaiSendEvidence;
  /** 诊断用：等待期间看到过 Stop 按钮（**不参与分档**）。 */
  sawStop: boolean;
  /** 诊断用：这一轮桥上来了几条请求（`observedAugRequestCount` 的增量）。 */
  requestDelta: number;
  /** 诊断用：其中几条认作续跑模板（`continuationRequestSeq` 的增量）。 */
  continuationDelta: number;
}> {
  const startSeq = continuationRequestSeq;
  const startCount = observedAugRequestCount;
  // ⚠️ **`sawStop` 的取法跟着改了**：原来是每 150ms 采样一次、记「等待期间看到过」。
  // 改成事件驱动之后没有采样点了，但 `installStopObserver` 本来就在记
  // `lastStopButtonAppearedAt`（Stop 出现的时刻）⇒ 直接比时间戳，
  // **比轮询更准**（不会因为采样错过而漏记）。
  const startedAt = Date.now();

  const verdict = (): ZaiSendEvidence => classifySendEvidence(
    observedAugRequestCount - startCount,
    continuationRequestSeq - startSeq,
  );

  // ⚠️ **改成事件唤醒**（原来 `await sleep(150)` 轮询）：后台标签里定时器被压到
  // 每秒一次，5 秒窗口只剩 5 个采样点，而桥消息的真实延迟是几十毫秒级 ⇒ 会把
  // 「确实发出去了」判成 `ambiguous` ⇒ 起看门狗、回收循环（静默收尾）。
  await waitForNotified(() => verdict() === 'sent', 5_000, augProgressWaiters);

  return {
    evidence: verdict(),
    // 等待期间 Stop 出现过（时间戳比较），或此刻仍在生成。
    sawStop: lastStopButtonAppearedAt > startedAt || isAgentCurrentlyRunning(),
    requestDelta: observedAugRequestCount - startCount,
    continuationDelta: continuationRequestSeq - startSeq,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export default defineContentScript({
  // ⚠️ **两站都要挂** —— 见 `zai-main-world.content.ts` 的说明；manifest 阶段是
  // 字面量、引不到真源 ⇒ **改要两处同改**。
  matches: ['*://zchat.z.ai/*', '*://chat.z.ai/*'],
  runAt: 'document_idle',
  async main(ctx) {
    extensionContextValid = true;

    // ⚠️⚠️ **清掉上一页留在后台的保活会话** —— 保活活在 service worker 里（按标签记），
    // 而内容脚本是每页一份。页面一刷新 / 一导航，旧页面那条续跑循环连同它的收尾一起消失，
    // 但 SW 里那条 CDP 会话**还在** ⇒ 那个标签上一直画着「Zai++ started debugging this
    // browser」横幅，而此刻并没有任何续跑在跑。
    // 新页面启动时**必然**没有续跑循环 ⇒ 该标签上任何保活会话都是孤儿，直接停掉。
    // ⚠️ 只停本标签（命令按 `context.tabId` 生效），并发时不会误伤别的自动化。
    // **不 await**：清不掉最多让横幅多挂一会儿，不该拖住启动链。
    void releaseTabKeepAlive();

    // 工具结果卡片（Skill 起草 / 记忆导入预览）的渲染器与落库通道。
    //
    // ⚠️ **必须在面板首次渲染之前**：面板行的详情走 `renderDetail` →
    // `renderToolResultWithRegistry`，注册表为空时渲染器一个都不认，那两类结果会退化成
    // 纯文本（**没有「保存 / 导入」按钮**）。放在 `main` 开头最省心。
    // ⚠️ **只注册一次**（`registerDefaultToolResultRenderers` 内部按 `renderers.length` 短路）——
    // 每轮重复注册会让注册表无限增长。
    registerDefaultToolResultRenderers({
      saveSkill: saveSkillDraftViaRuntime,
      importMemories: importMemoryDraftsViaRuntime,
      isSkillDraftSaved: isSkillDraftSavedNow,
      areMemoriesImported: areMemoriesImportedNow,
    });

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      // 信封校验（source + type 形状）走共用判定，与协议清单同源。
      if (!isZaiBridgeMessage(event.data, ZAI_MAIN_TO_CONTENT)) return;
      void dispatchMainWorldMessage(event.data);
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // ⚠️ 闸门必须在**任何分支之前**：见 isAuthorizedInboundRuntimeMessage 的说明。
      // 不通过就静默 return（不回响应 —— 回错误响应同样算应答、会赢下竞速）。
      if (!isAuthorizedInboundRuntimeMessage(message, sender)) return undefined;
      if (message.type === 'STATE_UPDATED' || message.type === 'TOOL_DESCRIPTORS_UPDATED') {
        // ⚠️ `void` 的 rejection 没人接 —— 这条广播监听是 fire-and-forget，
        // 不该指望被调函数永不抛（后台的 `refreshBackgroundLocale` 也是自带 `.catch`）。
        void loadAndSyncRuntimeState().catch((error) => {
          console.error('[Zai++] runtime state sync failed', error);
        });
        sendResponse({ ok: true });
        return true;
      }
      if (message.type === 'BACKGROUND_UPDATED') {
        // 背景配置变了（侧边栏保存/清除）→ 立刻应用，不必等页面刷新。
        applyBackground((message.config ?? null) as BackgroundConfig | null);
        sendResponse({ ok: true });
        return true;
      }
      if (message.type === 'REFRESH_ZAI_AUTH') {
        // 返回真实的 hasToken：只有从页面 localStorage 兜底拿到 token 并写进
        // storage 才算刷新成功，不能无条件谎报（否则 background 会以为刷新成功）。
        void refreshZaiAuth()
          .then((hasToken) => sendResponse({ ok: hasToken, hasToken }))
          .catch((error) =>
            sendResponse({
              ok: false,
              hasToken: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        return true;
      }
      if (message.type === 'INSERT_PROMPT_TEXT') {
        const text = typeof message.text === 'string' ? message.text : '';
        sendResponse(insertPromptText(text));
        return true;
      }
      if (message.type === 'RUN_DOM_TASK') {
        // 后台发起 DOM 任务（Step 1：只做归属 + 结束回传；协调器在 Step 2）。
        void (async () => {
          try {
            const result = await runDomTask({
              taskId: typeof message.taskId === 'string' ? message.taskId : '',
              kind: typeof message.kind === 'string' ? message.kind : 'automation',
              prompt: typeof message.prompt === 'string' ? message.prompt : '',
              chatSessionId:
                typeof message.chatSessionId === 'string' ? message.chatSessionId : null,
              model: typeof message.model === 'string' ? message.model : null,
            });
            sendResponse(result);
          } catch (error) {
            sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        })();
        return true;
      }
      if (message.type === 'CANCEL_DOM_TASK') {
        const taskId = typeof message.taskId === 'string' ? message.taskId : '';
        if (taskId) {
          // 清掉该 task 关联的所有手动停止宽限窗口，避免残留 timer 误再回 FAILED。
          for (const [requestId, mappedTaskId] of [...taskIdByRequestId]) {
            if (mappedTaskId !== taskId) continue;
            taskIdByRequestId.delete(requestId);
            respondedRequestIds.add(requestId);
            const timer = manualStopTimers.get(requestId);
            if (timer) {
              clearTimeout(timer);
              manualStopTimers.delete(requestId);
            }
            // ⚠️ **取消本身不 abort 页面的读取流**（这条消息由协调器在 `signal` abort 时发，
            // 见 `dom-task-coordinator.ts`），所以该请求的 `REQUEST_TERMINAL` 仍会照常到达、
            // 收尾不会漏。这里补一次会合只是为了**给「取消」也留一个唤醒源** ——
            // 防的是将来某条错误路径不再发终态（那一刻会合状态就永远没人推进）。
            // ⚠️ **不能在这里直接置 `terminalSeen = true` 再收尾** —— 那会立刻关授权、立刻释放
            // 请求级状态，而在飞的工具（MCP 工具上界可达 120 秒）落地后会查不到 grant、落到
            // `executeDetected` 的懒建授权路径。会合点自己会因 `pendingExecutions > 0` 提前返回，
            // 真正收尾仍等执行落地。
            settleToolTurn(requestId);
          }
          // 若该任务已演化成运行中的续跑循环，先摘掉 taskId 让收尾不再回 COMPLETE。
          if (continuationLoop?.status === 'running' && continuationLoop.taskId === taskId) {
            continuationLoop.taskId = null;
            finishContinuationLoop(continuationLoop);
          }
          clearActiveDomTask(taskId);
          void sendRuntimeMessage({
            type: 'DOM_TASK_FAILED',
            taskId,
            error: ZAI_DOM_TASK_CANCELLED_CODE,
            chatSessionId: getCurrentChatSessionId(),
          });
        }
        sendResponse({ ok: true });
        return true;
      }
      return undefined;
    });

    // 启动链的编排搬到了 `core/zai/capability-install.ts`（依赖注入、可被测试直接调用）。
    // ⚠️ **顺序与「哪几处不等 promise」都是契约的一部分**，理由逐条写在那边的注释里。
    installZaiCapabilities({
      installStopObserver,
      installSessionWatch: () => installSessionWatch(ctx),
      installBackgroundCapability,
      installInjectedThemeWatch,
      installContinuationBubbleHider,
      installToolPanel: () => toolPanel.install(),
      onSessionChange: onZaiSessionChange,
      // ⚠️⚠️ **两件事，顺序不能反**：先收续跑循环，再让面板换记录。
      // 循环不收的话它会永久停在 `running`，`runDomTask` 的 busy 判据会把之后
      // **每一次自动化**都静默拒掉（`busy` 不在可重试码里）；长窗口也不会解除。
      handleSessionChange: () => {
        reclaimLoopOnSessionChange();
        toolPanel.handleSessionChange();
      },
      refreshAuth: refreshZaiAuth,
      // 「最近活跃站」（A 兜底）：内容脚本是唯一知道页面在哪一站的上下文，
      // 由它把这个事实写进 storage 供没有页面上下文的链路（侧边栏兜底拼链接、
      // 后台抓模型清单）读取。**不 await** —— 写不进去只是那条兜底退回默认站。
      rememberActiveSite: () => rememberActiveZaiSite(location.origin),
      syncRuntimeState: loadAndSyncRuntimeState,
      // ⚠️ **`onContinuationBubblesHidden` 刻意不传** —— 它存在的唯一用途是打一条
      // 「隐藏了几条气泡」的日志，而那是**正常路径上的成功事件**（每轮续跑都会发生）。
      // 扩展没有 dev/prod 之分（unpacked 安装），所以只能逐条决定「这句话该不该被
      // 用户看见」；这条不该。接口里那个可选钩子保留（编排层照常转发，只是没人接）。
    });

    await syncRuntimeStateBeforeUse({ syncRuntimeState: loadAndSyncRuntimeState });
  },
});

/** 后台 auth refresh：从页面 localStorage 读 token 兜底写进 chrome.storage（best-effort）。 */
async function refreshZaiAuth(): Promise<boolean> {
  try {
    const raw = (typeof localStorage === 'undefined' ? '' : localStorage.getItem('token') ?? '');
    const token = raw.trim();
    if (!token) return false;
    // ⚠️ **写进本页所属站的桶**（同 HEADERS_CAPTURED 那条）。
    return await mergeZaiAuthFromCapture({
      token,
      userId: readZaiUserIdFromToken(token),
      feVersion: undefined,
      deviceId: undefined,
    }, currentSiteOrigin());
  } catch {
    return false;
  }
}