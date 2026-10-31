import { indexedDbSyncLocalApplyJournal } from './apply-journal';
import { createSyncLocalApplyCoordinator } from './local-apply';
import { browserSyncLocalStatePort } from './local-state-browser';
import {
  clearRequiredLocalStateRecovery,
  recoverRequiredLocalStateAlreadyLocked,
  requireLocalStateRecovery,
  withSyncLocalStateLock,
  withSyncLocalStateRecoveryLock,
} from '../persistence/local-state-lock';

const coordinator = createSyncLocalApplyCoordinator(
  browserSyncLocalStatePort,
  indexedDbSyncLocalApplyJournal,
  {
    /**
     * 有一份**读不出来**的 journal 被丢弃（那次未完成的变更失去了回滚依据）。
     *
     * ⚠️ **只能 `log`，不能 `error`** —— 打 error 会让扩展错误面板长期挂红，
     * 而这件事不需要用户做任何事、也不影响任何后续操作。
     */
    onJournalDiscarded(error) {
      console.log('[Zai++] discarded unreadable sync local-apply journal', error);
    },
  },
);

async function recoverCoordinatorAlreadyLocked(): Promise<void> {
  await coordinator.recover();
}

export function runLocalStateMutationWithRecovery<T>(
  stage: () => Promise<() => Promise<T>>,
): Promise<T> {
  return withSyncLocalStateLock(async () => {
    await coordinator.recover();
    const operation = await stage();
    return runCoordinatorOperation(() => coordinator.runMutation(operation));
  });
}

export function recoverPendingSyncLocalApply() {
  return withSyncLocalStateRecoveryLock(async () => {
    try {
      const result = await coordinator.recover();
      clearRequiredLocalStateRecovery(recoverCoordinatorAlreadyLocked);
      return result;
    } catch (error) {
      requireLocalStateRecovery(recoverCoordinatorAlreadyLocked);
      throw error;
    }
  });
}

async function runCoordinatorOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (applyError) {
    requireLocalStateRecovery(recoverCoordinatorAlreadyLocked);
    try {
      await recoverRequiredLocalStateAlreadyLocked();
    } catch (recoveryError) {
      throw new AggregateError(
        [applyError, recoveryError],
        'Local-state mutation failed and required recovery remains pending',
      );
    }
    throw applyError;
  }
}
