import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOMATION_RUN_TIMEOUT_MS,
  createAutomationRunnerRequest,
  scanDueAutomations,
} from '../core/automation/scheduler';
import {
  claimAutomationRun,
  createAutomation,
  finalizeAutomationRun,
  getAutomationById,
  getAutomationRunById,
  updateAutomationRuntime,
} from '../core/automation/store';
import type {
  Automation,
  AutomationRun,
  AutomationRunnerRequest,
  AutomationRunnerResult,
} from '../core/automation/types';

function createChromeStub() {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          for (const [key, storedValue] of Object.entries(value)) storage.set(key, storedValue);
        }),
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('automation durable lease and restart recovery', () => {
  it('atomically grants only one running claim across concurrent callers', async () => {
    vi.stubGlobal('chrome', createChromeStub());
    const automation = await createScheduledAutomation();
    const startedAt = 1_000_000;

    const claims = await Promise.all([
      claimAutomationRun(claimInput(automation, 'run-a', startedAt, null, 'manual')),
      claimAutomationRun(claimInput(automation, 'run-b', startedAt, null, 'manual')),
    ]);

    expect(claims.filter((claim) => claim.kind === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === 'active_run')).toHaveLength(1);
  });

  it('treats a fresh persisted running row as the lease after service-worker restart', async () => {
    vi.stubGlobal('chrome', createChromeStub());
    const now = Date.parse('2026-07-13T08:00:00Z');
    const automation = await createScheduledAutomation();
    await updateAutomationRuntime(automation.id, { nextRunAt: now });
    await seedPersistedRun(makePersistedRun({
      id: 'legacy-random-run-id',
      automationId: automation.id,
      scheduledFor: now,
      startedAt: now - 1_000,
    }));
    const executor = vi.fn();

    const result = await scanDueAutomations(executor, now);

    expect(result.locked).toBe(1);
    expect(result.started).toBe(0);
    expect(executor).not.toHaveBeenCalled();
    expect((await getAutomationRunById('legacy-random-run-id'))?.status).toBe('running');
  });

  it('closes a legacy scheduled retry lease and advances without replaying it', async () => {
    vi.stubGlobal('chrome', createChromeStub());
    const now = Date.parse('2026-07-13T08:00:00Z');
    const automation = await createScheduledAutomation();
    await updateAutomationRuntime(automation.id, { nextRunAt: now });
    await seedPersistedRun(makePersistedRun({
      id: 'legacy-stale-run-id',
      automationId: automation.id,
      trigger: 'retry',
      scheduledFor: now,
      startedAt: now - AUTOMATION_RUN_TIMEOUT_MS - 1,
    }));
    const executor = vi.fn();

    const result = await scanDueAutomations(executor, now);

    expect(result.started).toBe(0);
    expect(executor).not.toHaveBeenCalled();
    expect(await getAutomationRunById('legacy-stale-run-id')).toMatchObject({
      status: 'failed',
      result: {
        ok: false,
        error: {
          code: 'automation_run_interrupted',
          retryable: false,
        },
      },
      error: {
        code: 'automation_run_interrupted',
        retryable: false,
        details: { externalOutcome: 'ambiguous', retrySafe: false },
      },
    });
    expect((await getAutomationById(automation.id))?.nextRunAt).toBeGreaterThan(now);
  });

  it('recovers a historical queued orphan instead of blocking the automation forever', async () => {
    vi.stubGlobal('chrome', createChromeStub());
    const now = Date.parse('2026-07-13T08:00:00Z');
    const automation = await createScheduledAutomation();
    await updateAutomationRuntime(automation.id, { nextRunAt: now });
    await seedPersistedRun(makePersistedRun({
      id: 'legacy-queued-run-id',
      automationId: automation.id,
      status: 'queued',
      scheduledFor: now,
      createdAt: now - AUTOMATION_RUN_TIMEOUT_MS - 1,
      startedAt: null,
    }));
    const executor = vi.fn();

    const result = await scanDueAutomations(executor, now);

    expect(result.started).toBe(0);
    expect(executor).not.toHaveBeenCalled();
    expect(await getAutomationRunById('legacy-queued-run-id')).toMatchObject({
      status: 'failed',
      result: {
        ok: false,
        error: { code: 'automation_run_interrupted' },
      },
    });
    expect((await getAutomationById(automation.id))?.nextRunAt).toBeGreaterThan(now);
  });

  it('fences a late executor result after the durable run is already terminal', async () => {
    vi.stubGlobal('chrome', createChromeStub());
    const automation = await createScheduledAutomation();
    const claim = await claimAutomationRun(claimInput(automation, 'run-fenced', 4_000_000, null, 'manual'));
    expect(claim.kind).toBe('claimed');

    const timeoutResult = failureResult(claim.kind === 'claimed' ? claim.run.request! : null);
    const terminal = await finalizeAutomationRun({
      runId: 'run-fenced',
      automationId: automation.id,
      status: 'timeout',
      result: timeoutResult,
      runtimePatch: () => ({ lastRunAt: timeoutResult.completedAt, lastError: timeoutResult.error }),
    });
    const lateSuccess = successResult(4_000_200);
    const rejected = await finalizeAutomationRun({
      runId: 'run-fenced',
      automationId: automation.id,
      status: 'succeeded',
      result: lateSuccess,
      runtimePatch: () => ({
        glm: {
          chatSessionId: lateSuccess.chatSessionId,
          sessionUrl: lateSuccess.sessionUrl,
          siteOrigin: lateSuccess.siteOrigin,
        },
      }),
    });

    expect(terminal?.status).toBe('timeout');
    expect(rejected).toBeNull();
    expect((await getAutomationRunById('run-fenced'))?.status).toBe('timeout');
    expect((await getAutomationById(automation.id))?.glm.chatSessionId).toBeNull();
  });

  it('repairs a stale occurrence without rolling back newer manual runtime state', async () => {
    vi.stubGlobal('chrome', createChromeStub());
    const now = Date.parse('2026-07-13T08:00:00Z');
    const scheduledFor = now - 60_000;
    const oldCompletedAt = now - 50_000;
    const newerCompletedAt = now - 1_000;
    const automation = await createScheduledAutomation();
    await updateAutomationRuntime(automation.id, {
      nextRunAt: scheduledFor,
      lastRunAt: newerCompletedAt,
      lastError: null,
      glm: {
        chatSessionId: 'newer-chat',
        sessionUrl: 'https://chat.z.ai/a/chat/s/newer-chat',
        siteOrigin: null,
      },
    });
    const oldResult = successResult(oldCompletedAt);
    await seedPersistedRun(makePersistedRun({
      id: 'old-terminal-occurrence',
      automationId: automation.id,
      trigger: 'retry',
      status: 'succeeded',
      scheduledFor,
      result: oldResult,
      completedAt: oldCompletedAt,
    }));
    const executor = vi.fn();

    await scanDueAutomations(executor, now);

    expect(executor).not.toHaveBeenCalled();
    expect(await getAutomationById(automation.id)).toMatchObject({
      lastRunAt: newerCompletedAt,
      lastError: null,
      glm: {
        chatSessionId: 'newer-chat',
      },
    });
    expect((await getAutomationById(automation.id))?.nextRunAt).toBeGreaterThan(now);
  });

  it('recovers the site from the stored session URL when reconciling an interrupted run', async () => {
    // ⚠️ **这条守的是「运行期间落库、站点没写」的旧记录** —— 会话 URL 是唯一证据。
    // 场景：上一版（无 `siteOrigin` 字段）运行中途落库了 `sessionUrl`，随后 service worker
    // 被杀；reconcile 改判时必须**顺手把站点补上**，否则记录会一直停在「站点未知」，
    // 下一次运行退回 A 兜底 / 默认站 ⇒ 跑到另一站上去（会话 id 在两站不通用）。
    vi.stubGlobal('chrome', createChromeStub());
    const now = Date.parse('2026-07-13T08:00:00Z');
    const automation = await createScheduledAutomation();
    // 只写 url、`siteOrigin` 保持 null（模拟本字段之前落库的记录）。
    await updateAutomationRuntime(automation.id, {
      nextRunAt: now,
      glm: {
        chatSessionId: 'mid-run-session',
        sessionUrl: 'https://chat.z.ai/c/mid-run-session',
        siteOrigin: null,
      },
    });
    await seedPersistedRun(makePersistedRun({
      id: 'orphan-mid-run',
      automationId: automation.id,
      status: 'running',
      scheduledFor: now,
      createdAt: now - AUTOMATION_RUN_TIMEOUT_MS - 1,
      startedAt: null,
    }));

    await scanDueAutomations(vi.fn(), now);

    // 站点从 `sessionUrl` 的 origin 反推出来 —— 这是回退链的第三级。
    expect((await getAutomationById(automation.id))?.glm.siteOrigin)
      .toBe('https://chat.z.ai');
  });

  it('also writes the site on the early-return branch of the reconcile patch', async () => {
    // ⚠️ 那条早退分支（`lastRunAt` 比这次 reconcile 的完成时间还晚）**也必须写站点** ——
    // 只改主返回分支的话，「有更新的手动运行」这类记录会被永久跳过，站点永远修不回来。
    vi.stubGlobal('chrome', createChromeStub());
    const now = Date.parse('2026-07-13T08:00:00Z');
    const automation = await createScheduledAutomation();
    const newerCompletedAt = now - 1_000;
    await updateAutomationRuntime(automation.id, {
      nextRunAt: now,
      lastRunAt: newerCompletedAt,
      glm: {
        chatSessionId: 'mid-run-session',
        sessionUrl: 'https://zchat.z.ai/c/mid-run-session',
        siteOrigin: null,
      },
    });
    await seedPersistedRun(makePersistedRun({
      id: 'orphan-older',
      automationId: automation.id,
      status: 'running',
      scheduledFor: now - 60_000,
      createdAt: now - AUTOMATION_RUN_TIMEOUT_MS - 60_000,
      startedAt: null,
    }));

    await scanDueAutomations(vi.fn(), now);

    expect((await getAutomationById(automation.id))?.glm.siteOrigin)
      .toBe('https://zchat.z.ai');
  });

  it('leaves the site unknown when reconciling a run with no site evidence', async () => {
    // ⚠️ **旧行为会把默认站（国区站）写进记录** —— 而那个值不是「本次运行的结论」，
    // 只是回退链的收口。写进去之后这条任务每次都去国区站，哪怕用户一直在国际站跑它。
    vi.stubGlobal('chrome', createChromeStub());
    const now = Date.parse('2026-07-13T08:00:00Z');
    const automation = await createScheduledAutomation();
    await updateAutomationRuntime(automation.id, {
      nextRunAt: now,
      glm: { chatSessionId: null, sessionUrl: null, siteOrigin: null },
    });
    await seedPersistedRun(makePersistedRun({
      id: 'orphan-no-site',
      automationId: automation.id,
      status: 'running',
      scheduledFor: now,
      createdAt: now - AUTOMATION_RUN_TIMEOUT_MS - 1,
      startedAt: null,
    }));

    await scanDueAutomations(vi.fn(), now);

    expect((await getAutomationById(automation.id))?.glm.siteOrigin).toBeNull();
  });

  it('normalizes historical runner requests that predate persisted deadlines', async () => {
    vi.stubGlobal('chrome', createChromeStub());
    const requestedAt = 8_000_000;
    await chrome.storage.local.set({
      glm_pp_automations: {
        version: 1,
        automations: [],
        runs: [{
          ...makePersistedRun({ id: 'legacy-request' }),
          request: {
            runId: 'legacy-request',
            automationId: 'automation',
            prompt: 'Legacy request',
            trigger: 'manual',
            chatSessionId: null,
            parentMessageId: null,
            promptOptions: {
              model: null,
              fixedSession: false,
            },
            requestedAt,
          },
        }],
      },
    });

    expect((await getAutomationRunById('legacy-request'))?.request?.deadlineAt)
      .toBe(requestedAt + AUTOMATION_RUN_TIMEOUT_MS);
  });

  it('uses the persisted deadline when deciding whether a restarted lease is stale', async () => {
    vi.stubGlobal('chrome', createChromeStub());
    const now = 12_000_000;
    const automation = await createScheduledAutomation();
    await seedPersistedRun(makePersistedRun({
      id: 'custom-deadline',
      automationId: automation.id,
      startedAt: now - AUTOMATION_RUN_TIMEOUT_MS,
      request: {
        ...claimInput(automation, 'custom-deadline', now - 1_000, null, 'manual')
          .createRequest(automation),
        deadlineAt: now + 1_000,
      },
    }));

    const result = await scanDueAutomations(vi.fn(), now);

    expect(result.started).toBe(0);
    expect((await getAutomationRunById('custom-deadline'))?.status).toBe('running');
  });
});

async function createScheduledAutomation(): Promise<Automation> {
  return createAutomation({
    name: 'Scheduled',
    prompt: 'Run safely.',
    schedule: {
      kind: 'rrule',
      expression: 'FREQ=MINUTELY;INTERVAL=15',
      timezone: 'UTC',
      enabled: true,
      minimumIntervalMinutes: 15,
    },
    promptOptions: {
      model: null,
      fixedSession: false,
    },
  });
}

function claimInput(
  automation: Automation,
  runId: string,
  startedAt: number,
  scheduledFor: number | null,
  trigger: 'manual' | 'schedule',
) {
  return {
    runId,
    automationId: automation.id,
    trigger,
    scheduledFor,
    startedAt,
    // ⚠️ **直接调生产那个构造函数**，不要在这里手抄一份 —— 手抄的那份在生产
    // 改判据时不会红（判据就变成两份了）。
    createRequest: (current: Automation) => createAutomationRunnerRequest(current, {
      runId,
      trigger,
      deadlineAt: startedAt + AUTOMATION_RUN_TIMEOUT_MS,
      requestedAt: startedAt,
    }),
  };
}

function makePersistedRun(overrides: Partial<AutomationRun>): AutomationRun {
  return {
    id: 'run',
    automationId: 'automation',
    trigger: 'schedule',
    status: 'running',
    scheduledFor: null,
    attempt: 1,
    request: null,
    result: null,
    error: null,
    createdAt: 1,
    startedAt: 1,
    completedAt: null,
    updatedAt: 1,
    ...overrides,
  };
}

async function seedPersistedRun(run: AutomationRun): Promise<void> {
  const key = 'glm_pp_automations';
  const data = await chrome.storage.local.get(key) as Record<string, unknown>;
  const current = data[key] as { version: 1; automations: Automation[]; runs: AutomationRun[] } | undefined;
  await chrome.storage.local.set({
    [key]: {
      version: 1,
      automations: current?.automations ?? [],
      runs: [run, ...(current?.runs ?? []).filter((stored) => stored.id !== run.id)],
    },
  });
}

function successResult(completedAt: number): Extract<AutomationRunnerResult, { ok: true }> {
  return {
    ok: true,
    chatSessionId: 'late-chat',
    sessionUrl: 'https://chat.z.ai/a/chat/s/late-chat',
    siteOrigin: 'https://chat.z.ai',
    assistantText: 'late',
    completedAt,
  };
}

function failureResult(
  request: AutomationRunnerRequest | null,
): Extract<AutomationRunnerResult, { ok: false }> {
  return {
    ok: false,
    chatSessionId: request?.chatSessionId ?? null,
    // 超时 / 租约丢失这类失败拿不到协调器的结论 ⇒ 站点未知。
    siteOrigin: null,
    completedAt: 4_000_100,
    error: {
      code: 'automation_run_timeout',
      message: 'timeout',
      phase: 'runner',
      retryable: false,
      at: 4_000_100,
      details: { externalOutcome: 'ambiguous', retrySafe: false },
    },
  };
}
