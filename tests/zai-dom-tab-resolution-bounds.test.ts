import { describe, expect, it, vi } from 'vitest';
import { createDomTaskCoordinator } from '../core/zai/dom-task-coordinator';

/**
 * 标签页解析阶段的**上界覆盖**。
 *
 * ⚠️⚠️ 这条守的是一条会导致「自动化永久停摆且没有日志」的路径：
 * `startTask` 的 `deadlineTimer` 与 abort 监听都挂在**解析之后**才建立的 promise 执行器里
 * ⇒ 解析阶段原本没有任何超时或取消覆盖。它一旦不返回：
 * ① `startTask` 永不 settle；② 它的调用方是自动化执行器，租约的 `finally` 在等它
 * ⇒ 那条 run 永久停在 running、该自动化之后不再运行，而**没有任何报错**。
 *
 * ⇒ 判据是「**在 `deadlineAt` / `signal` 到达时，`startTask` 一定结束**」。
 */

const TAB = { id: 7, url: 'https://chat.z.ai/', active: false, windowId: 1 } as chrome.tabs.Tab;

function hangingQueryTabs() {
  return vi.fn(() => new Promise<chrome.tabs.Tab[]>(() => { /* 永不 settle */ }));
}

function baseDeps(queryTabs: () => Promise<chrome.tabs.Tab[]>) {
  return {
    queryTabs,
    sendTabMessage: vi.fn(async () => ({ ok: true })),
    updateTab: vi.fn(async (tabId: number) => ({ id: tabId }) as chrome.tabs.Tab),
    createTab: vi.fn(async () => ({ id: 8 }) as chrome.tabs.Tab),
    readActiveSiteOrigin: vi.fn(async () => 'https://chat.z.ai'),
    reportError: vi.fn(),
  };
}

describe('resolveDomTab is bounded by deadlineAt and the caller signal', () => {
  it('gives up at deadlineAt when the tab query never settles', async () => {
    const coordinator = createDomTaskCoordinator(baseDeps(hangingQueryTabs()));

    const startedAt = Date.now();
    await expect(
      coordinator.startTask(
        { taskId: 'task-1', kind: 'automation', prompt: 'run', chatSessionId: null },
        { deadlineAt: startedAt + 50 },
      ),
    ).rejects.toThrow('dom_task_deadline_exceeded');
  });

  it('gives up at deadlineAt when activating the new tab never settles', async () => {
    // ⚠️⚠️ **这条守的是「上界必须覆盖 `busyTabs.set` 之前的那一段」** ——
    // 激活新标签页排在 `busyTabs.set` 之前，而 `busyTabs` 一写就把 tab 锁给本 taskId。
    // `tabs.update` 若挂住：`startTask` 永不完结、tab 却已被锁 ⇒ 之后所有落在该 tab 的任务
    // 全判 busy，那条 run 永久停在 running，且没有任何日志。
    const coordinator = createDomTaskCoordinator({
      // 没有可复用的空闲 tab ⇒ 会新开一个 ⇒ isNewlyCreated = true ⇒ 走激活
      queryTabs: vi.fn(async () => [] as chrome.tabs.Tab[]),
      sendTabMessage: vi.fn(async () => ({ ok: true })),
      updateTab: vi.fn(() => new Promise<chrome.tabs.Tab>(() => { /* 永不 settle */ })),
      createTab: vi.fn(async () => ({ id: 8 }) as chrome.tabs.Tab),
      readActiveSiteOrigin: vi.fn(async () => 'https://chat.z.ai'),
      reportError: vi.fn(),
    });

    const startedAt = Date.now();
    await expect(
      coordinator.startTask(
        { taskId: 'task-activate', kind: 'automation', prompt: 'run', chatSessionId: null },
        { deadlineAt: startedAt + 50 },
      ),
    ).rejects.toThrow('dom_task_deadline_exceeded');
  });

  it('does not create a tab after the deadline has already passed', async () => {
    // ⚠️⚠️ **上界只决定「我们等不等它」，不会取消已经发起的那次调用** ——
    // 所以有副作用的动作（开标签页）必须在自己落地**之前**再看一眼。
    // 判据：解析被 deadline 打断后，`createTab` 一次都不该被调用。
    const createTab = vi.fn(async () => ({ id: 8 }) as chrome.tabs.Tab);
    const coordinator = createDomTaskCoordinator({
      // 查标签页慢于 deadline，且没有可复用的 ⇒ 正常情况下会走到 createTab
      queryTabs: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return [] as chrome.tabs.Tab[];
      }),
      sendTabMessage: vi.fn(async () => ({ ok: true })),
      updateTab: vi.fn(async (tabId: number) => ({ id: tabId }) as chrome.tabs.Tab),
      createTab,
      readActiveSiteOrigin: vi.fn(async () => 'https://chat.z.ai'),
      reportError: vi.fn(),
    });

    await expect(
      coordinator.startTask(
        { taskId: 'task-orphan', kind: 'automation', prompt: 'run', chatSessionId: null },
        { deadlineAt: Date.now() + 50 },
      ),
    ).rejects.toThrow('dom_task_deadline_exceeded');

    // 等足够久，让那次仍在飞的解析走完 —— 它不该在超时之后偷偷开出一个孤儿标签页。
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(createTab, '超时之后不该再开标签页').not.toHaveBeenCalled();
  });

  it('gives up when the caller signal aborts mid-resolution', async () => {
    const coordinator = createDomTaskCoordinator(baseDeps(hangingQueryTabs()));
    const controller = new AbortController();

    const pending = coordinator.startTask(
      { taskId: 'task-2', kind: 'automation', prompt: 'run', chatSessionId: null },
      { signal: controller.signal },
    );
    controller.abort(new Error('lease_lost'));

    await expect(pending).rejects.toThrow('lease_lost');
  });

  it('does not leave the task registered when resolution times out', async () => {
    // ⚠️ 解析阶段失败时 `pending` 还没写入、`busyTabs` 也还没写 —— 但这条要钉住的是
    // 「同一个 taskId 之后还能重新发起」。若有人在解析**之前**就登记，之后每次重试都会
    // 拿到 `task_already_registered`，而那个 taskId 对应的 run 永远跑不起来。
    const broken = createDomTaskCoordinator(baseDeps(hangingQueryTabs()));
    await expect(
      broken.startTask(
        { taskId: 'task-3', kind: 'automation', prompt: 'run', chatSessionId: null },
        { deadlineAt: Date.now() + 50 },
      ),
    ).rejects.toThrow('dom_task_deadline_exceeded');

    const healthy = createDomTaskCoordinator(baseDeps(vi.fn(async () => [TAB])));
    const pending = healthy.startTask(
      { taskId: 'task-3', kind: 'automation', prompt: 'run', chatSessionId: null },
      { handshakeTimeoutMs: 1_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 握手桩恒成功 ⇒ 会一直等终态事件；这里主动回传一条终态让它收尾，
    // 只为拿到 outcome 并确认「不是被注册挡掉」。
    healthy.onFailed({ taskId: 'task-3', error: 'stopped_for_test' });

    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).not.toBe('task_already_registered');
  });

  it('still resolves normally when nothing hangs', async () => {
    const coordinator = createDomTaskCoordinator(baseDeps(vi.fn(async () => [TAB])));

    const pending = coordinator.startTask(
      { taskId: 'task-4', kind: 'automation', prompt: 'run', chatSessionId: null },
      { handshakeTimeoutMs: 1_000, deadlineAt: Date.now() + 5_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    coordinator.onComplete({
      taskId: 'task-4',
      chatSessionId: 'session-1',
      assistantText: 'done',
      toolExecutions: [],
      steps: 1,
    });
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
  });
});