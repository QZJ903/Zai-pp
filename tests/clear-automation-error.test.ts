import { describe, expect, it, vi } from 'vitest';
import type { Automation } from '../core/automation/types';
import type { RuntimeMessageContext } from '../core/messaging/runtime-boundary';
import {
  createAutomationRuntimeHandlers,
  type AutomationRuntimeHandlerDependencies,
} from '../entrypoints/background/automation-runtime-handlers';
import { decodeBackgroundRuntimePayload } from '../core/messaging/background-runtime-request-codec';

/**
 * 「清除自动化失败记录」这条命令（卡片红条的关闭按钮）。
 *
 * ⚠️ 它存在的理由是**不能复用另外两条**，而这两条各自的坑都是静默的：
 *  - 用 `SET_AUTOMATION_STATUS`：会连带 `refreshAutomationNextRunAt`，
 *    而它对「排期无效」的任务会**立刻把 schedule 错误写回** ⇒ 用户按关闭、红条再现；
 *  - 用 `UPDATE_AUTOMATION`：它的 patch 白名单里没有 `lastError` ⇒ 直接抛
 *    `unsupported field`，用户看到「关闭失败」。
 *
 * 所以下面同时断言「清了 lastError」与「**没碰 nextRunAt**」——
 * 后者才是这条命令与另外两条的分界。
 */

const context: RuntimeMessageContext = {
  runtimeId: 'extension-id',
  surface: 'extension_context',
  senderUrl: 'chrome-extension://extension-id/sidepanel.html',
  senderOrigin: 'chrome-extension://extension-id',
  tabId: 17,
  documentSessionId: 'document-1',
};

const automation: Automation = {
  id: 'automation-1',
  name: 'Failing',
  prompt: 'Run.',
  status: 'active',
  schedule: {
    kind: 'manual',
    expression: null,
    timezone: 'UTC',
    enabled: false,
    minimumIntervalMinutes: 0,
  },
  promptOptions: { model: null, searchEnabled: false, fixedSession: false },
  glm: { chatSessionId: null, sessionUrl: null },
  createdAt: 1,
  updatedAt: 1,
  lastRunAt: null,
  nextRunAt: null,
  lastError: {
    code: 'dom_automation_composer_inject_failed',
    message: 'composer_inject_failed',
    phase: 'runner',
    retryable: false,
    at: 1,
  },
  version: 1,
};

function createDependencies(): AutomationRuntimeHandlerDependencies & {
  clearAutomationError: ReturnType<typeof vi.fn>;
} {
  return {
    getAllAutomations: vi.fn(async () => [automation]),
    getAutomationRuns: vi.fn(async () => []),
    createAutomation: vi.fn(async () => automation),
    updateAutomation: vi.fn(async () => automation),
    setAutomationStatus: vi.fn(async () => automation),
    clearAutomationError: vi.fn(async () => ({ ...automation, lastError: null })),
    deleteAutomation: vi.fn(async () => undefined),
    refreshAutomationNextRunAt: vi.fn(async () => automation),
    cancelActiveAutomationRun: vi.fn(),
    runAutomationNow: vi.fn(async () => ({ ok: false as const, error: 'not_used' })),
    broadcastAutomationUpdate: vi.fn(async () => undefined),
    broadcastAutomationRunsUpdate: vi.fn(async () => undefined),
  };
}

function dispatch(
  handlers: ReturnType<typeof createAutomationRuntimeHandlers>,
  message: { type: string; payload?: unknown },
) {
  const handler = handlers.find((candidate) => candidate.type === message.type);
  if (!handler) throw new Error(`Handler not found: ${message.type}`);
  return handler.handle(message, context);
}

describe('CLEAR_AUTOMATION_ERROR', () => {
  it('clears the failure record and broadcasts the change', async () => {
    const dependencies = createDependencies();
    const handlers = createAutomationRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, {
      type: 'CLEAR_AUTOMATION_ERROR',
      payload: { id: automation.id },
    })).resolves.toEqual({ ok: true });

    expect(dependencies.clearAutomationError).toHaveBeenCalledWith(automation.id);
    expect(dependencies.broadcastAutomationUpdate).toHaveBeenCalledWith(17);
  });

  it('does not go through refreshAutomationNextRunAt', async () => {
    // ⚠️ 这是与 `SET_AUTOMATION_STATUS` 的分界：那条会重算排期，
    // 而对排期无效的任务，重算会**立刻把 schedule 错误写回 lastError**。
    const dependencies = createDependencies();
    const handlers = createAutomationRuntimeHandlers(dependencies);

    await dispatch(handlers, { type: 'CLEAR_AUTOMATION_ERROR', payload: { id: automation.id } });

    expect(dependencies.refreshAutomationNextRunAt).not.toHaveBeenCalled();
    expect(dependencies.setAutomationStatus).not.toHaveBeenCalled();
    expect(dependencies.updateAutomation).not.toHaveBeenCalled();
  });

  it('rejects a payload that is not exactly an id', async () => {
    const handlers = createAutomationRuntimeHandlers(createDependencies());

    await expect(dispatch(handlers, { type: 'CLEAR_AUTOMATION_ERROR' }))
      .rejects.toThrow('CLEAR_AUTOMATION_ERROR.payload must be a plain object');
    await expect(dispatch(handlers, {
      type: 'CLEAR_AUTOMATION_ERROR',
      payload: { id: automation.id, extra: 1 },
    })).rejects.toThrow('unsupported field: extra');
  });

  it('decodes through the shared background payload decoder table', () => {
    // ⚠️ 命令若没登记进解码表，`assertOnlyKeys` 那条守卫就不会生效 ——
    // 于是「名字对不上」是静默的：请求照发、extra 字段被忽略。
    expect(decodeBackgroundRuntimePayload('CLEAR_AUTOMATION_ERROR', { id: automation.id }))
      .toEqual({ id: automation.id });
    expect(() => decodeBackgroundRuntimePayload('CLEAR_AUTOMATION_ERROR', { id: '' }))
      .toThrow();
  });
});