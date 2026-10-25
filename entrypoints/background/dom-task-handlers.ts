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
  DomTaskStartedEvent,
} from '../../core/zai/dom-task-coordinator';
import type { ToolExecutionRecord } from '../../core/types';

export interface DomTaskRuntimeHandlerDependencies {
  coordinator: DomTaskCoordinator;
}

/**
 * content → 后台 DOM_TASK_* 事件 handler。
 *
 * content（zai.content.ts）用 chrome.runtime.sendMessage 发顶层字段（不带 payload），
 * 所以这里不走 payload 解码那一层，而是直接读
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
      // 首轮中途被暂停时，两次 DOM_TASK_STARTED 都还没读到会话 id，只有失败回传
      // 这一刻带得回来 —— 缺了它，自动化会一直显示会话「未创建」。
      chatSessionId: readNullableString(message, 'chatSessionId'),
    }), (coordinator, payload) => coordinator.onFailed(payload)),
  ]);
}
