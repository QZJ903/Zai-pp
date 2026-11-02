import type {
  Automation,
  AutomationCreateInput,
  AutomationId,
  AutomationRun,
  AutomationRunId,
  AutomationRunListOptions,
  AutomationRunnerRequest,
  AutomationRunnerResult,
  AutomationRunStatus,
  AutomationRunUpdateInput,
  AutomationRuntimeUpdate,
  AutomationStatus,
  AutomationUpdateInput,
} from './types';
import {
  AUTOMATION_STORAGE_KEY,
  decodeAutomationStorageState,
  encodeAutomationStorageState,
  type AutomationStorageState,
} from './storage-codec';
import { createSerialOperationQueue } from '../persistence/serial-operation-queue';

const DEFAULT_RUN_HISTORY_LIMIT = 100;

/**
 * 运行历史占 `chrome.storage.local` 配额的**比例上限**。
 *
 * ⚠️⚠️ **只按条数裁剪不构成上界** —— 单条 run 里带着 `toolExecutions`，写失败的
 * 表现不是「少一条记录」，而是 `QUOTA_BYTES` 抛到扫描之外、**整轮扫描中断**。
 * ⚠️ **这个比例是按「全局配额」留的余量，不是「本 key 独占配额」** ——
 * `chrome.storage.local.QUOTA_BYTES` 是**整个扩展共用**的一份，而
 * `core/tool/history.ts` 已在同一份配额上按 0.75 预算 ⇒ 两个 key 名义上可到 1.25×。
 * 实际不构成风险（裁剪后 run 历史只有几 MB），但**下次调这个比例时别按「单 key」推**。
 * ⚠️ 真正压体积的是 `trimRunnerResultForStorage`；预算这条是**第二道防线**。
 * ⚠️ **预算只在 `claimAutomationRun` 那条路上执行**（`pruneRunHistory` 的唯一调用点）——
 * `finalizeAutomationRun` / `updateAutomationRun` / `reconcileStaleRunsDetailed` 写盘时**不裁剪**，
 * 靠「单条已被裁到 27 KB 量级 + 100 条上限」保证不越界。
 */
const RUN_HISTORY_BUDGET_RATIO = 0.5;

/** 落库时给单个工具的 detail / 错误信息留多少字。 */
const RUN_TOOL_DETAIL_CHARS = 500;
const RUN_TOOL_ERROR_CHARS = 500;

export type AutomationRunClaimResult =
  | { kind: 'claimed'; automation: Automation; run: AutomationRun }
  | { kind: 'automation_missing'; run: null }
  | { kind: 'active_run'; automation: Automation; run: AutomationRun }
  | { kind: 'occurrence_exists'; automation: Automation; run: AutomationRun };

interface ClaimAutomationRunInput {
  runId: AutomationRunId;
  automationId: AutomationId;
  trigger: AutomationRun['trigger'];
  scheduledFor: number | null;
  startedAt: number;
  createRequest: (automation: Automation) => AutomationRunnerRequest;
}

interface FinalizeAutomationRunInput {
  runId: AutomationRunId;
  automationId: AutomationId;
  status: AutomationRunStatus;
  result: AutomationRunnerResult;
  runtimePatch: (automation: Automation) => AutomationRuntimeUpdate;
}

interface ReconcileStaleRunsOptions {
  protectedRunIds?: ReadonlySet<AutomationRunId>;
  runtimePatch?: (automation: Automation, run: AutomationRun) => AutomationRuntimeUpdate;
}

const automationOperations = createSerialOperationQueue();

export async function getAllAutomations(): Promise<Automation[]> {
  return automationOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    return [...state.automations].sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

export async function getAutomationById(id: AutomationId): Promise<Automation | null> {
  return automationOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    return state.automations.find((automation) => automation.id === id) ?? null;
  });
}

export async function createAutomation(input: AutomationCreateInput): Promise<Automation> {
  return mutateState((state) => {
    const now = Date.now();
    const automation: Automation = {
      ...input,
      id: crypto.randomUUID(),
      status: 'active',
      zai: {
        chatSessionId: null,
        sessionUrl: null,
        // 新记录没有「上次跑的站点」⇒ null = 不知道（协调器据此走 A 兜底/默认站）。
        siteOrigin: null,
      },
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      nextRunAt: null,
      lastError: null,
      version: 1,
    };
    return {
      nextState: {
        ...state,
        automations: [automation, ...state.automations],
      },
      result: automation,
      changed: true,
    };
  });
}

export async function updateAutomation(
  id: AutomationId,
  patch: AutomationUpdateInput,
): Promise<Automation | null> {
  return patchAutomation(id, patch);
}

export async function updateAutomationRuntime(
  id: AutomationId,
  patch: AutomationRuntimeUpdate,
): Promise<Automation | null> {
  return patchAutomation(id, patch);
}

/**
 * 与 `updateAutomationRuntime` 同效，但 patch 由**写盘那一刻的自动化记录**求值。
 *
 * ⚠️⚠️ **需要看现有值才能决定写什么的场景必须用它** —— 拿外面读到的快照去算 patch、
 * 再写进新状态，中间任何一次并发写都会被静默覆盖（整键读改写、后写赢）。
 * 这与 `finalizeAutomationRun` 的 `runtimePatch` 是同一个形态。
 *
 * `createPatch` 返回 `null` 表示「不写」（例如自动化已经不在了）。
 */
export async function updateAutomationRuntimeWith(
  id: AutomationId,
  createPatch: (automation: Automation) => AutomationRuntimeUpdate | null,
): Promise<Automation | null> {
  return mutateState((state) => {
    let updatedAutomation: Automation | null = null;
    const automations = state.automations.map((automation) => {
      if (automation.id !== id) return automation;
      const patch = createPatch(automation);
      if (!patch) return automation;
      updatedAutomation = {
        ...automation,
        ...patch,
        updatedAt: Date.now(),
      };
      return updatedAutomation;
    });
    return {
      nextState: { ...state, automations },
      result: updatedAutomation,
      changed: updatedAutomation !== null,
    };
  });
}

export async function setAutomationStatus(
  id: AutomationId,
  status: AutomationStatus,
): Promise<Automation | null> {
  return patchAutomation(id, { status });
}

export async function deleteAutomation(id: AutomationId): Promise<void> {
  await mutateState((state) => {
    const nextAutomations = state.automations.filter((automation) => automation.id !== id);
    const nextRuns = state.runs.filter((run) => run.automationId !== id);
    return {
      nextState: { ...state, automations: nextAutomations, runs: nextRuns },
      result: undefined,
      changed: nextAutomations.length !== state.automations.length || nextRuns.length !== state.runs.length,
    };
  });
}

export async function claimAutomationRun(
  input: ClaimAutomationRunInput,
): Promise<AutomationRunClaimResult> {
  return mutateState<AutomationRunClaimResult>((state) => {
    const automation = state.automations.find((item) => item.id === input.automationId);
    if (!automation) {
      return { nextState: state, result: { kind: 'automation_missing', run: null }, changed: false };
    }

    const activeRun = state.runs.find((run) =>
      run.automationId === input.automationId &&
      (run.status === 'queued' || run.status === 'running')
    );
    if (activeRun) {
      return {
        nextState: state,
        result: { kind: 'active_run', automation, run: activeRun },
        changed: false,
      };
    }

    if (input.trigger === 'schedule' && input.scheduledFor !== null) {
      const existingOccurrence = state.runs.find((run) =>
        run.automationId === input.automationId &&
        run.scheduledFor === input.scheduledFor
      );
      if (existingOccurrence) {
        return {
          nextState: state,
          result: { kind: 'occurrence_exists', automation, run: existingOccurrence },
          changed: false,
        };
      }
    }

    const request = input.createRequest(automation);
    const run: AutomationRun = {
      id: input.runId,
      automationId: automation.id,
      trigger: input.trigger,
      status: 'running',
      scheduledFor: input.scheduledFor,
      attempt: 1,
      request,
      result: null,
      error: null,
      createdAt: input.startedAt,
      startedAt: input.startedAt,
      completedAt: null,
      updatedAt: input.startedAt,
    };
    return {
      nextState: {
        ...state,
        runs: pruneRunHistory([run, ...state.runs]),
      },
      result: { kind: 'claimed', automation, run },
      changed: true,
    };
  });
}

export async function finalizeAutomationRun(
  input: FinalizeAutomationRunInput,
): Promise<AutomationRun | null> {
  return mutateState((state) => {
    const runIndex = state.runs.findIndex((run) =>
      run.id === input.runId &&
      run.automationId === input.automationId &&
      run.status === 'running'
    );
    if (runIndex === -1) {
      return { nextState: state, result: null, changed: false };
    }

    const automationIndex = state.automations.findIndex((automation) => automation.id === input.automationId);
    if (automationIndex === -1) {
      return { nextState: state, result: null, changed: false };
    }

    const now = Date.now();
    const runs = [...state.runs];
    const updatedRun: AutomationRun = {
      ...runs[runIndex],
      status: input.status,
      result: trimRunnerResultForStorage(input.result),
      error: input.result.ok ? null : input.result.error,
      completedAt: input.result.completedAt,
      updatedAt: now,
    };
    runs[runIndex] = updatedRun;

    const automations = [...state.automations];
    const currentAutomation = automations[automationIndex];
    automations[automationIndex] = {
      ...currentAutomation,
      ...input.runtimePatch(currentAutomation),
      updatedAt: now,
    };
    return {
      nextState: { ...state, automations, runs },
      result: updatedRun,
      changed: true,
    };
  });
}

export async function updateAutomationRun(
  id: AutomationRunId,
  patch: AutomationRunUpdateInput,
  options?: { expectedStatus?: AutomationRunStatus },
): Promise<AutomationRun | null> {
  return mutateState((state) => {
    let updatedRun: AutomationRun | null = null;
    const runs = state.runs.map((run) => {
      if (run.id !== id) return run;
      if (options?.expectedStatus !== undefined && run.status !== options.expectedStatus) return run;
      updatedRun = {
        ...run,
        ...patch,
        // 重试中途也会把 result 落库（`executeWithRetry`），同样要裁。
        ...(patch.result === undefined ? {} : { result: trimRunnerResultForStorage(patch.result) }),
        updatedAt: Date.now(),
      };
      return updatedRun;
    });
    return {
      nextState: { ...state, runs },
      result: updatedRun,
      changed: updatedRun !== null,
    };
  });
}

export async function getAutomationRuns(
  options: AutomationRunListOptions,
): Promise<AutomationRun[]> {
  return automationOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    const limit = options.limit ?? DEFAULT_RUN_HISTORY_LIMIT;
    return state.runs
      .filter((run) => run.automationId === options.automationId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  });
}

export async function getAutomationRunById(id: AutomationRunId): Promise<AutomationRun | null> {
  return automationOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    return state.runs.find((run) => run.id === id) ?? null;
  });
}

/**
 * Marks stale `queued` or `running` automation runs as failed. This recovers
 * service-worker termination without replaying an occurrence. Callers that
 * still own in-process execution must protect those run IDs until settlement.
 *
 * Safe to call repeatedly — only stale `running` rows are touched.
 */
export async function reconcileStaleRuns(
  thresholdMs: number,
  now: number = Date.now(),
): Promise<number> {
  return (await reconcileStaleRunsDetailed(thresholdMs, now)).length;
}

export async function reconcileStaleRunsDetailed(
  thresholdMs: number,
  now: number = Date.now(),
  options: ReconcileStaleRunsOptions = {},
): Promise<AutomationRun[]> {
  return mutateState((state) => {
    const reconciled: AutomationRun[] = [];
    const runs = state.runs.map((run) => {
      if (run.status !== 'queued' && run.status !== 'running') return run;
      if (options.protectedRunIds?.has(run.id)) return run;
      const executionStartedAt = run.startedAt ?? run.createdAt;
      const deadlineAt = run.request?.deadlineAt ?? executionStartedAt + thresholdMs;
      if (now < deadlineAt) return run;

      const completedAt = deadlineAt;
      const error: AutomationRun['error'] = {
        code: 'automation_run_interrupted',
        message: 'Service worker was terminated before the automation outcome was confirmed.',
        phase: 'runner',
        retryable: false,
        at: now,
        details: {
          startedAt: executionStartedAt,
          completedAt,
          externalOutcome: 'ambiguous',
          retrySafe: false,
        },
      };
      const updated: AutomationRun = {
        ...run,
        status: 'failed' as const,
        completedAt,
        result: {
          ok: false,
          chatSessionId: run.request?.chatSessionId ?? null,
          // 悬挂 run 被 reconcile 改判时拿不到协调器的结果 ⇒ 站点「不知道」。
          siteOrigin: null,
          completedAt,
          error,
        },
        error,
        updatedAt: now,
      };
      reconciled.push(updated);
      return updated;
    });
    const automations = options.runtimePatch && reconciled.length > 0
      ? applyReconciledRuntimePatches(state.automations, reconciled, options.runtimePatch, now)
      : state.automations;
    return {
      nextState: { ...state, automations, runs },
      result: reconciled,
      changed: reconciled.length > 0,
    };
  });
}

function applyReconciledRuntimePatches(
  automations: Automation[],
  runs: AutomationRun[],
  createPatch: (automation: Automation, run: AutomationRun) => AutomationRuntimeUpdate,
  updatedAt: number,
): Automation[] {
  const newestRunByAutomation = new Map<AutomationId, AutomationRun>();
  for (const run of runs) {
    const existing = newestRunByAutomation.get(run.automationId);
    if (!existing || (run.completedAt ?? 0) > (existing.completedAt ?? 0)) {
      newestRunByAutomation.set(run.automationId, run);
    }
  }

  return automations.map((automation) => {
    const run = newestRunByAutomation.get(automation.id);
    if (!run) return automation;
    return {
      ...automation,
      ...createPatch(automation, run),
      updatedAt,
    };
  });
}

async function patchAutomation(
  id: AutomationId,
  patch: AutomationUpdateInput | AutomationRuntimeUpdate,
): Promise<Automation | null> {
  return mutateState((state) => {
    let updatedAutomation: Automation | null = null;
    const automations = state.automations.map((automation) => {
      if (automation.id !== id) return automation;
      updatedAutomation = {
        ...automation,
        ...patch,
        updatedAt: Date.now(),
      };
      return updatedAutomation;
    });
    return {
      nextState: { ...state, automations },
      result: updatedAutomation,
      changed: updatedAutomation !== null,
    };
  });
}

async function readStateAlreadyOwned(): Promise<AutomationStorageState> {
  const data = await chrome.storage.local.get(AUTOMATION_STORAGE_KEY) as Record<string, unknown>;
  return decodeAutomationStorageState(data[AUTOMATION_STORAGE_KEY]);
}

async function writeState(state: AutomationStorageState): Promise<void> {
  await chrome.storage.local.set({
    [AUTOMATION_STORAGE_KEY]: encodeAutomationStorageState(state),
  });
}

async function mutateState<TResult>(
  mutation: (state: AutomationStorageState) => {
    nextState: AutomationStorageState;
    result: TResult;
    changed: boolean;
  },
): Promise<TResult> {
  return automationOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    const outcome = mutation(state);
    if (outcome.changed) await writeState(outcome.nextState);
    return outcome.result;
  });
}

function pruneRunHistory(runs: AutomationRun[]): AutomationRun[] {
  const grouped = new Map<AutomationId, AutomationRun[]>();
  for (const run of runs) {
    const group = grouped.get(run.automationId) ?? [];
    group.push(run);
    grouped.set(run.automationId, group);
  }

  const trimmed = [...grouped.values()].flatMap((group) =>
    group
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, DEFAULT_RUN_HISTORY_LIMIT),
  );
  return trimRunsToFit(trimmed, getRunHistoryBudgetBytes());
}

/**
 * 按序列化后的 **UTF-8 字节**丢最旧的 run，直到装得下。
 *
 * ⚠️ **判据是字节不是字符**（中文一字三字节，按 `string.length` 会低估三倍）。
 * ⚠️ **至少保留一条** —— 全丢会让「刚刚跑完」那条也看不见，而用户点「运行」
 * 之后最想看到的正是它。
 * ⚠️ **每条只序列化一次** —— 单条可以有几百 KB，`while` 里反复 stringify
 * 会把一次落库拖成几秒。
 */
function trimRunsToFit(runs: AutomationRun[], budgetBytes: number): AutomationRun[] {
  if (runs.length <= 1) return runs;
  const sorted = [...runs].sort((a, b) => b.createdAt - a.createdAt);
  const sizes = sorted.map((run) => utf8Bytes(JSON.stringify(run)));
  // 数组的序列化字节 = `[` + 各条之和 + 分隔逗号 + `]`
  let total = 2 + sizes.reduce((sum, size) => sum + size, 0) + (sorted.length - 1);
  let kept = sorted.length;
  while (kept > 1 && total > budgetBytes) {
    kept -= 1;
    total -= sizes[kept] + 1;
  }
  // ⚠️ **没超预算就原样返回 `runs`，不要返回 `sorted`** —— 否则每次 claim 都会把
  // 持久化的 `state.runs` 按 `createdAt` 重排一遍（原来是按 automation 分组拼接的顺序）。
  // 当前无消费者依赖那个顺序（`getAutomationRuns` 自己排、reconcile/claim 都是
  // `map`/`find`），但那是**隐性行为变更**，不该由「裁剪」顺手做掉。
  return kept === sorted.length ? runs : sorted.slice(0, kept);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function getRunHistoryBudgetBytes(): number {
  // 与工具历史同一口径：优先读运行时给的配额常量。
  const quota = (chrome.storage.local.QUOTA_BYTES as number | undefined) ?? 10_485_760;
  return Math.floor(quota * RUN_HISTORY_BUDGET_RATIO);
}

/**
 * 落库前裁掉 `toolExecutions` 里**只有界面以外的用途**才会看的大字段。
 *
 * ⚠️⚠️ **运行历史里真正占地方的就是它**：`shell_exec` 单条输出上限 128 KB、
 * MCP 默认 64 KB，一轮跑五个工具就是 640 KB，而自动化只占**一个 storage key**。
 * 实测「5 个 shell 工具 + 8000 字回答」的一轮：不裁 1274 KB、裁完 27 KB。
 * ⚠️ **`output` 整个丢掉是安全的** —— 全仓没有一处读 `run.result.toolExecutions`
 * （页面只渲染 `status` / `attempt`；reconcile 只读 `ok` / 会话 / 站点 / 错误 / 时间）。
 * 留下 `name` / `ok` / `summary` / `detail`（截断）/ `error` 已够回答「这轮调了什么、成没成」。
 * 裁完的记录仍能通过 `isToolExecutionRecord` 的校验。
 *
 * ⚠️ 入参**允许 `null`** —— `AutomationRun.result` 本身就是可空的，`updateAutomationRun`
 * 的 patch 也允许显式清空；那一档原样返回。
 */
function trimRunnerResultForStorage(
  result: AutomationRunnerResult | null,
): AutomationRunnerResult | null {
  if (!result || !result.ok || !result.toolExecutions?.length) return result;
  return {
    ...result,
    toolExecutions: result.toolExecutions.map((execution) => {
      // ⚠️ **`truncated` 只在真的动过内容时置位** —— 它是 `ToolCardResult` 的既有语义
      // （「给用户看的结果被截短了」），一律标 `true` 会让「detail 只有 20 字、也没有
      // output」的记录也说自己被截断。当前 run 历史零读者，但那是**元数据失真**，
      // 将来把 run 历史接到面板上就会显示成假截断。
      // ⚠️ 丢 `output` 本身也算一次截断（那份数据确实没落库）。
      const detailTruncated = typeof execution.result.detail === 'string'
        && execution.result.detail.length > RUN_TOOL_DETAIL_CHARS;
      const errorTruncated = (execution.result.error?.message.length ?? 0) > RUN_TOOL_ERROR_CHARS;
      const truncated = execution.result.output !== undefined
        || detailTruncated
        || errorTruncated
        || execution.result.truncated === true;
      return {
        ...execution,
        result: {
          ok: execution.result.ok,
          summary: execution.result.summary,
          ...(typeof execution.result.detail === 'string'
            ? { detail: truncateChars(execution.result.detail, RUN_TOOL_DETAIL_CHARS) }
            : {}),
          ...(execution.result.error
            ? {
                error: {
                  ...execution.result.error,
                  message: truncateChars(execution.result.error.message, RUN_TOOL_ERROR_CHARS),
                },
              }
            : {}),
          truncated,
        },
      };
    }),
  };
}

function truncateChars(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated]`;
}
