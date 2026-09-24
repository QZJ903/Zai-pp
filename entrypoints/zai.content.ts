/**
 * GLM++ isolated-world content script（chat.z.ai）。
 *
 * 职责：
 * 1. 运行时状态同步：从后台拉记忆/技能/预设/工具描述符，推给 MAIN world 的 hook。
 * 2. 请求增广：completion + /chats/new 的 body 增强（记忆 + 工具目录 + 沙盒提示词），
 *    续跑请求透传不重灌。
 * 3. 工具执行中继：MAIN world 识别出的 XML 工具 → 后台 EXECUTE_TOOL_CALL。
 * 4. 续跑循环状态机：原生轮执行了可续跑工具 → 用 DOM 注入让页面自己发下一轮。
 * 5. agent 状态面板 + 诊断锚点（data-glmpp-* / __GLMPP_DIAG__）。
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
import { filterMemoriesByProjectScope } from '../core/memory/scope';
import { getResolvedLocaleState } from '../core/i18n/store';
import {
  DEFAULT_LOCALE,
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
  disableZaiNativeWebSearch,
  parseZaiBody,
  parseZaiChatNewBody,
  readZaiCurrentUserMessageParentId,
  readZaiLastUserMessageText,
  readZaiModelForRoute,
  rewriteZaiChatNewUserMessages,
  rewriteZaiLastUserMessage,
} from '../core/zai/request-codec';
import {
  buildZaiContinuationPrompt,
  buildZaiNudgePrompt,
  isZaiContinuationPrompt,
  shouldNudgeZai,
  ZAI_CONTINUATION_DELAY_MS,
  ZAI_INLINE_AGENT_MAX_NUDGES,
  ZAI_INLINE_AGENT_MAX_STEPS,
} from '../core/zai/continuation';
import {
  ZAI_CONTENT_TO_MAIN,
  ZAI_MAIN_TO_CONTENT,
} from '../core/zai/messages';
import {
  applyBackground,
  isBackgroundActive,
  patchContainerBackgrounds,
} from '../core/zai/page-background';
import {
  ZAI_AGENT_FLAG,
  ZAI_CHAT_INPUT_SELECTOR as CHAT_INPUT_SELECTOR,
  ZAI_DIAG_GLOBAL,
  ZAI_DIAG_LOOP_ATTR,
  ZAI_DIAG_LOOP_CHECK_ATTR,
  ZAI_DIAG_STEP_ATTR,
  ZAI_DIAG_TOOL_RESULT_ATTR,
} from '../core/zai/contracts';
import { createToolInvocationCatalog } from '../core/tool/invocation';
import { MCP_CAPABILITY_TOOL_PROVIDER_ID } from '../core/mcp/capability-contract';
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
let currentProjectContext: string | null = null;
let currentProjectId: string | null = null;
/**
 * 侧边栏「联网搜索」开关的存储值。与「本轮是否开着页面原生联网」取或决定 web 工具
 * 是否进模型目录 —— 任一为真就放行，保证「用户想搜」时一定用扩展自己的搜索。
 */
let currentWebToolsEnabled = false;
let currentRequestMessageCount = 0;
let extensionContextValid = true;
/** 已执行过工具的 toolCall 签名集合（防 TOOL_CALL 通道重复执行同一 XML）。 */
const executedToolCallSignatures = new Set<string>();
/** grantId → chatSessionId 映射：请求增广时记下每个授权绑定的会话，执行时校验一致。 */
const grantChatSessionIdByAuthId = new Map<string, string | null>();
/** requestId → chatSessionId 映射：执行时补全 source.chatSessionId 用。 */
const chatSessionIdByRequestId = new Map<string, string | null>();
/** requestId → 是否 agent 轮：启动续跑循环时记下，循环内复用同一套裁剪口径。 */
const isAgentTurnByRequestId = new Map<string, boolean>();
/** requestId → 本轮是否开着原生联网：与上面同理，供 handleResponseComplete 建续跑循环时取用。 */
const nativeSearchOnByRequestId = new Map<string, boolean>();
/** requestId → 本轮已完成的工具执行记录（TOOL_CALL 通道执行后写入，response 里读取续跑判定）。 */
const executionsByRequest = new Map<string, ToolExecutionRecord[]>();
/** 待完成的工具执行 promise（REQUEST_TERMINAL 关闭授权前要等它们先跑完）。 */
const pendingToolExecutionsByRequest = new Map<string, Set<Promise<unknown>>>();
/** 主世界消息串行队列：保证 TOOL_CALL → RESPONSE_COMPLETE → REQUEST_TERMINAL 按顺序执行。 */
let mainWorldMessageQueue: Promise<void> = Promise.resolve();
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
/** 输入框输入调度回调（用于清空注入后可能残留的草稿）。 */
let pendingComposerDismiss: (() => void) | null = null;

/**
 * 后台发起的 DOM 任务登记（方案 §4.1 Step 1）：
 * taskId 由后台生成、唯一贯穿支付请求 → 响应 → 续跑 → 收尾。
 */
interface ActiveDomTask {
  taskId: string;
  kind: string;
  prompt: string;
  chatSessionId: string | null;
  /** 该任务是否开启 z.ai 联网搜索（命中归属后置请求体 features.web_search/auto_web_search）。 */
  searchEnabled: boolean;
  /** 该任务选定的模型 id（chat 模式下覆写请求体的 model）；null = 跟随页面默认。 */
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
  /** 已用掉的 nudge（无工具纠正）次数。 */
  nudgeCount: number;
  /** 上一轮模型回复正文（供 nudge 时回看）。 */
  lastVisibleText: string;
  /** 归属的后台 DOM 任务 id（手动聊天续跑为 null）。 */
  taskId: string | null;
  /** 续跑收尾时回传给后台的最终回复正文。 */
  finalAssistantText: string;
  /** 启动该循环的那轮是否为 agent 轮：续跑/nudge 轮复用同一套模型侧裁剪口径。 */
  isAgentTurn: boolean;
  /** 启动该循环的那轮是否开着原生联网：续跑/nudge 轮同样要据此放行 web 工具。 */
  nativeSearchOn: boolean;
  /** 归属任务选定的模型 id：续跑轮也要把同一模型写回请求体。 */
  model: string | null;
}

let continuationLoop: ContinuationLoop | null = null;
let continuationMarkerCount = 0;
const activeToolAuthorizations = new Map<string, ToolAuthorizationGrantSummary>();

const diag = getGlobalDiagnostics();

function getGlobalDiagnostics() {
  // 关键：isolation world 的 globalThis 是隔离对象，页面 console 读不到。
  // 必须写到共享的页面 window 上，用户才能用 window.__GLMPP_DIAG__ 读到。
  const target = (typeof window !== 'undefined' ? window : globalThis) as unknown as Record<string, unknown>;
  const existing = target[ZAI_DIAG_GLOBAL] as
    | {
        responses?: unknown[];
        toolCalls?: unknown[];
        failures?: unknown[];
        errors?: unknown[];
        stateless?: unknown[];
        sendProbe?: unknown[];
        turnLog?: unknown[];
        injectLog?: unknown[];
        ssaFatal?: unknown[];
        composerSnap?: unknown[];
        augRequests?: unknown[];
      }
    | undefined;
  const state = existing ?? { responses: [], toolCalls: [], failures: [], errors: [], stateless: [], sendProbe: [], turnLog: [], injectLog: [], ssaFatal: [], composerSnap: [], augRequests: [] };
  if (!state.responses) state.responses = [];
  if (!state.toolCalls) state.toolCalls = [];
  if (!state.failures) state.failures = [];
  if (!state.errors) state.errors = [];
  if (!state.stateless) state.stateless = [];
  if (!state.sendProbe) state.sendProbe = [];
  if (!state.turnLog) state.turnLog = [];
  if (!state.injectLog) state.injectLog = [];
  if (!state.ssaFatal) state.ssaFatal = [];
  if (!state.composerSnap) state.composerSnap = [];
  if (!state.augRequests) state.augRequests = [];
  target[ZAI_DIAG_GLOBAL] = state;
  return state;
}

function stampLoopDiagnostic(): void {
  if (!document.documentElement) return;
  document.documentElement.setAttribute(
    ZAI_DIAG_LOOP_ATTR,
    continuationLoop?.status === 'running' ? 'running' : 'complete',
  );
  document.documentElement.setAttribute(
    ZAI_DIAG_STEP_ATTR,
    String(continuationLoop?.stepCount ?? 0),
  );
}

// ---------------------------------------------------------------------------
// 会话/请求辅助
// ---------------------------------------------------------------------------

/** 从 location 读 z.ai 会话 id：`/c/<id>`。 */
function readZaiChatSessionId(value?: string): string | null {
  const pathname = value ?? location.pathname;
  const match = /^\/c\/([^/?#]+)/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

function getCurrentChatSessionId(): string | null {
  return readZaiChatSessionId();
}

function getCurrentConversationTitle(): string {
  // z.ai 页面标题形如「xxx - chat.z.ai」，去掉「 - chat.z.ai」后缀取会话标题。
  const title = document.title.replace(/\s*[-|]\s*chat\.z\.ai.*$/i, '').trim();
  return title || '未命名对话';
}

function isContinuationRequest(text: string): boolean {
  return isZaiContinuationPrompt(text);
}

/** 读 chatNew body 是否已开原生联网：chat.auto_web_search 为 true 视为开。 */
function readChatNewNativeSearchEnabled(body: Record<string, unknown>): boolean {
  const chat = body.chat;
  if (!chat || typeof chat !== 'object' || Array.isArray(chat)) return false;
  return (chat as Record<string, unknown>).auto_web_search === true;
}

/** 读 completion body 的 agent 标志：features.flags 含 general_agent 即 agent 模式。 */
function readZaiAgentFlag(body: Record<string, unknown>): boolean {
  const features = body.features;
  if (!features || typeof features !== 'object' || Array.isArray(features)) return false;
  const flags = (features as Record<string, unknown>).flags;
  return Array.isArray(flags) && flags.includes(ZAI_AGENT_FLAG);
}

/** 读 completion body 是否已开原生联网：features 的 auto_web_search / web_search 任一为 true 视为开。 */
function readCompletionNativeSearchEnabled(body: Record<string, unknown>): boolean {
  const features = body.features;
  if (!features || typeof features !== 'object' || Array.isArray(features)) return false;
  const record = features as Record<string, unknown>;
  return record.auto_web_search === true || record.web_search === true;
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

async function sendRuntimeMessageStrict<T>(
  message: unknown,
): Promise<T> {
  if (!hasLiveExtensionContext()) throw new Error('Extension context unavailable.');
  return (await chrome.runtime.sendMessage(message)) as T;
}

// ---------------------------------------------------------------------------
// 状态同步（isolated → main）
// ---------------------------------------------------------------------------

function postToMainWorld(message: Record<string, unknown>): void {
  try {
    window.postMessage({ source: ZAI_CONTENT_TO_MAIN, ...message }, '*');
  } catch (error) {
    console.error('[GLM++] post to main failed', error);
  }
}

/** 把隔离世界的诊断对象同步到页面共享 window（页面 console 读不到 isolation world 的 window）。 */
function syncDiagnosticsToMainWorld(): void {
  postToMainWorld({
    type: 'DIAG_SYNC',
    sendProbe: diag.sendProbe ?? [],
    failures: diag.failures ?? [],
    errors: diag.errors ?? [],
    toolCalls: diag.toolCalls ?? [],
    responses: diag.responses ?? [],
    turnLog: diag.turnLog ?? [],
    injectLog: diag.injectLog ?? [],
    ssaFatal: diag.ssaFatal ?? [],
    composerSnap: diag.composerSnap ?? [],
    augRequests: diag.augRequests ?? [],
  });
}

/** 记录自动化发送致命错误 + 立即同步一次诊断到页面（万一任务悬挂，console 直接能看到根因）。 */
function recordSsaFatal(kind: string, error: string): void {
  diag.ssaFatal ??= [];
  diag.ssaFatal.push({ kind, error, at: Date.now() });
  console.warn(`[GLM++] automation send fatal: ${kind}`, error);
  syncDiagnosticsToMainWorld();
}

function catalogNamesFor(descriptors: readonly ToolDescriptor[]): string[] {
  const catalog = createToolInvocationCatalog(descriptors);
  return catalog.invocationNames;
}

function syncHookState(): void {
  const names = catalogNamesFor(currentToolDescriptors);
  currentCatalogNames = names;
  postToMainWorld({ type: 'SYNC_HOOK_STATE', toolDescriptorNames: names });
}

async function loadAndSyncRuntimeState(): Promise<void> {
  const [memories, descriptors, skills, skillAutoActivation, activePreset, promptSettings, webToolSettings, resolvedLocale] = await Promise.all([
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
    // 联网开关的存储值：决定 web 工具是否进模型目录（见 augmentPrompt 的 modelFacing）。
    sendRuntimeMessage<Record<string, unknown>>({ type: 'GET_WEB_TOOL_SETTINGS' }),
    getResolvedLocaleState(),
  ]);
  currentMemories = memories;
  currentToolDescriptors = descriptors;
  currentSkills = skills;
  currentSkillAutoActivation = skillAutoActivation;
  currentActivePreset = activePreset;
  currentPromptSettings = promptSettings;
  // 任一工具开关开着就算「联网可用」；读取失败时保持上一次的值。
  if (webToolSettings && typeof webToolSettings === 'object') {
    currentWebToolsEnabled = webToolSettings.web_search === true || webToolSettings.web_fetch === true;
  }
  currentContentLocale = resolvedLocale.locale;
  syncHookState();
}

interface ResolvedProjectAugmentationContext {
  projectId: string;
  context: string | null;
}

/**
 * 解析当前会话的项目上下文（ds++ resolveProjectContextForRequestBody 的 z.ai 简化版）。
 * z.ai 会话 id 从 location /c/<id> 读；首条消息 bindPendingProject=true。
 * conversation title/url 对归属判断非必需（后台按 conversationId 反查 membership），
 * 这里仅透传能拿到的字段。返回 null 表示该会话未绑定项目。
 */
async function resolveProjectContextForRequest(
  chatSessionId: string | null,
  bindPendingProject: boolean,
): Promise<ResolvedProjectAugmentationContext | null> {
  if (!chatSessionId) return null;
  try {
    const result = await sendRuntimeMessageStrict<ResolvedProjectAugmentationContext | null>({
      type: 'GET_PROJECT_CONTEXT_FOR_CONVERSATION',
      payload: {
        bindPendingProject,
        conversation: { conversationId: chatSessionId },
      },
    });
    currentProjectId = result?.projectId ?? null;
    currentProjectContext = result?.context ?? null;
    return result ?? null;
  } catch (error) {
    if (isExtensionInvalidatedError(error)) invalidateExtensionContext();
    return null;
  }
}

// ---------------------------------------------------------------------------
// 工具授权 + 执行中继
// ---------------------------------------------------------------------------

async function createToolAuthorization(input: {
  requestId: string;
  chatSessionId: string | null;
  descriptorIds?: string[];
  toolIntent?: string;
}): Promise<ToolAuthorizationGrantSummary> {
  return sendRuntimeMessageStrict<ToolAuthorizationGrantSummary>({
    type: 'CREATE_TOOL_AUTHORIZATION',
    payload: { trigger: 'manual_chat', ...input },
  });
}

async function closeToolAuthorization(requestId: string): Promise<void> {
  const authorization = activeToolAuthorizations.get(requestId);
  if (!authorization) return;
  try {
    await sendRuntimeMessage({
      type: 'CLOSE_TOOL_AUTHORIZATION',
      payload: { authorizationId: authorization.id },
    });
  } catch (error) {
    if (!isExtensionInvalidatedError(error)) throw error;
    invalidateExtensionContext();
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
  diag.errors?.push({
    kind: 'execute_tool_call_invalid_result',
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
 * 返回 {call, payload} 供执行。这里复用 streaming-tool-call-parser 的成品语义：
 * 找 `<tool>JSON</tool>` 块，body 为 JSON。
 */
function parseToolXml(
  text: string,
  descriptors: readonly ToolDescriptor[],
): ToolCall[] {
  const catalog = createToolInvocationCatalog(descriptors);
  const regex = new RegExp(
    `<\\s*(${catalog.invocationNames.map(escapeRegExp).join('|')})\\s*>\\s*([\\s\\S]*?)\\s*<\\/\\s*\\1\\s*>`,
    'g',
  );
  const calls: ToolCall[] = [];
  for (const match of text.matchAll(regex)) {
    const matchedTag = match[1];
    const raw = match[0];
    const body = match[2] ?? '';
    const descriptor =
      catalog.descriptorByInvocationName.get(matchedTag) ??
      catalog.descriptorByName.get(matchedTag);
    // 关键：call.invocationName 必须是 descriptor 的权威 invocationName（长名），
    // 不能是正则匹配到的短名/别名。授权快照里存的是 descriptor.invocationName，
    // 短名会触发 tool_descriptor_mismatch（claims do not match authorized descriptor）。
    const invocationName = descriptor?.invocationName ?? matchedTag;
    // id 用「正文里出现的序号」而非全局 index，保证同一条消息里多个 memory_save 的
    // callId 稳定且唯一（否则三条 memory_save 全拿到 xml:0，被授权防重当成同一个调用，只执行第一条）。
    const id = `xml:${calls.length}`;
    let payload: Record<string, unknown> = {};
    let parseError;
    if (body.trim()) {
      try {
        const parsed = JSON.parse(body);
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
      raw,
      descriptorId: descriptor?.id,
      provider: descriptor?.provider,
      ...(parseError ? { parseError } : {}),
    });
  }
  return calls;
}

function isContinuableExecution(execution: ToolExecutionRecord): boolean {
  // 与 ds++ 的 selectContinuableToolExecutions 对齐：所有 MCP 工具（含用户自配）
  // + mcp capability + web + browser 都算可续跑；本地执行类工具（shell_/local_file_/python_）
  // 也一并算（它们在 z.ai 里是 Shell Local MCP server 的工具，provider.kind 是 mcp）。
  // 终态工具（memory_save/update/delete、artifact 等）不在此列 → 自然不可续跑。
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

/** 简单字符串哈希（djb2），用于给同一条消息里多个同类型工具生成稳定且唯一的 callId。 */
function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function augmentPrompt(
  originalPrompt: string,
  options?: {
    toolDescriptors?: readonly ToolDescriptor[];
    isFirstMessage?: boolean;
    projectContext?: string | null;
    projectId?: string | null;
    isAgent?: boolean;
    /** 本轮是否开着页面原生联网（等同「用户想搜」）。 */
    nativeSearchOn?: boolean;
  },
): string {
  const isFirstMessage = options?.isFirstMessage ?? true;
  const isAgent = options?.isAgent ?? false;
  const nativeSearchOn = options?.nativeSearchOn ?? false;
  // 模型侧裁掉由服务端或独立 UI 流程承担的工具。
  // web 工具（web_search / web_fetch）：agent 恒裁；chat 模式下「开关开着」或
  // 「本轮开着原生联网」任一成立就放行 —— 保证用户想搜时一定走扩展自己的搜索。
  const modelFacing = filterZaiModelFacingToolDescriptors(
    options?.toolDescriptors ?? currentToolDescriptors,
    { isAgent, webToolsEnabled: currentWebToolsEnabled, nativeSearchOn },
  );
  const locale = currentContentLocale ?? DEFAULT_LOCALE;
  const projectId = options?.projectId ?? currentProjectId ?? null;
  const projectContext = options?.projectContext ?? currentProjectContext ?? null;
  // 项目作用域记忆：只带全局 + 属于当前 project 的 project-scoped 记忆（ds++ filterMemoriesByProjectScope）。
  const scopedMemories = filterMemoriesByProjectScope(currentMemories, projectId);

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

  // Skill 激活：对齐 ds++ 的 request-augmentation 逻辑。显式 `/技能名` 触发优先；
  // 无触发词时，local indexed skill 按描述打分隐式激活（受 skillAutoActivation 门控）。
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
        projectContext,
        locale,
        memoryEnabled,
        systemPromptEnabled,
        forceResponseLanguage,
        isAgent,
      });
      return result.augmented;
    }
    const result = buildPromptAugmentation(resolved.combinedPrompt, {
      memories: scopedMemories,
      identityOnly,
      toolDescriptors: modelFacing,
      visibleUserPrompt: originalPrompt,
      presetContent,
      projectContext,
      locale,
      memoryEnabled,
      systemPromptEnabled,
      forceResponseLanguage,
      isAgent,
    });
    return result.augmented;
  }

  const result = buildPromptAugmentation(originalPrompt, {
    memories: scopedMemories,
    toolDescriptors: modelFacing,
    presetContent,
    projectContext,
    locale,
    memoryEnabled,
    systemPromptEnabled,
    forceResponseLanguage,
    isAgent,
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

  // 归属诊断：AUGMENT_REQUEST_BODY 一进来就登记 route + 原 prompt 头（不含隐私），
  // 即使下面 parse/归属失败，也能从 augRequests 看到页面到底发了什么请求、prompt 是什么样。
  diag.augRequests?.push({
    at: Date.now(),
    route,
    hasBody: !!bodyStr,
    promptHead: readPromptHead(bodyStr, route),
    userMessageCount: readUserMessageCount(bodyStr),
  });

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
  const chatSessionId = readZaiChatSessionId();
  // 记下 requestId → chatSessionId，执行工具时补全 source.chatSessionId。
  chatSessionIdByRequestId.set(requestId, chatSessionId);

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
      const isAgentTurn = parsed.isAgent === true;

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
          syncDiagnosticsToMainWorld();
        }
      }

      // 联网判定：自动化任务自身的 searchEnabled，或页面 body 已带原生联网标记
      // （手动点网页开关的场景）。检测到即为「本轮要用联网」——一律关掉原生通道，
      // 走扩展自带的 web_search / web_fetch。
      const nativeSearchOn = firstTaskId
        ? (activeDomTasks.get(firstTaskId)?.searchEnabled === true || readChatNewNativeSearchEnabled(body))
        : readChatNewNativeSearchEnabled(body);

      const authorization = await createToolAuthorization({
        requestId,
        chatSessionId,
        toolIntent: firstText.slice(0, 16_000),
      });
      activeToolAuthorizations.set(requestId, authorization);
      grantChatSessionIdByAuthId.set(authorization.id, chatSessionId);
      // 首条（chats/new）始终增强：把工具目录 + 记忆 + 联网引导注入，让模型在建会话
      // 那一刻就学会工具用法（web_search 搜、shell 写文件、memory 等）。首条注入不会污染
      // parent 链（首条是会话起点，无 parent），所以联网会话也照常注入。
      const augmented = parsed.userMessageTexts.map((text) =>
        augmentPrompt(text, {
          toolDescriptors: authorization.descriptors,
          isFirstMessage: true,
          isAgent: isAgentTurn,
          nativeSearchOn,
        }),
      );
      const nextBody = rewriteZaiChatNewUserMessages(body, augmented);

      // 关闭原生联网（chatNew 阶段）：**不能**改 chat.features（它是「数组」，
      // 覆盖成对象会 400 卡首页），而是在 chat 对象「顶层」写布尔字段。
      // 抓包实证：普通搜索时 chat.auto_web_search=true；高级搜索时同样为 true 且带
      // chat.mcp_servers:["advanced-search"]。这里统一写 false，让会话从头就走扩展的
      // web_search / web_fetch，不启用服务端检索通道。
      if (nativeSearchOn) {
        const chat = nextBody.chat;
        if (chat && typeof chat === 'object' && !Array.isArray(chat)) {
          (chat as Record<string, unknown>).auto_web_search = false;
        }
      }
      // 诊断：确认 chatNew 顶层 auto_web_search 写进去了、task 是否命中。
      const searchTask = firstTaskId ? activeDomTasks.get(firstTaskId) : undefined;
      // 模型覆写（chatNew 阶段）：会话模型在**建会话那一刻**定下 —— 落点是
      // `chat.models`（与首条 user 消息的 `models` 同值），由路由决定，见
      // `applyZaiModelOverrideForRoute`。这一步不能省：只在 completion 阶段写
      // 改不动已有会话。agent 模式不碰（服务端按 general_agent 装配自己的模型）。
      const chatNewModelBefore = readZaiModelForRoute(nextBody, 'chatNew');
      const modelOverridden = !isAgentTurn
        ? applyZaiModelOverrideForRoute(nextBody, 'chatNew', searchTask?.model ?? null)
        : false;
      diag.augRequests?.push({
        at: Date.now(),
        route: 'chatNew-search',
        searchEnabled: searchTask?.searchEnabled ?? null,
        nativeSearchOn,
        autoWebSearchWrote: ((nextBody as { chat?: { auto_web_search?: unknown } }).chat?.auto_web_search) ?? null,
        modelOverridden,
        modelBefore: chatNewModelBefore,
        modelAfter: readZaiModelForRoute(nextBody, 'chatNew'),
      });
      postToMainWorld({
        type: 'AUGMENT_REQUEST_BODY_RESULT',
        id,
        ok: true,
        result: {
          body: JSON.stringify(nextBody),
          requestId,
          toolDescriptorNames: currentCatalogNames,
        },
      });
      return;
    }

    // completion 路由
    const originalPrompt = readZaiLastUserMessageText(body);
    if (!originalPrompt) {
      postToMainWorld({ type: 'AUGMENT_REQUEST_BODY_RESULT', id, ok: true, result: null });
      return;
    }

    // 任务归属（方案 §4.1）：DOM 任务的首条注入不是续跑模板、isContinuationRequest 不命中，
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
      });
      activeToolAuthorizations.set(requestId, auth);
      grantChatSessionIdByAuthId.set(auth.id, chatSessionId);
      // 续跑轮也保持「原生联网关闭」：归属任务开启搜索时（matchedTask 或续跑循环所属任务），
      // 给透传 body 补上 features.auto_web_search=false + features.web_search=false，
      // 确保整条会话始终走扩展自带的 web_search / web_fetch。
      const searchEnabled =
        matchedTask?.searchEnabled === true ||
        (continuationLoop?.taskId != null &&
          activeDomTasks.get(continuationLoop.taskId)?.searchEnabled === true);
      // 续跑轮同样把任务选定的模型写回请求体：页面每轮都会重新带 model，
      // 只在首条写会退回到页面默认。agent 轮不碰（与首条同口径）。
      const loopTask = continuationLoop?.taskId != null
        ? activeDomTasks.get(continuationLoop.taskId)
        : undefined;
      const continuationModel: string | null =
        matchedTask?.model ?? loopTask?.model ?? continuationLoop?.model ?? null;
      const modelOverrideEnabled = continuationLoop?.isAgentTurn !== true;
      let nextBodyStr = bodyStr;
      if (searchEnabled || (modelOverrideEnabled && continuationModel)) {
        const parsedBody = parseZaiBody(bodyStr);
        if (parsedBody) {
          if (searchEnabled) disableZaiNativeWebSearch(parsedBody);
          // 续跑轮走 completion 端点 → 落点是顶层 `model`，由路由决定。
          if (modelOverrideEnabled) {
            applyZaiModelOverrideForRoute(parsedBody, 'completion', continuationModel);
          }
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
          toolDescriptorNames: currentCatalogNames,
        },
      });
      return;
    }

    // 先建授权（toolIntent → MCP capability 投影），再用授权返回的 descriptors 增广。
    const auth = await createToolAuthorization({
      requestId,
      chatSessionId,
      toolIntent: originalPrompt.slice(0, 16_000),
    });
    activeToolAuthorizations.set(requestId, auth);
    grantChatSessionIdByAuthId.set(auth.id, chatSessionId);
    const parentId = readZaiCurrentUserMessageParentId(body);
    const isFirstMessage = parentId === null || parentId === undefined;
    // completion 路由的 agent 判定：features.flags 里含 general_agent。
    const isAgentTurn = readZaiAgentFlag(body);
    // 记下 requestId → agent 标记：续跑/nudge 轮要用同一套模型侧裁剪口径。
    isAgentTurnByRequestId.set(requestId, isAgentTurn);
    // 联网判定：自动化任务自身的 searchEnabled，或 body 已带原生联网标记
    // （features.auto_web_search / features.web_search）。
    // 注意 matchedTask 变量在下方声明，这里先读 taskId 判断。
    const firstCompletionTaskId = taskIdByPromptText.get(originalPrompt);
    const nativeSearchOn = firstCompletionTaskId
      ? (activeDomTasks.get(firstCompletionTaskId)?.searchEnabled === true || readCompletionNativeSearchEnabled(body))
      : readCompletionNativeSearchEnabled(body);
    // 记下 requestId → 联网标记：同上。
    nativeSearchOnByRequestId.set(requestId, nativeSearchOn);
    // 项目上下文：ds++ 对首条消息才 bindPendingProject；z.ai 会话 id 从 /c/<id> 读，不需要 conversation title/url 也能拿到对话归属。
    const project = await resolveProjectContextForRequest(chatSessionId, isFirstMessage);
    // 每轮都增强（含续写轮）。
    //
    // 这里历史上曾按「本轮是否联网」跳过续写轮注入（`searchMode === 'off' || isFirstMessage`），
    // 那是为了让页面原生联网能正常工作 —— 原生通道在续写轮会因 messages.content 被替换而
    // 不再装配工具。现在联网一律走扩展自己的 web_search / web_fetch（原生通道由下方
    // disableZaiNativeWebSearch 关掉），那个前提不复存在，跳过的理由也随之作废。
    const augmented = augmentPrompt(originalPrompt, {
      toolDescriptors: auth.descriptors,
      isFirstMessage,
      projectContext: project?.context ?? null,
      projectId: project?.projectId ?? null,
      isAgent: isAgentTurn,
      nativeSearchOn,
    });
    currentRequestMessageCount = isFirstMessage ? 1 : currentRequestMessageCount + 1;
    const nextBody = rewriteZaiLastUserMessage(body, augmented);
    // 关键：signature_prompt 是服务端权威 prompt、参与续写链 parent 校验与历史存储，
    // 必须始终是「用户原文」。而模型读的是 messages.content（系统注入 + 标记包裹原文）。
    const visibleOriginal = extractVisibleUserPrompt(augmented) ?? originalPrompt;
    (nextBody as Record<string, unknown>).signature_prompt = visibleOriginal;

    // 关闭原生联网：检测到本轮要用联网时，把 features 的 auto_web_search / web_search
    // 都写成 false，让服务端不装配原生检索通道，联网一律走扩展的 web_search / web_fetch。
    if (nativeSearchOn) {
      disableZaiNativeWebSearch(nextBody);
    }
    // 模型覆写：请求归属到自动化任务时，在 chat 模式下覆写 body 的 model。
    // agent 轮不碰 —— 那由服务端按 general_agent 装配。
    const modelOverridden = isAgentTurn
      ? false
      : applyZaiModelOverrideForRoute(nextBody, 'completion', matchedTask?.model ?? null);

    // 诊断：记录 completion 首条/续跑的归属 + features 最终值，便于定位联网开关问题。
    diag.augRequests?.push({
      at: Date.now(),
      route: 'completion-features',
      promptHead: originalPrompt.slice(0, 40),
      matched: matchedTaskId ?? null,
      searchEnabled: matchedTask?.searchEnabled ?? null,
      featuresAfter: (nextBody as { features?: unknown }).features ?? null,
      modelOverridden,
      modelAfter: readZaiModelForRoute(nextBody, 'completion'),
    });

    // 记忆命中 → 后台 touch。
    await sendRuntimeMessage({ type: 'TOUCH_MEMORIES', payload: { ids: [] } }).catch(() => undefined);

    postToMainWorld({
      type: 'AUGMENT_REQUEST_BODY_RESULT',
      id,
      ok: true,
      result: {
        body: JSON.stringify(nextBody),
        requestId,
        toolDescriptorNames: currentCatalogNames,
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

interface ZaiResponseComplete {
  requestId: string;
  originalPrompt: string;
  agentTaskPrompt: string;
  assistantText: string;
  toolCalls: Array<{ name: string; raw: string; requestId: string }>;
}

async function dispatchMainWorldMessage(data: Record<string, unknown>): Promise<void> {
  // 同步探测续跑请求：必须在串行队列外、消息抵达瞬间就标记，否则 waitForRequestObserved
  // 因串行队列阻塞而永远看不到 AUGMENT_REQUEST_BODY（自锁）。这里只看一眼 body 是否续跑模板。
  if (data.type === 'AUGMENT_REQUEST_BODY' && typeof data.body === 'string') {
    try {
      const peekBody = parseZaiBody(data.body);
      const peekPrompt = peekBody ? readZaiLastUserMessageText(peekBody) : '';
      if (isContinuationRequest(peekPrompt)) {
        continuationRequestSeq += 1;
      }
    } catch {
      /* ignore peek errors */
    }
  }
  // 串行队列：主世界消息可能乱序到达（TOOL_CALL/RESPONSE_COMPLETE/REQUEST_TERMINAL），
  // 串行执行能消除「响应先完成、授权后被关」的竞态。
  const run = mainWorldMessageQueue.then(() => dispatchMainWorldMessageInner(data));
  mainWorldMessageQueue = run.catch(() => undefined);
  await run;
}

async function dispatchMainWorldMessageInner(data: Record<string, unknown>): Promise<void> {
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
          void mergeZaiAuthFromCapture({
            token: captured.token,
            userId: captured.user_id,
            feVersion: captured['X-FE-Version'] ?? captured.feVersion,
            deviceId: captured['x-device-id'] ?? captured.deviceId,
          });
        }
        diag.responses?.push({ kind: 'headers-captured' });
        return;
      }
      case 'TOOL_CALL': {
        await handleDetectedToolCall(data.data as { name: string; raw: string; requestId: string });
        return;
      }
      case 'RESPONSE_COMPLETE': {
        await handleResponseComplete(data.payload as ZaiResponseComplete);
        return;
      }
      case 'REQUEST_TERMINAL': {
        const requestId = (data.payload as { requestId?: string } | undefined)?.requestId;
        // 关闭授权前，先等该 requestId 挂起的所有工具执行跑完。
        if (requestId) {
          const pending = pendingToolExecutionsByRequest.get(requestId);
          if (pending && pending.size > 0) {
            await Promise.allSettled([...pending]);
          }
        }
        if (requestId && activeToolAuthorizations.has(requestId)) {
          await closeToolAuthorization(requestId);
        }
        // 流终止但这一轮从未产出 RESPONSE_COMPLETE = 页面侧把读取流 abort 了
        // （用户点 Stop，或读取中途出错）。这比「等 Stop 按钮消失」更直接，
        // 这里立刻挂上手动停止宽限窗口，不必再等 180s 执行租约超时。
        // 正常结束的轮次不走这里：fetch hook 先发 RESPONSE_COMPLETE 再发 REQUEST_TERMINAL。
        if (requestId && !respondedRequestIds.has(requestId)) {
          armManualStopDetection();
        }
        return;
      }
      case 'HTML_CHALLENGE': {
        // completion 返回 HTML：推进续跑而不是干等。
        const requestId = (data.payload as { requestId?: string } | undefined)?.requestId;
        if (continuationLoop?.status === 'running' && continuationLoop.activeRequestId === requestId) {
          const expectedLoop = continuationLoop;
          setTimeout(() => {
            // 延迟到期时复检：期间可能已被别的 RESPONSE_COMPLETE 推进过、
            // 或整个循环已收尾 —— 不复检会重复注入同一轮。
            if (continuationLoop !== expectedLoop || expectedLoop.status !== 'running') return;
            if (expectedLoop.activeRequestId !== requestId) return;
            void advanceContinuationLoop();
          }, ZAI_CONTINUATION_DELAY_MS);
        }
        return;
      }
    }
  } catch (error) {
    if (isExtensionInvalidatedError(error)) invalidateExtensionContext();
    else console.error('[GLM++] main-world message handling failed', error);
  }
}

// ---------------------------------------------------------------------------
// 工具执行 + 续跑状态机
// ---------------------------------------------------------------------------

async function handleDetectedToolCall(
  detected: { name: string; raw: string; requestId: string },
): Promise<void> {
  if (!detected?.name) return;
  // 诊断：记录识别命中的工具（含 requestId 与 raw，方便定位 XML 归属）。
  diag.toolCalls?.push({
    kind: 'detected',
    name: detected.name,
    requestId: detected.requestId,
    raw: detected.raw,
  });
  try {
    await executeDetectedFromDetected(detected);
  } catch (error) {
    diag.errors?.push({
      kind: 'detected_tool_parse_error',
      name: detected.name,
      requestId: detected.requestId,
      raw: detected.raw,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function executeDetectedFromDetected(
  detected: { name: string; raw: string; requestId: string },
): Promise<void> {
  // 注意：不能用 requestId 粒度去重！fetch-hook 对同一条模型回复里的每个工具
  // 单独发一条 TOOL_CALL 消息（requestId 相同、raw 不同）。若按 requestId 去重，
  // 第二个工具（如 memory_save 之后的 shell_status）会被误判「已执行」而跳过，
  // 导致「记住+看桌面」这类多工具回复只执行第一个工具。
  // 真正的重复由 executeDetected 内部的 executedToolCallSignatures（requestId+name+callId）兜底。
  const calls = parseToolXml(detected.raw, currentToolDescriptors);
  if (calls.length === 0) {
    diag.errors?.push({
      kind: 'detected_tool_not_parsed',
      name: detected.name,
      requestId: detected.requestId,
      raw: detected.raw,
      catalogNames: currentCatalogNames,
    });
    return;
  }
  for (const call of calls) {
    await executeDetected(call, detected.requestId);
  }
}

async function executeDetected(call: ToolCall, requestId: string): Promise<ToolExecutionRecord | null> {
  // 授权：原生轮/续跑轮都可能因为请求已被 requestTerminal 关掉 grant 而查不到。
  // 这里做「懒建授权」——查不到就现场新建一个 grant，保证工具永远能执行。
  let authorization = activeToolAuthorizations.get(requestId);
  const authId = authorization?.id;
  if (!authId) {
    const chatSessionId =
      chatSessionIdByRequestId.get(requestId) ?? readZaiChatSessionId();
    try {
      authorization = await createToolAuthorization({
        requestId,
        chatSessionId,
        descriptorIds: currentToolDescriptors.map((d) => d.id),
      });
      activeToolAuthorizations.set(requestId, authorization);
    } catch (error) {
      diag.toolCalls?.push({
        kind: 'executed',
        name: call.name,
        requestId,
        authorizationId: null,
        ok: false,
        summary: '工具授权创建失败',
        detail: error instanceof Error ? error.message : String(error),
        error: { code: 'tool_authorization_create_failed', message: error instanceof Error ? error.message : String(error), retryable: false },
      });
      console.warn('[GLM++] executeDetected: create auth failed', { name: call.name, requestId, error });
      return null;
    }
  }

  console.log('[GLM++] executeDetected', {
    name: call.name,
    requestId,
    hasAuth: !!authorization?.id,
    lazyCreated: !authId,
  });

  // 补全 source.chatSessionId：优先授权记的会话，其次 requestId 映射。
  const boundSessionId = authorization?.chatSessionId ?? null;
  const chatSessionId =
    (boundSessionId !== null && boundSessionId !== undefined ? boundSessionId : undefined) ??
    chatSessionIdByRequestId.get(requestId) ??
    readZaiChatSessionId();

  // 关键：callId 必须是「本条 raw 内容的稳定且唯一」的 id。
  // parseToolXml 对「单条 raw」解析时 id 恒为 xml:0，三条 memory_save 会撞同一个
  // callId，background 授权层 grant 里 callId 去重（tool_call_replayed）就把后面两条拦截。
  // 用 raw 的哈希作 id：同一条 raw 在 TOOL_CALL 通道和 response 通道拿到的 id 一致（可复用），
  // 不同 raw 拿到的 id 不同（不误判 replay）。
  const stableCallId = `xml:${hashString(call.raw || call.invocationName || crypto.randomUUID())}`;
  const callWithSource: ToolCall = {
    ...call,
    id: stableCallId,
    source: {
      trigger: 'manual_chat',
      requestId,
      chatSessionId,
    },
  };
  // 同一 toolCall 签名重复执行保护（TOOL_CALL 通道 + response 通道可能并发，二者 requestId 相同）。
  // 关键：签名必须含 raw（XML 原文）。TOOL_CALL 通道对同一条回复里的每个工具分别发一条
  // 消息、raw 各自不同，但 parseToolXml 对「单条 raw」重解析时 id 恒为 xml:0 —— 若签名只用
  // id，三条 memory_save 会撞同一个签名、只剩第一条执行。用 raw 区分，每个工具天然唯一。
  const signature = `${requestId}:${callWithSource.raw ?? callWithSource.invocationName}:${callWithSource.id}`;
  if (executedToolCallSignatures.has(signature)) {
    diag.toolCalls?.push({ kind: 'skipped_duplicate_call', name: call.name, requestId, signature });
    return null;
  }
  executedToolCallSignatures.add(signature);

  const effectiveAuthId = authorization?.id;
  if (!effectiveAuthId) {
    diag.toolCalls?.push({
      kind: 'executed',
      name: call.name,
      requestId,
      authorizationId: null,
      ok: false,
      summary: '工具授权缺失（authId 为空）',
      detail: 'activeToolAuthorizations 里没有该 requestId 对应的 grant',
      error: { code: 'tool_authorization_missing', message: 'no grant for requestId', retryable: false },
    });
    return null;
  }
  const result = await executeToolCall(callWithSource, effectiveAuthId);
  console.log('[GLM++] tool call executed', {
    ok: result.ok,
    name: result.name,
    requestId,
    summary: result.summary,
    detail: result.detail,
    error: result.error,
  });
  const execution: ToolExecutionRecord = {
    callId: callWithSource.id,
    // 关键：用短名（call.name，来自 descriptor.name）而非后台返回的 result.name。
    // result.name 可能是 MCP 长名（mcp_xxx_shell_status），会让 isContinuableExecution 误判。
    name: call.name ?? result.name,
    result,
    provider: result.provider ?? call.provider,
    descriptorId: result.descriptorId ?? call.descriptorId,
  };
  // 记下本轮执行（供 response 的续跑判定读取），并登记 pending 待办。
  const list = executionsByRequest.get(requestId) ?? [];
  list.push(execution);
  executionsByRequest.set(requestId, list);
  diag.toolCalls?.push({
    kind: 'executed',
    name: result.name ?? call.name,
    requestId,
    authorizationId: effectiveAuthId ?? null,
    ok: result.ok,
    summary: result.summary,
    detail: result.detail,
    error: result.error ?? null,
  });
  if (document.documentElement) {
    document.documentElement.setAttribute(
      ZAI_DIAG_TOOL_RESULT_ATTR,
      `${call.name}:${result.ok ? 'ok' : 'error'}`,
    );
  }
  return execution;
}

async function handleResponseComplete(complete: ZaiResponseComplete): Promise<void> {
  if (!complete?.requestId) return;
  respondedRequestIds.add(complete.requestId);
  const pendingStop = manualStopTimers.get(complete.requestId);
  if (pendingStop) {
    clearTimeout(pendingStop);
    manualStopTimers.delete(complete.requestId);
  }
  diag.responses?.push({
    requestId: complete.requestId,
    textLength: complete.assistantText.length,
    assistantText: complete.assistantText,
    detectedToolCalls: complete.toolCalls,
  });
  console.log('[GLM++] response complete', {
    requestId: complete.requestId,
    textLength: complete.assistantText.length,
    detectedToolCalls: complete.toolCalls.map((tc) => tc.name),
  });

  // 首条请求发出后，页面 SPA 可能已经从首页跳到 /c/<id>（新建会话场景）。
  // 把任务的最新会话 id 同步下来，这样回传 backend 的才是真实 id，而非首条注入时的 null。
  const liveTaskId = taskIdByRequestId.get(complete.requestId);
  const liveChatSessionId = readZaiChatSessionId();
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
        diag.failures?.push({
          kind: 'continuation_loop_missing',
          taskId: orphanTaskId,
          requestId: complete.requestId,
        });
        void sendRuntimeMessage({
          type: 'DOM_TASK_FAILED',
          taskId: orphanTaskId,
          error: 'continuation_loop_missing',
        });
      }
      return;
    }
    continuationLoop.activeRequestId = null;
    // 本轮已完成，摘掉它的归属登记（收尾时 clearActiveDomTask 会兜底清剩下的）。
    taskIdByRequestId.delete(complete.requestId);

    // 关键：这轮的工具 XML 可能已经通过 TOOL_CALL 通道执行过了（fetch-hook 既发 TOOL_CALL
    // 又发 RESPONSE_COMPLETE，两条消息同 requestId）。先读回已执行记录复用，别再重新执行
    // ——否则会被 executedToolCallSignatures 防重挡住，误判「无可续跑工具」→ 提前收尾。
    const alreadyExecutedThisTurn = executionsByRequest.get(complete.requestId) ?? [];
    let executedThisTurn: ToolExecutionRecord[] = [...alreadyExecutedThisTurn];

    if (alreadyExecutedThisTurn.length === 0) {
      // TOOL_CALL 通道没先到：兜底在这里解析并执行。
      const calls = parseToolXml(complete.assistantText, currentToolDescriptors);
      for (const call of calls) {
        const execution = await executeDetected(call, complete.requestId);
        if (execution) {
          continuationLoop.toolExecutions.push(execution);
          executedThisTurn.push(execution);
        }
      }
    } else {
      // 复用已执行结果：也要补进 loop.toolExecutions（如果还没被 TOOL_CALL 通道 push 过）。
      for (const execution of alreadyExecutedThisTurn) {
        if (!continuationLoop.toolExecutions.includes(execution)) {
          continuationLoop.toolExecutions.push(execution);
        }
      }
    }

    console.log('[GLM++] continuation turn', {
      step: continuationLoop.stepCount,
      parsedTools: parseToolXml(complete.assistantText, currentToolDescriptors).map((c) => c.name),
      executedTools: executedThisTurn.map((e) => e.name),
      continuable: executedThisTurn.filter(isContinuableExecution).map((e) => e.name),
      reusedFromToolCall: alreadyExecutedThisTurn.length > 0,
    });

    // 铺密诊断：每轮续跑的现场完整记录，方便压测「概率不续跑」时一断就知道卡在哪个判定。
    diag.turnLog?.push({
      step: continuationLoop.stepCount,
      requestId: complete.requestId,
      parsedTools: parseToolXml(complete.assistantText, currentToolDescriptors).map((c) => c.name),
      executedTools: executedThisTurn.map((e) => e.name),
      continuable: executedThisTurn.filter(isContinuableExecution).map((e) => e.name),
      reusedFromToolCall: alreadyExecutedThisTurn.length > 0,
      assistantTextHead: complete.assistantText.slice(0, 500),
      decided: 'pending',
    });
    const turnLogIndex = (diag.turnLog?.length ?? 1) - 1;

    // 更新上一轮可见正文，供 nudge 回看。
    continuationLoop.lastVisibleText = complete.assistantText;
    // 续跑轮每轮更新最终回传正文（方案 §4.1）。
    continuationLoop.finalAssistantText = complete.assistantText;

    // 核心判定：本轮模型有没有「可续跑」的工具。
    const continuable = executedThisTurn.filter(isContinuableExecution);
    if (continuable.length > 0) {
      // 还有工具可跑 → 注入下一轮续跑。
      const log = diag.turnLog?.[turnLogIndex];
      if (log && typeof log === 'object') (log as Record<string, unknown>).decided = 'continue';
      await advanceContinuationLoop();
      return;
    }

    // 没有可续跑工具：引入 ds++ 的 shouldNudge —— 模型末尾还有「待办」
    // （比如「接下来读文件」却没吐工具），就发 nudge 让它继续，而不是直接收尾。
    // 这就是「记忆+建文件分两步」不会烂尾的关键。
    const shouldNudgeNow =
      continuationLoop.nudgeCount < ZAI_INLINE_AGENT_MAX_NUDGES &&
      shouldNudgeZai(
        continuationLoop.originalTask,
        continuationLoop.toolExecutions,
        complete.assistantText,
      );
    const log = diag.turnLog?.[turnLogIndex];
    if (log && typeof log === 'object') {
      (log as Record<string, unknown>).decided = shouldNudgeNow ? 'nudge' : 'finish';
      (log as Record<string, unknown>).shouldNudge = shouldNudgeNow;
    }
    if (shouldNudgeNow) {
      continuationLoop.nudgeCount += 1;
      // 实时拉取最新工具目录，nudge 轮注入的「可用工具清单」同样实时。
      await loadAndSyncRuntimeState();
      const nudgeToolNames = catalogNamesFor(filterZaiModelFacingToolDescriptors(
        currentToolDescriptors,
        {
          isAgent: continuationLoop.isAgentTurn,
          webToolsEnabled: currentWebToolsEnabled,
          nativeSearchOn: continuationLoop.nativeSearchOn,
        },
      ));
      const nudgePrompt = buildZaiNudgePrompt(
        continuationLoop.originalTask,
        complete.assistantText,
        continuationLoop.toolExecutions,
        continuationLoop.nudgeCount,
        nudgeToolNames,
      );
      console.log('[GLM++] nudge continuation', {
        step: continuationLoop.stepCount,
        nudgeCount: continuationLoop.nudgeCount,
      });
      const submitted = await submitContinuationViaPage(nudgePrompt);
      if (!submitted) {
        diag.failures?.push({ kind: 'continuation_nudge_submit_not_observed', step: continuationLoop.stepCount });
        finishContinuationLoop(continuationLoop);
      }
      return;
    }

    // 无可续跑工具、也没有待办 → 收尾。
    finishContinuationLoop(continuationLoop);
    return;
  }

  // 原生轮：工具若已在 TOOL_CALL 通道执行过（executionsByRequest 有记录），
  // 这里不重复执行，只读回执行结果判定是否要续跑。
  const alreadyExecuted = executionsByRequest.get(complete.requestId) ?? [];
  const calls = parseToolXml(complete.assistantText, currentToolDescriptors);
  const executions: ToolExecutionRecord[] = [...alreadyExecuted];
  if (alreadyExecuted.length === 0) {
    // 工具没在 TOOL_CALL 通道跑过（可能是 fetch-hook 只发 RESPONSE_COMPLETE 没发 TOOL_CALL），
    // 兜底：这里解析并执行。但先检查授权是否还在。
    for (const call of calls) {
      const execution = await executeDetected(call, complete.requestId);
      if (execution) executions.push(execution);
    }
  }

  const continuable = executions.filter(isContinuableExecution);
  if (continuable.length === 0) {
    // 无续跑工具，结束。有 XML 但没续跑（如 memory_save）也算完成。
    console.log('[GLM++] native turn: no continuable tool', {
      requestId: complete.requestId,
      executionNames: executions.map((e) => e.name),
      assistantText: complete.assistantText.slice(0, 300),
    });
    // 后台 DOM 任务：单轮无工具就要回传，不能悬挂（方案 §3 风险 #4）。
    const nativeTaskId = taskIdByRequestId.get(complete.requestId);
    if (nativeTaskId) {
      const task = activeDomTasks.get(nativeTaskId);
      taskIdByRequestId.delete(complete.requestId);
      if (task) {
        task.status = 'done';
        activeDomTasks.delete(nativeTaskId);
        // 固定会话：回传前 re-read 真实 /c/<id>（新建会话下 task.chatSessionId 可能还是 null）。
        const liveSessionId = readZaiChatSessionId();
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

  const chatSessionId = readZaiChatSessionId();
  if (!chatSessionId) {
    console.log('[GLM++] native turn: no chat session id', {
      requestId: complete.requestId,
      pathname: location.pathname,
      executionNames: executions.map((e) => e.name),
    });
    // 读不到 /c/<id> 就没法建续跑循环。若这个 requestId 归属着后台任务，
    // 必须回 FAILED 收尾，否则任务一直挂在「运行中」直到 180s 租约超时。
    const orphanTaskId = taskIdByRequestId.get(complete.requestId);
    if (orphanTaskId) {
      clearActiveDomTask(orphanTaskId);
      diag.failures?.push({
        kind: 'continuation_session_id_missing',
        taskId: orphanTaskId,
        requestId: complete.requestId,
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
  if (continuationLoop?.status === 'running') {
    const staleLoop = continuationLoop;
    if (staleLoop.taskId) {
      const staleTaskId = staleLoop.taskId;
      staleLoop.taskId = null;
      clearActiveDomTask(staleTaskId);
      diag.failures?.push({
        kind: 'continuation_loop_superseded',
        taskId: staleTaskId,
        requestId: complete.requestId,
      });
      void sendRuntimeMessage({
        type: 'DOM_TASK_FAILED',
        taskId: staleTaskId,
        error: 'continuation_loop_superseded',
      });
    }
    finishContinuationLoop(staleLoop);
  }

  console.log('[GLM++] starting continuation loop', {
    requestId: complete.requestId,
    chatSessionId,
    executionNames: executions.map((e) => e.name),
  });

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
    isAgentTurn: isAgentTurnByRequestId.get(complete.requestId) ?? false,
    nativeSearchOn: nativeSearchOnByRequestId.get(complete.requestId) ?? false,
    model: resolveLoopModel(complete.requestId),
  };
  isAgentTurnByRequestId.delete(complete.requestId);
  nativeSearchOnByRequestId.delete(complete.requestId);
  stampLoopDiagnostic();
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
  if (continuable.length === 0 || loop.stepCount >= ZAI_INLINE_AGENT_MAX_STEPS) {
    finishContinuationLoop(loop);
    return;
  }

  // 实时拉取最新工具目录，续跑轮注入的「可用工具清单」始终是当前真实状态
  // （用户新增 skill / MCP 后，续跑轮立刻能用到，而非首条消息时的快照）。
  await loadAndSyncRuntimeState();
  const toolNames = catalogNamesFor(filterZaiModelFacingToolDescriptors(
    currentToolDescriptors,
    {
      isAgent: loop.isAgentTurn,
      webToolsEnabled: currentWebToolsEnabled,
      nativeSearchOn: loop.nativeSearchOn,
    },
  ));
  const prompt = buildZaiContinuationPrompt(loop.originalTask, loop.toolExecutions, toolNames);
  loop.pendingPrompt = prompt;
  loop.stepCount += 1;
  stampLoopDiagnostic();

  // 续跑注入策略（不丢弃用户输入）：
  // 1. 注入前复制用户已有的输入文字；2. 注入时覆盖为续跑 prompt；3. 注入后恢复用户文字。
  // 注入期间锁定输入，避免用户打字和注入交错。
  const composerInput = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
  if (composerInput && composerInput.value && composerInput.value.trim()) {
    pendingUserComposerRestore = composerInput.value;
  }

  // 主路：复用页面原生 form submit（send 函数路线）；兜底：DOM 点按钮。
  const submitted = await submitContinuationViaPage(prompt);

  // 铺密诊断：记录每一次注入的成败。
  diag.injectLog?.push({
    step: loop.stepCount,
    submitted,
    path: 'submitContinuationViaPage',
    hasPendingUserInput: pendingUserComposerRestore !== null,
  });

  // 注入完成后，恢复用户之前输入的草稿（如果有）。恢复时不要触发输入事件，避免误发。
  if (pendingUserComposerRestore !== null) {
    const textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
    if (textarea) {
      setTextareaValue(textarea, pendingUserComposerRestore);
    }
    pendingUserComposerRestore = null;
  }

  if (!submitted) {
    diag.failures?.push({ kind: 'continuation_submit_not_observed', step: loop.stepCount });
    finishContinuationLoop(loop);
  }
}

/**
 * 续跑提交：主路 trySubmitViaFormRequestSubmit（原生 form submit，send 函数路线），
 * 失败回退 sendPromptViaDom（点 #send-message-button，DOM 兜底）。
 */
async function submitContinuationViaPage(prompt: string): Promise<boolean> {
  const sentViaForm = await trySubmitViaFormRequestSubmit(prompt);
  if (sentViaForm) return true;
  return sendPromptViaDom(prompt);
}

// ---------------------------------------------------------------------------
// 后台 DOM 任务（方案 §4.1 Step 1：任务归属 + 结束回传，不接后台协调器）
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
      const lastError = (diag.ssaFatal?.[diag.ssaFatal.length - 1] as { kind?: string } | undefined)?.kind;
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
 * 归属自检（waitForDomTaskRecognized）是 GLM++ 自己加的「成功判据」，取代不可信的
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
        recordSsaFatal('no_textarea', 'automation send: chat-input textarea missing after 60s');
        return false;
      }
      textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
    }
    if (!textarea) {
      recordSsaFatal('no_textarea', 'automation send: chat-input textarea missing');
      return false;
    }

    // 关键：等 form 真正挂到文档（isConnected）且 Svelte 反应式就绪后，才允许提交。
    // 「Form submission canceled because the form is not connected」= 提交发生在 form 被
    // Svelte 短暂 detach / 尚未挂载的窗口期。手动不受影响因为人点的时候页面早稳定了；
    // 自动化注入太快，必须显式等这个窗口过去。
    const formReady = await waitForFormConnected(textarea);
    if (!formReady) {
      recordSsaFatal('form_not_connected', 'automation send: form never became connected');
      return false;
    }

    // 只读一次性快照：输入框/按钮/框架的 top-level DOM 形状（不逐按钮列，避免噪音）。
    // 用于定位「楼层里为什么没二楼」。属性-snapshot 最大 6 层、每节点最多 4 个 prop。
    try {
      diag.composerSnap?.push(snapshotReplyComposer());
    } catch {
      /* 诊断失败不影响主流程 */
    }

    // 提交前等上一轮生成结束（只读判定 Stop 按钮，不推进/不读写 continuationLoop）。
    if (!(await waitForAgentIdle())) {
      recordSsaFatal('agent_not_idle', 'automation send: previous generation never went idle');
      return false;
    }

    // 联网任务：不再点前端的「高级搜索」开关 —— 高级搜索会把 mcp_servers 写成
    // ["advanced-search"]、让服务端硬注入 search/open/click/find，与扩展自带的
    // web_search / web_fetch 抢通道。联网一律交给扩展工具，由 handleAugmentRequestBody
    // 把 features.auto_web_search / features.web_search 强制写成 false 关掉原生通道。
    const taskRecord = activeDomTasks.get(taskId);
    if (taskRecord?.searchEnabled === true) {
      diag.sendProbe?.push({ kind: 'automation-send', nativeSearchForcedOff: true });
    }

    // 原生 setter + input 事件（真机验证过的写法）。不 disable 输入框。
    setTextareaValue(textarea, '');
    setTextareaValue(textarea, prompt);

    // 写值自检：确认 value + 事件真的把内容写进去了。
    const writeOk = typeof textarea.value === 'string' && textarea.value.trim() === prompt.trim();
    diag.composerSnap?.push({
      beforeValue: textarea.value,
      afterValue: textarea.value,
      writeOk,
      promptHead: prompt.slice(0, 40),
      valueHead: textarea.value.slice(0, 40),
    });

    // 短稳定期：给 Svelte 时间把 bound-value 刷到 send 按钮态 / 反应式状态。
    await sleep(AUTOMATION_SUBMIT_SETTLE_MS);

    const sendButton = document.querySelector<HTMLButtonElement>(SEND_BUTTON_SELECTOR);
    const observedBefore = diag.augRequests?.length ?? 0;
    // 关键判据：「有没有请求真的发出」用 augRequests（AUGMENT_REQUEST_BODY，chatNew 和
    // completion 都计入）。不能用 diag.responses（只计 completion 的 RESPONSE_COMPLETE）。
    const hasNewRequest = () => (diag.augRequests?.length ?? 0) > observedBefore;

    // 主路：form.requestSubmit()（真机验证过的「让 z.ai 自己发」路径，
    // 触发面最小、原子，Z.ai 自己的 JS 处理后续 chatNew → 跳 /c/<id> → completion）。
    // 兜底：点 #send-message-button（type=submit，.click() 最终也走表单提交）。
    let submitPath = 'requestSubmit';
    // 提交前重新取 textarea 与 form：写值后 Svelte 可能已重建这一小块 DOM，
    // 早先抓到的引用会变成脱连节点（对它提交只报「form is not connected」且不发请求）。
    const liveTextarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR) ?? textarea;
    const submitOutcome = submitFormViaRequestSubmit(liveTextarea);
    if (submitOutcome !== 'ok') {
      diag.sendProbe?.push({ kind: 'automation-send', submitOutcome });
    }
    // requestSubmit 触发了，等 AUGMENT_REQUEST_BODY 真正被串行队列加工并记录（不一味 sleep）。
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
    const chatNewCount = (diag.augRequests ?? []).filter(
      (r) => (r as { route?: string }).route === 'chatNew',
    ).length;
    diag.sendProbe?.push({
      kind: 'automation-send',
      writeOk,
      submitPath,
      sendBtnExists: !!sendButton,
      sendBtnDisabled: sendButton?.disabled ?? null,
      observedBefore,
      observedAfter: diag.augRequests?.length ?? 0,
      chatNewCount,
      requestFired,
      userNodes: document.querySelectorAll(USER_MESSAGE_SELECTOR).length,
      anyPendingDialog: !!document.querySelector('[role="dialog"][data-dialog-content]'),
      pendingDialogText: (document.querySelector('[role="dialog"][data-dialog-content]')?.textContent ?? '').trim().slice(0, 60),
    });

    // 请求已发出 → 直接按「归属确认」等最终结果（不用管输入框/按钮的 UI 态了）。
    if (requestFired) {
      const recognized = await waitForDomTaskRecognized(taskId);
      if (recognized) {
        syncDiagnosticsToMainWorld();
        return true;
      }
      const jumped = readZaiChatSessionId() !== null;
      diag.sendProbe?.push({
        kind: 'automation-send',
        firedButNotRecognized: true,
        jumped,
        hasStop: isAgentCurrentlyRunning(),
      });
      syncDiagnosticsToMainWorld();
      return false;
    }

    // 三类发送动作都触发不了任何请求：这条链路在页面侧被完全拦截。
    diag.sendProbe?.push({
      kind: 'automation-send',
      error: 'no_request_fired',
      jumped: readZaiChatSessionId() !== null,
      hasStop: isAgentCurrentlyRunning(),
    });
    syncDiagnosticsToMainWorld();
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

/** 等 augRequests 出现新记录（首条 chatNew 从发送到 main-world hook 上报串行队列有延迟）。 */
async function waitForNewAugRequest(beforeCount: number, timeoutMs = 1_200): Promise<boolean> {
  const endAt = Date.now() + timeoutMs;
  while (Date.now() < endAt) {
    if ((diag.augRequests?.length ?? 0) > beforeCount) return true;
    await sleep(80);
  }
  return false;
}

/** 等 textarea 所在的 form 真正挂载到文档（isConnected）并给一个反应式稳定期。 */
async function waitForFormConnected(
  textarea: HTMLTextAreaElement,
  timeoutMs = 4_000,
): Promise<boolean> {
  const endAt = Date.now() + timeoutMs;
  while (Date.now() < endAt) {
    const form = textarea.closest('form');
    if (form && form.isConnected) {
      // 连续两帧 DOM 不变（Svelte 反应式稳定）再放行，避免提交撞上「节点刚被替换」的窗口。
      const snapBefore = form.outerHTML.length;
      await sleep(60);
      const formAfter = textarea.closest('form');
      if (formAfter && formAfter.isConnected && formAfter.outerHTML.length === snapBefore) {
        return true;
      }
    }
    await sleep(80);
  }
  // 兜底：超时仍按当前状态放行（isConnected 那次检查给了最大把握）。
  const form = textarea.closest('form');
  return !!form && form.isConnected;
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

/** 从请求 body 字符串里读 user 消息的 prompt 头（chatNew 读 chat.history，completion 读 messages）。 */
function readPromptHead(bodyStr: string, route: 'chatNew' | 'completion'): string {
  try {
    const parsed = JSON.parse(bodyStr) as Record<string, unknown>;
    if (route === 'chatNew') {
      const firstText = parseZaiChatNewBody(parsed)?.userMessageTexts[0] ?? '';
      if (firstText) return `chatNew:${firstText.slice(0, 60)}`;
      // 兜底：直接抓 body.chat.history 任一 content，看真实形状。
      const chat = parsed.chat as Record<string, unknown> | undefined;
      const history = chat?.history as Record<string, unknown> | undefined;
      const msgs = history?.messages as Record<string, unknown> | undefined;
      const anyContent = Object.values(msgs ?? {})
        .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>).content : undefined))
        .find((c) => typeof c === 'string');
      return anyContent ? `chatNew~raw:${String(anyContent).slice(0, 60)}` : '[chatNew: no user text found]';
    }
    const prompt = readZaiLastUserMessageText(parsed);
    return prompt ? `completion:${prompt.slice(0, 60)}` : '[completion: no user message]';
  } catch {
    return '[unparseable body]';
  }
}

/** 读请求 body 里 user 消息数量（首条/续跑诊断用）。 */
function readUserMessageCount(bodyStr: string): number {
  try {
    const parsed = JSON.parse(bodyStr) as Record<string, unknown>;
    const messages = parsed.messages;
    if (!Array.isArray(messages)) return 0;
    return messages.filter(
      (m) => m && typeof m === 'object' && (m as Record<string, unknown>).role === 'user',
    ).length;
  } catch {
    return -1;
  }
}

const AUTOMATION_SEND_MAX_ATTEMPTS = 3;
const AUTOMATION_SUBMIT_SETTLE_MS = 120;
const AUTOMATION_KEY_SEND_SETTLE_MS = 600;
const AUTOMATION_RECOGNIZE_TIMEOUT_MS = 5_000;
const AUTOMATION_SEND_RETRY_DELAY_MS = 800;
const USER_MESSAGE_SELECTOR = '.user-message';

/**
 * 派发一次真人风格的 Enter 按键（只发 keydown，不三连发）。
 * 关键：真人按 Enter 时页面只在 on:keydown 触发一次发送；此前同时派发
 * keydown+keypress+keyup 导致 z.ai 在多个 key 事件上都绑定发送 → 一次注入
 * 变成两条 /chats/new（双提交）→ 第二条覆盖第一条、SPA 不跳 /c/<id>。
 * 所以这里只发 keydown 一个事件，requestSubmit/点按钮作为后续兜底。
 */
function dispatchEnterKey(target: HTMLTextAreaElement): void {
  try {
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }));
  } catch {
    /* ignore */
  }
}

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
  searchEnabled: boolean;
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
  const currentSessionId = readZaiChatSessionId();
  if (input.chatSessionId && input.chatSessionId !== currentSessionId) {
    return { ok: false, error: 'wrong_conversation' };
  }

  const task: ActiveDomTask = {
    taskId: input.taskId,
    kind: input.kind,
    prompt: input.prompt,
    chatSessionId: currentSessionId,
    searchEnabled: input.searchEnabled === true,
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

/**
 * send 函数路线（Svelte 页面里唯一可复用的「原生发送」= form.requestSubmit()）。
 * 与 DOM 点按钮同层（都要先设 textarea value + dispatch input 让 bound-value 同步），
 * 区别只在「触发提交」这一步走原生 submit 事件链而非模拟点击。
 */
async function trySubmitViaFormRequestSubmit(prompt: string): Promise<boolean> {
  if (domSendInFlight) return false;
  domSendInFlight = true;
  try {
    await waitForComposerReady();
    const textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
    if (!textarea) return false;

    // 等上一轮生成结束，避免首页双提交（首条消息卡在首页的根因）。
    if (!(await waitForAgentIdle())) {
      diag.sendProbe?.push({ kind: 'form', error: 'agent_not_idle' });
      return false;
    }

    // 注入期间锁定输入框，避免用户打字与注入交错。
    const wasDisabled = textarea.disabled;
    textarea.disabled = true;

    setTextareaValue(textarea, '');
    setTextareaValue(textarea, prompt);

    // 关键：等 send 按钮从 disabled 变 enabled（Svelte bound-value 先更新按钮态）。
    // 不等就 requestSubmit 会读到旧（空）值 → 空提交 → 输入框被清空但页面不发请求、
    // 不跳 /c/<id>（自动化卡在首页的根因，与页面的 60ms 提交延迟窗口同义）。
    const sendButton = await waitForSendButtonEnabled();
    if (!sendButton) {
      textarea.disabled = wasDisabled;
      diag.sendProbe?.push({ kind: 'form', error: 'no_send_button' });
      return false;
    }

    // 异常已在 `submitFormViaRequestSubmit` 内部吞掉并转成 `'threw'`，这里只判结果。
    const outcome = submitFormViaRequestSubmit(textarea);
    if (outcome !== 'ok') {
      textarea.disabled = wasDisabled;
      diag.sendProbe?.push({ kind: 'form', error: outcome });
      return false;
    }

    // 成功判定：Svelte 提交后 input 会被清空。
    const sentOk = await waitForComposerCleared();
    textarea.disabled = wasDisabled;
    diag.sendProbe?.push({ kind: 'form', sentOk });
    if (sentOk) return true;
    // input 没清空，但请求计数涨了也算发出去了（跟 DOM 路同一兜底判定）。
    return waitForRequestObserved(Date.now());
  } finally {
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

/** 把当前地址里的会话 id 补给所有还没拿到它的在跑任务（幂等：id 相同就跳过）。 */
function reportLiveSessionToActiveTasks(): void {
  // 没有在跑的后台任务时直接返回。
  if (activeDomTasks.size === 0) return;
  const sessionId = readZaiChatSessionId();
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
 */
function installSessionWatch(ctx: { addEventListener: (t: Window, type: string, h: () => void) => void }): void {
  if (sessionWatchInstalled) return;
  sessionWatchInstalled = true;
  try {
    ctx.addEventListener(window, 'wxt:locationchange', reportLiveSessionToActiveTasks);
  } catch (error) {
    console.warn('[GLM++] locationchange listener unavailable', error);
  }
  window.addEventListener('popstate', reportLiveSessionToActiveTasks);
  window.addEventListener('hashchange', reportLiveSessionToActiveTasks);
  setInterval(reportLiveSessionToActiveTasks, SESSION_WATCH_INTERVAL_MS);
}

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
    console.warn('[GLM++] background config load failed', error);
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

function finishContinuationLoop(loop: ContinuationLoop): void {
  if (continuationLoop !== loop) return;
  loop.status = 'idle';
  loop.activeRequestId = null;
  loop.pendingPrompt = null;
  continuationLoop = null;
  stampLoopDiagnostic();
  console.log('[GLM++] continuation loop complete', {
    steps: loop.stepCount,
    executions: loop.toolExecutions.length,
    taskId: loop.taskId,
  });
  // 后台 DOM 任务：续跑收尾 → 回传终态成功并清理归属（方案 §4.1 / §2.6）。
  if (loop.taskId) {
    const task = activeDomTasks.get(loop.taskId);
    // 固定会话：回传前强制 re-read location 的真实 /c/<id>。新建会话场景
    // 下，loop.chatSessionId 可能是早期读到的 null；此刻页面早已跳到 /c/<id>，重新
    // 读才能把「真实会话 id」落库，后续运行才能沿用同一个对话。
    const liveSessionId = readZaiChatSessionId();
    const finalSessionId = liveSessionId ?? task?.chatSessionId ?? loop.chatSessionId;
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
  // 循环收尾时，把隔离世界的诊断同步到页面 window（sendProbe/failures/errors 等）。
  syncDiagnosticsToMainWorld();
}

// ---------------------------------------------------------------------------
// DOM 注入发送（共享原语 + Stop 按钮观察器，见 sendPromptPrimitive）
// ---------------------------------------------------------------------------

const SEND_BUTTON_SELECTOR = '#send-message-button';
const SUBMIT_OBSERVE_TIMEOUT_MS = 4_000;

let submitObserver: MutationObserver | null = null;
let lastSubmitObservedUrl = '';

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
  });
  if (document.body) {
    stopObserver.observe(document.body, { childList: true, subtree: true });
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
  const liveSessionId = readZaiChatSessionId();
  taskIdByRequestId.delete(requestId);
  respondedRequestIds.add(requestId);
  manualStopTimers.delete(requestId);
  // 若它已演化成运行中的续跑循环，先摘 taskId 让收尾不再回 COMPLETE。
  if (continuationLoop?.status === 'running' && continuationLoop.taskId === taskId) {
    continuationLoop.taskId = null;
    finishContinuationLoop(continuationLoop);
  }
  clearActiveDomTask(taskId);
  diag.failures?.push({ kind: 'manual_stop_detected', taskId, requestId });
  void sendRuntimeMessage({
    type: 'DOM_TASK_FAILED',
    taskId,
    error: 'cancelled',
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
  const endAt = Date.now() + timeoutMs;
  // 若刚观察到 Stop 按钮消失，等一个微小稳定期，避免 Svelte 还在收尾。
  while (Date.now() < endAt) {
    if (!isAgentCurrentlyRunning()) {
      const goneAt = lastStopButtonGoneAt;
      if (goneAt > 0 && Date.now() - goneAt > 150) return true;
      // observer 还没记录到「消失」事件，说明它从没出现过或刚装好：直接按当前 DOM 判定。
      if (goneAt === 0) return true;
    }
    await sleep(120);
  }
  return !isAgentCurrentlyRunning();
}

/**
 * 共享的「发送原语」：把一段 prompt 注入输入框并让页面自己发出。
 *
 * 这是续跑与自动化都复用的唯一发送函数（sendPromptViaDom / trySubmitViaFormRequestSubmit
 * 都收敛到这里），它负责：等输入框就绪 → 等上一轮生成结束 → 写 value → 派发 input
 * → 点 send 按钮（不做 requestSubmit，避免首页双提交）→ 判定「已发出」（输入框被清空）。
 *
 * 注意：这里只管「发送动作是否成功发出」，**不管**后续的请求归属/续跑/收尾，
 * 那些是调用方（续跑状态机 / 自动化任务状态机）各自的职责。续跑机制不被本函数改动。
 */
async function sendPromptPrimitive(prompt: string): Promise<boolean> {
  if (domSendInFlight) return false;
  domSendInFlight = true;
  try {
    await waitForComposerReady();
    const textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
    if (!textarea) return false;

    // 等上一轮生成结束，避免注入被当作用户抢答丢弃（首页首条尤其重要）。
    if (!(await waitForAgentIdle())) {
      diag.sendProbe?.push({ kind: 'shared-send', error: 'agent_not_idle' });
      return false;
    }

    const wasDisabled = textarea.disabled;
    textarea.disabled = true;

    setTextareaValue(textarea, '');
    setTextareaValue(textarea, prompt);

    const sendButton = await waitForSendButtonEnabled();
    if (!sendButton) {
      textarea.disabled = wasDisabled;
      diag.sendProbe?.push({ kind: 'shared-send', error: 'no_send_button' });
      return false;
    }

    sendButton.click();

    // 成功判定：输入框被页面清空即视为已发出。
    const sentOk = await waitForComposerCleared();
    textarea.disabled = wasDisabled;
    if (sentOk) {
      diag.sendProbe?.push({ kind: 'shared-send', sentOk: true });
      return true;
    }
    // 兜底：请求计数涨了也算发出去了（续跑模板请求会被 peek 计数）。
    return waitForRequestObserved(Date.now());
  } finally {
    domSendInFlight = false;
  }
}

function installSubmitObserver(): void {
  if (submitObserver) return;
  submitObserver = new MutationObserver(() => {
    lastSubmitObservedUrl = location.href;
  });
}

function observeSubmit(): void {
  if (!submitObserver) installSubmitObserver();
  // 观察 body 变化：提交成功会新增 user 消息节点。
  if (submitObserver && document.body) {
    submitObserver.observe(document.body, { childList: true, subtree: false });
  }
}

function stopObserveSubmit(): void {
  submitObserver?.disconnect();
  submitObserver = null;
}

async function sendPromptViaDom(prompt: string): Promise<boolean> {
  // 收敛到共享发送原语：等上一轮生成结束 → 写 value → 点 send → 判定已发出。
  return sendPromptPrimitive(prompt);
}

/** 等输入框被页面清空（提交成功的信号），最多等 6 秒。 */
async function waitForComposerCleared(): Promise<boolean> {
  const endAt = Date.now() + 6_000;
  while (Date.now() < endAt) {
    const textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
    if (textarea && textarea.value.trim() === '') return true;
    await sleep(200);
  }
  return false;
}

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
 * 插入文本到聊天输入框（对齐 ds++ 的 insertTextIntoPromptTextarea 语义）。
 * 走原生 value setter + input/change 事件，让 Svelte bound-value 同步，返回
 * { ok, insertedLength } 或 { ok:false, error }。供保存项「插入到对话」复用。
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
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      const button = document.querySelector<HTMLButtonElement>(SEND_BUTTON_SELECTOR);
      if (button && !button.disabled && getComputedStyle(button).pointerEvents !== 'none') {
        resolve(button);
        return;
      }
      if (Date.now() - startedAt > 4_000) {
        resolve(null);
        return;
      }
      setTimeout(check, 80);
    };
    check();
  });
}

function waitForComposerReady(): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      const textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
      if (textarea) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 6_000) {
        resolve();
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// composer 结构快照（自动化诊断用）：把输入框所在「楼层」的 top-level 形状
// 抓下来，判断页面到底是哪套 UI、send 按钮在哪、以及输入框外层有没有拦截层。
// 属性去敏感，只留结构；最多 6 层、每节点最多 4 个 prop。
// ---------------------------------------------------------------------------

const COMPOSER_BUILDINGS = [
  '#chat-input',
  'textarea',
  'form',
  '[data-editor]',
  '[contenteditable="true"]',
  '.chat-input',
  '[class*="chat-input" i]',
  '[class*="composer" i]',
  '[id*="send" i]',
  '[aria-label*="send" i]',
  '[aria-label*="Send" i]',
].map((selector) => ({ kind: 'sel', selector }));

function snapshotReplyComposer(): unknown {
  return {
    url: location.href,
    time: Date.now(),
    buildings: COMPOSER_BUILDINGS.map((q) => {
      let el: Element | null = null;
      try {
        el = document.querySelector(q.selector);
      } catch {
        el = null;
      }
      if (!el) return { q: q.selector, found: false };
      return {
        q: q.selector,
        found: true,
        id: el.id || null,
        disabled: (el as HTMLTextAreaElement).disabled ?? (el as HTMLButtonElement).disabled ?? null,
        wrapAttr: el.getAttribute('data-editor') ?? el.getAttribute('contenteditable') ?? null,
        path: buildAncestorPath(el),
      };
    }),
  };
}

function buildAncestorPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && depth < 6; depth += 1) {
    parts.push(buildNodeLabel(node, depth));
    node = node.parentElement;
  }
  return parts.join(' < ');
}

function buildNodeLabel(node: Element, depth: number): string {
  const tag = node.tagName.toLowerCase();
  const id = node.id ? `#${node.id}` : '';
  const cls = typeof node.className === 'string'
    ? `.${node.className.trim().split(/\s+/).slice(0, 2).join('.')}`
    : '';
  const aria = node.getAttribute('aria-label')
    ? `[aria*="${node.getAttribute('aria-label')!.slice(0, 14)}"]`
    : '';
  const type = depth === 0 ? buildNodeExtra(node) : '';
  return `${tag}${id}${cls}${aria}${type}`;
}

function buildNodeExtra(node: Element): string {
  const props: string[] = [];
  const el = node as HTMLElement;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    props.push(`value=${JSON.stringify(el.value.slice(0, 30))}`);
    props.push(`disabled=${el.disabled}`);
  } else if (el instanceof HTMLButtonElement) {
    props.push(`disabled=${el.disabled}`);
    props.push(`type=${el.type || el.getAttribute('type') || '(none)'}`);
    props.push(`text=${JSON.stringify((el.innerText || el.textContent || '').trim().slice(0, 12))}`);
  }
  return props.length > 0 ? ` ${props.slice(0, 4).join(' ')}` : '';
}

async function waitForRequestObserved(sinceTs: number): Promise<boolean> {
  // 判定「注入的续跑 prompt 真的发出去」：看 AUGMENT_REQUEST_BODY 是否观察到一条续跑请求。
  // 不能用 continuationLoop.status 判定（会自锁：RESPONSE_COMPLETE 在串行队列里被本函数阻塞，
  // 而本函数又在等 status 变化），只能改用独立的 request 计数。
  const startSeq = continuationRequestSeq;
  const endAt = Date.now() + 5_000;
  while (Date.now() < endAt) {
    if (continuationRequestSeq > startSeq) return true;
    await sleep(150);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 高峰弹窗自动关（data-dialog-close，MutationObserver 连点）
// ---------------------------------------------------------------------------

let dialogObserver: MutationObserver | null = null;
let lastDialogAutoSendAt = 0;

/** 高峰弹窗标题。只自动关这个标题的弹窗，避免误伤其它 dialog。 */
const PEAK_DIALOG_TITLE = '目前处于高峰时段';

function findPeakDialogCloseButton(): HTMLElement | null {
  // 只匹配真正的弹窗容器（role=dialog + data-dialog-content），
  // 且正文包含高峰标题才认，最后取容器内的关闭按钮。
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][data-dialog-content]');
  for (const dialog of dialogs) {
    if (!(dialog.textContent ?? '').includes(PEAK_DIALOG_TITLE)) continue;
    const closer = dialog.querySelector<HTMLElement>('[data-dialog-close]');
    if (closer) return closer;
  }
  return null;
}

function installPeakDialogAutoDismiss(): void {
  if (dialogObserver) return;
  dialogObserver = new MutationObserver(() => {
    const closer = findPeakDialogCloseButton();
    if (!closer) return;
    if (!closer.offsetParent && closer.getClientRects().length === 0) return;
    closer.click();
    autoSendAfterDialogDismiss();
  });
  dialogObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
}

function autoSendAfterDialogDismiss(): void {
  const now = Date.now();
  if (now - lastDialogAutoSendAt < 2_000) return;
  if (domSendInFlight) return;
  const textarea = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
  if (!textarea || !textarea.value.trim()) return;
  if (findStopButton()) return;
  lastDialogAutoSendAt = now;
  const send = document.querySelector<HTMLButtonElement>(SEND_BUTTON_SELECTOR);
  send?.click();
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export default defineContentScript({
  matches: ['*://chat.z.ai/*'],
  runAt: 'document_idle',
  async main(ctx) {
    extensionContextValid = true;

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data as Record<string, unknown> | undefined;
      if (!data || data.source !== ZAI_MAIN_TO_CONTENT) return;
      void dispatchMainWorldMessage(data);
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== 'object') return undefined;
      if (message.type === 'STATE_UPDATED' || message.type === 'TOOL_DESCRIPTORS_UPDATED') {
        void loadAndSyncRuntimeState();
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
      if (message.type === 'GET_CURRENT_GLM_CONVERSATION') {
        const conversationId = getCurrentChatSessionId();
        sendResponse(
          conversationId
            ? {
                ok: true,
                conversation: {
                  conversationId,
                  title: getCurrentConversationTitle(),
                  url: location.href,
                },
              }
            : { ok: false, error: 'no_current_conversation' },
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
              searchEnabled:
                typeof message.searchEnabled === 'boolean' ? message.searchEnabled : false,
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
            error: 'cancelled',
            chatSessionId: readZaiChatSessionId(),
          });
        }
        sendResponse({ ok: true });
        return true;
      }
      return undefined;
    });

    installPeakDialogAutoDismiss();
    installStopObserver();
    installSessionWatch(ctx);
    void installBackgroundCapability();

    await loadAndSyncRuntimeState();
    stampLoopDiagnostic();
    console.log('[GLM++] isolated content ready');
  },
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 后台 auth refresh：从页面 localStorage 读 token 兜底写进 chrome.storage（best-effort）。 */
async function refreshZaiAuth(): Promise<boolean> {
  try {
    const raw = (typeof localStorage === 'undefined' ? '' : localStorage.getItem('token') ?? '');
    const token = raw.trim();
    if (!token) return false;
    return await mergeZaiAuthFromCapture({
      token,
      userId: readZaiUserIdFromToken(token),
      feVersion: undefined,
      deviceId: undefined,
    });
  } catch {
    return false;
  }
}