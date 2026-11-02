import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshAutomationNextRunAt } from '../core/automation/scheduler';
import {
  createAutomation,
  getAutomationById,
  updateAutomation,
  updateAutomationRuntime,
} from '../core/automation/store';

/**
 * `refreshAutomationNextRunAt` 与 `lastError` 的关系。
 *
 * `lastError` 一个字段承载**两种语义**：
 * - **排期校验错误**（`phase: 'schedule'`）—— 这条表达式算不出下一次运行；
 * - **运行期错误**（`phase: 'runner'` 等）—— 上一次运行失败。
 *
 * 这个函数只负责**排期**那一半。它原先无条件写 `lastError: null`，后果有两条，
 * 都是静默的：
 * ① 用户**只改个名字**保存（`UPDATE_AUTOMATION` 会连带调它）⇒ 上次运行的失败记录被抹掉，
 *    而卡片上那条红条本该留着；
 * ② 它在**外面读快照、在里面写新状态** —— 两次队列操作之间若有一次运行收尾写下
 *    运行期错误，那一条会被旧快照算出的 patch 覆盖掉。
 *
 * ⇒ 判据两条：**只在读到排期错误时才清**；**patch 必须在写盘那一刻求值**。
 */

function createChromeStub() {
  const storage = new Map<string, unknown>();
  return {
    storage,
    chromeStub: {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
          set: vi.fn(async (value: Record<string, unknown>) => {
            for (const [key, storedValue] of Object.entries(value)) storage.set(key, storedValue);
          }),
        },
      },
    },
  };
}

async function createScheduled(expression = '0 9 * * *') {
  return createAutomation({
    name: 'Scheduled',
    prompt: 'Run once.',
    schedule: {
      kind: 'cron',
      expression,
      timezone: 'Asia/Shanghai',
      enabled: true,
      minimumIntervalMinutes: 15,
    },
    promptOptions: { model: null, fixedSession: false },
  });
}

describe('refreshAutomationNextRunAt and lastError', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', createChromeStub().chromeStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not clear a runtime failure when the schedule is recomputed', async () => {
    const automation = await createScheduled();
    await updateAutomationRuntime(automation.id, {
      lastError: {
        code: 'automation_run_timeout',
        message: 'Automation run exceeded 180 seconds.',
        phase: 'runner',
        retryable: false,
        at: Date.now(),
      },
    });

    const refreshed = await refreshAutomationNextRunAt(automation.id);

    expect(refreshed?.nextRunAt, '排期仍然要算出来').not.toBeNull();
    // ⚠️ **这一条就是缺陷本身**：无条件 `lastError: null` 会把它清成 null。
    expect(refreshed?.lastError?.code).toBe('automation_run_timeout');
    expect(refreshed?.lastError?.phase).toBe('runner');
  });

  it('clears a schedule failure once the expression becomes valid again', async () => {
    // 反向：排期错误**该**被清 —— 否则卡片红条常驻、用户改回合法表达式也不消失。
    const automation = await createScheduled('0 0 30 2 *');
    const broken = await refreshAutomationNextRunAt(automation.id);
    expect(broken?.lastError?.phase).toBe('schedule');

    // 直接改库里那条记录（绕过 UI 的保存前校验），模拟「用户把表达式改回合法」。
    await updateAutomation(automation.id, {
      schedule: {
        kind: 'cron',
        expression: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        enabled: true,
        minimumIntervalMinutes: 15,
      },
    });

    const fixed = await refreshAutomationNextRunAt(automation.id);
    expect(fixed?.lastError).toBeNull();
    expect(fixed?.nextRunAt).not.toBeNull();
  });

  it('keeps the runtime failure even when the task stops being schedulable', async () => {
    const automation = await createScheduled();
    await updateAutomationRuntime(automation.id, {
      lastError: {
        code: 'automation_run_timeout',
        message: 'timed out',
        phase: 'runner',
        retryable: false,
        at: Date.now(),
      },
    });
    await updateAutomation(automation.id, {
      schedule: {
        kind: 'manual',
        expression: null,
        timezone: 'Asia/Shanghai',
        enabled: false,
        minimumIntervalMinutes: 15,
      },
    });

    const refreshed = await refreshAutomationNextRunAt(automation.id);

    expect(refreshed?.nextRunAt).toBeNull();
    expect(refreshed?.lastError?.code).toBe('automation_run_timeout');
  });

  it('returns null for an automation that no longer exists', async () => {
    await expect(refreshAutomationNextRunAt('missing-automation')).resolves.toBeNull();
  });

  /**
   * **patch 必须在写盘那一刻求值，不能拿外面读到的快照算。**
   *
   * 触发条件：读快照那一刻 `lastError` 恰好是**排期**错误（于是 patch 非空、要清），
   * 而两次队列操作之间有一次运行收尾写下**运行期**错误 ⇒ 旧快照的 `{ lastError: null }`
   * 会把它覆盖掉。
   *
   * 复现方式：让 `get` 在**第一次**被调用之后排一次并发写（`Promise.all` 同时发起
   * 刷新与运行收尾，靠串行队列的自然交错）。
   */
  it('does not let a stale snapshot wipe a runtime error written concurrently', async () => {
    const automation = await createScheduled();
    await updateAutomationRuntime(automation.id, {
      lastError: {
        code: 'cron_no_next_run',
        message: 'no next run in the lookahead window',
        phase: 'schedule',
        retryable: false,
        at: Date.now(),
      },
    });

    await Promise.all([
      refreshAutomationNextRunAt(automation.id),
      updateAutomationRuntime(automation.id, {
        lastError: {
          code: 'automation_run_timeout',
          message: 'timed out',
          phase: 'runner',
          retryable: false,
          at: Date.now(),
        },
      }),
    ]);

    const stored = await getAutomationById(automation.id);
    // ⚠️ 顺序取决于串行队列的入队顺序，所以这里只断言「不是 null」——
    // 无论谁后写，**运行期错误都不该被排期 patch 清成 null**。
    expect(stored?.lastError).not.toBeNull();
  });
});