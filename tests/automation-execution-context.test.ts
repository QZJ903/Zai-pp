import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AutomationExecutionStoppedError,
  createAutomationExecutionContext,
  readAutomationStopKind,
  throwIfAutomationAborted,
} from '../core/automation/execution';

/**
 * 自动化**执行上下文**的三个出口：`assertActive` / `throwIfAutomationAborted` /
 * `readAutomationStopKind`。
 *
 * **为什么值得单独测**：这三个出口是自动化「停下来」这件事的**唯一判据来源** ——
 * `core/automation/scheduler.ts` 靠它们决定一次运行是 `timeout`（可重试）还是
 * `cancelled`（用户主动停）/ `lease_lost`（租约被别人抢走）。
 * 判错的表现是**静默的行为改变**：用户点了停止，却按超时处理（或反过来，
 * 超时被当成用户取消、不重试）。而这三条路径**在此之前零直测**。
 *
 * ⚠️ **优先级顺序是刻意的**：`assertActive` 先判 deadline、再判租约、最后判 abort。
 * 顺序反过来会改变「同时超时又被取消」时报哪个 kind。
 *
 * ⚠️ 上游对应的是 `tests/automation-runner-execution.test.ts` —— 但那份测试的主体
 * （12 条里的 11 条）测的是 `core/automation/runner.ts`，**那个模块本项目没有**
 * （本项目自动化走 DOM 注入、由 `domTaskCoordinator` 驱动）。所以这里只覆盖
 * `execution.ts` 本身，**不照搬上游的 runner 用例**。
 */
const BASE_INPUT = {
  runId: 'run-1' as never,
  automationId: 'automation-1' as never,
  deadlineAt: 1_000,
  attempt: 1,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('automation execution context', () => {
  it('builds an idempotency key from the run id and a trimmed scope', () => {
    const execution = createAutomationExecutionContext({
      ...BASE_INPUT,
      signal: new AbortController().signal,
      isLeaseCurrent: () => true,
    });
    expect(execution.createIdempotencyKey('tool:1')).toBe('automation:run-1:tool:1');
    expect(execution.createIdempotencyKey('  tool:2  ')).toBe('automation:run-1:tool:2');
  });

  it('rejects an empty idempotency scope instead of building a colliding key', () => {
    const execution = createAutomationExecutionContext({
      ...BASE_INPUT,
      signal: new AbortController().signal,
      isLeaseCurrent: () => true,
    });
    // ⚠️ 空白 scope 若不拦，会造出 `automation:run-1:` 这种**同一次运行内必然重复**的 key
    // ⇒ 后续「按 key 去重」的地方会把两个不同的工具调用当成同一个。
    expect(() => execution.createIdempotencyKey('   ')).toThrow('must not be empty');
  });

  it('passes the identity fields through unchanged', () => {
    const controller = new AbortController();
    const execution = createAutomationExecutionContext({
      ...BASE_INPUT,
      attempt: 3,
      signal: controller.signal,
      isLeaseCurrent: () => true,
    });
    expect(execution.runId).toBe('run-1');
    expect(execution.automationId).toBe('automation-1');
    expect(execution.deadlineAt).toBe(1_000);
    expect(execution.attempt).toBe(3);
    expect(execution.signal).toBe(controller.signal);
  });

  it('reports a timeout once the deadline is reached, and stays quiet before it', () => {
    vi.useFakeTimers();
    const execution = createAutomationExecutionContext({
      ...BASE_INPUT,
      deadlineAt: 1_000,
      signal: new AbortController().signal,
      isLeaseCurrent: () => true,
    });

    vi.setSystemTime(999);
    expect(() => execution.assertActive()).not.toThrow();

    // ⚠️ 边界是 `>=`：到点即算超时（不是「超过」）。
    vi.setSystemTime(1_000);
    expect(() => execution.assertActive()).toThrow(AutomationExecutionStoppedError);
    expect(() => execution.assertActive()).toThrow(
      expect.objectContaining({ kind: 'timeout' }) as unknown as Error,
    );
  });

  it('reports lease_lost when the run no longer owns its lease', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const execution = createAutomationExecutionContext({
      ...BASE_INPUT,
      deadlineAt: 10_000,
      signal: new AbortController().signal,
      isLeaseCurrent: () => false,
    });
    expect(() => execution.assertActive()).toThrow(
      expect.objectContaining({ kind: 'lease_lost' }) as unknown as Error,
    );
  });

  it('checks the deadline before the lease, so a run that is both late and unleased is a timeout', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const execution = createAutomationExecutionContext({
      ...BASE_INPUT,
      deadlineAt: 1_000,
      signal: new AbortController().signal,
      isLeaseCurrent: () => false,
    });
    // ⚠️ 顺序是契约的一部分：超时的运行会被判「可重试」，租约丢失不会。
    expect(() => execution.assertActive()).toThrow(
      expect.objectContaining({ kind: 'timeout' }) as unknown as Error,
    );
  });

  it('rethrows the exact stop error carried by the abort reason', () => {
    // ⚠️⚠️ **必须冻结时钟**：`deadlineAt` 是**绝对时间戳**，而真实时钟是 2026 年（≈1.7e12 ms）
    // ⇒ `Date.now() >= 10_000` 恒真、会先抛 `timeout`，永远走不到 abort 分支。
    // **本条最初就是漏了这两行而实际为红**（真 vitest 跑出来的，不是静态推断）。
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const controller = new AbortController();
    const stop = new AutomationExecutionStoppedError('cancelled', 'stopped by the user');
    controller.abort(stop);
    const execution = createAutomationExecutionContext({
      ...BASE_INPUT,
      deadlineAt: 10_000,
      signal: controller.signal,
      isLeaseCurrent: () => true,
    });

    // ⚠️ 必须是**同一个实例**：调用方靠 `instanceof` + `kind` 分类，重新构造会丢 kind。
    expect(() => execution.assertActive()).toThrow(stop);
  });

  it('does nothing when the signal is not aborted', () => {
    expect(() => throwIfAutomationAborted(new AbortController().signal)).not.toThrow();
  });

  it('rethrows any Error reason, and only synthesises cancelled for a non-Error reason', () => {
    // ⚠️⚠️ **无参 `abort()` 这一档：不能断言抛的是哪一个类，只能断言语义（归成 `cancelled`）。**
    // 原因是**跨 realm 的类身份**，不是「两条分支」：
    // 测试环境（`--environment jsdom`）里 `AbortController` 仍是运行时自带的那个，
    // 它 `abort()` 产出的 `DOMException` 与断言里引用的 `DOMException` **不是同一个类**
    // ⇒ `expect(...).toThrow(DOMException)` 恒 false（实测：`constructor.name === 'DOMException'`、
    // `name === 'AbortError'`，但 `instanceof DOMException === false`）。
    // ⚠️ **生产代码走的仍是「原样抛出」那条分支**（`reason instanceof Error` 为真）——
    // 与真机一致，两种环境在**行为**上并没有分叉，分叉只在「测试里那个类名属于哪个 realm」。
    const bare = new AbortController();
    bare.abort();
    expect(() => throwIfAutomationAborted(bare.signal)).toThrow();
    // 关键：不管抛的是 DOMException 还是合成的 stop error，`readAutomationStopKind` 都给 `cancelled`。
    expect(readAutomationStopKind(bare.signal)).toBe('cancelled');

    // 「回落到 `cancelled`」那条分支在**任何环境**下都可达的输入是「非 Error 的 reason」
    // （`abort('str')` / `abort(42)` / `abort({})`）。
    const nonError = new AbortController();
    nonError.abort('stopped');
    expect(() => throwIfAutomationAborted(nonError.signal)).toThrow(
      expect.objectContaining({ kind: 'cancelled' }) as unknown as Error,
    );

    const withError = new AbortController();
    const reason = new Error('something else went wrong');
    withError.abort(reason);
    expect(() => throwIfAutomationAborted(withError.signal)).toThrow(reason);
  });

  it('reads the stop kind from the signal without throwing', () => {
    expect(readAutomationStopKind(new AbortController().signal)).toBeNull();

    for (const [kind, expected] of [
      ['timeout', 'timeout'],
      ['cancelled', 'cancelled'],
      ['lease_lost', 'lease_lost'],
    ] as const) {
      const controller = new AbortController();
      controller.abort(new AutomationExecutionStoppedError(kind, 'stopped'));
      expect(readAutomationStopKind(controller.signal), kind).toBe(expected);
    }

    // ⚠️ 非我们的错误 ⇒ 归成 `cancelled`（**不是** `lease_lost`）——
    // scheduler 靠这个区分「可重试」与「不可重试」，归错会让一次超时被反复重跑。
    // ⚠️ **这条也兜住了上面那个 DOMException**：`throwIfAutomationAborted` 会原样抛 DOMException，
    // 而 `scheduler.createStoppedRunFailure` 用 `instanceof AutomationExecutionStoppedError` 判失败后
    // **回落到本函数**拿 kind ⇒ 无参 `abort()` 最终仍被正确归成 `cancelled`。
    const foreign = new AbortController();
    foreign.abort(new Error('network blew up'));
    expect(readAutomationStopKind(foreign.signal)).toBe('cancelled');

    const bare = new AbortController();
    bare.abort();
    expect(readAutomationStopKind(bare.signal)).toBe('cancelled');
  });
});
