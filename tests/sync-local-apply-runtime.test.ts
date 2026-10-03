import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withSyncLocalStateLock } from '../core/persistence/local-state-lock';

/**
 * 本地状态锁与**必需恢复（required recovery）**的交互语义。
 *
 * 从上游 `sync-local-apply-runtime.test.ts` 移植。⚠️ **被测函数换了**：
 * 上游测的是 `stageAndApplySyncSnapshotLocally`（「应用下载到的快照」），
 * 那条路径随 WebDAV 同步子系统一起在本项目**被删除**，`core/sync/local-apply-runtime.ts`
 * 现在只剩两个导出。
 *
 * 但**它守的机制在本项目是活的**：`runLocalStateMutationWithRecovery` 保留了同一套
 * `withSyncLocalStateLock` + `runCoordinatorOperation` + `requireLocalStateRecovery`，
 * 而它被 `entrypoints/background.ts` 的 `beginLocalStateMutation` 用作**所有持久化
 * 变更**的入口（删 skill / 删 source / 删 preset / 删项目上下文 / 导入 skill …）。
 * 所以下面两条契约测的是**真正在跑的那条路径**：
 *
 *  ① **失败的操作必须留下「必需恢复」**，且**下一次取得锁的人要替它重试**
 *     —— 这是 `withSyncLocalStateLock` 开头那句 `recoverRequiredLocalStateAlreadyLocked()`
 *     的全部意义；没有它，一次失败的变更会让本地状态永远停在半途。
 *  ② **重试发生在同一个锁内**，排在队列里的普通写入**不会**抢到前面
 *     —— 否则普通写入会写到一个尚未恢复的半途状态上。
 *
 * ⚠️ 与上游的调用序差异（本项目实际形状）：上游是 `stage → apply`；
 * 本项目是 `recover → stage → runMutation`（多了一次入口 recover）。
 */

const coordinator = vi.hoisted(() => ({
  recover: vi.fn(),
  runMutation: vi.fn(),
}));

vi.mock('../core/sync/local-apply', () => ({
  createSyncLocalApplyCoordinator: () => coordinator,
}));
vi.mock('../core/sync/apply-journal', () => ({
  indexedDbSyncLocalApplyJournal: {},
}));
vi.mock('../core/sync/local-state-browser', () => ({
  browserSyncLocalStatePort: {},
}));

import { runLocalStateMutationWithRecovery } from '../core/sync/local-apply-runtime';

beforeEach(() => {
  coordinator.recover.mockReset();
  coordinator.runMutation.mockReset();
});

describe('sync local-apply runtime lock integration', () => {
  it('recovers inside the failed mutation lock before a queued ordinary write', async () => {
    const events: string[] = [];
    let rejectMutation!: (error: Error) => void;
    coordinator.recover
      // 入口那次 recover：无事可恢复
      .mockImplementationOnce(async () => {
        events.push('recover:entry');
        return { recovered: false, operationId: null };
      })
      // 失败操作内部的恢复尝试：也失败 ⇒ 留下「必需恢复」
      .mockImplementationOnce(async () => {
        events.push('recover:failed');
        throw new Error('recovery unavailable');
      })
      // 队列里下一个取锁者的重试：成功
      .mockImplementationOnce(async () => {
        events.push('recover:retried');
        return { recovered: true, operationId: 'operation-1' };
      });
    coordinator.runMutation.mockImplementation(() => new Promise<void>((_resolve, reject) => {
      events.push('runMutation');
      rejectMutation = reject;
    }));

    const mutation = runLocalStateMutationWithRecovery(async () => {
      events.push('stage');
      return async () => { events.push('mutation:body'); };
    });
    await vi.waitFor(() => expect(events).toEqual(['recover:entry', 'stage', 'runMutation']));
    const ordinaryWrite = withSyncLocalStateLock(async () => {
      events.push('ordinary:write');
    });

    rejectMutation(new Error('mutation failed'));
    await expect(mutation).rejects.toThrow('required recovery remains pending');
    await ordinaryWrite;
    // ⚠️ 关键顺序：`recover:retried` 必须排在 `ordinary:write` **之前**
    // —— 它是那个普通写入自己取锁时的入口恢复，不是失败操作补做的。
    expect(events).toEqual([
      'recover:entry',
      'stage',
      'runMutation',
      'recover:failed',
      'recover:retried',
      'ordinary:write',
    ]);
  });

  it('recovers before staging a second queued mutation', async () => {
    const events: string[] = [];
    let rejectFirstMutation!: (error: Error) => void;
    coordinator.recover
      .mockImplementationOnce(async () => {
        events.push('recover:entry:first');
        return { recovered: false, operationId: null };
      })
      .mockImplementationOnce(async () => {
        events.push('recover:failed');
        throw new Error('recovery unavailable');
      })
      .mockImplementationOnce(async () => {
        events.push('recover:entry:second');
        return { recovered: true, operationId: 'operation-1' };
      });
    coordinator.runMutation
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        events.push('runMutation:first');
        rejectFirstMutation = reject;
      }))
      .mockImplementationOnce(async () => {
        events.push('runMutation:second');
      });

    const first = runLocalStateMutationWithRecovery(async () => {
      events.push('stage:first');
      return async () => undefined;
    });
    await vi.waitFor(() => expect(events).toEqual([
      'recover:entry:first',
      'stage:first',
      'runMutation:first',
    ]));
    const second = runLocalStateMutationWithRecovery(async () => {
      events.push('stage:second');
      return async () => undefined;
    });

    rejectFirstMutation(new Error('mutation failed'));
    await expect(first).rejects.toThrow('required recovery remains pending');
    await expect(second).resolves.toBeUndefined();
    // 第二个变更**先恢复、再 stage** —— 顺序反了就会在未恢复的状态上暂存
    expect(events).toEqual([
      'recover:entry:first',
      'stage:first',
      'runMutation:first',
      'recover:failed',
      'recover:entry:second',
      'stage:second',
      'runMutation:second',
    ]);
  });

  it('keeps the mutation body inside the lock so a concurrent write cannot interleave', async () => {
    // 上游没有这一条，但它是「锁」这个前提本身：`stage` 返回的操作在
    // `runCoordinatorOperation` 里被 await，而 `runCoordinatorOperation` 在
    // `withSyncLocalStateLock` 的回调内 —— 所以并发的普通写入排不进来。
    const events: string[] = [];
    coordinator.recover.mockResolvedValue({ recovered: false, operationId: null });
    coordinator.runMutation.mockImplementation(async () => {
      events.push('runMutation:start');
      await Promise.resolve();
      events.push('runMutation:end');
    });

    const mutation = runLocalStateMutationWithRecovery(async () => {
      events.push('stage');
      return async () => { events.push('mutation:body'); };
    });
    const ordinaryWrite = withSyncLocalStateLock(async () => {
      events.push('ordinary:write');
    });

    await Promise.all([mutation, ordinaryWrite]);
    expect(events).toEqual([
      'stage',
      'runMutation:start',
      'runMutation:end',
      'ordinary:write',
    ]);
  });
});