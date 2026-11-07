import type { SupportedLocale } from '../../core/i18n';
import {
  definePayloadlessRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import type { PlatformEnvironment } from '../../core/platform/capabilities';
import type {
  CreateToolAuthorizationInput,
} from '../../core/tool/authorization';
import { ToolAuthorizationError } from '../../core/tool/authorization';
import type {
  RuntimeToolAuthorizationContext,
  ToolAuthorizationGrantSummary,
  ToolAuthorizationSubject,
  ToolCall,
  ToolDescriptor,
  ToolExecutionTrigger,
  ToolResult,
  TrustedToolExecutionContext,
} from '../../core/tool/types';
import type {
  ToolCallHistoryReadOptions,
  ToolCallHistoryReadResult,
} from '../../core/tool/history';
import type { RuntimeMessageContext } from '../../core/messaging/runtime-boundary';
import { defineToolPayloadRuntimeCommandHandler } from './runtime-handler';

export interface ToolExecutionRuntimeHandlerDependencies {
  getLocale(): SupportedLocale;
  getToolDescriptors(locale: SupportedLocale): Promise<ToolDescriptor[]>;
  getPromptToolDescriptors(locale: SupportedLocale, intent: string): Promise<ToolDescriptor[]>;
  getAuthorizationDescriptors(locale: SupportedLocale): Promise<ToolDescriptor[]>;
  refreshToolDescriptors(locale: SupportedLocale): Promise<ToolDescriptor[]>;
  createToolAuthorization(input: CreateToolAuthorizationInput): Promise<ToolAuthorizationGrantSummary>;
  /** Background validation: whether a given directory belongs to an imported local skill. */
  validateLocalSkillDirectory(dir: string): Promise<boolean>;
  closeToolAuthorization(
    authorizationId: string,
    subject: ToolAuthorizationSubject,
  ): Promise<void>;
  createInvalidToolCallResult(value: unknown, locale: SupportedLocale): ToolResult;
  executeToolCall(
    call: ToolCall,
    authorization: RuntimeToolAuthorizationContext,
    locale: SupportedLocale,
  ): Promise<ToolResult>;
  getToolCallHistory(options?: ToolCallHistoryReadOptions): Promise<ToolCallHistoryReadResult>;
  clearToolCallHistory(): Promise<void>;
  getPlatformEnvironment(): PlatformEnvironment;
  createRequestId(): string;
  now(): number;
  broadcastToolDescriptorsUpdate(excludeTabId?: number): Promise<void>;
  broadcastMcpServersUpdate(excludeTabId?: number): Promise<void>;
  broadcastToolCallHistoryUpdate(excludeTabId?: number): Promise<void>;
  /**
   * 工具执行后通知记忆/技能等状态已变（`memory_save` 后立即重播）。
   *
   * ⚠️⚠️ **刻意不传 `excludeTabId`** —— 本条与其它广播的语义相反：其它广播是「发起方不用再听一遍」，
 * 而工具改的是**后台**状态，发起命令的那条标签**尤其不能漏掉**它（`memory_save` 存完，同标签
 * 下一轮注入要读到；内容脚本处理手发消息那条路不主动刷新运行时状态）。
 * ⚠️ **不要理解成「只发给发起方」** —— 不传参数的语义是**发给所有人**（`excludeTabId` 为
   * `undefined` 时逐条全发），发起方只是其中一员。改成只发一条会让别的标签停在旧状态。
   */
  notifyStateCommitted?(): Promise<void>;
}

export function createToolExecutionRuntimeHandlers(
  dependencies: ToolExecutionRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    definePayloadlessRuntimeCommandHandler('GET_TOOL_DESCRIPTORS', () => (
      dependencies.getToolDescriptors(dependencies.getLocale())
    )),
    definePayloadlessRuntimeCommandHandler('REFRESH_TOOL_DESCRIPTORS', async (context) => {
      const tools = await dependencies.refreshToolDescriptors(dependencies.getLocale());
      await dependencies.broadcastToolDescriptorsUpdate(context.tabId);
      await dependencies.broadcastMcpServersUpdate(context.tabId);
      return tools;
    }),
    defineToolPayloadRuntimeCommandHandler('CREATE_TOOL_AUTHORIZATION', async (decoded, context) => {
      if (context.surface !== 'zai_content') {
        return { ok: false as const, error: 'tool_authorization_requires_content_runtime' };
      }
      if (decoded.ok === false) {
        return { ok: false as const, error: decoded.error };
      }

      const payload = decoded.payload;
      const locale = dependencies.getLocale();
      const currentDescriptors = payload.descriptorIds
        ? await dependencies.getToolDescriptors(locale)
        : await dependencies.getPromptToolDescriptors(locale, payload.toolIntent ?? '');
      const requestedDescriptorIds = payload.descriptorIds
        ? new Set(payload.descriptorIds)
        : null;
      const descriptors = requestedDescriptorIds
        ? currentDescriptors.filter((descriptor) => requestedDescriptorIds.has(descriptor.id))
        : currentDescriptors;
      if (requestedDescriptorIds && descriptors.length !== requestedDescriptorIds.size) {
        return { ok: false as const, error: 'unknown_tool_authorization_descriptor' };
      }

      // The page/model-supplied localSkillDir is untrusted; write it
      // to the grant only when background confirms it belongs to an imported
      // local-skill directory, otherwise do not force cwd.
      const requestedLocalSkillDir = payload.localSkillDir;
      const validatedLocalSkillDir =
        requestedLocalSkillDir && await dependencies.validateLocalSkillDirectory(requestedLocalSkillDir)
          ? requestedLocalSkillDir
          : undefined;
      return dependencies.createToolAuthorization({
        requestId: payload.requestId,
        trigger: payload.trigger,
        chatSessionId: payload.chatSessionId,
        runId: payload.runId,
        subject: createToolAuthorizationSubject(context),
        descriptors,
        localSkillDir: validatedLocalSkillDir,
      });
    }),
    defineToolPayloadRuntimeCommandHandler('CLOSE_TOOL_AUTHORIZATION', async (decoded, context) => {
      if (decoded.ok === false) {
        return { ok: false as const, error: decoded.error };
      }
      const { authorizationId } = decoded.payload;
      await dependencies.closeToolAuthorization(
        authorizationId,
        createToolAuthorizationSubject(context),
      );
      return { ok: true as const };
    }),
    defineToolPayloadRuntimeCommandHandler('EXECUTE_TOOL_CALL', async (decoded, context) => {
      const locale = dependencies.getLocale();
      if (decoded.ok === false) {
        return dependencies.createInvalidToolCallResult(decoded.call, locale);
      }
      const { authorizationId, call } = decoded;
      const authorization: RuntimeToolAuthorizationContext = context.surface === 'zai_content'
        ? {
          kind: 'grant',
          grantId: authorizationId ?? '',
          subject: createToolAuthorizationSubject(context),
        }
        : createTrustedToolExecutionContext(
          call,
          'manual_chat',
          dependencies.createRequestId,
        );
      const result = await dependencies.executeToolCall(
        call,
        authorization,
        locale,
      );
      await dependencies.broadcastToolCallHistoryUpdate(context.tabId);
      // 工具执行后（尤其 memory_save / shell_exec 等会改状态），补一次状态广播，
      // 保证记忆保存后立即注入到后续请求、UI 状态同步。
      // ⚠️ **不传 `context.tabId`** —— 见依赖声明处：这一条要通知所有人，
      // 而发起命令的标签恰恰最需要它。
      if (dependencies.notifyStateCommitted) {
        await dependencies.notifyStateCommitted();
      }
      return result;
    }),
    defineToolPayloadRuntimeCommandHandler('GET_TOOL_CALL_HISTORY', (payload) => (
      // 两个字段一起传、都保持可选 —— 省略 `serverId` 就是「全体最近 N 条」，
      // 内容脚本那条路（工具面板）走的就是这个形态，别在这里拆成两个分支。
      dependencies.getToolCallHistory({
        ...(payload?.limit === undefined ? {} : { limit: payload.limit }),
        ...(payload?.serverId === undefined ? {} : { serverId: payload.serverId }),
      })
    )),
    definePayloadlessRuntimeCommandHandler('CLEAR_TOOL_CALL_HISTORY', async (context) => {
      await dependencies.clearToolCallHistory();
      await dependencies.broadcastToolCallHistoryUpdate(context.tabId);
      return { ok: true as const };
    }),
    definePayloadlessRuntimeCommandHandler('GET_PLATFORM_CAPABILITIES', () => (
      dependencies.getPlatformEnvironment()
    )),
  ]);
}

export function createToolAuthorizationSubject(
  context: RuntimeMessageContext,
): ToolAuthorizationSubject {
  // Some browsers may omit MessageSender.documentId. Keep the receiver-owned
  // tab/frame identity stable across same-origin SPA route changes; a full
  // navigation destroys the content runtime and revokes its in-memory grant.
  const documentSessionId = context.documentId
    ? context.documentSessionId
    : `${context.surface}:${context.tabId ?? 'extension'}:${context.frameId ?? 'extension'}`;
  return {
    surface: context.surface,
    documentSessionId,
    tabId: context.tabId,
    frameId: context.frameId,
    chatSessionId: context.chatSessionId ?? null,
  };
}

/**
 * 后台自己发起的工具调用的身份对象。
 *
 * ⚠️⚠️ **`requestId` 只认 `call.source.requestId`，没有别的回落。**
 * 原先还有 `automationRunId` → `runId` 两档，那是上游给「自动化直连工具」那条路
 * 准备的；本项目自动化最终也是页面里的模型吐 XML、走 grant 档授权，
 * 那两档**在生产里一次都不会命中**（`ToolCall.source` 的构造点全仓只有两处：
 * 内容脚本的 `executeDetected` 带 `requestId`、授权层的 `canonicalizeCall` 从 grant 抄，
 * 而 `automationRunId` / `runId` / `taskId` 没有任何写入点）。
 * 留着它们会让「这条 id 到底从哪来」有两个看起来都可能成立的答案。
 *
 * ⚠️ **拿不到就现生成一个** —— 本地技能导入那条 trusted 调用就没有 `source.requestId`
 * （它的 source 只有 `{ trigger }`），而这个 id 唯一的用途是给 tool capability scope
 * 当 `scopeId`（`createRuntimeCapabilityScope` 的 `capabilityScopeId ?? requestId`），
 * 每次调用一个新 id 正是想要的语义。
 */
export function createTrustedToolExecutionContext(
  call: ToolCall,
  trigger: ToolExecutionTrigger,
  createRequestId: () => string = () => crypto.randomUUID(),
  capabilityScopeId?: string,
): TrustedToolExecutionContext {
  return {
    kind: 'trusted',
    trigger,
    requestId: call.source?.requestId ?? createRequestId(),
    capabilityScopeId,
    chatSessionId: call.source?.chatSessionId ?? null,
    taskId: call.source?.taskId,
    runId: call.source?.runId,
    automationId: call.source?.automationId,
    automationRunId: call.source?.automationRunId,
  };
}
