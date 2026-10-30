import { describe, expect, it, vi } from 'vitest';
import {
  ZAI_MODEL_LIST_TIMEOUT_MS,
  createZaiModelCatalog,
} from '../core/zai/models';

/**
 * 模型清单那次请求的**上界**。
 *
 * ⚠️⚠️ 这条守的是一次「不可自愈」的失效：`list()` 用 `inFlight` 做并发合流，而它在
 * `finally` 里释放。请求挂住 ⇒ `fetchLive` 不返回 ⇒ `finally` 走不到 ⇒ 槽位被永久占住
 * ⇒ 之后每次 `list()` 都返回同一个未完成的 promise：**下拉一直是空的，连「不是最新」
 * 的提示都不出现**（`catch` 走不到）。
 *
 * ⇒ 判据是「**在上界内一定拿到结果**」，不是「不报错」。
 */

const LIVE = {
  data: [{ id: 'glm-5.3', name: 'GLM-5.3', info: { meta: { capabilities: { reasoning_effort: true } } } }],
};

function hangingFetch() {
  // 接受 signal 但永不 settle —— 只有 `AbortSignal` 能把这次调用中断。
  return (_input: string, init: RequestInit) => new Promise<never>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason ?? new Error('aborted'));
    }, { once: true });
  });
}

function catalogWith(fetchImpl: (input: string, init: RequestInit) => Promise<never>) {
  return createZaiModelCatalog({
    loadToken: async () => 'token-1',
    resolveOrigin: async () => 'https://chat.z.ai',
    fetchImpl,
  });
}

describe('model list request upper bound', () => {
  it('passes an abort signal to the request', () => {
    const seen: Array<RequestInit> = [];
    const catalog = createZaiModelCatalog({
      loadToken: async () => 'token-1',
      resolveOrigin: async () => 'https://chat.z.ai',
      fetchImpl: async (_input, init) => {
        seen.push(init);
        return { ok: true, status: 200, json: async () => LIVE };
      },
    });

    return catalog.list().then(() => {
      // ⚠️ 只断言「有 signal」不够 —— 还要断言它**不是已经 aborted 的**，
      // 否则一次布局错误就会让所有请求立刻失败（而且是静默掉兜底清单）。
      expect(seen).toHaveLength(1);
      expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
      expect(seen[0]!.signal!.aborted).toBe(false);
    });
  });

  it('gives up within the bound when the request never settles, and does not wedge the slot', async () => {
    vi.useFakeTimers();
    try {
      const catalog = catalogWith(hangingFetch());

      const first = catalog.list();
      // 让 `resolveOrigin` / `loadToken` 的微任务先跑完，请求进入挂起状态。
      await vi.advanceTimersByTimeAsync(0);

      // 第二次调用会命中 `inFlight` 那个槽位。
      const second = catalog.list();

      await vi.advanceTimersByTimeAsync(ZAI_MODEL_LIST_TIMEOUT_MS + 10);

      // ① 卡住的那次必须结束（超时 ⇒ 兜底清单），而不是永远 pending。
      await expect(first).resolves.toMatchObject({ source: 'fallback' });
      // ② 并发的第二次也必须拿到同一个结果（共享在飞请求）。
      await expect(second).resolves.toMatchObject({ source: 'fallback' });

      // ③ **槽位必须已释放** —— 这是「不可自愈」那一半。换成能成功的请求，
      // 它必须真的打出去（若 `inFlight` 没清空，这里会直接拿到上面那个 fallback）。
      let calls = 0;
      const recovering = createZaiModelCatalog({
        loadToken: async () => 'token-1',
        resolveOrigin: async () => 'https://chat.z.ai',
        fetchImpl: async () => {
          calls += 1;
          return { ok: true, status: 200, json: async () => LIVE };
        },
      });
      await expect(recovering.list()).resolves.toMatchObject({ source: 'live' });
      expect(calls).toBe(1);

      // ④ 上界不能太长（用户等不起），也不能短到误伤正常请求。
      expect(ZAI_MODEL_LIST_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
      expect(ZAI_MODEL_LIST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the body read too, not just the header', async () => {
    vi.useFakeTimers();
    try {
      const catalog = createZaiModelCatalog({
        loadToken: async () => 'token-1',
        resolveOrigin: async () => 'https://chat.z.ai',
        // 响应头到了、body 永不到 —— 只包 fetch 的写法在这里会挂住。
        fetchImpl: (_input, init) => new Promise((resolve) => {
          const signal = init.signal;
          resolve({
            ok: true,
            status: 200,
            json: () => new Promise<never>((_res, reject) => {
              signal?.addEventListener('abort', () => {
                reject(signal.reason ?? new Error('aborted'));
              }, { once: true });
            }),
          });
        }),
      });

      const pending = catalog.list();
      await vi.advanceTimersByTimeAsync(ZAI_MODEL_LIST_TIMEOUT_MS + 10);
      await expect(pending).resolves.toMatchObject({ source: 'fallback' });
    } finally {
      vi.useRealTimers();
    }
  });
});