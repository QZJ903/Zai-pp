import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAutomation } from '../core/automation/scheduler';
import { createAutomation, getAutomationById, updateAutomationRuntime } from '../core/automation/store';
import { createAutomationRunnerFailure } from '../core/automation/messages';
import type { AutomationRunnerRequest, AutomationRunnerResult } from '../core/automation/types';

function createChromeStub() {
  const storage = new Map<string, unknown>();
  return {
    storage,
    chromeStub: {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
          set: vi.fn(async (value: Record<string, unknown>) => {
            for (const [key, storedValue] of Object.entries(value)) storage.set(key, storedValue);
          }),
        },
      },
    },
  };
}

async function createTestAutomation() {
  return createAutomation({
    name: 'Automation',
    prompt: 'Run once.',
    schedule: {
      kind: 'manual',
      expression: null,
      timezone: 'UTC',
      enabled: false,
      minimumIntervalMinutes: 15,
    },
    promptOptions: {
      searchEnabled: false,
      fixedSession: false,
    },
  });
}

function failureWithSession(
  request: AutomationRunnerRequest,
  chatSessionId: string | null,
): AutomationRunnerResult {
  return createAutomationRunnerFailure(
    request,
    'dom_automation_cancelled',
    'cancelled',
    'runner',
    false,
    Date.now(),
    { externalOutcome: 'ambiguous', retrySafe: false },
    chatSessionId,
  );
}

describe('automation failure persists the live session', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', createChromeStub().chromeStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores chatSessionId and sessionUrl when a run fails after the session was created', async () => {
    const automation = await createTestAutomation();
    const executor = vi.fn(async (request: AutomationRunnerRequest) =>
      failureWithSession(request, 'session-created-then-paused'));

    const completed = await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor,
    });

    expect(completed?.status).toBe('cancelled');
    const stored = await getAutomationById(automation.id);
    expect(stored?.glm.chatSessionId).toBe('session-created-then-paused');
    // 会话 URL 必须一起写：侧边栏的「打开会话」按钮判的是 sessionUrl。
    expect(stored?.glm.sessionUrl).toBe('https://chat.z.ai/c/session-created-then-paused');
  });

  it('keeps the previous session when the failure carries no session id', async () => {
    const automation = await createTestAutomation();
    const executor = vi.fn(async (request: AutomationRunnerRequest) =>
      createAutomationRunnerFailure(
        request,
        'dom_automation_busy',
        'busy',
        'tab',
        false,
        Date.now(),
        { externalOutcome: 'ambiguous', retrySafe: false },
        null,
      ));

    const completed = await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor,
    });

    expect(completed?.status).toBe('failed');
    const stored = await getAutomationById(automation.id);
    expect(stored?.glm.chatSessionId).toBeNull();
    expect(stored?.glm.sessionUrl).toBeNull();
  });

  it('falls back to the request session id when no override is supplied', async () => {
    const automation = await createTestAutomation();
    const executor = vi.fn(async (request: AutomationRunnerRequest) =>
      createAutomationRunnerFailure(
        { ...request, chatSessionId: 'request-session' },
        'dom_automation_failed',
        'failed',
        'runner',
        false,
      ));

    const completed = await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor,
    });

    expect(completed?.status).toBe('failed');
    expect(completed?.result?.chatSessionId).toBe('request-session');
  });

  it('keeps the session persisted mid-run when the failure result carries none', async () => {
    const automation = await createTestAutomation();
    // 模拟运行期间 persistAutomationSession 已经把会话写进去了。
    await updateAutomationRuntime(automation.id, {
      glm: {
        chatSessionId: 'persisted-mid-run',
        parentMessageId: null,
        sessionUrl: 'https://chat.z.ai/c/persisted-mid-run',
        lastHistorySyncedAt: null,
      },
    });

    const executor = vi.fn(async (request: AutomationRunnerRequest) =>
      createAutomationRunnerFailure(
        request,
        'automation_run_timeout',
        'timed out',
        'runner',
        false,
        Date.now(),
        { timeoutMs: 30_000, externalOutcome: 'ambiguous', retrySafe: false },
        null,
      ));

    const completed = await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor,
    });

    expect(completed?.status).toBe('timeout');
    const stored = await getAutomationById(automation.id);
    expect(stored?.glm.chatSessionId).toBe('persisted-mid-run');
    expect(stored?.glm.sessionUrl).toBe('https://chat.z.ai/c/persisted-mid-run');
  });

  it('repairs a sessionUrl that does not match the stored session id', async () => {
    const automation = await createTestAutomation();
    // 早期版本留下的不一致记录：id 是新会话、url 指向上一次的会话。
    await updateAutomationRuntime(automation.id, {
      glm: {
        chatSessionId: 'new-session',
        parentMessageId: null,
        sessionUrl: 'https://chat.z.ai/c/old-session',
        lastHistorySyncedAt: null,
      },
    });

    const executor = vi.fn(async (request: AutomationRunnerRequest) =>
      createAutomationRunnerFailure(
        request,
        'dom_automation_busy',
        'busy',
        'tab',
        false,
        Date.now(),
        { externalOutcome: 'ambiguous', retrySafe: false },
        null,
      ));

    await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor,
    });

    const stored = await getAutomationById(automation.id);
    expect(stored?.glm.chatSessionId).toBe('new-session');
    // 必须重写成与 id 一致的 URL，否则「打开会话」会跳到 old-session。
    expect(stored?.glm.sessionUrl).toBe('https://chat.z.ai/c/new-session');
  });
});
