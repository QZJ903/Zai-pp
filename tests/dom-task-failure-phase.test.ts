import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDomTaskCoordinator } from '../core/zai/dom-task-coordinator';
import { ZAI_DOM_TASK_CANCELLED_CODE } from '../core/zai/contracts';

/**
 * 协调器在**失败定档**上的契约：`phase` 由**错误码**决定，不由调用时机决定。
 *
 * 为什么要单测这一条：`phase` 是 `scheduler.completeRun` 判定 run 终态的唯一依据
 * （`'cancelled'` → run 显示「已取消」，其余 → 「失败」）。而**取消与其它失败走的是
 * 同一条回传通道**（都是 `DOM_TASK_FAILED`），只有错误码能区分 —— 一旦这里的映射写错，
 * 用户点 Stop 之后卡片会显示「失败」，而没有任何测试会红。
 *
 * ⚠️ 上游对照：上游没有 `'cancelled'` 这一档，它是靠 `scheduler` 里
 * `code === 'dom_automation_cancelled'` 这个**拼出来的字符串**特判的 ——
 * 那是「判定端抄生产端字面量」的老形态，两侧各写一遍、改一处不报错。
 */

function createCoordinator() {
  return createDomTaskCoordinator({
    queryTabs: vi.fn(async () => [
      { id: 7, url: 'https://chat.z.ai/', active: false, windowId: 1 } as chrome.tabs.Tab,
    ]),
    sendTabMessage: vi.fn(async () => ({ ok: true })),
    updateTab: vi.fn(async (tabId) => ({ id: tabId } as chrome.tabs.Tab)),
    createTab: vi.fn(async () => ({ id: 8 } as chrome.tabs.Tab)),
    // 站点兜底：桩掉它，测试就不必依赖 chrome.storage。
    readActiveSiteOrigin: vi.fn(async () => 'https://chat.z.ai'),
    reportError: vi.fn(),
  });
}

/**
 * 走一遍握手把 task 登记进 pending，再回传给定的错误码。
 *
 * ⚠️ **等待用宏任务、不用「两拍微任务」** —— `startTask` 在登记 pending 之前要
 * `await resolveDomTab`，而那里现在会**按站点逐个查标签页**（几拍微任务取决于站点数量）。
 * 用固定拍数会在站点数量变化时静默失效（表现：`onFailed` 早于登记、promise 永不 settle
 * ⇒ 5 秒超时）。宏任务能一次性冲干所有待决微任务。
 */
async function settleWithError(error: string) {
  const coordinator = createCoordinator();
  const pending = coordinator.startTask(
    { taskId: 'task-1', kind: 'automation', prompt: 'run', chatSessionId: null },
    { handshakeTimeoutMs: 1_000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  coordinator.onFailed({ taskId: 'task-1', error });
  return pending;
}

describe('dom task failure phase', () => {
  it('marks the cancelled code as phase cancelled, not runner', async () => {
    const outcome = await settleWithError(ZAI_DOM_TASK_CANCELLED_CODE);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.phase).toBe('cancelled');
    expect(outcome.error).toBe(ZAI_DOM_TASK_CANCELLED_CODE);
  });

  it('keeps every other failure code on the runner phase', async () => {
    for (const code of [
      'composer_inject_failed',
      'continuation_loop_missing',
      'continuation_loop_superseded',
      'continuation_session_id_missing',
      'no_textarea',
      'dom_task_failed',
    ]) {
      const outcome = await settleWithError(code);

      expect(outcome.ok, `${code} 应当是失败`).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.phase, `${code} 不该被归成 cancelled`).toBe('runner');
    }
  });

  it('keeps cancelled out of the retryable pre-send set', async () => {
    // 取消**不能**被判成 retrySafe —— 那会让 scheduler 自动重跑一个用户刚停掉的任务。
    const outcome = await settleWithError(ZAI_DOM_TASK_CANCELLED_CODE);

    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.retrySafe).toBe(false);
  });

  it('keeps the content script emitting the very same code the coordinator matches on', () => {
    // ⚠️ 这条守的是**生产端与判定端同源**：内容脚本发 `ZAI_DOM_TASK_CANCELLED_CODE`、
    // 协调器也拿它比对。两边若各写一遍字面量，改一处另一处不报错 —— 只是「取消」
    // 静默退回「失败」。所以这里直接读源码断言**内容脚本没有写裸字面量**。
    //
    // ⚠️ 断言的是「发出去的 error 字段用的是常量」而不是「文件里出现过常量名」——
    // 后者在 import 语句上就恒真（`includes` 型断言的老毛病）。
    const source = readFileSync(
      resolve(process.cwd(), 'entrypoints/zai.content.ts'),
      'utf8',
    );

    expect(source).toMatch(/import\s*\{[\s\S]*?ZAI_DOM_TASK_CANCELLED_CODE[\s\S]*?\}\s*from\s*'\.\.\/core\/zai\/contracts';/);
    expect(source).toContain('error: ZAI_DOM_TASK_CANCELLED_CODE,');
    // 报送取消的两处都不许写裸字面量
    expect(source).not.toContain("error: 'cancelled',");
  });
});