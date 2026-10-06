import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * **整键持久化**的边界：每个 store 必须拥有**自己的**串行队列，不许去蹭云同步那把全局锁。
 *
 * **为什么要有这条**：`withSyncLocalStateLock` 是**云同步的全局锁** —— 它保证「同步 apply
 * 期间没有别的写入」。如果某个 store 的日常写入也去抢这把锁，就会发生两件坏事：
 * ① 一次同步 apply 会把**所有** store 的普通写入一起挡住（同步慢 ⇒ 界面卡）；
 * ② 反过来，某个 store 的长写入会拖住同步 apply（`sync-recovery-barrier` 超时）。
 *
 * ⚠️ **所以判据是「这个文件不许出现 `withSyncLocalStateLock`」**，而不是「必须 import 队列」——
 * 前者才是真正要拦的形态。
 *
 * ⚠️ 上游对应文件是 `tests/whole-key-storage-boundary.test.ts`。⚠️ 上游 4 条里
 * **本项目只补 3 条**：第 3 条要求 usage 走 `sendRuntimeMessageStrict`，而本项目刻意用
 * **宽松的 `sendRuntimeMessage`**（既定取舍，见 `zai.content.ts` 的 `handleUsageSnapshot`）
 * —— 照搬会红，且那不是缺陷。
 *
 * ⚠️ **2026-10-06 实测：这 3 条对本项目全部通过**（写测试时逐条核过文件内容）。
 */
describe('whole-key persistence boundaries', () => {
  it('owns one independent queue per store instead of joining the sync-global lock', () => {
    for (const [path, queueFactory] of [
      ['core/automation/store.ts', 'createSerialOperationQueue'],
      ['core/mcp/store.ts', 'createSerialOperationQueue'],
      ['core/usage/store.ts', 'createCoalescingMutationQueue'],
      ['core/tool/history.ts', 'createCoalescingMutationQueue'],
    ] as const) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).toContain(queueFactory);
      // ⚠️ 这条是重点：抢全局锁 = 与云同步互相阻塞。
      expect(source, path).not.toContain('withSyncLocalStateLock');
    }
  });

  it('reuses the queue primitive for the sync recovery lock', () => {
    const source = readFileSync('core/persistence/local-state-lock.ts', 'utf8');
    expect(source).toContain('createSerialOperationQueue');
    // ⚠️ 反向断言：曾经有一版是手写 `.then(run, run)` 串行，它**在抛错路径上会断链**
    // （`run` 抛错时后一个分支拿到 rejection、队列停摆）。复用队列原语就不会。
    expect(source).not.toContain('.then(run, run)');
  });

  it('unwraps background failures before rendering Usage or Tool History data', () => {
    // ⚠️ 判据是「侧边栏必须经 `sidepanelRuntimeClient` 请求」—— 它内部会把后台的
    // `{ ok: false, error }` 转成异常（`isRuntimeFailure`）；直接 `chrome.runtime.sendMessage`
    // 会把那个对象当**成功响应**返回，页面拿到它再解包就晚了（表现为「界面只是重绘一次、
    // 什么都没变、也没有任何提示」）。
    const automation = readFileSync('entrypoints/sidepanel/pages/AutomationPage.tsx', 'utf8');
    expect(automation).toContain('decodeAutomationList');
    expect(automation).toContain('sidepanelRuntimeClient.request');
    expect(automation).not.toContain('chrome.runtime.sendMessage');

    const usage = readFileSync('entrypoints/sidepanel/components/settings/UsageSubPage.tsx', 'utf8');
    expect(usage).toContain('usageController.getSummary');

    const usageController = readFileSync('entrypoints/sidepanel/controllers/usage-controller.ts', 'utf8');
    expect(usageController).toContain('sidepanelRuntimeClient');
    expect(usageController).toContain('isUsageSummary(value)');

    const mcp = readFileSync('entrypoints/sidepanel/pages/McpPage.tsx', 'utf8');
    expect(mcp).toContain('useMcpPageController');

    const mcpController = readFileSync('entrypoints/sidepanel/controllers/mcp-tools-controller.ts', 'utf8');
    expect(mcpController).toContain('sidepanelRuntimeClient');
    expect(mcpController).toContain("decodeToolCallHistory(value, 'GET_TOOL_CALL_HISTORY response')");
  });

  it('keeps the sidepanel off the raw runtime channel entirely', () => {
    // ⚠️ 上面那条只查了三个文件；这条把范围扩到**整个 sidepanel**：
    // 唯一允许直接 `chrome.runtime.sendMessage` 的地方是 runtime client 自己。
    // 手抄的第二份清单必然分叉（B9）—— 所以这里用「扫目录 + 白名单一个文件」代替列举。
    const offenders = walk('entrypoints/sidepanel')
      .filter((path) => !path.endsWith('runtime-client.ts'))
      .filter((path) => readFileSync(path, 'utf8').includes('chrome.runtime.sendMessage'));
    expect(offenders).toEqual([]);
  });
});

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}
