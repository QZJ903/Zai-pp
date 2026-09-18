import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
  type TypedRuntimeCommandType,
} from '../../core/messaging/runtime-command-registry';
import type {
  RuntimeMessageEnvelope,
} from '../../core/messaging/runtime-boundary';
import type {
  DomTaskCompleteEvent,
  DomTaskCoordinator,
  DomTaskFailedEvent,
  DomTaskNeedsActionEvent,
  DomTaskProgressEvent,
  DomTaskStartedEvent,
} from '../../core/zai/dom-task-coordinator';
import type { ToolExecutionRecord } from '../../core/types';

export interface DomTaskRuntimeHandlerDependencies {
  coordinator: DomTaskCoordinator;
}

/**
 * content → 后台 DOM_TASK_* 事件 handler（方案 §4.3）。
 *
 * content（zai.content.ts）用 chrome.runtime.sendMessage 发顶层字段（不带 payload），
 * 所以这里不走 defineGLMPayloadRuntimeCommandHandler 的 payload 解码，而是直接读
 * envelope 顶层字段。契约登记为 payload-cast（list-only 语义），响应统一 ack。
 */
export function createDomTaskRuntimeHandlers(
  dependencies: DomTaskRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  const readString = (message: RuntimeMessageEnvelope, key: string): string => {
    const value = message[key];
    return typeof value === 'string' ? value : '';
  };
  const readNullableString = (message: RuntimeMessageEnvelope, key: string): string | null => {
    const value = message[key];
    return typeof value === 'string' ? value : null;
  };
  const readExecutions = (message: RuntimeMessageEnvelope): ToolExecutionRecord[] => {
    const value = message.toolExecutions;
    return Array.isArray(value) ? (value as ToolExecutionRecord[]) : [];
  };

  const event = <TEvent>(
    type: TypedRuntimeCommandType,
    build: (message: RuntimeMessageEnvelope) => TEvent,
    apply: (coordinator: DomTaskCoordinator, payload: TEvent) => void,
  ): RuntimeCommandHandler<TypedRuntimeCommandType> => defineRuntimeCommandHandler({
    type,
    decode: (message) => message,
    handle: async (message) => {
      apply(dependencies.coordinator, build(message));
      return { ok: true as const };
    },
  });

  return Object.freeze([
    event<DomTaskStartedEvent>('DOM_TASK_STARTED', (message) => ({
      taskId: readString(message, 'taskId'),
      chatSessionId: readNullableString(message, 'chatSessionId'),
    }), (coordinator, payload) => coordinator.onStarted(payload)),
    event<DomTaskCompleteEvent>('DOM_TASK_COMPLETE', (message) => ({
      taskId: readString(message, 'taskId'),
      chatSessionId: readNullableString(message, 'chatSessionId'),
      assistantText: readString(message, 'assistantText'),
      toolExecutions: readExecutions(message),
      steps: typeof message.steps === 'number' ? message.steps : 0,
    }), (coordinator, payload) => coordinator.onComplete(payload)),
    event<DomTaskFailedEvent>('DOM_TASK_FAILED', (message) => ({
      taskId: readString(message, 'taskId'),
      error: readString(message, 'error'),
    }), (coordinator, payload) => coordinator.onFailed(payload)),
    event<DomTaskNeedsActionEvent>('DOM_TASK_NEEDS_ACTION', (message) => ({
      taskId: readString(message, 'taskId'),
      kind: message.kind === 'captcha' || message.kind === 'peak' ? message.kind : 'captcha',
    }), (coordinator, payload) => coordinator.onNeedsAction(payload)),
    event<DomTaskProgressEvent>('DOM_TASK_PROGRESS', (message) => ({
      taskId: readString(message, 'taskId'),
      text: readString(message, 'text'),
      phase: readString(message, 'phase'),
    }), (coordinator, payload) => coordinator.onProgress(payload)),
  ]);
}
