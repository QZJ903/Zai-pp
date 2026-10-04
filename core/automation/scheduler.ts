import {
  claimAutomationRun,
  finalizeAutomationRun,
  getAllAutomations,
  getAutomationById,
  getAutomationRunById,
  reconcileStaleRunsDetailed,
  updateAutomationRun,
  updateAutomationRuntime,
} from './store';
import { calculateNextRunAt } from './schedule';
import { buildZaiChatSessionUrl } from '../zai/chat-session';
import {
  AutomationExecutionStoppedError,
  createAutomationExecutionContext,
  readAutomationStopKind,
  throwIfAutomationAborted,
  type AutomationExecutionContext,
} from './execution';
import type {
  Automation,
  AutomationErrorState,
  AutomationId,
  AutomationRun,
  AutomationRunnerRequest,
  AutomationRunnerResult,
  AutomationRuntimeUpdate,
  AutomationTrigger,
} from './types';

export const AUTOMATION_WAKE_ALARM_NAME = 'glm_pp_automation_wake';
export const AUTOMATION_WAKE_INTERVAL_MINUTES = 1;
export const AUTOMATION_RUN_TIMEOUT_MS = 180_000;
export const AUTOMATION_MAX_ATTEMPTS = 2;
export const AUTOMATION_RETRY_DELAY_MS = 10_000;

export type AutomationRunExecutor = (
  request: AutomationRunnerRequest,
  execution: AutomationExecutionContext,
) => Promise<AutomationRunnerResult>;

export interface RunAutomationOptions {
  automationId: AutomationId;
  trigger: AutomationTrigger;
  scheduledFor: number | null;
  now?: number;
  timeoutMs?: number;
  executor: AutomationRunExecutor;
}

export interface ScanDueAutomationsResult {
  checkedAt: number;
  scanned: number;
  initialized: number;
  due: number;
  started: number;
  locked: number;
  failed: number;
  /** 被 reconcile 判定为「中断」并改判终态的悬挂 run 数量（不含本次新起的 run）。 */
  reconciled: number;
}

interface ActiveAutomationLease {
  runId: string;
  automationId: AutomationId;
  deadlineAt: number;
  controller: AbortController;
}

const activeRunLeases = new Map<AutomationId, ActiveAutomationLease>();

export async function scanDueAutomations(
  executor: AutomationRunExecutor,
  now: number = Date.now(),
): Promise<ScanDueAutomationsResult> {
  // Recover any `running` rows orphaned by a service-worker termination before
  // scanning, so the in-memory lock (which is lost on restart) doesn't allow a
  // duplicate run and so the orphaned row is finalized.
  const reconciled = await reconcileStaleRunsDetailed(AUTOMATION_RUN_TIMEOUT_MS, now, {
    protectedRunIds: new Set([...activeRunLeases.values()].map((lease) => lease.runId)),
    runtimePatch: (automation, run) => createInterruptedRuntimePatch(automation, run, now),
  });

  const automations = await getAllAutomations();
  const result: ScanDueAutomationsResult = {
    checkedAt: now,
    scanned: automations.length,
    initialized: 0,
    due: 0,
    started: 0,
    locked: 0,
    failed: 0,
    reconciled: reconciled.length,
  };

  for (const automation of automations) {
    if (!isSchedulableAutomation(automation)) continue;

    if (automation.nextRunAt == null) {
      await refreshAutomationNextRunAt(automation.id, now);
      result.initialized++;
      continue;
    }

    if (automation.nextRunAt > now) continue;

    result.due++;
    const run = await runAutomation({
      automationId: automation.id,
      trigger: 'schedule',
      scheduledFor: automation.nextRunAt,
      now,
      executor,
    });

    if (run == null) {
      result.locked++;
    } else if (run.status === 'failed' || run.status === 'timeout') {
      result.started++;
      result.failed++;
    } else {
      result.started++;
    }
  }

  return result;
}

export async function refreshAutomationNextRunAt(
  automationId: AutomationId,
  now: number = Date.now(),
): Promise<Automation | null> {
  const automation = await getAutomationById(automationId);
  if (!automation) return null;

  if (!isSchedulableAutomation(automation)) {
    return updateAutomationRuntime(automation.id, { nextRunAt: null });
  }

  const next = calculateNextRunAt(automation.schedule, now);
  if (!next.ok) {
    return updateAutomationRuntime(automation.id, {
      nextRunAt: null,
      lastError: toAutomationError(next.error.code, next.error.message, 'schedule', false, now),
    });
  }

  return updateAutomationRuntime(automation.id, {
    nextRunAt: next.value,
    lastError: null,
  });
}

export async function runAutomation(options: RunAutomationOptions): Promise<AutomationRun | null> {
  if (activeRunLeases.has(options.automationId)) return null;

  const now = options.now ?? Date.now();
  const runId = createAutomationRunId(options.automationId, options.trigger, options.scheduledFor);
  const timeoutMs = normalizeRunTimeout(options.timeoutMs);
  const lease: ActiveAutomationLease = {
    runId,
    automationId: options.automationId,
    deadlineAt: Date.now() + timeoutMs,
    controller: new AbortController(),
  };
  activeRunLeases.set(options.automationId, lease);
  const timeout = setTimeout(() => {
    lease.controller.abort(new AutomationExecutionStoppedError(
      'timeout',
      `Automation run ${runId} exceeded ${Math.round(timeoutMs / 1000)} seconds.`,
    ));
  }, timeoutMs);

  try {
    const claim = await claimAutomationRun({
      runId,
      automationId: options.automationId,
      trigger: options.trigger,
      scheduledFor: options.scheduledFor,
      startedAt: Date.now(),
      createRequest: (automation) => ({
        runId,
        automationId: automation.id,
        deadlineAt: lease.deadlineAt,
        prompt: automation.prompt,
        trigger: options.trigger,
        chatSessionId: automation.glm.chatSessionId,
        promptOptions: automation.promptOptions,
        requestedAt: now,
      }),
    });
    if (claim.kind === 'automation_missing' || claim.kind === 'active_run') return null;
    if (claim.kind === 'occurrence_exists') {
      if (isTerminalRun(claim.run)) {
        await refreshAutomationFromExistingRun(claim.automation, claim.run);
        return claim.run;
      }
      return null;
    }

    const { automation, run } = claim;
    const request = run.request!;
    const runnerResult = await executeWithRetry(run, request, options.executor, lease, timeoutMs);
    return completeRun(automation, run, runnerResult, options.trigger);
  } finally {
    clearTimeout(timeout);
    if (activeRunLeases.get(options.automationId) === lease) {
      activeRunLeases.delete(options.automationId);
    }
  }
}

export function hasActiveAutomationRun(automationId: AutomationId): boolean {
  return activeRunLeases.has(automationId);
}

export function cancelActiveAutomationRun(
  automationId: AutomationId,
  runId?: string,
): boolean {
  const lease = activeRunLeases.get(automationId);
  if (!lease || (runId !== undefined && lease.runId !== runId)) return false;
  lease.controller.abort(new AutomationExecutionStoppedError(
    'cancelled',
    `Automation run ${lease.runId} was cancelled.`,
  ));
  return true;
}

async function completeRun(
  automation: Automation,
  run: AutomationRun,
  result: AutomationRunnerResult,
  trigger: AutomationTrigger,
): Promise<AutomationRun | null> {
  // ⚠️ 超时**没有独立 phase**（它是 `runner` 阶段里的一种结果，靠 code 区分）；
  // 而「取消」有 —— 两个来源（后台 lease 被取消 / 内容脚本回传用户停止）都走
  // `phase: 'cancelled'`。**判定端只认 phase**，不再去比 `dom_automation_cancelled`
  // 这个拼出来的 code（那是「判定端抄生产端字面量」的老形态）。
  const status = result.ok
    ? 'succeeded'
    : result.error.code === 'automation_run_timeout'
      ? 'timeout'
      : result.error.phase === 'cancelled'
        ? 'cancelled'
        : 'failed';
  const finalized = await finalizeAutomationRun({
    runId: run.id,
    automationId: automation.id,
    status,
    result,
    runtimePatch: (latestAutomation) => createAutomationRuntimePatch(
      latestAutomation,
      result,
      trigger,
      run.scheduledFor,
    ),
  });
  if (finalized) return finalized;

  const persisted = await getAutomationRunById(run.id);
  if (persisted && isTerminalRun(persisted)) return persisted;
  return {
    ...run,
    status,
    result,
    error: result.ok ? null : result.error,
    completedAt: result.completedAt,
    updatedAt: result.completedAt,
  };
}

async function executeWithRetry(
  run: AutomationRun,
  request: AutomationRunnerRequest,
  executor: AutomationRunExecutor,
  lease: ActiveAutomationLease,
  timeoutMs: number,
): Promise<AutomationRunnerResult> {
  let lastResult: AutomationRunnerResult | null = null;

  for (let attempt = 1; attempt <= AUTOMATION_MAX_ATTEMPTS; attempt++) {
    if (lease.controller.signal.aborted) {
      return createStoppedRunFailure(request, lease.controller.signal, timeoutMs);
    }

    if (attempt > 1) {
      const updated = await updateAutomationRun(run.id, {
        attempt,
        trigger: 'retry',
      }, { expectedStatus: 'running' });
      if (!updated) {
        abortLeaseForLoss(lease);
        return createStoppedRunFailure(request, lease.controller.signal, timeoutMs);
      }
      try {
        await delayWithSignal(
          Math.min(AUTOMATION_RETRY_DELAY_MS, Math.max(0, lease.deadlineAt - Date.now())),
          lease.controller.signal,
        );
      } catch {
        return createStoppedRunFailure(request, lease.controller.signal, timeoutMs);
      }
    }

    if (lease.deadlineAt - Date.now() <= 0) {
      abortLeaseForTimeout(lease, timeoutMs);
      return createStoppedRunFailure(request, lease.controller.signal, timeoutMs);
    }

    const execution = createAutomationExecutionContext({
      runId: run.id,
      automationId: run.automationId,
      deadlineAt: lease.deadlineAt,
      attempt,
      signal: lease.controller.signal,
      isLeaseCurrent: () => activeRunLeases.get(lease.automationId) === lease,
    });
    let result: AutomationRunnerResult;
    try {
      execution.assertActive();
      result = await executor(request, execution);
      execution.assertActive();
    } catch (error) {
      if (error instanceof AutomationExecutionStoppedError || lease.controller.signal.aborted) {
        return createStoppedRunFailure(request, lease.controller.signal, timeoutMs, error);
      }
      const now = Date.now();
      result = {
        ok: false,
        chatSessionId: request.chatSessionId,
        completedAt: now,
        error: toAutomationError(
          'automation_executor_failed',
          error instanceof Error ? error.message : String(error),
          'runner',
          false,
          now,
          { externalOutcome: 'ambiguous', retrySafe: false },
        ),
      };
    }
    lastResult = result;

    if (result.ok || !isExplicitlySafeToRetry(result) || attempt === AUTOMATION_MAX_ATTEMPTS) {
      return result;
    }

    const updated = await updateAutomationRun(run.id, {
      attempt,
      error: result.error,
      result,
    }, { expectedStatus: 'running' });
    if (!updated) {
      abortLeaseForLoss(lease);
      return createStoppedRunFailure(request, lease.controller.signal, timeoutMs);
    }
  }

  return lastResult ?? createRunTimeoutFailure(request, timeoutMs);
}

function isExplicitlySafeToRetry(result: AutomationRunnerResult): boolean {
  return !result.ok &&
    result.error.retryable &&
    result.error.details?.retrySafe === true &&
    result.error.details?.externalOutcome === 'not_started';
}

function createRunTimeoutFailure(
  request: AutomationRunnerRequest,
  timeoutMs: number,
): AutomationRunnerResult {
  const now = Date.now();
  return {
    ok: false,
    chatSessionId: request.chatSessionId,
    completedAt: now,
    error: toAutomationError(
      'automation_run_timeout',
      `Automation run exceeded ${Math.round(timeoutMs / 1000)} seconds.`,
      'runner',
      false,
      now,
      { timeoutMs, externalOutcome: 'ambiguous', retrySafe: false },
    ),
  };
}

function createStoppedRunFailure(
  request: AutomationRunnerRequest,
  signal: AbortSignal,
  timeoutMs: number,
  error?: unknown,
): AutomationRunnerResult {
  const kind = error instanceof AutomationExecutionStoppedError
    ? error.kind
    : readAutomationStopKind(signal) ?? 'lease_lost';
  if (kind === 'timeout') return createRunTimeoutFailure(request, timeoutMs);

  const now = Date.now();
  const cancelled = kind === 'cancelled';
  return {
    ok: false,
    chatSessionId: request.chatSessionId,
    completedAt: now,
    error: toAutomationError(
      cancelled ? 'automation_run_cancelled' : 'automation_run_lease_lost',
      error instanceof Error
        ? error.message
        : cancelled
          ? 'Automation run was cancelled.'
          : 'Automation run lost its execution lease.',
      cancelled ? 'cancelled' : 'runner',
      false,
      now,
      { externalOutcome: 'ambiguous', retrySafe: false },
    ),
  };
}

function abortLeaseForTimeout(lease: ActiveAutomationLease, timeoutMs: number): void {
  lease.controller.abort(new AutomationExecutionStoppedError(
    'timeout',
    `Automation run ${lease.runId} exceeded ${Math.round(timeoutMs / 1000)} seconds.`,
  ));
}

function abortLeaseForLoss(lease: ActiveAutomationLease): void {
  lease.controller.abort(new AutomationExecutionStoppedError(
    'lease_lost',
    `Automation run ${lease.runId} lost its persisted execution lease.`,
  ));
}

function normalizeRunTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : AUTOMATION_RUN_TIMEOUT_MS;
}

function createAutomationRunId(
  automationId: AutomationId,
  trigger: AutomationTrigger,
  scheduledFor: number | null,
): string {
  return trigger === 'schedule' && scheduledFor !== null
    ? `schedule:${automationId}:${scheduledFor}`
    : crypto.randomUUID();
}

function isTerminalRun(run: AutomationRun): boolean {
  return run.status !== 'queued' && run.status !== 'running';
}

async function refreshAutomationFromExistingRun(
  automation: Automation,
  run: AutomationRun,
): Promise<void> {
  const completedAt = run.result?.completedAt ?? run.completedAt;
  if (
    completedAt !== null &&
    automation.lastRunAt !== null &&
    completedAt <= automation.lastRunAt
  ) {
    await updateAutomationRuntime(automation.id, {
      nextRunAt: createRecoveredNextRunAt(automation, run, automation.lastRunAt),
    });
    return;
  }
  if (run.result) {
    await updateAutomationRuntime(
      automation.id,
      createAutomationRuntimePatch(automation, run.result, run.trigger, run.scheduledFor),
    );
    return;
  }
  if (!run.error || run.completedAt === null) return;
  await updateAutomationRuntime(automation.id, {
    lastRunAt: run.completedAt,
    nextRunAt: isScheduledRun(run)
      ? nextRunAfterCompletion(automation, run.completedAt)
      : automation.nextRunAt,
    lastError: run.error,
  });
}

function createInterruptedRuntimePatch(
  automation: Automation,
  run: AutomationRun,
  fallbackAt: number,
): AutomationRuntimeUpdate {
  const completedAt = run.completedAt ?? fallbackAt;
  const nextRunAt = createRecoveredNextRunAt(
    automation,
    run,
    Math.max(completedAt, automation.lastRunAt ?? completedAt),
  );
  if (automation.lastRunAt !== null && completedAt <= automation.lastRunAt) {
    return { nextRunAt };
  }
  return {
    lastRunAt: completedAt,
    nextRunAt,
    lastError: run.error,
  };
}

function createRecoveredNextRunAt(
  automation: Automation,
  run: AutomationRun,
  referenceAt: number,
): number | null {
  if (!isScheduledRun(run)) return automation.nextRunAt;
  const candidate = nextRunAfterCompletion(automation, referenceAt);
  if (candidate === null) return null;
  if (
    automation.nextRunAt !== null &&
    automation.nextRunAt > (run.scheduledFor ?? Number.NEGATIVE_INFINITY)
  ) {
    return Math.max(automation.nextRunAt, candidate);
  }
  return candidate;
}

function createAutomationRuntimePatch(
  automation: Automation,
  result: AutomationRunnerResult,
  trigger: AutomationTrigger,
  scheduledFor: number | null = null,
): AutomationRuntimeUpdate {
  const completedAt = result.completedAt;
  const nextRunAt = trigger === 'schedule' || scheduledFor !== null
    ? nextRunAfterCompletion(automation, completedAt)
    : automation.nextRunAt;

  if (result.ok) {
    return {
      glm: {
        ...automation.glm,
        chatSessionId: result.chatSessionId,
        sessionUrl: result.sessionUrl,
      },
      lastRunAt: completedAt,
      nextRunAt,
      lastError: null,
    };
  }

  // 会话状态收尾：把「目前已知的最新会话」与它的 URL 一起落库。
  // - result 带了会话（成功收尾、或失败时内容脚本回传的真值）→ 以它为准；
  // - result 没带（超时 / 租约丢失 / 中途暂停走 request.chatSessionId 的路径）→
  //   退回记录里已有的会话，别把运行期间 persistAutomationSession 写进去的值抹掉；
  // - sessionUrl 与 id 不一致也要重写：早期版本可能留下「新 id + 旧 url」的记录，
  //   只判「url 缺不缺」会跳过修复，「打开会话」会一直跳到上一次的对话。
  const nextSessionId = result.chatSessionId ?? automation.glm.chatSessionId;
  const sessionPatch = nextSessionId && (
    nextSessionId !== automation.glm.chatSessionId ||
    automation.glm.sessionUrl !== buildZaiChatSessionUrl(nextSessionId)
  )
    ? {
        glm: {
          ...automation.glm,
          chatSessionId: nextSessionId,
          sessionUrl: buildZaiChatSessionUrl(nextSessionId),
        },
      }
    : {};

  return {
    // Persist a session created during a failed run so the retry reuses it
    // instead of leaking a fresh GLM session per attempt (M15).
    ...sessionPatch,
    lastRunAt: completedAt,
    nextRunAt,
    lastError: result.error,
  };
}

function isScheduledRun(run: AutomationRun): boolean {
  return run.trigger === 'schedule' || run.scheduledFor !== null;
}

function nextRunAfterCompletion(automation: Automation, completedAt: number): number | null {
  if (!isSchedulableAutomation(automation)) return null;
  const next = calculateNextRunAt(automation.schedule, completedAt);
  return next.ok ? next.value : null;
}

function isSchedulableAutomation(automation: Automation): boolean {
  return (
    automation.status === 'active' &&
    automation.schedule.enabled &&
    automation.schedule.kind !== 'manual'
  );
}

function toAutomationError(
  code: string,
  message: string,
  phase: AutomationErrorState['phase'],
  retryable: boolean,
  at: number,
  details?: Record<string, unknown>,
): AutomationErrorState {
  return {
    code,
    message,
    phase,
    retryable,
    at,
    details,
  };
}

function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAutomationAborted(signal);
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
