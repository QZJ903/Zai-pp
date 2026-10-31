import { SUPPORTED_LOCALES } from '../i18n/types';
import { decodePersistedMemoryRecord } from '../memory/codec';
import {
  isToolDescriptorRecord,
  isToolExecutionRecord,
} from '../messaging/tool-record-codec';
import type {
  Automation,
  AutomationZaiSession,
  AutomationErrorState,
  AutomationFailurePhase,
  AutomationPromptContext,
  AutomationPromptOptions,
  AutomationRun,
  AutomationRunnerFailure,
  AutomationRunnerRequest,
  AutomationRunnerResult,
  AutomationRunnerSuccess,
  AutomationSchedule,
} from './types';

export const AUTOMATION_STORAGE_KEY = 'zai_pp_automations';
export const AUTOMATION_STORAGE_VERSION = 1 as const;
export const LEGACY_AUTOMATION_RUN_TIMEOUT_MS = 180_000;

const AUTOMATION_STATUSES = new Set(['active', 'paused', 'archived']);
const AUTOMATION_RUN_STATUSES = new Set([
  'queued',
  'running',
  'succeeded',
  'failed',
  'timeout',
  'cancelled',
  'skipped',
]);
const AUTOMATION_TRIGGERS = new Set(['manual', 'schedule', 'retry']);
const AUTOMATION_SCHEDULE_KINDS = new Set(['manual', 'cron', 'rrule']);
/**
 * **已知**的失败阶段（= `AutomationFailurePhase` 的全部取值）。
 *
 * ⚠️ 这**不是**读取时的白名单 —— 读到不认识的值**不报错**，归一成 `'unknown'`
 * （见 `readFailurePhase` 的说明）。它只用于「这个值是不是我们认识的那些」这一个判断。
 */
const AUTOMATION_FAILURE_PHASES = new Set([
  'schedule',
  'tab',
  'bridge',
  'runner',
  'cancelled',
  'unknown',
]);
const SUPPORTED_LOCALE_SET: ReadonlySet<string> = new Set(SUPPORTED_LOCALES);

export type AutomationStorageState = {
  version: typeof AUTOMATION_STORAGE_VERSION;
  automations: Automation[];
  runs: AutomationRun[];
} & Record<string, unknown>;

export type AutomationStorageContractErrorCode =
  | 'automation_storage_corrupt'
  | 'automation_storage_version_unsupported';

export class AutomationStorageContractError extends Error {
  constructor(
    readonly code: AutomationStorageContractErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'AutomationStorageContractError';
  }
}

export function createEmptyAutomationStorageState(): AutomationStorageState {
  return {
    version: AUTOMATION_STORAGE_VERSION,
    automations: [],
    runs: [],
  };
}

/** Pure decoder for the released v1 storage contract and its explicit aliases. */
export function decodeAutomationStorageState(
  raw: unknown,
  path = 'automationStorage',
): AutomationStorageState {
  if (raw === undefined) return createEmptyAutomationStorageState();

  const state = recordValue(raw, path);
  requireStorageVersion(state.version, `${path}.version`);
  const automations = decodeAutomationList(state.automations, `${path}.automations`);
  const runs = decodeAutomationRunList(state.runs, `${path}.runs`);

  return {
    ...state,
    version: AUTOMATION_STORAGE_VERSION,
    automations,
    runs,
  } as AutomationStorageState;
}

export function encodeAutomationStorageState(state: AutomationStorageState): AutomationStorageState {
  return decodeAutomationStorageState(state);
}

export function decodeAutomationList(raw: unknown, path = 'automations'): Automation[] {
  const automations = arrayValue(raw, path)
    .map((value, index) => decodeAutomation(value, `${path}[${index}]`));
  assertUniqueIds(automations.map((automation) => automation.id), path);
  return automations;
}

export function decodeAutomationRunList(raw: unknown, path = 'automationRuns'): AutomationRun[] {
  const runs = arrayValue(raw, path)
    .map((value, index) => decodeAutomationRun(value, `${path}[${index}]`));
  assertUniqueIds(runs.map((run) => run.id), path);
  return runs;
}

function decodeAutomation(raw: unknown, path: string): Automation {
  const value = recordValue(raw, path);
  if (value.version !== AUTOMATION_STORAGE_VERSION) {
    if (typeof value.version === 'number' && Number.isFinite(value.version)) {
      unsupportedVersion(`${path}.version`);
    }
    corrupt(`${path}.version`, 'Automation record version must be 1.');
  }

  return {
    ...value,
    id: nonEmptyString(value.id, `${path}.id`),
    name: nonEmptyString(value.name, `${path}.name`),
    prompt: nonEmptyString(value.prompt, `${path}.prompt`),
    status: enumValue(value.status, AUTOMATION_STATUSES, `${path}.status`),
    schedule: decodeSchedule(value.schedule, `${path}.schedule`),
    promptOptions: decodePromptOptions(value.promptOptions, `${path}.promptOptions`),
    // The initial released reader projected missing session state to nulls.
    zai: value.zai === undefined
      ? createEmptyZaiSession()
      : decodeZaiSession(value.zai, `${path}.zai`),
    createdAt: finiteNumber(value.createdAt, `${path}.createdAt`),
    updatedAt: finiteNumber(value.updatedAt, `${path}.updatedAt`),
    lastRunAt: nullableFiniteNumber(value.lastRunAt, `${path}.lastRunAt`),
    nextRunAt: nullableFiniteNumber(value.nextRunAt, `${path}.nextRunAt`),
    lastError: value.lastError === null
      ? null
      : decodeError(value.lastError, `${path}.lastError`),
    version: AUTOMATION_STORAGE_VERSION,
  } as Automation;
}

function decodeAutomationRun(raw: unknown, path: string): AutomationRun {
  const value = recordValue(raw, path);
  const id = nonEmptyString(value.id, `${path}.id`);
  const automationId = nonEmptyString(value.automationId, `${path}.automationId`);
  const createdAt = finiteNumber(value.createdAt, `${path}.createdAt`);
  const startedAt = nullableFiniteNumber(value.startedAt, `${path}.startedAt`);

  return {
    ...value,
    id,
    automationId,
    trigger: enumValue(value.trigger, AUTOMATION_TRIGGERS, `${path}.trigger`),
    status: enumValue(value.status, AUTOMATION_RUN_STATUSES, `${path}.status`),
    scheduledFor: nullableFiniteNumber(value.scheduledFor, `${path}.scheduledFor`),
    attempt: positiveInteger(value.attempt, `${path}.attempt`),
    request: value.request === null
      ? null
      : decodeRunnerRequest(
        value.request,
        `${path}.request`,
        id,
        automationId,
      ),
    result: value.result === null
      ? null
      : decodeRunnerResult(value.result, `${path}.result`),
    error: value.error === null
      ? null
      : decodeError(value.error, `${path}.error`),
    createdAt,
    startedAt,
    completedAt: nullableFiniteNumber(value.completedAt, `${path}.completedAt`),
    updatedAt: finiteNumber(value.updatedAt, `${path}.updatedAt`),
  } as AutomationRun;
}

function decodeSchedule(raw: unknown, path: string): AutomationSchedule {
  const value = recordValue(raw, path);
  const kind = enumValue(value.kind, AUTOMATION_SCHEDULE_KINDS, `${path}.kind`);
  return {
    ...value,
    kind,
    expression: nullableString(value.expression, `${path}.expression`),
    timezone: stringValue(value.timezone, `${path}.timezone`),
    // ⚠️ **缺省按 `kind` 兜底，不取 `false`** —— `enabled` 与 `kind` 在写入侧是
    // 派生关系（`kind === 'manual'` ⇔ `!enabled`），所以缺这个字段的记录，
    // 其真实意图已经从 `kind` 读得出来。取 `false` 会让一条 `kind: 'cron'` 的记录
    // **静默永不排期**（`isSchedulableAutomation` 判否），而它看起来完全正常。
    // ⚠️ **两个字段并存是刻意的**：`enabled` 将来可能允许「cron 但暂停」这种组合。
    enabled: value.enabled === undefined
      ? kind !== 'manual'
      : booleanValue(value.enabled, `${path}.enabled`),
    minimumIntervalMinutes: nonNegativeNumber(
      value.minimumIntervalMinutes,
      `${path}.minimumIntervalMinutes`,
    ),
  } as AutomationSchedule;
}

function decodePromptOptions(raw: unknown, path: string): AutomationPromptOptions {
  const value = recordValue(raw, path);
  // 保留未知字段：旧存储里的历史 promptOptions 字段（如 modelType / refFileIds /
  // thinkingEnabled / searchEnabled）原样带过，避免写入时把它们抹掉。
  return {
    ...value,
    // 兼容缺省：模型选择是后加的字段，旧存储里没有 → 视为 null（跟随页面默认）。
    model: defaultedNullableString(value.model, `${path}.model`),
    // ⚠️ **宽容只开在这里，别下放到 `booleanValue`** —— 它是后加字段，
    // 缺省 `false` 是本字段独有的向后兼容需求。共用 helper 一旦宽容，
    // `schedule.enabled` / `error.retryable` 这些**一直必填**的字段也会跟着变宽容，
    // 后果是「数据损坏」被静默换成「按缺省值行事」。
    fixedSession: value.fixedSession === undefined
      ? false
      : booleanValue(value.fixedSession, `${path}.fixedSession`),
  } as AutomationPromptOptions;
}

function createEmptyZaiSession(): AutomationZaiSession {
  return {
    chatSessionId: null,
    sessionUrl: null,
    // 旧记录（本字段之前落库的）没有它 ⇒ 视为「不知道」。
    siteOrigin: null,
  };
}

function decodeZaiSession(raw: unknown, path: string): AutomationZaiSession {
  const value = recordValue(raw, path);
  // 已删字段（parentMessageId / lastHistorySyncedAt）刻意**不再解出** —— 它们是上游
  // HTTP 直连架构的续写链锚点与落库校验时间戳，本项目 DOM 注入架构下恒为空。
  // 旧记录里可能还带着它们（`...value` 会原样保留、写入时也带着），这里不报错、不读取。
  return {
    ...value,
    chatSessionId: nullableString(value.chatSessionId, `${path}.chatSessionId`),
    sessionUrl: nullableString(value.sessionUrl, `${path}.sessionUrl`),
    // ⚠️ **兼容缺省**：站点是后加字段，旧记录里没有 ⇒ 视为 null（不知道）。
    // 写成 `requiredString` 会让所有旧记录直接判 corrupt、**整份自动化存储打不开**。
    siteOrigin: defaultedNullableString(value.siteOrigin, `${path}.siteOrigin`),
  } as AutomationZaiSession;
}

function decodeRunnerRequest(
  raw: unknown,
  path: string,
  expectedRunId: string,
  expectedAutomationId: string,
): AutomationRunnerRequest {
  const value = recordValue(raw, path);
  const runId = nonEmptyString(value.runId, `${path}.runId`);
  const automationId = nonEmptyString(value.automationId, `${path}.automationId`);
  if (runId !== expectedRunId) corrupt(`${path}.runId`, 'Runner request does not match its run.');
  if (automationId !== expectedAutomationId) {
    corrupt(`${path}.automationId`, 'Runner request does not match its automation.');
  }
  const requestedAt = finiteNumber(value.requestedAt, `${path}.requestedAt`);
  const deadlineAt = value.deadlineAt === undefined
    ? requestedAt + LEGACY_AUTOMATION_RUN_TIMEOUT_MS
    : positiveNumber(value.deadlineAt, `${path}.deadlineAt`);

  return {
    ...value,
    runId,
    automationId,
    deadlineAt,
    prompt: nonEmptyString(value.prompt, `${path}.prompt`),
    trigger: enumValue(value.trigger, AUTOMATION_TRIGGERS, `${path}.trigger`),
    chatSessionId: nullableString(value.chatSessionId, `${path}.chatSessionId`),
    // ⚠️ **兼容缺省**：站点是后加字段，旧 run 记录里没有 ⇒ null（不知道）。
    siteOrigin: defaultedNullableString(value.siteOrigin, `${path}.siteOrigin`),
    promptOptions: decodePromptOptions(value.promptOptions, `${path}.promptOptions`),
    ...(value.locale === undefined
      ? {}
      : { locale: enumValue(value.locale, SUPPORTED_LOCALE_SET, `${path}.locale`) }),
    ...(value.promptContext === undefined
      ? {}
      : { promptContext: decodePromptContext(value.promptContext, `${path}.promptContext`) }),
    requestedAt,
  } as AutomationRunnerRequest;
}

function decodePromptContext(raw: unknown, path: string): AutomationPromptContext {
  const value = recordValue(raw, path);
  const memories = value.memories === undefined
    ? undefined
    : arrayValue(value.memories, `${path}.memories`).map((memory, index) => (
      decodePersistedMemoryRecord(memory, `${path}.memories[${index}]`)
    ));
  const toolDescriptors = value.toolDescriptors === undefined
    ? undefined
    : arrayValue(value.toolDescriptors, `${path}.toolDescriptors`).map((descriptor, index) => {
      if (!isToolDescriptorRecord(descriptor)) {
        corrupt(`${path}.toolDescriptors[${index}]`, 'Invalid persisted tool descriptor.');
      }
      return descriptor;
    });

  return {
    ...value,
    ...(memories === undefined ? {} : { memories }),
    ...(value.presetContent === undefined
      ? {}
      : { presetContent: nullableString(value.presetContent, `${path}.presetContent`) }),
    ...(toolDescriptors === undefined ? {} : { toolDescriptors }),
  } as AutomationPromptContext;
}

function decodeRunnerResult(raw: unknown, path: string): AutomationRunnerResult {
  const value = recordValue(raw, path);
  if (value.ok === true) return decodeRunnerSuccess(value, path);
  if (value.ok === false) return decodeRunnerFailure(value, path);
  corrupt(`${path}.ok`, 'Runner result must declare a boolean outcome.');
}

function decodeRunnerSuccess(
  value: Record<string, unknown>,
  path: string,
): AutomationRunnerSuccess {
  const toolExecutions = value.toolExecutions === undefined
    ? undefined
    : arrayValue(value.toolExecutions, `${path}.toolExecutions`).map((execution, index) => {
      if (!isToolExecutionRecord(execution)) {
        corrupt(`${path}.toolExecutions[${index}]`, 'Invalid persisted tool execution.');
      }
      return execution;
    });

  return {
    ...value,
    ok: true,
    chatSessionId: stringValue(value.chatSessionId, `${path}.chatSessionId`),
    sessionUrl: nullableString(value.sessionUrl, `${path}.sessionUrl`),
    // ⚠️ **兼容缺省**（与 `AutomationZaiSession.siteOrigin` 同口径）：站点是后加字段，
    // 旧记录里没有 ⇒ null（不知道）。写成必填会让旧记录判 corrupt、整份存储打不开。
    siteOrigin: defaultedNullableString(value.siteOrigin, `${path}.siteOrigin`),
    assistantText: stringValue(value.assistantText, `${path}.assistantText`),
    ...(toolExecutions === undefined ? {} : { toolExecutions }),
    completedAt: finiteNumber(value.completedAt, `${path}.completedAt`),
  } as AutomationRunnerSuccess;
}

function decodeRunnerFailure(
  value: Record<string, unknown>,
  path: string,
): AutomationRunnerFailure {
  return {
    ...value,
    ok: false,
    chatSessionId: nullableString(value.chatSessionId, `${path}.chatSessionId`),
    // 同上的兼容缺省。
    siteOrigin: defaultedNullableString(value.siteOrigin, `${path}.siteOrigin`),
    error: decodeError(value.error, `${path}.error`),
    completedAt: finiteNumber(value.completedAt, `${path}.completedAt`),
  } as AutomationRunnerFailure;
}

function decodeError(raw: unknown, path: string): AutomationErrorState {
  const value = recordValue(raw, path);
  if (value.details !== undefined) recordValue(value.details, `${path}.details`);
  return {
    ...value,
    code: nonEmptyString(value.code, `${path}.code`),
    message: stringValue(value.message, `${path}.message`),
    phase: readFailurePhase(value.phase, `${path}.phase`),
    retryable: booleanValue(value.retryable, `${path}.retryable`),
    at: finiteNumber(value.at, `${path}.at`),
  } as AutomationErrorState;
}

/**
 * **宽容读回**失败阶段：不认识的字符串一律归 `'unknown'`，不判 corrupt。
 *
 * **为什么要宽容**：`phase` 的取值集合会随版本收缩（本项目就删掉了上游那六档
 * 无生产者的值），而**已落库的记录不会跟着改**。若这里判 corrupt，用户升级后
 * 整份自动化存储会直接抛 `AutomationStorageContractError`、**全部任务打不开** ——
 * 那是一次升级换一次数据不可用，代价远高于「某一档显示成未知」。
 *
 * ⚠️ **非字符串仍然是 corrupt** —— 那是真的数据损坏，不是版本差异。
 * ⚠️ **`code` / `message` 保持严格** —— 它们没有类似的收缩场景。
 */
function readFailurePhase(raw: unknown, path: string): AutomationFailurePhase {
  // 非字符串 = 真的数据损坏（数字 / 对象 / null 出现在 phase 位上），不是版本差异 ⇒ 照旧严格。
  if (typeof raw !== 'string') {
    corrupt(path, `Expected one of: ${[...AUTOMATION_FAILURE_PHASES].join(', ')}.`);
  }
  // 是字符串但不在已知集合里 = 版本差异（本项目删了几档上游的值，旧记录不会跟着改）⇒ 归一。
  return AUTOMATION_FAILURE_PHASES.has(raw) ? raw as AutomationFailurePhase : 'unknown';
}

function requireStorageVersion(value: unknown, path: string): void {
  if (value === AUTOMATION_STORAGE_VERSION) return;
  if (typeof value === 'number' && Number.isFinite(value)) unsupportedVersion(path);
  corrupt(path, 'Automation storage version must be 1.');
}

function recordValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    corrupt(path, 'Expected an object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    corrupt(path, 'Expected a plain object.');
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) corrupt(path, 'Expected an array.');
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') corrupt(path, 'Expected a string.');
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  const result = stringValue(value, path);
  if (!result.trim()) corrupt(path, 'Expected a non-empty string.');
  return result;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return stringValue(value, path);
}

/** 后加的可空字符串字段：旧记录里缺失视为 null（向后兼容）。 */
function defaultedNullableString(value: unknown, path: string): string | null {
  if (value === undefined) return null;
  return nullableString(value, path);
}

function booleanValue(value: unknown, path: string): boolean {
  // ⚠️ **严格**：缺省不在这里兜。宽容是**逐字段的需求**（见 `decodePromptOptions`
  // 的 `fixedSession` 与 `decodeSchedule` 的 `enabled`），写进共用 helper 会让
  // 一直必填的字段跟着变宽容。
  if (typeof value !== 'boolean') corrupt(path, 'Expected a boolean.');
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    corrupt(path, 'Expected a finite number.');
  }
  return value;
}

function positiveNumber(value: unknown, path: string): number {
  const result = finiteNumber(value, path);
  if (result <= 0) corrupt(path, 'Expected a positive number.');
  return result;
}

function nonNegativeNumber(value: unknown, path: string): number {
  const result = finiteNumber(value, path);
  if (result < 0) corrupt(path, 'Expected a non-negative number.');
  return result;
}

function nullableFiniteNumber(value: unknown, path: string): number | null {
  if (value === null) return null;
  return finiteNumber(value, path);
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    corrupt(path, 'Expected a positive safe integer.');
  }
  return value as number;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<string>, path: string): T {
  if (typeof value !== 'string' || !allowed.has(value)) {
    corrupt(path, `Expected one of: ${[...allowed].join(', ')}.`);
  }
  return value as T;
}

function assertUniqueIds(ids: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) corrupt(path, `Duplicate id: ${id}.`);
    seen.add(id);
  }
}

function unsupportedVersion(path: string): never {
  throw new AutomationStorageContractError(
    'automation_storage_version_unsupported',
    path,
    `${path} is not supported.`,
  );
}

function corrupt(path: string, message: string): never {
  throw new AutomationStorageContractError(
    'automation_storage_corrupt',
    path,
    `${path}: ${message}`,
  );
}
