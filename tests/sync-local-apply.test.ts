import { describe, expect, it } from 'vitest';
import type { Memory } from '../core/types';
import { createSha256Checksum } from '../core/sync/checksum';
import {
  SYNC_APPLY_STEP_ORDER,
  SYNC_LOCAL_APPLY_JOURNAL_KIND,
  SYNC_LOCAL_APPLY_JOURNAL_SCHEMA_VERSION,
  SyncLocalCommitOutcomeUnknownError,
  createSyncLocalApplyCoordinator,
  type SyncApplyStep,
  type SyncLocalApplyJournalPort,
  type SyncLocalApplyJournalV1,
  type SyncLocalStatePort,
  type SyncUndoPreimageV1,
} from '../core/sync/local-apply';

const BEFORE = {
  memoryRecords: [{ id: 7, syncId: 'before-memory', futureField: { keep: true } }],
  storage: {
    skills: { present: true, value: { future: 'raw-skills' } },
    skillSources: { present: false },
    presets: { present: true, value: [{ raw: 'preset' }] },
    activePreset: { present: true, value: 'preset-before' },
    savedItems: { present: false },
  },
} satisfies SyncUndoPreimageV1;

describe('sync local apply coordinator', () => {
  it('commits only by deleting the prepared journal after deterministic writes', async () => {
    const state = new FakeLocalState();
    const journal = new FakeJournal();
    const coordinator = createCoordinator(state, journal);

    await expect(coordinator.runMutation(async () => {
      for (const step of SYNC_APPLY_STEP_ORDER) state.values[step] = `target:${step}`;
      return { operationId: 'operation-1' };
    })).resolves.toEqual({ operationId: 'operation-1' });

    expect(state.restoreCalls).toEqual([]);
    expect(state.values).toEqual(targetValues());
    expect(journal.current).toBeNull();
    expect(journal.events).toEqual(['read', 'write', 'clear']);
  });

  it('reuses the same durable preimage and commit point for a preset-memory cascade', async () => {
    const state = new FakeLocalState();
    const journal = new FakeJournal();
    const coordinator = createCoordinator(state, journal);

    await expect(coordinator.runMutation(async () => {
      state.values.presets = 'target:presets';
      state.values.memories = 'target:memories';
      return 3;
    })).resolves.toBe(3);

    expect(state.values.presets).toBe('target:presets');
    expect(state.values.memories).toBe('target:memories');
    expect(journal.current).toBeNull();
    expect(journal.events).toEqual(['read', 'write', 'clear']);
  });

  it('restores every raw local-state preimage when a journaled cascade fails', async () => {
    const state = new FakeLocalState();
    const journal = new FakeJournal();
    const coordinator = createCoordinator(state, journal);

    await expect(coordinator.runMutation(async () => {
      state.values.presets = 'target:presets';
      state.values.memories = 'target:memories';
      throw new Error('preset Memory delete failed');
    })).rejects.toThrow('preset Memory delete failed');

    expect(state.values).toEqual(beforeValues());
    expect(state.restoreCalls).toEqual([...SYNC_APPLY_STEP_ORDER].reverse());
    expect(journal.current).toBeNull();
  });

  for (const mode of ['before', 'after'] as const) {
    it(`restores the exact preimage when a failed mutation rolled back the ${mode}-write window`, async () => {
      const state = new FakeLocalState();
      const journal = new FakeJournal();
      const coordinator = createCoordinator(state, journal);

      await expect(coordinator.runMutation(async () => {
        // 模拟「写了一半」：先改一个槽，再抛。
        state.values.skills = 'target:skills';
        if (mode === 'after') state.values.presets = 'target:presets';
        throw new Error(`mutation failed ${mode}`);
      })).rejects.toThrow(`mutation failed ${mode}`);

      expect(state.values).toEqual(beforeValues());
      expect(state.restoreCalls).toEqual([...SYNC_APPLY_STEP_ORDER].reverse());
      expect(journal.current).toBeNull();
    });
  }

  it('accepts a journal prepare that committed before the storage API threw', async () => {
    const state = new FakeLocalState();
    const journal = new FakeJournal({ writeMode: 'after' });
    const coordinator = createCoordinator(state, journal);

    await expect(coordinator.runMutation(async () => {
      for (const step of SYNC_APPLY_STEP_ORDER) state.values[step] = `target:${step}`;
      return { operationId: 'operation-1' };
    })).resolves.toEqual({ operationId: 'operation-1' });
    expect(state.values).toEqual(targetValues());
    expect(journal.current).toBeNull();
  });

  it('does not mutate local state when journal preparation fails before commit', async () => {
    const state = new FakeLocalState();
    const journal = new FakeJournal({ writeMode: 'before' });
    const coordinator = createCoordinator(state, journal);

    await expect(coordinator.runMutation(async () => state.values.skills = 'target:skills'))
      .rejects.toThrow('journal write before');
    expect(state.restoreCalls).toEqual([]);
    expect(state.values).toEqual(beforeValues());
    expect(journal.current).toBeNull();
  });

  it('fails closed when a failed journal preparation cannot be verified', async () => {
    const state = new FakeLocalState();
    const journal = new FakeJournal({ writeMode: 'before', failReadAt: 2 });
    const coordinator = createCoordinator(state, journal);

    await expect(coordinator.runMutation(async () => state.values.skills = 'target:skills'))
      .rejects.toThrow('Sync local journal prepare outcome is unknown');
    expect(state.restoreCalls).toEqual([]);
    expect(state.values).toEqual(beforeValues());
  });

  it('accepts a commit delete that completed before the storage API threw', async () => {
    const state = new FakeLocalState();
    const journal = new FakeJournal({ clearModes: ['after'] });
    const coordinator = createCoordinator(state, journal);

    await expect(coordinator.runMutation(async () => {
      for (const step of SYNC_APPLY_STEP_ORDER) state.values[step] = `target:${step}`;
      return { operationId: 'operation-1' };
    })).resolves.toEqual({ operationId: 'operation-1' });
    expect(state.values).toEqual(targetValues());
    expect(state.restoreCalls).toEqual([]);
    expect(journal.current).toBeNull();
  });

  it('rolls back when commit deletion fails before removing the journal', async () => {
    const state = new FakeLocalState();
    const journal = new FakeJournal({ clearModes: ['before', 'success'] });
    const coordinator = createCoordinator(state, journal);

    await expect(coordinator.runMutation(async () => {
      for (const step of SYNC_APPLY_STEP_ORDER) state.values[step] = `target:${step}`;
      return { operationId: 'operation-1' };
    })).rejects.toThrow('journal clear before');
    expect(state.values).toEqual(beforeValues());
    expect(journal.current).toBeNull();
  });

  it('fails explicitly without guessing when commit deletion cannot be verified', async () => {
    const state = new FakeLocalState();
    const journal = new FakeJournal({ clearModes: ['before'], failReadAt: 2 });
    const coordinator = createCoordinator(state, journal);

    await expect(coordinator.runMutation(async () => {
      for (const step of SYNC_APPLY_STEP_ORDER) state.values[step] = `target:${step}`;
      return { operationId: 'operation-1' };
    })).rejects.toBeInstanceOf(SyncLocalCommitOutcomeUnknownError);
    expect(state.values).toEqual(targetValues());
    expect(state.restoreCalls).toEqual([]);
    expect(journal.current).not.toBeNull();
  });

  for (const failedRestoreStep of SYNC_APPLY_STEP_ORDER) {
    for (const mode of ['before', 'after'] as const) {
      it(`keeps the journal when rollback restore of ${failedRestoreStep} fails ${mode} commit`, async () => {
        const state = new FakeLocalState({
          restoreFailure: { step: failedRestoreStep, mode },
        });
        const journal = new FakeJournal();
        const coordinator = createCoordinator(state, journal);

        await expect(coordinator.runMutation(async () => {
          for (const step of SYNC_APPLY_STEP_ORDER) state.values[step] = `target:${step}`;
          throw new Error('mutation failed');
        })).rejects.toThrow('rollback is incomplete');
        expect(state.restoreCalls).toEqual([...SYNC_APPLY_STEP_ORDER].reverse());
        expect(journal.current).not.toBeNull();
        // ⚠️ **两档要分别钉住** —— 不加这两条断言时，`before` 与 `after` 只在
        // `FakeLocalState` 内部有区别，用例本身看不出来（变异注入「before 不抛」
        // 能不能被抓住全靠这条）。判据是手写期望，不是「与另一档相等」：
        //   before ⇒ 抛在赋值**之前**，该槽仍是上一次的值；
        //   after  ⇒ 抛在赋值**之后**，该槽已经是回滚后的值。
        expect(state.values[failedRestoreStep]).toBe(
          mode === 'before' ? `target:${failedRestoreStep}` : `before:${failedRestoreStep}`,
        );

        state.restoreFailure = null;
        const restarted = createCoordinator(state, journal, 'operation-2');
        await expect(restarted.recover()).resolves.toEqual({
          recovered: true,
          operationId: 'operation-1',
        });
        expect(state.values).toEqual(beforeValues());
        expect(journal.current).toBeNull();
        await expect(restarted.recover()).resolves.toEqual({ recovered: false, operationId: null });
      });
    }
  }

  it('recovers every interrupted apply prefix after a worker restart', async () => {
    for (let prefix = 0; prefix <= SYNC_APPLY_STEP_ORDER.length; prefix += 1) {
      const state = new FakeLocalState();
      for (const step of SYNC_APPLY_STEP_ORDER.slice(0, prefix)) state.values[step] = `target:${step}`;
      const journal = new FakeJournal();
      journal.current = await createJournal('crashed-operation');

      const restarted = createCoordinator(state, journal, 'retry-operation');
      await expect(restarted.recover()).resolves.toEqual({
        recovered: true,
        operationId: 'crashed-operation',
      });
      expect(state.values).toEqual(beforeValues());
      expect(journal.current).toBeNull();
    }
  });

  it('retries the same mutation idempotently after a rolled-back failure', async () => {
    const state = new FakeLocalState();
    const journal = new FakeJournal();
    const coordinator = createCoordinator(state, journal);

    let shouldFail = true;
    await expect(coordinator.runMutation(async () => {
      state.values.presets = 'target:presets';
      if (shouldFail) throw new Error('preset write failed');
    })).rejects.toThrow('preset write failed');

    shouldFail = false;
    await expect(coordinator.runMutation(async () => {
      for (const step of SYNC_APPLY_STEP_ORDER) state.values[step] = `target:${step}`;
      return { operationId: 'operation-1' };
    })).resolves.toEqual({ operationId: 'operation-1' });
    expect(state.values).toEqual(targetValues());
    expect(journal.current).toBeNull();
  });

  it('discards an unreadable journal and continues instead of blocking every locked operation', async () => {
    const invalidRecords: unknown[] = [
      { ...(await createJournal('future')), schemaVersion: 2 },
      { ...(await createJournal('checksum')), preimageChecksum: { algorithm: 'sha256', value: '0'.repeat(64) } },
      { kind: 'corrupt' },
    ];

    for (const record of invalidRecords) {
      const state = new FakeLocalState();
      const journal = new FakeJournal();
      journal.current = structuredClone(record);
      const discarded: unknown[] = [];
      const coordinator = createCoordinator(state, journal, 'operation-1', {
        onJournalDiscarded: (error) => discarded.push(error),
      });

      // 丢弃 + 继续，**不抛** —— 抛出去会让 `withSyncLocalStateLock` 前置的
      // 恢复步骤拦住之后每一次加锁操作（含只读入口）。
      await expect(coordinator.recover()).resolves.toEqual({
        recovered: false,
        operationId: null,
      });
      expect(state.values).toEqual(beforeValues());
      expect(state.restoreCalls).toEqual([]);
      // journal 被清掉了 ⇒ 下一轮不再卡住。
      expect(journal.current).toBeNull();
      expect(discarded).toHaveLength(1);
      await expect(coordinator.recover()).resolves.toEqual({
        recovered: false,
        operationId: null,
      });
    }
  });

  it('keeps a journal whose read failed, so a later attempt can still roll it back', async () => {
    const state = new FakeLocalState();
    const journal = new FakeJournal({ failReadAt: 1 });
    journal.current = await createJournal('pending');
    const discarded: unknown[] = [];
    const coordinator = createCoordinator(state, journal, 'operation-1', {
      onJournalDiscarded: (error) => discarded.push(error),
    });

    await expect(coordinator.recover()).rejects.toThrow('journal read failed');
    // ⚠️ 读失败是基础设施故障、不是「读不出来」，journal 必须留着。
    expect(journal.current).not.toBeNull();
    expect(discarded).toEqual([]);
  });
});

class FakeLocalState implements SyncLocalStatePort {
  values = beforeValues();
  restoreCalls: SyncApplyStep[] = [];
  restoreFailure: { step: SyncApplyStep; mode: 'before' | 'after' } | null;

  constructor(options: {
    restoreFailure?: { step: SyncApplyStep; mode: 'before' | 'after' };
  } = {}) {
    this.restoreFailure = options.restoreFailure ?? null;
  }

  async captureUndoPreimage() {
    return structuredClone(BEFORE);
  }

  async restoreStep(step: SyncApplyStep) {
    this.restoreCalls.push(step);
    if (this.restoreFailure?.step === step && this.restoreFailure.mode === 'before') {
      throw new Error(`restore ${step} before`);
    }
    this.values[step] = `before:${step}`;
    if (this.restoreFailure?.step === step && this.restoreFailure.mode === 'after') {
      throw new Error(`restore ${step} after`);
    }
  }
}

class FakeJournal implements SyncLocalApplyJournalPort {
  current: unknown | null = null;
  events: string[] = [];
  private readonly writeMode: 'success' | 'before' | 'after';
  private readonly clearModes: Array<'success' | 'before' | 'after'>;
  private readonly failReadAt: number | null;
  private readCount = 0;

  constructor(options: {
    writeMode?: 'success' | 'before' | 'after';
    clearModes?: Array<'success' | 'before' | 'after'>;
    failReadAt?: number;
  } = {}) {
    this.writeMode = options.writeMode ?? 'success';
    this.clearModes = [...(options.clearModes ?? [])];
    this.failReadAt = options.failReadAt ?? null;
  }

  async readCurrent() {
    this.events.push('read');
    this.readCount += 1;
    if (this.failReadAt === this.readCount) throw new Error('journal read failed');
    return this.current === null ? null : structuredClone(this.current);
  }

  async writeCurrent(record: SyncLocalApplyJournalV1) {
    this.events.push('write');
    if (this.writeMode === 'before') throw new Error('journal write before');
    this.current = structuredClone(record);
    if (this.writeMode === 'after') throw new Error('journal write after');
  }

  async clearCurrent() {
    this.events.push('clear');
    const mode = this.clearModes.shift() ?? 'success';
    if (mode === 'before') throw new Error('journal clear before');
    this.current = null;
    if (mode === 'after') throw new Error('journal clear after');
  }
}

function createCoordinator(
  state: FakeLocalState,
  journal: FakeJournal,
  operationId = 'operation-1',
  options: { onJournalDiscarded?: (error: unknown) => void } = {},
) {
  return createSyncLocalApplyCoordinator(state, journal, {
    now: () => 1_700_000_000_000,
    createOperationId: () => operationId,
    ...options,
  });
}

async function createJournal(operationId: string): Promise<SyncLocalApplyJournalV1> {
  const preimage = structuredClone(BEFORE);
  return {
    kind: SYNC_LOCAL_APPLY_JOURNAL_KIND,
    schemaVersion: SYNC_LOCAL_APPLY_JOURNAL_SCHEMA_VERSION,
    operationId,
    createdAt: 1_700_000_000_000,
    preimage,
    preimageChecksum: await createSha256Checksum(JSON.stringify(preimage)),
  };
}

function beforeValues(): Record<SyncApplyStep, string> {
  return Object.fromEntries(
    SYNC_APPLY_STEP_ORDER.map((step) => [step, `before:${step}`]),
  ) as Record<SyncApplyStep, string>;
}

function targetValues(): Record<SyncApplyStep, string> {
  return Object.fromEntries(
    SYNC_APPLY_STEP_ORDER.map((step) => [step, `target:${step}`]),
  ) as Record<SyncApplyStep, string>;
}
