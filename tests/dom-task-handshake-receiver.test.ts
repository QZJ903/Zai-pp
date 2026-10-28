import { describe, expect, it, vi } from 'vitest';
import { createDomTaskCoordinator } from '../core/zai/dom-task-coordinator';

/**
 * 握手失败时，「这个页面里没有我们的内容脚本」与「页面在、但没应答」必须分开报。
 *
 * 起因：扩展被重新加载后，已经打开的 z.ai 标签页里那份内容脚本不属于当前扩展实例，
 * `tabs.sendMessage` 会一直抛 `Receiving end does not exist` —— 而用户收到的提示是
 * 「请确认 Zai 标签页已打开」，可他明明就停在这个页面上。
 *
 * ⚠️ 判据是**每一次投递都收不到接收端**，不是「至少一次」：取宽松判据会把
 * 「前几拍还没加载完、后来应答了但内容不对」的标签也判成孤儿，把用户指向错误的成因。
 */

const MISSING_RECEIVER = new Error('Could not establish connection. Receiving end does not exist.');

function startTask(sendTabMessage: () => Promise<unknown>) {
  const coordinator = createDomTaskCoordinator({
    queryTabs: vi.fn(async () => [
      { id: 7, url: 'https://chat.z.ai/', active: false, windowId: 1 } as chrome.tabs.Tab,
    ]),
    sendTabMessage: vi.fn(sendTabMessage),
    updateTab: vi.fn(async (tabId) => ({ id: tabId } as chrome.tabs.Tab)),
    createTab: vi.fn(async () => ({ id: 8 } as chrome.tabs.Tab)),
    // 站点兜底：桩掉它，测试就不必依赖 chrome.storage。
    readActiveSiteOrigin: vi.fn(async () => 'https://chat.z.ai'),
    reportError: vi.fn(),
  });
  // 400ms 预算 ⇒ 两次投递（退避 300ms 后第二次，再退避 550ms 超时）。
  return coordinator.startTask(
    { taskId: 'task-1', kind: 'automation', prompt: 'run', chatSessionId: null },
    { handshakeTimeoutMs: 400 },
  );
}

describe('dom task handshake receiver state', () => {
  it('reports a missing content script when every attempt has no receiver', async () => {
    const outcome = await startTask(async () => {
      throw MISSING_RECEIVER;
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('dom_task_content_script_missing');
    expect(outcome.phase).toBe('bridge');
    // ⚠️ 这一档不带 `retrySafe`（握手失败一律不带），后台按「不是 true 就不重试」处理 ——
    // 内容脚本不会因为重跑就回来，判成可重试只会白跑一次。
    expect(outcome.retrySafe).not.toBe(true);
  });

  it('keeps the generic timeout when a receiver answered with nothing', async () => {
    // 有接收端、但没给出形状合法的答复（例如入站来源闸门拒了）—— 另一类失效，
    // 重试有意义，报错也不该指向「没有内容脚本」。
    const outcome = await startTask(async () => undefined);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('dom_task_handshake_timeout');
  });

  it('keeps the generic timeout when only some attempts had no receiver', async () => {
    // 第一拍接收端缺失、第二拍接收端在但没应答 ⇒ 不是孤儿（页面还在加载）。
    let call = 0;
    const outcome = await startTask(async () => {
      call += 1;
      if (call === 1) throw MISSING_RECEIVER;
      return undefined;
    });

    expect(call).toBeGreaterThan(1);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('dom_task_handshake_timeout');
  });

  it('does not confuse other delivery errors with a missing receiver', async () => {
    // 「标签页已经没了」与「接收端不存在」处置不同（前者该换标签），不能合并成一档。
    const outcome = await startTask(async () => {
      throw new Error('No tab with id: 7.');
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('dom_task_handshake_timeout');
  });

  it('reports a plain timeout when the budget is already spent before any attempt', async () => {
    // ⚠️ 这条守的是「一次都没试过」这一档：两个计数都是 0，若判据只写
    // `missingReceiverAttempts === attempt`，`0 === 0` 成立 ⇒ 会把「根本没投递过」
    // 误报成「页面里没有内容脚本」，把用户指向一个不存在的成因。
    const coordinator = createDomTaskCoordinator({
      queryTabs: vi.fn(async () => [
        { id: 7, url: 'https://chat.z.ai/', active: false, windowId: 1 } as chrome.tabs.Tab,
      ]),
      sendTabMessage: vi.fn(async () => ({ ok: true })),
      updateTab: vi.fn(async (tabId) => ({ id: tabId } as chrome.tabs.Tab)),
      createTab: vi.fn(async () => ({ id: 8 } as chrome.tabs.Tab)),
      readActiveSiteOrigin: vi.fn(async () => 'https://chat.z.ai'),
      reportError: vi.fn(),
    });

    const outcome = await coordinator.startTask(
      { taskId: 'task-1', kind: 'automation', prompt: 'run', chatSessionId: null },
      { handshakeTimeoutMs: 0 },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('dom_task_handshake_timeout');
  });
});
