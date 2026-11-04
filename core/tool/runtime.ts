import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n/background';
import { appendToolCallHistory } from './history';
import { ToolPostEffectPersistenceError } from './execution-error';
import type {
  RuntimeToolAuthorizationContext,
  ToolCall,
  ToolCapabilityScope,
  ToolDescriptor,
  ToolExecutionTrigger,
  ToolResult,
} from './types';
import type { ToolProviderExecutionContext, ToolProviderRegistry } from './provider-registry';
import { isToolCallRecord } from '../messaging/tool-record-codec';
import { diagnosticLogBuffer } from '../diagnostics/log-buffer';
import {
  authorizeToolExecution,
  completeToolExecutionAuthorization,
  createToolAuthorizationResult,
  getGrantLocalSkillDir,
  getToolAuthorizationAuditTrigger,
  ToolAuthorizationError,
} from './authorization';
import { enforceLocalSkillCwd } from './local-skill-cwd';
import { createAbortScope } from '../network/abort';
import { truncateUtf8ToByteLimit } from './result-bytes';

export interface RuntimeToolCallOptions {
  timeoutMs?: number;
  maxResultBytes?: number;
  signal?: AbortSignal;
  assertActive?: () => void;
  /** Stable, background-owned scope for a multi-step trusted run. */
  trustedCapabilityScopeId?: string;
}

export interface RuntimeCapabilityInvocationInput {
  call: ToolCall;
  descriptor: ToolDescriptor;
  capabilityScope: ToolCapabilityScope;
  currentDescriptors: readonly ToolDescriptor[];
}

export type RuntimeCapabilityInvocationResolution =
  | { kind: 'target'; call: ToolCall; descriptor: ToolDescriptor }
  | { kind: 'rejected'; result: ToolResult };

/**
 * A deliberately narrow port for proxy-style capability calls. The runtime
 * owns normal tool authorization and provider dispatch; the injected resolver
 * may only map an already-authorized control call to one live target.
 */
export interface RuntimeCapabilityInvocationResolver {
  supports(descriptor: ToolDescriptor): boolean;
  resolveInvocation(
    input: RuntimeCapabilityInvocationInput,
  ): Promise<RuntimeCapabilityInvocationResolution>;
}

export interface RuntimeToolRuntimeOptions {
  capabilityInvocationResolver?: RuntimeCapabilityInvocationResolver;
}

export interface RuntimeToolRuntime {
  getToolDescriptors(locale?: SupportedLocale): Promise<ToolDescriptor[]>;
  getAuthorizationDescriptors(locale?: SupportedLocale): Promise<ToolDescriptor[]>;
  refreshToolDescriptors(locale?: SupportedLocale): Promise<ToolDescriptor[]>;
  executeToolCall(
    call: ToolCall,
    authorization: RuntimeToolAuthorizationContext,
    locale?: SupportedLocale,
    options?: RuntimeToolCallOptions,
  ): Promise<ToolResult>;
}

export function createRuntimeToolRuntime(
  providerRegistry: ToolProviderRegistry,
  runtimeOptions: RuntimeToolRuntimeOptions = {},
): RuntimeToolRuntime {
  return {
    getToolDescriptors: (locale = DEFAULT_LOCALE) => getRuntimeDescriptors(
      providerRegistry,
      locale,
      false,
    ),
    getAuthorizationDescriptors: (locale = DEFAULT_LOCALE) => getRuntimeDescriptors(
      providerRegistry,
      locale,
      true,
    ),
    refreshToolDescriptors: async (locale = DEFAULT_LOCALE) => {
      await providerRegistry.refresh({ locale });
      return getRuntimeDescriptors(providerRegistry, locale, false);
    },
    executeToolCall: (call, authorization, locale = DEFAULT_LOCALE, callOptions = {}) =>
      executeRuntimeToolCall(
        providerRegistry,
        call,
        authorization,
        locale,
        callOptions,
        runtimeOptions.capabilityInvocationResolver,
      ),
  };
}

async function getRuntimeDescriptors(
  providerRegistry: ToolProviderRegistry,
  locale: SupportedLocale,
  includeDisabledMcp: boolean,
): Promise<ToolDescriptor[]> {
  return providerRegistry.listTools({
    locale,
    includeDisabled: includeDisabledMcp,
  });
}

async function executeRuntimeToolCall(
  providerRegistry: ToolProviderRegistry,
  call: ToolCall,
  context: RuntimeToolAuthorizationContext,
  locale: SupportedLocale = DEFAULT_LOCALE,
  options: RuntimeToolCallOptions = {},
  capabilityInvocationResolver?: RuntimeCapabilityInvocationResolver,
): Promise<ToolResult> {
  assertRuntimeExecutionActive(options);
  if (!isToolCallRecord(call)) {
    diagnosticLogBuffer.record({
      level: 'warn',
      source: 'tool-runtime',
      message: 'tool call payload rejected',
      details: String(call?.name ?? 'unknown'),
    });
    return createInvalidToolCallResult(call, locale);
  }
  diagnosticLogBuffer.record({
    level: 'info',
    source: 'tool-runtime',
    message: `tool start: ${call.name}`,
  });
  if (call.parseError) {
    const result = createParseErrorToolResult(call, locale);
    await appendAuthorizedFailureHistory(call, result, context);
    return result;
  }
  let authorized: Awaited<ReturnType<typeof authorizeToolExecution>>;
  let currentDescriptors: ToolDescriptor[];
  try {
    currentDescriptors = await getRuntimeDescriptors(providerRegistry, locale, true);
    authorized = await authorizeToolExecution(
      call,
      context,
      currentDescriptors,
    );
    assertRuntimeExecutionActive(options);
  } catch (error) {
    if (!(error instanceof ToolAuthorizationError)) throw error;
    const result = error.code === 'tool_unsupported'
      ? createUnsupportedToolResult(call, locale)
      : createToolAuthorizationResult(
        error,
        call,
        translate(locale, 'tool.runtime.authorizationRejected'),
        buildAuthorizationRejectionHint(locale, error),
      );
    diagnosticLogBuffer.record({
      level: 'warn',
      source: 'tool-runtime',
      message: `tool authorization denied: ${call.name}`,
      details: `${error.code}: ${error.message}`,
    });
    await appendAuthorizedFailureHistory(call, result, context);
    return result;
  }

  let result: ToolResult;
  let resolvedCall = authorized.call;
  let executionDescriptor = authorized.descriptor;
  let providerCompleted = false;
  try {
    resolvedCall = await resolveToolCallPayload(
      authorized.call,
      authorized.reservation?.grantId,
    );
    assertRuntimeExecutionActive(options);
    if (resolvedCall.parseError) {
      result = createParseErrorToolResult(resolvedCall, locale);
    } else if (capabilityInvocationResolver?.supports(executionDescriptor)) {
      const resolution = await capabilityInvocationResolver.resolveInvocation({
        call: resolvedCall,
        descriptor: executionDescriptor,
        capabilityScope: createRuntimeCapabilityScope(context, resolvedCall),
        currentDescriptors,
      });
      if (resolution.kind === 'rejected') {
        result = resolution.result;
      } else {
        resolvedCall = resolution.call;
        executionDescriptor = resolution.descriptor;
        result = await runProvider(providerRegistry, resolvedCall, executionDescriptor, {
          locale,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          maxResultBytes: options.maxResultBytes,
          availableDescriptors: currentDescriptors,
          capabilityScope: createRuntimeCapabilityScope(context, authorized.call),
        });
        providerCompleted = true;
      }
    } else {
      result = await runProvider(providerRegistry, resolvedCall, executionDescriptor, {
        locale,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        maxResultBytes: options.maxResultBytes,
        availableDescriptors: currentDescriptors,
        capabilityScope: createRuntimeCapabilityScope(context, authorized.call),
      });
      providerCompleted = true;
    }
    assertRuntimeExecutionActive(options);
  } catch (error) {
    diagnosticLogBuffer.record({
      level: 'error',
      source: 'tool-runtime',
      message: `tool execution failed: ${resolvedCall.name}`,
      details: error instanceof Error ? error.message : String(error),
    });
    await completeAuthorizationAfterProvider(authorized.reservation);
    throw error;
  }
  await completeAuthorizationAfterProvider(authorized.reservation);
  try {
    await appendRuntimeToolHistory(resolvedCall, result, authorized.trigger);
  } catch (error) {
    if (providerCompleted) throw new ToolPostEffectPersistenceError(error);
    throw error;
  }
  assertRuntimeExecutionActive(options);
  diagnosticLogBuffer.record({
    level: result.ok ? 'info' : 'warn',
    source: 'tool-runtime',
    message: `tool finished: ${result.name ?? resolvedCall.name} (${result.ok ? 'ok' : 'error'})`,
    details: summarizeToolResult(result),
  });
  return result;
}

function summarizeToolResult(result: ToolResult): string {
  const parts = [result.summary];
  if (result.detail) parts.push(result.detail.slice(0, 500));
  return parts.join(' | ').slice(0, 600);
}

export function createInvalidToolCallResult(
  value: unknown,
  locale: SupportedLocale = DEFAULT_LOCALE,
): ToolResult {
  const message = 'Runtime tool call does not match the released contract.';
  const name = value && typeof value === 'object'
    && typeof (value as { name?: unknown }).name === 'string'
    ? (value as { name: string }).name
    : undefined;
  return {
    ok: false,
    summary: translate(locale, 'tool.runtime.invalidFormat'),
    detail: message,
    name,
    error: {
      code: 'tool_call_payload_invalid',
      message,
      retryable: false,
    },
  };
}

function assertRuntimeExecutionActive(options: RuntimeToolCallOptions): void {
  options.assertActive?.();
  if (!options.signal?.aborted) return;
  const reason = options.signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException('Tool execution was aborted.', 'AbortError');
}

async function appendAuthorizedFailureHistory(
  call: ToolCall,
  result: ToolResult,
  context: RuntimeToolAuthorizationContext,
): Promise<void> {
  const trigger = await getToolAuthorizationAuditTrigger(call, context);
  if (trigger) await appendRuntimeToolHistory(call, result, trigger);
}

async function completeAuthorizationAfterProvider(
  reservation: Awaited<ReturnType<typeof authorizeToolExecution>>['reservation'],
): Promise<void> {
  try {
    await completeToolExecutionAuthorization(reservation);
  } catch (error) {
    // The executing reservation was persisted before provider I/O, so a failed
    // completion write remains fail-closed for replay. Preserve the real
    // provider result and history instead of replacing it with a storage error.
    console.log('[Zai++] tool authorization completion persistence failed', error);
  }
}

/**
 * 执行一次 provider 调用，**把描述符声明的两道上界都真的施加一遍**。
 *
 * 两件事分开算、顺序固定：
 * 1. **时长**（`execution.timeoutMs`）—— 建 `AbortScope` + 与 provider 调用竞速；
 * 2. **体积**（`execution.maxResultBytes`）—— 对结果本身裁 `detail` / `output`。
 *
 * ⚠️⚠️ **这两条在改造前都是空转的**：本地 provider 链上没有任何地方读这两个字段
 * （`core/mcp/discovery.ts` 那条是 MCP 链自己的，管不到本地 provider），
 * 而 `core/tool/authorization.ts:854-855` 还在校验它们的合法性 ——
 * 那层校验让读者更确信它们生效。
 * ⚠️ **顺序不能反**：先裁体积再判超时的话，超时那条错误结果本身也会被裁，
 * 而它的 `details: { timeoutMs }` 是排障依据。
 */
async function runProvider(
  providerRegistry: ToolProviderRegistry,
  call: ToolCall,
  descriptor: ToolDescriptor,
  context: ToolProviderExecutionContext,
): Promise<ToolResult> {
  const result = await executeWithTimeout(providerRegistry, call, descriptor, context);
  return applyResultByteBudget(result, descriptor, context);
}

/**
 * 按 `execution.maxResultBytes` 裁结果。
 *
 * ⚠️⚠️ **这是 `maxResultBytes` 在本地 provider 链上唯一的消费点** —— 在此之前
 * 那 18 个浏览器工具声明的 40 000 / 60 000、以及 `memory_*` / `skill_*` 的 4096
 * **全部空转**（`core/mcp/discovery.ts` 那条是 MCP 链自己的，管不到本地 provider）。
 *
 * ⚠️⚠️ **只裁 `detail`，不裁 `output`** —— 这是 MCP 链的既有口径
 * （`normalizeMcpToolResult` 裁 `detailSource`，`output` 原样结构化返回），local 链必须**跟它一致**，
 * 否则同一个 `ToolResult` 在两个 provider 上形状不同：
 * - `output` 是**结构化结果**，消费方按对象形状判（`skill_draft_create` 的「保存」按钮、
 *   `memory_import_preview` 的「导入」按钮都靠它）—— 把它裁成字符串等于**让按钮消失**，
 *   而且失败方向是静默的（渲染器按「形状不对」退回纯文本，不报错）。
 * - `detail` 是**给人/模型看的文本**，本来就是要被裁的那一侧。
 *
 * ⚠️ **不要改成「裁整个 ToolResult 的 JSON」**：`name` / `provider` / `error.code`
 * 是判据字段，被截断会让下游认不出这是什么工具、失败码是什么。
 * ⚠️ **`summary` 不裁** —— 它是给面板与模型看的一行摘要，各工具自己控制在几十字内；
 * 裁它只会让「工具名 + 失败原因」拼不成句。
 * ⚠️ **超预算时置 `truncated: true`** —— 这是「结果被裁过」的唯一信号，
 * 续跑模板会把它原样带给模型。
 */
function applyResultByteBudget(
  result: ToolResult,
  descriptor: ToolDescriptor,
  context: ToolProviderExecutionContext,
): ToolResult {
  const limit = context.maxResultBytes ?? descriptor.execution.maxResultBytes;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return result;

  if (typeof result.detail !== 'string') return result;
  const projection = truncateUtf8ToByteLimit(result.detail, limit);
  if (!projection.truncated) return result;
  return { ...result, detail: projection.value, truncated: true };
}

/**
 * 时长那一半：建 `AbortScope` 并与 provider 调用竞速。
 *
 * ⚠️ **`context.timeoutMs`（调用方显式传的）优先于描述符** —— 后者是工具自己声明的
 * 默认值，前者是这一次调用的意图。
 * ⚠️ **当前没有生产调用方传 `context.timeoutMs`**（后台那条 `EXECUTE_TOOL_CALL` 入口
 * 只传 `call` / `authorization` / `locale`；自动化走的是内容脚本的 DOM 任务，不经过这里）。
 * 留这个优先关系是为了将来能按租约剩余时间收窄——**在此之前别把它当成已有来源**。
 * ⚠️ **两者都没有时不建 scope** —— 不加超时是既有行为，不要在这里凭空造一个上限：
 * `memory_*` / `skill_*` 那几个工具本来就不声明 `timeoutMs`。
 */
async function executeWithTimeout(
  providerRegistry: ToolProviderRegistry,
  call: ToolCall,
  descriptor: ToolDescriptor,
  context: ToolProviderExecutionContext,
): Promise<ToolResult> {
  const timeoutMs = context.timeoutMs ?? descriptor.execution.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return providerRegistry.execute(call, descriptor, context);
  }
  const startedAt = Date.now();
  const scope = createAbortScope(context.signal, timeoutMs);
  try {
    // ⚠️⚠️ **光传 signal 不够，必须真的竞速** —— 各 provider 对 `signal` 的反应
    // 是不统一的：browser 那条链会把它传到 `cdp.sendCommand`（那里会抛
    // `browser_control_aborted`），而 MCP / memory / skill 那几条**根本不看它**，
    // 拿着一个已 abort 的 signal 照样跑到底（实测：一个永不 settle 的 provider
    // 在只传 signal 的情况下会一直挂到测试超时）。
    // ⇒ 传 signal 是为了「能真取消的链真的取消」，竞速是为了「不能取消的链也按时返回」。
    return await raceProviderExecution(
      providerRegistry.execute(call, descriptor, { ...context, signal: scope.signal }),
      scope.signal,
    );
  } catch (error) {
    // ⚠️⚠️ **超时收敛成一条 ToolResult，不是往上抛** —— 抛出去会落到
    // `createBackgroundErrorResponse`，那里把任何异常折成
    // `{ code: 'background_tool_execution_failed', retryable: true }`，
    // 「超时」这个信息当场丢掉，模型看到的是「工具坏了、可以重试」。
    // 而各 provider 对 signal 的反应本来就不统一（browser 抛 `browser_control_aborted`、
    // 别的可能抛 `DOMException`、也可能拿着已 abort 的 signal 跑完再正常返回）。
    // ⚠️ **这一层只是兜底，不是 MCP 超时的唯一出口** —— MCP 那条链自己有传输层超时，
    // 而且它比本层**早 500ms** 到期（见 `core/mcp/discovery.ts` 的
    // `MCP_TRANSPORT_TIMEOUT_BUFFER_MS`）。正常情况下先到的是内层，模型拿到的是
    // `mcp_transport_timeout` + `retryable: true`；只有 provider 链**根本不看 signal**
    // 真挂住时，才会走到这里的 `tool_execution_timeout`。
    if (!scope.timedOut()) throw error;
    const completedAt = Date.now();
    const message = `Tool ${descriptor.name} exceeded its ${timeoutMs} ms budget.`;
    return {
      ok: false,
      name: descriptor.name,
      provider: descriptor.provider,
      descriptorId: descriptor.id,
      summary: translate(context.locale, 'tool.runtime.timedOut'),
      detail: message,
      error: {
        code: 'tool_execution_timeout',
        message,
        // ⚠️ **不可重试**：超时说明这个动作这一次已经跑满预算，自动重跑只会再等一遍
        // 同样长的时间（`browser_wait_for` 那种「本来就要等」的场景尤其如此）。
        retryable: false,
        details: { timeoutMs, providerId: descriptor.provider.id },
      },
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
    };
  } finally {
    scope.cleanup();
  }
}

/**
 * 让 provider 调用与取消信号竞速。
 *
 * ⚠️ **取消之后底层那次调用仍在飞** —— 这是有意的取舍：留一个在飞的读操作无害
 * （结果没人接），而「一直等」会让整条工具链卡死、续跑循环停在 `running`。
 * ⚠️ **监听器必须摘** —— 每次工具调用都往同一个 signal 上挂 `abort` 而不摘，
 * 长会话里会累积。
 */
function raceProviderExecution<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Tool execution aborted.', 'AbortError'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

async function appendRuntimeToolHistory(
  call: ToolCall,
  result: ToolResult,
  source: ToolExecutionTrigger,
): Promise<void> {
  try {
    await appendToolCallHistory(call, result, source);
  } catch (error) {
    if (!isRecoverableToolHistoryError(error)) throw error;
    // ⚠️ 只覆盖「配额类」可恢复错误。**配额耗尽是持续性状态** —— 此后每次工具调用都走这里，
    // 表现是「刷新后工具详情只剩摘要」而不报错。降成 log 的代价就是这种长期退化不再亮红。
    console.log('[Zai++] tool history persistence failed', error);
  }
}

/**
 * 把调用准备成「可执行」形态：只做一件事 —— 按后台 grant 归一 `cwd`。
 *
 * ⚠️⚠️ **`cwd` 的唯一可信来源是后台 grant**（`getGrantLocalSkillDir(grantId)`）。
 * **`ToolCall` 上不再有任何本地目录提示字段**（原先的 `localSkillDir` 已删 —— 它唯一的
 * 赋值点是上游那个未移植的流式解析器，本项目从来没有生产者）⇒ 这一层**没有需要拦的输入面**，
 * 只是把 grant 上那份目录填进 payload。
 * ⚠️ **闸门键是 `call.name`（稳定工具身份），不是 `call.invocationName`** ——
 * 后者对每个 Shell Local 工具都是 `mcp_<server uuid>_<tool>`，拿它比白名单恒不命中，
 * 而失败方向是静默的（cwd 退回 `homedir()`）。详见 `local-skill-cwd.ts`。
 */
export async function resolveToolCallPayload(
  call: ToolCall,
  grantId?: string,
): Promise<ToolCall> {
  const grantLocalSkillDir = grantId
    ? await getGrantLocalSkillDir(grantId)
    : undefined;
  return {
    ...call,
    payload: enforceLocalSkillCwd(call.payload, call.name, grantLocalSkillDir),
  };
}

function isRecoverableToolHistoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /QUOTA_BYTES|quota exceeded|max(?:imum)?\s+(?:write|storage)|too large/i.test(message);
}

function createParseErrorToolResult(call: ToolCall, locale: SupportedLocale): ToolResult {
  return {
    ok: false,
    summary: translate(locale, 'tool.runtime.invalidFormat'),
    detail: call.parseError?.message ?? 'Tool call payload is invalid.',
    name: call.name,
    provider: call.provider,
    descriptorId: call.descriptorId,
    error: call.parseError ?? {
      code: 'tool_call_payload_invalid',
      message: 'Tool call payload is invalid.',
      retryable: false,
    },
  };
}

function createUnsupportedToolResult(call: ToolCall, locale: SupportedLocale): ToolResult {
  return {
    ok: false,
    summary: translate(locale, 'tool.runtime.unknownTool'),
    detail: `Unsupported tool: ${call.name}`,
    name: call.name,
    provider: call.provider,
    descriptorId: call.descriptorId,
    error: {
      code: 'tool_unsupported',
      message: `Unsupported tool: ${call.name}`,
      retryable: false,
    },
  };
}

function createRuntimeCapabilityScope(
  context: RuntimeToolAuthorizationContext,
  canonicalCall: ToolCall,
): ToolCapabilityScope {
  if (context.kind === 'grant') {
    const source = canonicalCall.source;
    if (!source?.requestId) {
      throw new Error('Granted capability scope is missing its authorized request identity.');
    }
    return {
      kind: 'grant',
      scopeId: source.requestId,
      trigger: source.trigger,
      chatSessionId: source.chatSessionId ?? null,
      subject: { ...context.subject },
    };
  }
  return {
    kind: 'trusted',
    scopeId: context.capabilityScopeId ?? context.requestId,
    trigger: context.trigger,
    chatSessionId: context.chatSessionId ?? null,
  };
}


type AuthorizationHintKey =
  | 'tool.runtime.authorizationMissingHint'
  | 'tool.runtime.authorizationStaleHint'
  | 'tool.runtime.authorizationSessionMismatchHint'
  | 'tool.runtime.authorizationDisabledHint'
  | 'tool.runtime.authorizationIdentityMissingHint'
  | 'tool.runtime.authorizationGenericHint';

function buildAuthorizationRejectionHint(
  locale: SupportedLocale,
  error: ToolAuthorizationError,
): string {
  return translate(locale, authorizationHintKey(error.code), {});
}

function authorizationHintKey(code: string): AuthorizationHintKey {
  switch (code) {
    case 'tool_authorization_missing':
      return 'tool.runtime.authorizationMissingHint';
    case 'tool_authorization_stale':
      return 'tool.runtime.authorizationStaleHint';
    case 'tool_session_mismatch':
      return 'tool.runtime.authorizationSessionMismatchHint';
    case 'tool_disabled':
      return 'tool.runtime.authorizationDisabledHint';
    case 'tool_identity_missing':
      return 'tool.runtime.authorizationIdentityMissingHint';
    default:
      return 'tool.runtime.authorizationGenericHint';
  }
}
