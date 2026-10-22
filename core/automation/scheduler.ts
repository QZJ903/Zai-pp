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
import { resolveZaiSiteOrigin } from '../zai/contracts';
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

export const AUTOMATION_WAKE_ALARM_NAME = 'zai_pp_automation_wake';
export const AUTOMATION_WAKE_INTERVAL_MINUTES = 1;
export const AUTOMATION_RUN_TIMEOUT_MS = 180_000;
export const AUTOMATION_MAX_ATTEMPTS = 2;
export const AUTOMATION_RETRY_DELAY_MS = 10_000;

export type AutomationRunExecutor = (
  request: AutomationRunnerRequest,
  execution: AutomationExecutionContext,
) => Promise<AutomationRunnerResult>;

/**
 * 一次运行**可以沿用的会话 id** —— 只有「开了固定会话」且「记录里真的已经有会话」
 * 时才成立。
 *
 * ⚠️ 两个条件缺一不可，**它是本文件里唯一的判定入口**：站点提示由它派生
 * （见 `createAutomationRunnerRequest`）。分成两处各判一次会出现
 * 「会话按新对话发、站点却按旧会话选」的组合 —— 表现是任务被送到记录里那一站
 * 去开一个全新对话，与用户当前所在的站无关。
 */
export function resolveAutomationReusableSessionId(
  automation: Pick<Automation, 'promptOptions' | 'zai'>,
): string | null {
  if (automation.promptOptions.fixedSession !== true) return null;
  return automation.zai.chatSessionId;
}

export interface AutomationRunnerRequestContext {
  runId: string;
  trigger: AutomationTrigger;
  deadlineAt: number;
  requestedAt: number;
}

/**
 * 由记录构造一次运行的请求。
 *
 * ⚠️ **生产与测试共用它** —— 测试里手抄一份请求构造，生产改判据时那边不会红。
 * 两处都调这个函数，判定就只有一个出处。
 */
export function createAutomationRunnerRequest(
  automation: Automation,
  context: AutomationRunnerRequestContext,
): AutomationRunnerRequest {
  const reusableSessionId = resolveAutomationReusableSessionId(automation);
  return {
    runId: context.runId,
    automationId: automation.id,
    deadlineAt: context.deadlineAt,
    prompt: automation.prompt,
    trigger: context.trigger,
    chatSessionId: automation.zai.chatSessionId,
    // 站点提示只在**复用已有会话**时成立：那条会话属于哪一站是确定的，会话 id
    // 在两站之间也不通用，所以必须去记录里那一站找它。
    // 其余情况（没开固定会话、或开了但还没建出会话）都是新对话、没有会话归属
    // ⇒ 站点交给协调器按「用户当前所在的标签页」判定（`resolveDomTab`），
    // 不能沿用记录里上一次跑过的站，否则任务会被上一次运行永久钉在那一站。
    siteOrigin: reusableSessionId !== null ? automation.zai.siteOrigin : null,
    promptOptions: automation.promptOptions,
    requestedAt: context.requestedAt,
  };
}

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
      createRequest: (automation) => createAutomationRunnerRequest(automation, {
        runId,
        trigger: options.trigger,
        deadlineAt: lease.deadlineAt,
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
        // 执行器自己抛错时，协调器还没来得及回传站点 ⇒ 「不知道」，守记录里的旧值。
        siteOrigin: null,
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
    // 超时那一刻协调器已经挑好标签页了，但它的结果还没回来（超时就是因为它没回）
    // ⇒ 只能按「不知道」处理，守记录里的旧站点。
    siteOrigin: null,
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
    // 取消 / 租约丢失都发生在「协调器还没回传结果」的时刻 ⇒ 站点「不知道」。
    siteOrigin: null,
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

/**
 * 「这条运行落在哪个站」的**唯一**回退链 —— `createAutomationRuntimePatch` 与
 * `createInterruptedRuntimePatch` 共用它，两条收尾路径必须给出一致的结论。
 *
 * 三条证据的可靠度从高到低：
 *   ① `reportedSiteOrigin` —— **本次运行实际落在哪**（协调器挑标签页时定下的）。
 *      只有正常收尾（`result.siteOrigin`）才拿得到；reconcile 路径恒为 null。
 *   ② `automation.zai.siteOrigin` —— 上次运行记下的。
 *   ③ `automation.zai.sessionUrl` 的 origin —— 本字段之前落库的旧记录只有 url，
 *      而**那条 url 本身就是站点证据**（少了这一步，旧记录会被当成「默认站」，
 *      于是下一次运行把会话链接指向另一站）。
 *
 * ⚠️⚠️ **没有证据时返回 `null`，不再收口到默认站**。收口的后果不是「保守」而是
 * **把记录钉死**：一次在「还没挑中标签页」阶段就失败的运行（`'tab'` 阶段）、
 * 或 service worker 中途死掉走的 reconcile，都拿不到 ①；若这里补一个默认站，
 * 它会被当成「本次运行的结论」写回记录，从此这条任务每次都去默认站，
 * 哪怕用户一直在另一站上跑它。
 * ⚠️ **两条收尾路径共用它是必需的**：service worker 在运行中途死掉时走 reconcile，
 * 而它拿不到 ① —— 若那条路径不写站点，「运行期间落库的错站值」会一直留到下一次
 * 运行成功收尾才被纠正（用户看到的是侧边栏「打开会话」长期指向另一站）。
 * 「有证据就写」与「没证据不猜」是同一件事的两面。
 */
function resolveAutomationSiteOrigin(
  automation: Automation,
  reportedSiteOrigin: string | null | undefined,
): string | null {
  return resolveZaiSiteOrigin(reportedSiteOrigin)
    ?? resolveZaiSiteOrigin(automation.zai.siteOrigin)
    ?? resolveZaiSiteOrigin(automation.zai.sessionUrl)
    ?? null;
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
  // 站点收尾：reconcile 拿不到本次运行的结论（进程都死了），所以走回退链的
  // ② / ③ —— **有证据就写**，否则 record 里可能留着「运行期间落库的错站值」，
  // 而下次运行要靠它决定去哪一站（见 `resolveAutomationSiteOrigin` 的说明）。
  // ⚠️ **没有证据（null）就不写**：不能拿默认站冒充结论，那会把记录钉死。
  const siteOrigin = resolveAutomationSiteOrigin(automation, null);
  const sitePatch = siteOrigin !== null && automation.zai.siteOrigin !== siteOrigin
    ? { zai: { ...automation.zai, siteOrigin } }
    : {};
  if (automation.lastRunAt !== null && completedAt <= automation.lastRunAt) {
    return {
      // 早退分支也要带上站点 —— 否则「上一次运行更晚」的情况下站点永远修不回来。
      ...sitePatch,
      nextRunAt,
    };
  }
  return {
    ...sitePatch,
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

  // 站点收尾：本次运行报了什么就用什么（那是**标签页实际所在**的站），没报就按
  // 「记录里已有的证据」倒推。
  // ⚠️⚠️ **没有证据时保持 `null`，不收口默认站** —— 默认站不是结论，写回去会把
  // 这条任务永久钉在那一站（成因见 `resolveAutomationSiteOrigin` 的说明）。
  // ⚠️ **写回的值必须与 `sessionUrl` 同源** —— 下面拼 URL 用的是同一个站，
  // 否则会出现「url 指向 A 站、记录的站点写着 B 站」的自相矛盾记录。
  const siteOrigin = resolveAutomationSiteOrigin(automation, result.siteOrigin);
  // 写回记录用「有证据的站点，否则保留旧值」。
  const nextSiteOrigin = siteOrigin ?? automation.zai.siteOrigin;

  if (result.ok) {
    return {
      zai: {
        ...automation.zai,
        chatSessionId: result.chatSessionId,
        sessionUrl: result.sessionUrl,
        // 成功收尾时协调器一定给得出站点；万一没有，保留旧值，不拿 null 覆盖已知站点。
        siteOrigin: nextSiteOrigin,
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
  //   只判「url 缺不缺」会跳过修复，「打开会话」会一直跳到上一次的对话；
  // - **站点也要一起写**：即使这次没拿到会话 id，本次跑在哪个站仍是已知事实，
  //   下一次运行要靠它决定去哪一站。
  const nextSessionId = result.chatSessionId ?? automation.zai.chatSessionId;
  // 拼 URL 的 base 只认证据（本次 / 记录站点 / 记录里那条 url 的 origin）。
  // ⚠️ **不再吃默认站**：那会造出一条「站点写着 null、url 却指向默认站」的记录，
  // 而下一次运行又会把那条 url 当成站点证据（第三级）⇒ 绕一圈仍然钉死在默认站。
  // 拿不到站就不拼 URL ——「打开会话」宁可暂时没有链接，也不能指错站。
  const urlSiteOrigin = nextSiteOrigin
    ?? resolveZaiSiteOrigin(automation.zai.sessionUrl);
  const nextSessionUrl = nextSessionId && urlSiteOrigin
    ? buildZaiChatSessionUrl(nextSessionId, urlSiteOrigin)
    : null;
  const sessionPatch = nextSessionId && (
    nextSessionId !== automation.zai.chatSessionId ||
    automation.zai.sessionUrl !== nextSessionUrl
  )
    ? {
        zai: {
          ...automation.zai,
          chatSessionId: nextSessionId,
          sessionUrl: nextSessionUrl,
          siteOrigin: nextSiteOrigin,
        },
      }
    : (nextSiteOrigin !== automation.zai.siteOrigin
        ? { zai: { ...automation.zai, siteOrigin: nextSiteOrigin } }
        : {});

  return {
    // Persist a session created during a failed run so the retry reuses it
    // instead of leaking a fresh session per attempt.
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
