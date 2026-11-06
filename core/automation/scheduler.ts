import {
  claimAutomationRun,
  finalizeAutomationRun,
  getAllAutomations,
  getAutomationRunById,
  reconcileStaleRunsDetailed,
  updateAutomationRun,
  updateAutomationRuntime,
  updateAutomationRuntimeWith,
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
/**
 * 扫描周期（分钟）。
 *
 * ⚠️⚠️ **必须 ≥ 1、且只能取整数** —— `chrome.alarms` 的驱动粒度是**分钟**：`0.5` 不会
 * 报错、只会安静地按 1 分钟跑（声明与行为不符），`2` 以上会让「最小间隔 15 分钟」的
 * 判据与真实扫描周期错位（漏一次扫描就整体延后一整个周期）。
 * ⚠️ 不要为它加运行时断言 —— 断言失败等于**整个自动化不跑**，比「扫得慢一点」更糟。
 */
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
  // 空串不是会话 id。判 `!== null` 会把空串当成「有会话」，
  // 于是新对话被送去记录里那一站。
  return automation.zai.chatSessionId || null;
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
    // ⚠️⚠️ **必须是 `reusableSessionId`，不能直接抄记录里的 `zai.chatSessionId`。**
    // 两者在两个格子上分叉：**非固定会话**（本轮是新对话）与 **固定会话但记录里是空串**
    // （没有可用会话）。抄原值会让这两格填进一个**不属于本轮**的会话 id，后果有两个：
    // ① 与下面 `siteOrigin` 的判据矛盾（一个说「复用它」、一个说「跟当前标签页」）；
    // ② **会写坏数据** —— 失败收尾时 `createAutomationRunnerFailure` 在没有
    //    `sessionIdOverride` 时会回落这个值（见 `background.ts` 的 catch 分支），
    //    而收尾再把 `result.chatSessionId ?? 记录` 写回去 ⇒ 运行期间
    //    `persistAutomationSession` 刚写进去的新会话被上一轮的旧 id 顶掉。
    chatSessionId: reusableSessionId,
    // 站点提示只在**复用已有会话**时成立：那条会话属于哪一站是确定的，会话 id
    // 在两站之间也不通用，所以必须去记录里那一站找它。
    // 其余情况（没开固定会话、或开了但还没建出会话）都是新对话、没有会话归属
    // ⇒ 站点交给协调器按「用户当前所在的标签页」判定（`resolveDomTab`），
    // 不能沿用记录里上一次跑过的站，否则任务会被上一次运行永久钉在那一站。
    // ⚠️ 判据与 `chatSessionId` 那行**同源**（都走 `reusableSessionId`），别再各判一次。
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
  /**
   * 本轮**因为读写存储失败而被跳过**的任务数。
   *
   * ⚠️ 与 `failed` 分开：`failed` 是「真的跑了一次、结果是失败」，这一档连 run
   * 都没建出来。混在一起会让界面在「什么都没跑」时也刷新运行记录。
   */
  errored: number;
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
  //
  // ⚠️⚠️ **这一步也要兜错** —— 它在有悬挂 run 时**会写盘**（`mutateState` →
  // `chrome.storage.local.set`），配额满 / 上下文失效时抛出来就**从第一行中断整轮**，
  // 与下面 `for` 循环里那条是同一个失效形态。而且两条路径**正相关**：存储越满，
  // 越可能先在这里炸。
  // ⚠️ **失败不能早退** —— reconcile 只负责「顺手清理」，清不掉不代表没东西可扫。
  // 早退会让所有本来到期的任务这一分钟一个都不跑，比不清理更糟。
  let reconciled: Awaited<ReturnType<typeof reconcileStaleRunsDetailed>> = [];
  let reconcileFailed = false;
  try {
    reconciled = await reconcileStaleRunsDetailed(AUTOMATION_RUN_TIMEOUT_MS, now, {
      protectedRunIds: new Set([...activeRunLeases.values()].map((lease) => lease.runId)),
      runtimePatch: (automation, run) => createInterruptedRuntimePatch(automation, run, now),
    });
  } catch (error) {
    reconcileFailed = true;
    console.error('[Zai++] stale run reconciliation before the scan failed', error);
  }

  // ⚠️ 这一行是**读**，配额不影响读 —— 它抛基本只意味着存储损坏 / 上下文失效，
  // 那种情况下面一条任务也跑不动，让它照常抛出去（由调用方记 `automation_*_scan_failed`）。
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
    // reconcile 失败也算一次「本轮被跳过的事」，让调用方的广播判据照常成立。
    errored: reconcileFailed ? 1 : 0,
  };

  /** 本轮的逐条错误（整轮只在末尾汇总打一行）。 */
  const scanErrors: Array<{ automationId: AutomationId; message: string }> = [];

  for (const automation of automations) {
    if (!isSchedulableAutomation(automation)) continue;

    // ⚠️⚠️ **每条任务各自兜错** —— 存储写失败（配额满 / 上下文失效）会从
    // `refreshAutomationNextRunAt` / `runAutomation` 里抛出来。没有这一层的话
    // 一次抛错就**中断整轮扫描**，而扫描每分钟一次、每次都在同一个任务上再撞
    // ⇒ 排在其后的所有自动化**永久不再运行**。
    try {
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
    } catch (error) {
      result.errored++;
      scanErrors.push({
        automationId: automation.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (scanErrors.length > 0) {
    // 整轮只打一行：这一档每分钟都会重来，逐条打会按任务数刷屏。
    // 用 error 而不是静默 —— 成因（配额满 / 存储不可写）用户从界面上看不出来。
    console.error('[Zai++] automation scan skipped some automations', {
      count: scanErrors.length,
      first: scanErrors[0],
    });
  }

  return result;
}

export async function refreshAutomationNextRunAt(
  automationId: AutomationId,
  now: number = Date.now(),
): Promise<Automation | null> {
  /**
   * ⚠️⚠️ **patch 必须在写盘那一刻求值，不能拿外面读到的快照算** —— 这个函数要读
   * 现有值才能决定写什么（排期是否还成立、要不要清 `lastError`），而两次队列操作
   * 之间任何一次并发写（运行收尾 / 用户改配置）都会被旧快照的 patch 覆盖。
   *
   * 会丢的东西具体是：快照里是**排期错误**时 patch 非空（要清 `lastError`），
   * 应用在**新**状态上 ⇒ 这中间刚落库的**运行期错误被清掉**。
   *
   * `lastError` 一个字段承载两种语义（排期校验 / 运行期），所以这里只清
   * 「自己那一半」：读到的是排期错误才清，运行期错误一律不碰。
   */
  return updateAutomationRuntimeWith(automationId, (automation) => {
    // ⚠️ 显式标类型，不用 `as const` —— 后者作用在**三元结果**上不合法（TS1355）。
    const scheduleErrorPatch: AutomationRuntimeUpdate = automation.lastError?.phase === 'schedule'
      ? { lastError: null }
      : {};

    if (!isSchedulableAutomation(automation)) {
      // 不再排期 ⇒ 没有「排期错误」可报，但运行期错误要留着。
      return { nextRunAt: null, ...scheduleErrorPatch };
    }

    const next = calculateNextRunAt(automation.schedule, now);
    if (!next.ok) {
      return {
        nextRunAt: null,
        lastError: toAutomationError(next.error.code, next.error.message, 'schedule', false, now),
      };
    }

    return { nextRunAt: next.value, ...scheduleErrorPatch };
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
  // ⚠️ **口径已定（N5）：重算的参照点是 `completedAt`，不是 `scheduledFor`。**
  // 理由：`nextRunAfterCompletion` 守的语义就是「跑完之后隔多久再跑」，重试也是跑。
  // 代价上界：重试最多把 `completedAt` 往后拖 `AUTOMATION_RETRY_DELAY_MS` +
  // 剩余执行时间（两次尝试共享同一个 `deadlineAt`，故 ≤ `AUTOMATION_RUN_TIMEOUT_MS`）
  // ≈ 3 分钟，而最小间隔是 15 分钟 ⇒ **不会连跑**。
  // ⚠️ **别改成从 `scheduledFor` 算** —— 那会把「不连跑」这条不变式绑在
  // 「最小间隔 > 最大重试时长」上，而那个间隔是可调的。
  const nextRunAt = isScheduledOccurrence(trigger, scheduledFor)
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
    // `result.chatSessionId` 可空 —— `null` = 本次没拿到，**保留记录里已有的**
    // （运行期间 `persistAutomationSession` 可能已经写进去了），与失败分支同口径。
    // ⚠️ **末尾的 `|| null` 顺手把历史遗留的空串归一成 `null`** ——
    // `resolveAutomationReusableSessionId` 那侧已确立「空串不是会话 id」，
    // 而这里是**唯一一处仍会把 `''` 写回库**的路径；不归一的话那条脏值永远不会自愈。
    const successSessionId = (result.chatSessionId ?? automation.zai.chatSessionId) || null;
    return {
      zai: {
        ...automation.zai,
        chatSessionId: successSessionId,
        // 有 id 时 result 的 url 才是权威的；没有就保留旧 url。
        sessionUrl: result.chatSessionId !== null ? result.sessionUrl : automation.zai.sessionUrl,
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
  // ⚠️ **同上**：末尾 `|| null` 把历史遗留的空串归一（失败分支也写会话状态）。
  const nextSessionId = (result.chatSessionId ?? automation.zai.chatSessionId) || null;
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

/**
 * **这条运行是不是「按排期来的」**（而不是用户手动点的）。
 *
 * ⚠️ **两个条件任一成立就算**：`trigger === 'schedule'` 或 `scheduledFor !== null`。
 * 后者是必需的 —— `executeWithRetry` 在中途把 run 的 `trigger` 改写成 `'retry'`
 * （那是**记录**上的语义，UI 靠它显示「重试」），而 `scheduledFor` 保留原值
 * ⇒ 只看 `trigger` 会把重试误判成手动运行、**不再重算 `nextRunAt`**。
 *
 * ⚠️ **这是唯一判定入口** —— `createAutomationRuntimePatch`（收 `trigger` + `scheduledFor`）
 * 与 `isScheduledRun`（收整条 run）都走它。两处各写一遍 `||` 的老形态改一处不报错。
 */
function isScheduledOccurrence(
  trigger: AutomationTrigger,
  scheduledFor: number | null,
): boolean {
  return trigger === 'schedule' || scheduledFor !== null;
}

function isScheduledRun(run: AutomationRun): boolean {
  return isScheduledOccurrence(run.trigger, run.scheduledFor);
}

/**
 * 收尾时重算「下一次运行时刻」。**失败一律返回 `null`，不传播错误。**
 *
 * ⚠️⚠️ **这个「吞掉错误」是刻意的，但它依赖一个前提** —— 三个调用点里
 * `createRecoveredNextRunAt`（`:616` 附近）**不写 `lastError`**，另外两处
 * （`refreshAutomationFromExistingRun` 的失败分支、`createAutomationRuntimePatch`）
 * 会写。所以这里吞掉的错误，在那条路径上要靠下一次扫描补上。
 *
 * **前提是「建得出来的排期，运行期不会失败」**：
 * - `invalid_timezone` / `missing_expression` / `invalid_cron*` / `invalid_rrule*`
 *   在创建时就被 `validateAutomationSchedule` 挡掉，而它们的输入（时区、表达式）
 *   存进库之后不会再变；
 * - `schedule_too_frequent` 与 `schedule_too_sparse` 都**与 `referenceAt` 无关**
 *   （前者按固定锚点判、后者按周期长度判）⇒ 建得进就一直成立；
 * - `cron_no_next_run` 在创建时同样判过 ⇒ 建不进来。
 *
 * ⚠️ **这个前提一旦被打破，后果不是「静默」而是「每分钟报错」**：
 * `nextRunAt` 停在 null ⇒ `scanDueAutomations` 每分钟重算一次、失败一次、
 * 写一次同样的 `lastError` ⇒ 卡片上「排期无法计算」的红条常驻，任务永不执行。
 * **历史上闰日表达式正好能打破它**（建得进、跑完一次后重算扫不到），
 * 现在由 `MAX_CRON_INTERVAL_DAYS` 在创建时拒掉。
 * ⚠️ **若将来放开那个上界、或允许更稀疏的表达式，这里要改成传播错误。**
 */
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
