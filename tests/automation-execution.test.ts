import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOMATION_RETRY_DELAY_MS,
  cancelActiveAutomationRun,
  hasActiveAutomationRun,
  runAutomation,
  scanDueAutomations,
} from '../core/automation/scheduler';
import {
  createAutomation,
  deleteAutomation,
  getAutomationById,
  getAutomationRunById,
  setAutomationStatus,
  updateAutomation,
  updateAutomationRuntime,
} from '../core/automation/store';
import type {
  Automation,
  AutomationRunnerRequest,
  AutomationRunnerResult,
} from '../core/automation/types';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('automation execution authority', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T00:00:00Z'));
    vi.stubGlobal('chrome', createChromeStub().chromeStub);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('aborts at the deadline but retains the lease until the executor actually settles', async () => {
    const automation = await createTestAutomation();
    const started = deferred<void>();
    const finished = deferred<AutomationRunnerResult>();
    let observedSignal: AbortSignal | undefined;
    const executor = vi.fn(async (request, execution) => {
      observedSignal = execution.signal;
      started.resolve();
      return finished.promise;
    });

    const pendingRun = runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 100,
      executor,
    });
    await started.promise;

    await vi.advanceTimersByTimeAsync(100);
    expect(observedSignal?.aborted).toBe(true);
    expect(hasActiveAutomationRun(automation.id)).toBe(true);
    expect(await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 100,
      executor,
    })).toBeNull();

    finished.resolve(successResult(executor.mock.calls[0][0], Date.now()));
    const completed = await pendingRun;

    expect(completed?.status).toBe('timeout');
    expect(completed?.error?.code).toBe('automation_run_timeout');
    expect(hasActiveAutomationRun(automation.id)).toBe(false);
    expect(executor).toHaveBeenCalledTimes(1);
    expect((await getAutomationById(automation.id))?.zai.chatSessionId).toBeNull();
  });

  it('does not let a concurrent alarm reconcile a timed-out executor before it settles', async () => {
    const automation = await createTestAutomation();
    const started = deferred<void>();
    const finished = deferred<AutomationRunnerResult>();
    let runId = '';
    const executor = vi.fn(async (request) => {
      runId = request.runId;
      started.resolve();
      return finished.promise;
    });
    const pendingRun = runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 100,
      executor,
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(100);

    await scanDueAutomations(executor, Date.now());

    expect((await getAutomationRunById(runId))?.status).toBe('running');
    expect(hasActiveAutomationRun(automation.id)).toBe(true);
    finished.resolve(successResult(executor.mock.calls[0][0], Date.now()));
    expect((await pendingRun)?.status).toBe('timeout');
    expect((await getAutomationRunById(runId))?.status).toBe('timeout');
  });

  it('keeps the logical idempotency key stable across an explicitly safe retry', async () => {
    const automation = await createTestAutomation();
    const keys: string[] = [];
    const executor = vi.fn(async (request, execution): Promise<AutomationRunnerResult> => {
      keys.push(execution.createIdempotencyKey('prompt:initial'));
      if (execution.attempt === 1) {
        return failureResult(request, 'preflight_unavailable', true, {
          externalOutcome: 'not_started',
          retrySafe: true,
        });
      }
      return successResult(request, Date.now());
    });

    const pendingRun = runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor,
    });
    await vi.advanceTimersByTimeAsync(AUTOMATION_RETRY_DELAY_MS);
    const completed = await pendingRun;

    expect(completed?.status).toBe('succeeded');
    expect(completed?.attempt).toBe(2);
    expect(completed?.trigger).toBe('retry');
    expect(executor).toHaveBeenCalledTimes(2);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('does not replay an ambiguous external failure even when its provider marks it retryable', async () => {
    const automation = await createTestAutomation();
    const executor = vi.fn(async (request): Promise<AutomationRunnerResult> => failureResult(
      request,
      'completion_response_lost',
      true,
      { externalOutcome: 'ambiguous', retrySafe: false },
    ));

    const completed = await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor,
    });

    expect(completed?.status).toBe('failed');
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', undefined],
    ['confirmed', 'confirmed'],
    ['unknown', 'future-outcome'],
  ])('does not retry a retrySafe result with %s external outcome', async (_label, externalOutcome) => {
    const automation = await createTestAutomation();
    const details: Record<string, unknown> = { retrySafe: true };
    if (externalOutcome !== undefined) details.externalOutcome = externalOutcome;
    const executor = vi.fn(async (request): Promise<AutomationRunnerResult> => failureResult(
      request,
      'unsafe_retry_classification',
      true,
      details,
    ));

    const completed = await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor,
    });

    expect(completed?.status).toBe('failed');
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('uses one stable scheduled occurrence identity and never executes it twice', async () => {
    const automation = await createTestAutomation();
    const scheduledFor = Date.now();
    const executor = vi.fn(async (request): Promise<AutomationRunnerResult> =>
      successResult(request, Date.now()));

    const first = await runAutomation({
      automationId: automation.id,
      trigger: 'schedule',
      scheduledFor,
      executor,
    });
    const duplicate = await runAutomation({
      automationId: automation.id,
      trigger: 'schedule',
      scheduledFor,
      executor,
    });

    expect(first?.id).toBe(`schedule:${automation.id}:${scheduledFor}`);
    expect(duplicate?.id).toBe(first?.id);
    expect(executor).toHaveBeenCalledTimes(1);
    expect((await getAutomationRunById(first!.id))?.status).toBe('succeeded');
  });

  it('supports internal cancellation without releasing authority before settlement', async () => {
    const automation = await createTestAutomation();
    const started = deferred<void>();
    const finished = deferred<AutomationRunnerResult>();
    const executor = vi.fn(async (request, execution) => {
      started.resolve();
      await finished.promise;
      execution.assertActive();
      return successResult(request, Date.now());
    });

    const pendingRun = runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      executor,
    });
    await started.promise;
    expect(cancelActiveAutomationRun(automation.id)).toBe(true);
    expect(hasActiveAutomationRun(automation.id)).toBe(true);

    finished.resolve(successResult(executor.mock.calls[0][0], Date.now()));
    const completed = await pendingRun;

    expect(completed?.status).toBe('cancelled');
    expect(completed?.error?.code).toBe('automation_run_cancelled');
    expect(hasActiveAutomationRun(automation.id)).toBe(false);
  });

  it('keeps edit and pause changes scoped to future runs while the claimed request stays immutable', async () => {
    const automation = await createScheduledAutomation();
    const started = deferred<void>();
    const finished = deferred<void>();
    const claimedRequests: AutomationRunnerRequest[] = [];
    const executor = vi.fn(async (request): Promise<AutomationRunnerResult> => {
      claimedRequests.push(request);
      started.resolve();
      await finished.promise;
      return successResult(request, Date.now());
    });

    const pendingRun = runAutomation({
      automationId: automation.id,
      trigger: 'schedule',
      scheduledFor: Date.now(),
      executor,
    });
    await started.promise;
    await updateAutomation(automation.id, { prompt: 'Use this only next time.' });
    await setAutomationStatus(automation.id, 'paused');

    expect(hasActiveAutomationRun(automation.id)).toBe(true);
    expect(claimedRequests[0]?.prompt).toBe('Run once.');
    finished.resolve();
    await pendingRun;

    expect(await getAutomationById(automation.id)).toMatchObject({
      prompt: 'Use this only next time.',
      status: 'paused',
      nextRunAt: null,
    });
  });

  it('does not recreate deleted automation state when the cancelled executor settles late', async () => {
    const automation = await createTestAutomation();
    const started = deferred<void>();
    const finished = deferred<void>();
    const executor = vi.fn(async (request): Promise<AutomationRunnerResult> => {
      started.resolve();
      await finished.promise;
      return successResult(request, Date.now());
    });

    const pendingRun = runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      executor,
    });
    await started.promise;
    expect(cancelActiveAutomationRun(automation.id)).toBe(true);
    await deleteAutomation(automation.id);
    expect(hasActiveAutomationRun(automation.id)).toBe(true);

    finished.resolve();
    const completed = await pendingRun;

    expect(completed?.status).toBe('cancelled');
    expect(await getAutomationById(automation.id)).toBeNull();
    expect(await getAutomationRunById(completed!.id)).toBeNull();
    expect(hasActiveAutomationRun(automation.id)).toBe(false);
  });
});

async function createTestAutomation(): Promise<Automation> {
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
      model: null,
      fixedSession: false,
    },
  });
}

async function createScheduledAutomation(): Promise<Automation> {
  return createAutomation({
    name: 'Scheduled automation',
    prompt: 'Run once.',
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

function successResult(
  request: AutomationRunnerRequest,
  completedAt: number,
): AutomationRunnerResult {
  return {
    ok: true,
    chatSessionId: 'chat-1',
    sessionUrl: 'https://chat.z.ai/a/chat/s/chat-1',
    siteOrigin: 'https://chat.z.ai',
    assistantText: 'done',
    completedAt,
  };
}

function failureResult(
  request: AutomationRunnerRequest,
  code: string,
  retryable: boolean,
  details: Record<string, unknown>,
): AutomationRunnerResult {
  return {
    ok: false,
    chatSessionId: request.chatSessionId,
    // 测试造的是「执行器自己抛错 / 超时」这类没有协调器结论的失败 ⇒ 站点未知。
    siteOrigin: null,
    completedAt: Date.now(),
    error: {
      code,
      message: code,
      phase: 'runner',
      retryable,
      at: Date.now(),
      details,
    },
  };
}

/**
 * 站点提示与收尾写回。
 *
 * 两条不变量：
 * ① **只有复用已有会话**才把记录里的站点带进请求 —— 没开固定会话、或开了但还没
 *    建出会话，都是新对话，站点应由「用户当前所在的标签页」决定；
 *    沿用上一次的站会把任务永久钉在那一站。
 * ② **没有证据就不写站点** —— 收尾链的默认站兜底曾把「不知道」写成「国区站」，
 *    而那个值会被下一次运行当成结论。
 */
describe('automation site hint and write-back', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', createChromeStub().chromeStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not pass the remembered site for a non-fixed session', async () => {
    const automation = await createTestAutomation();
    await updateAutomationRuntime(automation.id, {
      zai: {
        chatSessionId: null,
        sessionUrl: null,
        siteOrigin: 'https://zchat.z.ai',
      },
    });

    const observed: AutomationRunnerRequest[] = [];
    await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      executor: async (request) => {
        observed.push(request);
        return successResult(request, Date.now());
      },
    });

    expect(observed[0]?.siteOrigin).toBeNull();
  });

  it('passes the remembered site for a fixed session', async () => {
    const automation = await createTestAutomation();
    await updateAutomation(automation.id, {
      promptOptions: { model: null, fixedSession: true },
    });
    await updateAutomationRuntime(automation.id, {
      zai: {
        chatSessionId: 'cn-session',
        sessionUrl: 'https://zchat.z.ai/c/cn-session',
        siteOrigin: 'https://zchat.z.ai',
      },
    });

    const observed: AutomationRunnerRequest[] = [];
    await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      executor: async (request) => {
        observed.push(request);
        return successResult(request, Date.now());
      },
    });

    expect(observed[0]?.siteOrigin).toBe('https://zchat.z.ai');
  });

  it('does not pass the remembered site when a fixed session has no session yet', async () => {
    // ⚠️ 这一格最容易漏：开了固定会话、但记录里还没有会话 id（首跑，或上次在
    // 「已挑中标签页、没建出会话」阶段失败）⇒ 本次走的是**新对话**。
    // 若仍把记录站点带下去，协调器会跳过「跟当前标签页」的判定，直接把新对话
    // 开在记录里那一站。
    const automation = await createTestAutomation();
    await updateAutomation(automation.id, {
      promptOptions: { model: null, fixedSession: true },
    });
    await updateAutomationRuntime(automation.id, {
      zai: {
        chatSessionId: null,
        sessionUrl: null,
        siteOrigin: 'https://zchat.z.ai',
      },
    });

    const observed: AutomationRunnerRequest[] = [];
    await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      executor: async (request) => {
        observed.push(request);
        return successResult(request, Date.now());
      },
    });

    expect(observed[0]?.siteOrigin).toBeNull();
  });

  it('does not pin a record to the default site when a failure reports no site', async () => {
    const automation = await createTestAutomation();

    await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      executor: async (request) => failureResult(request, 'dom_automation_failed', false, {}),
    });

    // 旧行为：回退链收口到默认站（国区站）⇒ 下一次运行被钉死在那一站。
    expect((await getAutomationById(automation.id))?.zai.siteOrigin).toBeNull();
  });

  it('does not build a session URL from the default site when no site evidence exists', async () => {
    // ⚠️ C 的核心新行为：失败时若拿到了会话 id、却没有任何站点证据，
    // **不能**拿默认站拼一条 url —— 那会造出「站点是 null、url 指向国区站」的记录，
    // 而下一次运行又把那条 url 当成站点证据（第三级）⇒ 绕一圈仍钉死在国区站。
    const automation = await createTestAutomation();

    await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      executor: async (request) => ({
        ...failureResult(request, 'dom_automation_failed', false, {}),
        chatSessionId: 'session-without-site',
      }),
    });

    const stored = await getAutomationById(automation.id);
    expect(stored?.zai.chatSessionId).toBe('session-without-site');
    expect(stored?.zai.siteOrigin).toBeNull();
    expect(stored?.zai.sessionUrl).toBeNull();
  });
});

/**
 * 模型覆写**不看模式**。
 *
 * ⚠️ 这条守的是一个被真机推翻的假设：代码里曾有「agent 模式的模型由服务端按
 * `general_agent` 装配、覆写无效」的门，三处（chatNew / 原生轮 / 续跑轮）都把
 * agent 轮跳过。真机实测 agent 的 completion body 带顶层 `model`，且同一会话
 * 不同轮次带不同 id ⇒ 模型字段是活的，门是多余的。
 *
 * 这里的断言只能覆盖「请求带上了模型」，**不能**覆盖「内容脚本真的写了 body」——
 * 那一步在 `zai.content.ts`（不可 import）。所以另有一条源码级守卫盯着三处调用点
 * 不带 `isAgentTurn` 门（见 `zai-content-model-override-contract.test.ts`）。
 */
describe('automation model is carried into the run request', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', createChromeStub().chromeStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes the selected model through regardless of mode', async () => {
    const automation = await createTestAutomation();
    await updateAutomation(automation.id, {
      promptOptions: { model: 'glm-5.3', fixedSession: false },
    });

    const observed: AutomationRunnerRequest[] = [];
    await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      executor: async (request) => {
        observed.push(request);
        return successResult(request, Date.now());
      },
    });

    expect(observed[0]?.promptOptions.model).toBe('glm-5.3');
  });
});
