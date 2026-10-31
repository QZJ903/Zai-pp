import { createSerialOperationQueue } from './serial-operation-queue';

/**
 * 本地状态的**单一串行锁**：所有 store 的读写共用一条 FIFO。
 *
 * ⚠️⚠️ **它不可重入，而且没有任何运行时守卫** —— 在已经持锁的操作里再调一个
 * 会加锁的 API 会**永久死锁**（内层排在队尾等外层结束，外层又在 await 内层），
 * 没有报错、没有超时。⇒ 两类 API 不能塞进持锁区：
 *
 * - `versioned-repository` 的 `read()`
 * - `getAllSkills` / `getAllPresets` / `getSavedItemsState` / `getAllSavedItems`
 *
 * 它们的名字看不出会加锁。需要「在锁内读 / 写」时用对应的 `*AlreadyLocked` 变体
 * （`getUserSkillsAlreadyLocked` / `getSavedItemsStateAlreadyLocked` / …）。
 */
const localStateOperations = createSerialOperationQueue();
let requiredRecovery: (() => Promise<void>) | null = null;

export function requireLocalStateRecovery(recover: () => Promise<void>): void {
  requiredRecovery = recover;
}

export function clearRequiredLocalStateRecovery(recover: () => Promise<void>): void {
  if (requiredRecovery === recover) requiredRecovery = null;
}

export async function recoverRequiredLocalStateAlreadyLocked(): Promise<void> {
  const recover = requiredRecovery;
  if (!recover) return;
  await recover();
  clearRequiredLocalStateRecovery(recover);
}

export function withSyncLocalStateLock<T>(operation: () => Promise<T>): Promise<T> {
  return enqueueLocalStateOperation(async () => {
    await recoverRequiredLocalStateAlreadyLocked();
    return operation();
  });
}

export function withSyncLocalStateRecoveryLock<T>(operation: () => Promise<T>): Promise<T> {
  return enqueueLocalStateOperation(operation);
}

function enqueueLocalStateOperation<T>(operation: () => Promise<T>): Promise<T> {
  return localStateOperations.run(operation);
}
