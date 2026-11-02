import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOMATION_RETRY_DELAY_MS,
  cancelActiveAutomationRun,
  hasActiveAutomationRun,
  runAutomation,
  scanDueAutomations,
} from '../core/automation/scheduler';
import {
  claimAutomationRun,
  createAutomation,
  deleteAutomation,
  finalizeAutomationRun,
  getAutomationById,
  getAutomationRunById,
  getAutomationRuns,
  setAutomationStatus,
  updateAutomation,
  updateAutomationRuntime,
} from '../core/automation/store';
import { AUTOMATION_STORAGE_KEY } from '../core/automation/storage-codec';
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

  it('retries an explicitly safe failure once and marks the run as a retry', async () => {
    const automation = await createTestAutomation();
    const executor = vi.fn(async (request, execution): Promise<AutomationRunnerResult> => {
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
  });

  /**
   * **重试过的计划运行仍然要重算 `nextRunAt`。**
   *
   * `executeWithRetry` 在 `attempt > 1` 时把 **run 的** `trigger` 改写成 `'retry'`
   * （那是记录上的语义，UI 靠它显示「重试」）。而 `completeRun` 传给
   * `createAutomationRuntimePatch` 的是 **`options.trigger`**（仍是 `'schedule'`）
   * ⇒ 判据必须**同时看 `trigger` 与 `scheduledFor`**：只看 `trigger` 会把重试误判成
   * 手动运行、**不再重算**，那条任务从此不再排期（静默）。
   *
   * ⚠️ 参照点是 **`completedAt`** 而不是 `scheduledFor`（口径已定）：
   * 重试最多把完成时刻往后拖约 3 分钟（`AUTOMATION_RETRY_DELAY_MS` + 剩余执行时间，
   * 两次尝试共享同一个 `deadlineAt`），而最小间隔 15 分钟 ⇒ 不会连跑。
   */
  it('recomputes nextRunAt for a scheduled run that had to retry', async () => {
    const automation = await createScheduledAutomation();
    const scheduledFor = Date.now() + 1_000;
    await updateAutomationRuntime(automation.id, { nextRunAt: scheduledFor });

    const executor = vi.fn(async (request, execution): Promise<AutomationRunnerResult> => {
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
      trigger: 'schedule',
      scheduledFor,
      timeoutMs: 30_000,
      executor,
    });
    await vi.advanceTimersByTimeAsync(AUTOMATION_RETRY_DELAY_MS);
    const completed = await pendingRun;

    expect(completed?.status).toBe('succeeded');
    expect(completed?.trigger, 'run 记录上标成 retry').toBe('retry');
    // ⚠️ 这条才是判据：**重试不等于手动**，`nextRunAt` 必须被重算到未来。
    const stored = await getAutomationById(automation.id);
    expect(stored?.nextRunAt, '重试过的计划运行也要重算下一次').not.toBeNull();
    expect(stored!.nextRunAt!).toBeGreaterThan(completed!.completedAt!);
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

/**
 * **`getAutomationRuns` 的排序是契约，不是实现细节。**
 *
 * 侧边栏的「最近」那一格是 `runs[0]`（`AutomationPage` 的 `const latestRun = runs[0]`）
 * —— 它**不做二次排序**，直接取第一条。所以「按 `createdAt` 降序」一旦改掉，
 * UI 会**静默**把最旧那条显示成「最近一次运行」，而没有任何测试会红。
 *
 * ⚠️ 这条守卫钉在 **store** 上（契约所在层），不是给 UI 加排序 ——
 * 给消费方加排序只会让契约漂移得更隐蔽。
 */
describe('getAutomationRuns ordering is part of the contract', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', createChromeStub().chromeStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns newest first and honours the limit from the newest end', async () => {
    const automation = await createTestAutomation();
    // 三次运行，`createdAt` 严格递增 ⇒ 期望顺序是 c, b, a。
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      await claimAutomationRun({
        runId: id,
        automationId: automation.id,
        trigger: 'manual',
        scheduledFor: null,
        startedAt: 1_000 + index,
        createRequest: (record) => ({
          runId: id,
          automationId: record.id,
          deadlineAt: 99_999,
          prompt: record.prompt,
          trigger: 'manual',
          chatSessionId: null,
          siteOrigin: null,
          promptOptions: record.promptOptions,
          requestedAt: 1_000 + index,
        }),
      });
      await finalizeAutomationRun({
        runId: id,
        automationId: automation.id,
        status: 'succeeded',
        result: {
          ok: true,
          chatSessionId: 'chat-1',
          sessionUrl: null,
          siteOrigin: 'https://chat.z.ai',
          assistantText: id,
          completedAt: 1_000 + index,
        },
        runtimePatch: () => ({}),
      });
    }

    const all = await getAutomationRuns({ automationId: automation.id, limit: 10 });
    expect(all.map((run) => run.id), '必须按 createdAt 降序 —— UI 的「最近」直接取 runs[0]')
      .toEqual(['c', 'b', 'a']);

    // ⚠️ 截断也要从**最新那一头**截：limit 是「最近 N 条」，不是「最早 N 条」。
    const limited = await getAutomationRuns({ automationId: automation.id, limit: 2 });
    expect(limited.map((run) => run.id)).toEqual(['c', 'b']);
  });
});

/**
 * **一次存储写失败不能拖垮整轮扫描。**
 *
 * 扫描每分钟一次、按任务顺序逐个跑。原来 `for` 循环是裸的 —— `refreshAutomationNextRunAt`
 * 或 `runAutomation` 里任何一次抛错（配额满 / 扩展上下文失效）都会**中断整轮**，
 * 而下一分钟会在同一个任务上再撞一次 ⇒ 排在其后的自动化**永久不再运行**，
 * 只有一条 `console.error`。
 *
 * ⚠️ 这一档记进 `errored`，**不并进 `failed`** —— `failed` 的语义是「真的跑了一次、
 * 结果是失败」，而这里连 run 都没建出来。混在一起会让界面在「什么都没跑」时也刷运行记录。
 */
describe('a storage failure skips one automation instead of aborting the scan', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', createChromeStub().chromeStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps scanning the remaining automations after one write throws', async () => {
    const first = await createScheduledAutomation();
    const second = await createScheduledAutomation();
    const past = Date.now() - 60_000;
    await updateAutomationRuntime(first.id, { nextRunAt: past });
    await updateAutomationRuntime(second.id, { nextRunAt: past });

    const chromeStub = (globalThis as { chrome: { storage: { local: {
      set: (value: Record<string, unknown>) => Promise<void>;
    } } } }).chrome;
    const realSet = chromeStub.storage.local.set;
    // 让**第一次**写就抛配额错。`failFor` 决定抛几次：这里只抛第一次，
    // 后续恢复 —— 若隔离没生效，第二个任务会因为整轮已中断而**根本不跑**。
    let thrown = false;
    chromeStub.storage.local.set = async (value: Record<string, unknown>) => {
      if (!thrown) {
        thrown = true;
        throw new Error('QUOTA_BYTES quota exceeded');
      }
      return realSet(value);
    };

    const executed: string[] = [];
    const result = await scanDueAutomations(async (request) => {
      executed.push(request.automationId);
      return successResult(request, Date.now());
    }, Date.now());

    expect(result.errored, '第一个任务写失败要记进 errored').toBe(1);
    expect(result.started, '其余任务照常起跑').toBeGreaterThanOrEqual(1);
    // ⚠️ 只断言「不抛 + 计数」不够 —— 要断言**后面那条真的执行了**。
    expect(executed.length, '排在失败任务之后的那条必须仍然执行').toBeGreaterThanOrEqual(1);
  });

  it('reports zero errored when every write succeeds', async () => {
    const automation = await createScheduledAutomation();
    await updateAutomationRuntime(automation.id, { nextRunAt: Date.now() - 60_000 });

    const result = await scanDueAutomations(
      async (request) => successResult(request, Date.now()),
      Date.now(),
    );

    expect(result.errored).toBe(0);
    expect(result.started).toBe(1);
  });

  /**
   * **`reconcileStaleRunsDetailed` 那一步也会写盘，也要兜住。**
   *
   * 它在有悬挂 `running` run 时会走 `mutateState` → `chrome.storage.local.set`。
   * 这一步在 `for` 循环**外面** ⇒ 没有兜错的话，配额满时从**第一行**就中断整轮，
   * 与循环里那条是同一个失效形态，而且两条路径正相关（存储越满越先在这里炸）。
   *
   * ⚠️ **失败不能早退** —— reconcile 只负责「顺手清理」，清不掉不代表没东西可扫；
   * 早退会让所有本来到期的任务这一分钟一个都不跑。
   */
  it('still scans when the pre-scan reconciliation cannot write', async () => {
    const automation = await createScheduledAutomation();
    const past = Date.now() - 60_000;
    await updateAutomationRuntime(automation.id, { nextRunAt: past });

    // 造一条**悬挂的 running run**（startedAt 远早于阈值），让 reconcile 有东西可写。
    await claimAutomationRun({
      runId: 'stale-run',
      automationId: automation.id,
      trigger: 'schedule',
      scheduledFor: past - 1_000,
      startedAt: 1_000,
      createRequest: (record) => ({
        runId: 'stale-run',
        automationId: record.id,
        deadlineAt: 1_000 + 180_000,
        prompt: record.prompt,
        trigger: 'schedule',
        chatSessionId: null,
        siteOrigin: null,
        promptOptions: record.promptOptions,
        requestedAt: 1_000,
      }),
    });

    // 之后所有写都失败（模拟配额满）。
    const chromeStub = (globalThis as { chrome: { storage: { local: {
      set: (value: Record<string, unknown>) => Promise<void>;
    } } } }).chrome;
    chromeStub.storage.local.set = async () => {
      throw new Error('QUOTA_BYTES quota exceeded');
    };

    // ⚠️ **不抛** —— 这是本条的判据（改造前它从第一行就抛）。
    const result = await scanDueAutomations(
      async (request) => successResult(request, Date.now()),
      Date.now(),
    );

    expect(result.errored, 'reconcile 失败也要记进 errored').toBeGreaterThanOrEqual(1);
  });
});

/**
 * **裁剪不该顺手重排持久化的 `runs`。**
 *
 * `trimRunsToFit` 内部要按 `createdAt` 降序排一遍才能「从最旧那头丢」，但那只是为了
 * 挑丢弃对象 —— **没超预算时不该把这个顺序写回去**。否则每次 `claimAutomationRun`
 * 都会把 `state.runs` 按 `createdAt` 重排一遍，而那原本是「新的在前」的插入序。
 * 当前无消费者依赖这个顺序（`getAutomationRuns` 自己排、reconcile/claim 都是
 * `map`/`find`），所以它是一条**隐性行为变更**：不守就会在将来某处突然显形。
 */
describe('run history trimming leaves the persisted order alone', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', createChromeStub().chromeStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the newest-first insertion order when the budget is not exceeded', async () => {
    const first = await createTestAutomation();
    const second = await createTestAutomation();
    // 两次 claim 的插入序是「后 claim 的在前」⇒ [r-second, r-first]；
    // 而按 `createdAt` 降序会是 [r-first, r-second]（startedAt 3000 > 1000）。
    for (const [runId, automationId, startedAt] of [
      ['r-first', first.id, 3_000],
      ['r-second', second.id, 1_000],
    ] as const) {
      await claimAutomationRun({
        runId,
        automationId,
        trigger: 'manual',
        scheduledFor: null,
        startedAt,
        createRequest: (record) => ({
          runId,
          automationId: record.id,
          deadlineAt: 99_999,
          prompt: record.prompt,
          trigger: 'manual',
          chatSessionId: null,
          siteOrigin: null,
          promptOptions: record.promptOptions,
          requestedAt: startedAt,
        }),
      });
    }

    const data = await chrome.storage.local.get(AUTOMATION_STORAGE_KEY) as Record<string, unknown>;
    const stored = data[AUTOMATION_STORAGE_KEY] as { runs: { id: string }[] };
    expect(stored.runs.map((run) => run.id), '未超预算 ⇒ 保持插入序')
      .toEqual(['r-second', 'r-first']);
  });
});
