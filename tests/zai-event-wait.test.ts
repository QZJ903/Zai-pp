import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWaiterRegistry,
  safeProbe,
  waitForDomCondition,
  waitForNotified,
} from '../core/zai/event-wait';

/**
 * 事件驱动等待原语。
 *
 * ⚠️⚠️ **这一组的核心判据是「定时器被压到 1000ms 时仍然成功」** —— 那正是
 * 后台标签的真实处境（Chrome 把 `setTimeout` 压到每秒一次，强化节流档压到每分钟）。
 * 只测「正常情况下能等到」是不够的：用轮询实现的旧代码在正常情况下也能过。
 */

/**
 * 把 `setTimeout` 压成「最早 1000ms 才触发」，模拟后台标签节流。
 *
 * ⚠️ **只压定时器，不动 MutationObserver** —— 那正是真机的样子
 * （实测后台：观察器 p50 138ms、`setInterval` p50 998ms）。
 */
function throttleTimers(): () => void {
  const realSetTimeout = globalThis.setTimeout;

  // ⚠️ 只包 `setTimeout` —— `clearTimeout` 收的是同一个句柄，原样传回去即可
  // （jsdom 里是 number，Node 里是 Timeout 对象，所以这里不碰类型）。
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
    const delay = Math.max(timeout ?? 0, 1_000);
    return (realSetTimeout as (...args: unknown[]) => unknown)(
      handler, delay, ...rest,
    );
  }) as unknown as typeof setTimeout;

  return () => {
    globalThis.setTimeout = realSetTimeout;
  };
}

/** 等到下一轮微任务 + 一遍观察器回调。 */
const tick = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

let dom: HTMLDivElement;

beforeEach(() => {
  document.body.innerHTML = '';
  dom = document.createElement('div');
  document.body.appendChild(dom);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('safeProbe', () => {
  it('swallows a throwing probe and reports "not satisfied"', () => {
    // ⚠️ `getComputedStyle` 在脱连节点上会抛 —— 「暂时读不到」不能等于「条件不成立」，
    // 更不能把整个等待打断。
    expect(safeProbe(() => { throw new Error('boom'); })).toBeNull();
    expect(safeProbe(() => undefined)).toBeNull();
    expect(safeProbe(() => 'ok')).toBe('ok');
    expect(safeProbe(() => false)).toBe(false);
  });
});

describe('waitForDomCondition', () => {
  it('resolves immediately when the condition already holds', async () => {
    const value = await waitForDomCondition<string>({
      probe: () => 'ready',
      timeoutMs: 5_000,
      fallback: () => 'timeout',
    });
    expect(value).toBe('ready');
  });

  it('resolves on a DOM mutation, well before the timeout', async () => {
    const started = Date.now();
    const promise = waitForDomCondition<HTMLButtonElement>({
      probe: () => document.querySelector<HTMLButtonElement>('#go:not([disabled])'),
      timeoutMs: 5_000,
      fallback: () => null as unknown as HTMLButtonElement,
    });

    await tick();
    const button = document.createElement('button');
    button.id = 'go';
    button.disabled = true;
    dom.appendChild(button);
    await tick();

    // ⚠️ 只改属性、不动节点 —— 这一档正是「发送按钮可用」的形态，
    // 少了 `attributes` 观察就永远等不到。
    button.disabled = false;
    const result = await promise;

    expect(result).toBe(button);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('resolves with a throttled timer (the real background case)', async () => {
    const restore = throttleTimers();
    try {
      const promise = waitForDomCondition<HTMLElement>({
        probe: () => document.querySelector<HTMLElement>('#late'),
        timeoutMs: 4_000,
        fallback: () => null as unknown as HTMLElement,
      });

      await tick();
      const el = document.createElement('div');
      el.id = 'late';
      dom.appendChild(el);

      // ⚠️ 这个 await 会立即返回 —— 若实现仍在用轮询，它得等满 1000ms 的兜底定时器，
      // 那时断言的时间上限就会破。这一条是整组测试的**主判据**。
      const result = await promise;
      expect(result).toBe(el);
    } finally {
      restore();
    }
  });

  it('falls back on timeout without waiting forever', async () => {
    const value = await waitForDomCondition<string>({
      probe: () => null,
      timeoutMs: 30,
      fallback: () => 'gave-up',
    });
    expect(value).toBe('gave-up');
  });

  it('keeps waiting when the probe throws mid-flight', async () => {
    let attempt = 0;
    const promise = waitForDomCondition<string>({
      probe: () => {
        attempt += 1;
        if (attempt === 1) return null;   // 首次探针：未成立
        if (attempt <= 3) throw new Error('transient');  // 中途读不到
        return 'ok';
      },
      timeoutMs: 2_000,
      fallback: () => 'timeout',
    });

    // 三次变动：前两次探针抛错（必须被吞、继续等），第三次才成立。
    for (let i = 0; i < 3; i += 1) {
      dom.appendChild(document.createElement('span'));
      await tick();
    }

    expect(await promise).toBe('ok');
  });

  it('resolves to the fallback when there is no observable root', async () => {
    const value = await waitForDomCondition<string>({
      probe: () => null,
      timeoutMs: 5_000,
      fallback: () => 'no-root',
      root: null,
    });
    expect(value).toBe('no-root');
  });

  it('degrades to the fallback when observe() throws, instead of rejecting', async () => {
    // ⚠️⚠️ **这条守的是「失败方向必须是静默降级」** —— `observer.observe()` 抛错时
    // 整个 Promise 会 reject，而调用方（`waitForComposerReady` 的 `.then`、
    // `trySubmitViaFormRequestSubmit` 的 `finally`）**都没有 catch**
    // ⇒ 一次观察器失败会让整条发送链抛错。
    //
    // ⚠️ 触发条件：`root` 不是合法 Node（真实场景是 body 在判断之后被换掉 / 被分离）。
    // 这里传一个普通对象模拟，断言它降级而不是抛。
    const bogus = {} as unknown as Node;
    await expect(waitForDomCondition<string>({
      probe: () => null,
      timeoutMs: 5_000,
      fallback: () => 'degraded',
      root: bogus,
    })).resolves.toBe('degraded');
  });
});

describe('waitForNotified', () => {
  it('resolves when the registry notifies', async () => {
    const registry = createWaiterRegistry();
    let counter = 0;

    const promise = waitForNotified(() => counter > 0, 5_000, registry);
    await tick();
    counter += 1;
    registry.notify();

    expect(await promise).toBe(true);
    // ⚠️ 结束后必须自动退订 —— 否则等过几百轮之后登记表会一直涨。
    expect(registry.size).toBe(0);
  });

  it('resolves with a throttled timer (the real background case)', async () => {
    const restore = throttleTimers();
    try {
      const registry = createWaiterRegistry();
      let counter = 0;
      const promise = waitForNotified(() => counter > 0, 5_000, registry);
      await tick();
      counter = 1;
      registry.notify();
      // 轮询实现要等满 1000ms 兜底定时器；事件实现立即返回。
      expect(await promise).toBe(true);
    } finally {
      restore();
    }
  });

  it('returns false on timeout and unregisters', async () => {
    const registry = createWaiterRegistry();
    const result = await waitForNotified(() => false, 30, registry);
    expect(result).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('keeps waiting when the predicate throws', async () => {
    const registry = createWaiterRegistry();
    let ok = false;
    const promise = waitForNotified(() => {
      if (!ok) throw new Error('transient');
      return true;
    }, 2_000, registry);

    await tick();
    registry.notify();      // 仍在抛错 —— 必须继续等
    await tick();
    ok = true;
    registry.notify();

    expect(await promise).toBe(true);
  });

  it('does not let one throwing waiter break the others', async () => {
    const registry = createWaiterRegistry();
    let reached = false;
    registry.add(() => { throw new Error('bad waiter'); });
    const unsubscribe = registry.add(() => { reached = true; });

    expect(() => registry.notify()).not.toThrow();
    expect(reached).toBe(true);
    unsubscribe();
    expect(registry.size).toBe(1);  // 只剩那个抛错的（它没退订）
  });
});