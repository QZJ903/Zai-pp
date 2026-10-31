import {
  assertSha256Checksum,
  createSha256Checksum,
  parseSha256Checksum,
  type Sha256Checksum,
} from './checksum';

export const SYNC_LOCAL_APPLY_JOURNAL_KIND = 'zai-pp.sync-local-apply-journal' as const;
export const SYNC_LOCAL_APPLY_JOURNAL_SCHEMA_VERSION = 1 as const;

/**
 * **回滚顺序**（按声明序倒着走）覆盖的存储槽。
 *
 * ⚠️ 名字里的 `APPLY` 是历史遗留：这里只剩「要恢复哪些槽」这一个用途
 * —— 整份快照落地的写入方向已经不存在了（唯一的写入入口是
 * `runMutation`，它执行的是调用方给的闭包）。
 */
export const SYNC_APPLY_STEP_ORDER = [
  'memories',
  'skills',
  'skillSources',
  'presets',
  'activePreset',
  'savedItems',
] as const;

export type SyncApplyStep = typeof SYNC_APPLY_STEP_ORDER[number];

export interface OpaqueStoragePreimage {
  present: boolean;
  value?: unknown;
}

export interface SyncUndoPreimageV1 {
  memoryRecords: Record<string, unknown>[];
  storage: Record<Exclude<SyncApplyStep, 'memories'>, OpaqueStoragePreimage> & {
    /**
     * 已退役的槽位（原「项目」功能的 storage 快照）。
     *
     * ⚠️ **只为了读旧 journal 而保留** —— preimage 的校验和是对**整个** serialized
     * preimage 算的，解析时把这个字段丢掉会让旧 journal 的 checksum 恒不匹配。
     * 它**不参与** `SYNC_APPLY_STEP_ORDER`，所以既不会被写入也不会被回滚
     * （那个 storage key 本身已随功能删除）。
     * ⚠️ **位置必须留在 `activePreset` 与 `savedItems` 之间** —— 键序影响序列化字节。
     *
     * ⚠️⚠️ **加槽位时的纪律：必须写成可选字段，并同步补进 `parseUndoPreimage`。**
     * 那份解析是**白名单式重建**（只抄它认识的键），所以新增一个**必填**槽位会让
     * 缺该键的旧 journal 在解析阶段直接抛错。抛错本身现在是安全的（`recover()` 会丢弃
     * 读不出来的 journal），但丢弃意味着**那次未完成的变更失去了回滚依据** ——
     * 能少丢一次就少丢一次。
     */
    projectContext?: OpaqueStoragePreimage;
  };
}

export interface SyncLocalApplyJournalV1 {
  kind: typeof SYNC_LOCAL_APPLY_JOURNAL_KIND;
  schemaVersion: typeof SYNC_LOCAL_APPLY_JOURNAL_SCHEMA_VERSION;
  operationId: string;
  createdAt: number;
  preimage: SyncUndoPreimageV1;
  preimageChecksum: Sha256Checksum;
}

export interface SyncLocalStatePort {
  captureUndoPreimage(): Promise<SyncUndoPreimageV1>;
  restoreStep(step: SyncApplyStep, before: SyncUndoPreimageV1): Promise<void>;
}

export interface SyncLocalApplyJournalPort {
  readCurrent(): Promise<unknown | null>;
  writeCurrent(record: SyncLocalApplyJournalV1): Promise<void>;
  clearCurrent(): Promise<void>;
}

export interface SyncLocalApplyCoordinatorOptions {
  now?: () => number;
  createOperationId?: () => string;
  /**
   * 有一份 **永远回滚不出来** 的 journal 被丢弃时调用。
   *
   * 判别标准见 `recover()` 的说明：**读不出来**（结构不合法 / 版本不认识 /
   * 校验和不匹配）与 **回滚执行失败** 是两档，前者丢弃、后者阻塞。
   * 丢弃是静默的数据库清理，所以必须留一条上报 —— 否则「有一次未完成的变更
   * 被放弃」这件事只会出现在用户后来的数据差异里。
   */
  onJournalDiscarded?: (error: unknown) => void;
}

export interface SyncLocalRecoveryResult {
  recovered: boolean;
  operationId: string | null;
}

export class SyncLocalCommitOutcomeUnknownError extends Error {
  constructor(cause: unknown, verificationError: unknown) {
    super('Sync local commit outcome is unknown', {
      cause: new AggregateError([cause, verificationError]),
    });
    this.name = 'SyncLocalCommitOutcomeUnknownError';
  }
}

export function createSyncLocalApplyCoordinator(
  localState: SyncLocalStatePort,
  journal: SyncLocalApplyJournalPort,
  options: SyncLocalApplyCoordinatorOptions = {},
) {
  const now = options.now ?? Date.now;
  const createOperationId = options.createOperationId ?? defaultOperationId;

  /**
   * 收尾上一份未完成的变更。
   *
   * ⚠️⚠️ **失败必须分两档，处置相反：**
   *
   * | 档 | 判据 | 处置 |
   * |---|---|---|
   * | **读不出来** | `kind` / `schemaVersion` 不认识、结构不合法、校验和不匹配 | **丢弃这份 journal，继续** |
   * | **回滚执行失败** | 读得出来、但恢复某一步时抛错 | **保留 journal，阻塞** |
   *
   * 前者的 preimage 根本解析不出来 ⇒ **它本来就不可能被用来回滚**，留着只会让
   * `recover()` 永久失败；而 `recover()` 被 `withSyncLocalStateLock` 前置到**每一次**
   * 加锁（含 `versioned-repository.read()` 这样的只读入口）⇒ 留着等于让整个本地状态
   * **连读都读不了**，且清 journal 的动作排在恢复成功之后 ⇒ 没有任何自愈路径。
   *
   * 后者不同：状态确实不自洽、但下一轮可能自愈（比如磁盘暂时不可写），
   * 丢掉 journal 就真的没有回滚依据了。
   */
  async function recover(): Promise<SyncLocalRecoveryResult> {
    // ⚠️ **读失败不丢** —— 那是一次基础设施故障（磁盘忙、事务被打断），
    // 下一轮完全可能读得出来，丢掉 journal 等于白白放弃唯一一份回滚依据。
    const value = await journal.readCurrent();
    if (value === null) return { recovered: false, operationId: null };

    let record: SyncLocalApplyJournalV1;
    try {
      record = await validateSyncLocalApplyJournal(value);
    } catch (parseError) {
      await discardUnreadableJournal(journal, parseError);
      options.onJournalDiscarded?.(parseError);
      return { recovered: false, operationId: null };
    }

    await restoreAllSteps(localState, record.preimage);
    await clearJournalAfterRollback(journal, record);
    return { recovered: true, operationId: record.operationId };
  }

  async function runMutation<T>(operation: () => Promise<T>): Promise<T> {
    await recover();
    const before = await localState.captureUndoPreimage();
    return runJournaledMutation(before, async () => operation());
  }

  async function runJournaledMutation<T>(
    before: SyncUndoPreimageV1,
    operation: (operationId: string) => Promise<T>,
  ): Promise<T> {
    const createdAt = now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new Error('Sync local apply createdAt is invalid');
    }
    const operationId = createOperationId();
    if (!operationId) throw new Error('Sync local apply operationId is required');
    const record = await createJournalRecord(operationId, createdAt, before);
    await prepareJournal(journal, record);

    try {
      const result = await operation(operationId);
      await clearJournalForCommit(journal, record);
      return result;
    } catch (applyError) {
      if (applyError instanceof SyncLocalCommitOutcomeUnknownError) throw applyError;

      try {
        await restoreAllSteps(localState, before);
      } catch (rollbackError) {
        throw new AggregateError(
          [applyError, rollbackError],
          'Sync local apply failed and rollback is incomplete',
        );
      }

      try {
        await clearJournalAfterRollback(journal, record);
      } catch (cleanupError) {
        throw new AggregateError(
          [applyError, cleanupError],
          'Sync local apply failed, rollback completed, and journal cleanup failed',
        );
      }
      throw applyError;
    }
  }

  return { recover, runMutation };
}

async function createJournalRecord(
  operationId: string,
  createdAt: number,
  preimage: SyncUndoPreimageV1,
): Promise<SyncLocalApplyJournalV1> {
  return {
    kind: SYNC_LOCAL_APPLY_JOURNAL_KIND,
    schemaVersion: SYNC_LOCAL_APPLY_JOURNAL_SCHEMA_VERSION,
    operationId,
    createdAt,
    preimage,
    preimageChecksum: await createSha256Checksum(serializePreimage(preimage)),
  };
}

async function prepareJournal(
  journal: SyncLocalApplyJournalPort,
  record: SyncLocalApplyJournalV1,
): Promise<void> {
  try {
    await journal.writeCurrent(record);
  } catch (writeError) {
    let observed: SyncLocalApplyJournalV1 | null;
    try {
      observed = await readCurrentJournal(journal);
    } catch (verificationError) {
      throw new AggregateError(
        [writeError, verificationError],
        'Sync local journal prepare outcome is unknown',
      );
    }
    if (observed && sameJournal(observed, record)) return;
    throw writeError;
  }
}

async function clearJournalForCommit(
  journal: SyncLocalApplyJournalPort,
  record: SyncLocalApplyJournalV1,
): Promise<void> {
  try {
    await journal.clearCurrent();
  } catch (clearError) {
    let observed: SyncLocalApplyJournalV1 | null;
    try {
      observed = await readCurrentJournal(journal);
    } catch (verificationError) {
      throw new SyncLocalCommitOutcomeUnknownError(clearError, verificationError);
    }
    if (!observed) return;
    if (!sameJournal(observed, record)) {
      throw new AggregateError(
        [clearError, new Error('A different sync local journal is present')],
        'Sync local journal changed before commit',
      );
    }
    throw clearError;
  }
}

/**
 * 丢弃一份**读不出来**的 journal。
 *
 * ⚠️ 这里的 `catch` 不是「尽力而为」——清不掉就是清不掉，不能再往上抛：
 * 调用方已经确定这份 journal 回滚不出来，为「清理失败」再阻塞一次，
 * 等于用同一个理由把系统锁死第二遍。失败只记在上报里。
 */
async function discardUnreadableJournal(
  journal: SyncLocalApplyJournalPort,
  parseError: unknown,
): Promise<void> {
  try {
    await journal.clearCurrent();
  } catch (clearError) {
    console.log('[Zai++] unreadable sync journal could not be cleared', {
      parseError,
      clearError,
    });
  }
}

async function clearJournalAfterRollback(
  journal: SyncLocalApplyJournalPort,
  record: SyncLocalApplyJournalV1,
): Promise<void> {
  try {
    await journal.clearCurrent();
  } catch (clearError) {
    let observed: SyncLocalApplyJournalV1 | null;
    try {
      observed = await readCurrentJournal(journal);
    } catch (verificationError) {
      throw new AggregateError(
        [clearError, verificationError],
        'Sync local rollback journal cleanup outcome is unknown',
      );
    }
    if (!observed) return;
    if (!sameJournal(observed, record)) {
      throw new AggregateError(
        [clearError, new Error('A different sync local journal is present')],
        'Sync local rollback preserved an unexpected journal',
      );
    }
    throw clearError;
  }
}

async function restoreAllSteps(
  localState: SyncLocalStatePort,
  before: SyncUndoPreimageV1,
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of [...SYNC_APPLY_STEP_ORDER].reverse()) {
    try {
      await localState.restoreStep(step, before);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Sync local rollback did not restore every persistence store');
  }
}

async function readCurrentJournal(
  journal: SyncLocalApplyJournalPort,
): Promise<SyncLocalApplyJournalV1 | null> {
  const value = await journal.readCurrent();
  if (value === null) return null;
  return validateSyncLocalApplyJournal(value);
}

export async function validateSyncLocalApplyJournal(
  value: unknown,
): Promise<SyncLocalApplyJournalV1> {
  const record = parseJournalEnvelope(value);
  await assertSha256Checksum(
    'Sync local journal preimage',
    serializePreimage(record.preimage),
    record.preimageChecksum,
  );
  return record;
}

function parseJournalEnvelope(value: unknown): SyncLocalApplyJournalV1 {
  const object = objectValue(value, 'Sync local journal');
  if (object.kind !== SYNC_LOCAL_APPLY_JOURNAL_KIND) {
    throw new Error('Sync local journal kind is not supported');
  }
  if (object.schemaVersion !== SYNC_LOCAL_APPLY_JOURNAL_SCHEMA_VERSION) {
    throw new Error('Sync local journal schema is not supported');
  }
  if (typeof object.operationId !== 'string' || object.operationId.length === 0) {
    throw new Error('Sync local journal operationId is required');
  }
  if (!Number.isSafeInteger(object.createdAt) || (object.createdAt as number) < 0) {
    throw new Error('Sync local journal createdAt is invalid');
  }
  return {
    kind: SYNC_LOCAL_APPLY_JOURNAL_KIND,
    schemaVersion: SYNC_LOCAL_APPLY_JOURNAL_SCHEMA_VERSION,
    operationId: object.operationId,
    createdAt: object.createdAt as number,
    preimage: parseUndoPreimage(object.preimage),
    preimageChecksum: parseSha256Checksum(
      object.preimageChecksum,
      'Sync local journal preimageChecksum',
    ),
  };
}

function parseUndoPreimage(value: unknown): SyncUndoPreimageV1 {
  const object = objectValue(value, 'Sync local journal preimage');
  if (!Array.isArray(object.memoryRecords)) {
    throw new Error('Sync local journal memoryRecords must be an array');
  }
  const memoryRecords = object.memoryRecords.map((record, index) => (
    objectValue(record, `Sync local journal memoryRecords[${index}]`)
  ));
  const storage = objectValue(object.storage, 'Sync local journal storage');
  return {
    memoryRecords,
    storage: {
      skills: parseOpaqueStoragePreimage(storage.skills, 'skills'),
      skillSources: parseOpaqueStoragePreimage(storage.skillSources, 'skillSources'),
      presets: parseOpaqueStoragePreimage(storage.presets, 'presets'),
      activePreset: parseOpaqueStoragePreimage(storage.activePreset, 'activePreset'),
      // 旧 journal 里可能带着已退役的槽位（见 `SyncUndoPreimageV1` 的说明）：
      // 有就原样带上，让 checksum 校验能对上；没有就不写这个键。
      ...(storage.projectContext === undefined
        ? {}
        : { projectContext: parseOpaqueStoragePreimage(storage.projectContext, 'projectContext') }),
      savedItems: parseOpaqueStoragePreimage(storage.savedItems, 'savedItems'),
    },
  };
}

function parseOpaqueStoragePreimage(value: unknown, slot: string): OpaqueStoragePreimage {
  const object = objectValue(value, `Sync local journal storage.${slot}`);
  if (typeof object.present !== 'boolean') {
    throw new Error(`Sync local journal storage.${slot}.present must be a boolean`);
  }
  if (!object.present) return { present: false };
  if (!Object.prototype.hasOwnProperty.call(object, 'value')) {
    throw new Error(`Sync local journal storage.${slot}.value is required`);
  }
  return { present: true, value: object.value };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function serializePreimage(preimage: SyncUndoPreimageV1): string {
  const serialized = JSON.stringify(preimage);
  if (serialized === undefined) throw new Error('Sync local journal preimage is not serializable');
  return serialized;
}

function sameJournal(left: SyncLocalApplyJournalV1, right: SyncLocalApplyJournalV1): boolean {
  return left.operationId === right.operationId
    && left.preimageChecksum.value === right.preimageChecksum.value;
}

function defaultOperationId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID !== 'function') {
    throw new Error('Web Crypto randomUUID is required for sync local apply');
  }
  return cryptoApi.randomUUID();
}
