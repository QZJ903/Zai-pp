import { describe, expect, it, vi } from 'vitest';
import { createSyncRecoveryBarrier } from '../core/sync/recovery-barrier';

describe('sync recovery barrier', () => {
  it('retries durable recovery after a transient failure', async () => {
    const recover = vi.fn()
      .mockRejectedValueOnce(new Error('transient recovery failure'))
      .mockResolvedValueOnce({ recovered: false });
    const onRecoveryFailure = vi.fn();
    const barrier = createSyncRecoveryBarrier({
      recover,
      notifyRecovered: vi.fn(),
      onRecoveryFailure,
    });

    await expect(barrier.ensureReady()).rejects.toThrow('transient recovery failure');
    await expect(barrier.ensureReady()).resolves.toBeUndefined();
    expect(recover).toHaveBeenCalledTimes(2);
    expect(onRecoveryFailure).toHaveBeenCalledOnce();
  });

  it('does not poison readiness when the post-recovery broadcast fails', async () => {
    const notificationError = new Error('broadcast failed');
    const onNotificationFailure = vi.fn();
    const recover = vi.fn().mockResolvedValue({ recovered: true });
    const notifyRecovered = vi.fn().mockRejectedValue(notificationError);
    const barrier = createSyncRecoveryBarrier({
      recover,
      notifyRecovered,
      onNotificationFailure,
    });

    await expect(barrier.ensureReady()).resolves.toBeUndefined();
    await Promise.resolve();
    await expect(barrier.ensureReady()).resolves.toBeUndefined();
    expect(recover).toHaveBeenCalledOnce();
    expect(notifyRecovered).toHaveBeenCalledWith({ recovered: true });
    expect(onNotificationFailure).toHaveBeenCalledWith(notificationError);
  });

  it('does not broadcast when the recovery check finds no journal', async () => {
    const notifyRecovered = vi.fn();
    const barrier = createSyncRecoveryBarrier({
      recover: vi.fn().mockResolvedValue({ recovered: false }),
      notifyRecovered,
    });

    await expect(barrier.ensureReady()).resolves.toBeUndefined();

    expect(notifyRecovered).not.toHaveBeenCalled();
  });

  it('blocks later dispatch on recovery after a failed apply', async () => {
    let finishRecovery!: (result: { recovered: boolean }) => void;
    const recover = vi.fn(() => new Promise<{ recovered: boolean }>((resolve) => {
      finishRecovery = resolve;
    }));
    const barrier = createSyncRecoveryBarrier({
      recover,
      notifyRecovered: vi.fn().mockResolvedValue(undefined),
    });

    const apply = barrier.trackApply(Promise.reject(new Error('apply failed')));
    await expect(apply).rejects.toThrow('apply failed');
    const dispatch = vi.fn();
    const waitingDispatch = barrier.ensureReady().then(dispatch);
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();

    finishRecovery({ recovered: true });
    await waitingDispatch;
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('holds every later gate on a stalled recovery — the wait is deliberately unbounded', async () => {
    // ⚠️⚠️ **这条钉的是「已知行为」，不是「期望行为」。**
    //
    // 恢复动作**没有超时**：它第一步读 IndexedDB，而 IndexedDB 的版本升级在别的连接
    // 占着旧版本时会一直挂着（W3C 语义），全仓对 IDB 零超时。恢复挂住 ⇒ 这个 promise
    // 永不 settle ⇒ 之后每一条走 `ensureReady()` 的命令都跟着等，包括只读。
    //
    // 现状是**刻意接受**的（`background.ts` 的运行时门控就是这么写的）：加超时会把
    // 「状态不自洽时不许读写」这条 fail-closed 破坏掉。所以这里不测「多久会超时」，
    // 而是把「不会超时、且同一条 promise 被所有后来者共享」这件事钉住 ——
    // 将来真要加超时，会先撞到这条用例，而不是悄悄改变失败方向。
    //
    // ⚠️ 写法上**不能 await 它**（那会让用例自己挂死、vitest 既不红也不绿）。
    // 用一个短定时器跟它竞速，只断言「这段时间内没 settle」。
    const recover = vi.fn(() => new Promise<{ recovered: boolean }>(() => {
      /* 永不 resolve：模拟一次挂住的 IDB 读 */
    }));
    const barrier = createSyncRecoveryBarrier({
      recover,
      notifyRecovered: vi.fn().mockResolvedValue(undefined),
    });

    const settledOrTimedOut = (promise: Promise<unknown>): Promise<string> => Promise.race([
      promise.then(() => 'settled', () => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still-waiting'), 50)),
    ]);

    expect(await settledOrTimedOut(barrier.ensureReady())).toBe('still-waiting');
    // 第二个调用者拿到的是**同一条** promise，不是新起一次恢复（所以也不会自愈）。
    expect(await settledOrTimedOut(barrier.ensureReady())).toBe('still-waiting');
    expect(recover).toHaveBeenCalledOnce();
  });
});
