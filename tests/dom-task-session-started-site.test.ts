import { describe, expect, it, vi } from 'vitest';
import { createDomTaskCoordinator } from '../core/zai/dom-task-coordinator';

/**
 * 「本次运行落在哪个会话」回调里**必须同时带上站点**。
 *
 * **它守的是一个真实的用户可见缺陷**：消费者（`background.ts` 的
 * `persistAutomationSession`）要在那一刻**当场**拼一条可打开的会话 URL 落库，
 * 而**会话 id 在两站之间不通用**（token 也互不认）。消费者自己只能读到
 * 「记录里**上一次**运行的站点」—— 首次运行时那个值是 null，于是会拼成**默认站**
 * 的链接；国际站上跑任务时，运行期间侧边栏的「打开会话」点开是 401。
 *
 * ⇒ 站点在 `resolveDomTab` 挑中标签页时就已经定下（`entry.siteOrigin`），
 * **信息是齐的，只是必须送下去**。
 *
 * ⚠️ 写成**行为测试**（真调协调器、传桩、断言回调实参），不写 AST 断言 ——
 * 后者只能问「源码里有没有出现 `siteOrigin`」，问不出「它到底传对没传对」。
 * 理由见 `core/zai/capability-install.ts` 的文件头。
 */

/** 造一个协调器：标签页落在指定站点，回调里记录实参。 */
function startAgainstTab(tabUrl: string) {
  const onSessionStarted = vi.fn();
  const coordinator = createDomTaskCoordinator({
    tabUrlPatterns: ['*://zchat.z.ai/*', '*://chat.z.ai/*'],
    queryTabs: vi.fn(async () => [
      { id: 7, url: tabUrl, active: false, windowId: 1 } as chrome.tabs.Tab,
    ]),
    sendTabMessage: vi.fn(async () => ({ ok: true })),
    updateTab: vi.fn(async (tabId) => ({ id: tabId } as chrome.tabs.Tab)),
    createTab: vi.fn(async () => ({ id: 8 } as chrome.tabs.Tab)),
    readActiveSiteOrigin: vi.fn(async () => 'https://zchat.z.ai'),
    reportError: vi.fn(),
  });
  const pending = coordinator.startTask(
    { taskId: 'task-1', kind: 'automation', prompt: 'run', chatSessionId: null },
    { handshakeTimeoutMs: 1_000, onSessionStarted },
  );
  return { coordinator, pending, onSessionStarted };
}

/**
 * 等到协调器把 pending 登记完（`resolveDomTab` 要按站点逐个查标签页，拍数不定）。
 * ⚠️ **用宏任务、不用固定拍数的微任务** —— 站点数量变化时后者会静默失效。
 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('dom task session-started callback carries the site origin', () => {
  it('reports the site of the tab it actually picked (global)', async () => {
    const { coordinator, pending, onSessionStarted } = startAgainstTab('https://chat.z.ai/');
    await settle();

    coordinator.onStarted({ taskId: 'task-1', chatSessionId: 'sess-1' });

    expect(onSessionStarted).toHaveBeenCalledTimes(1);
    // ⚠️ 判据是**两个实参都断言** —— 只断言会话 id 的话，「站点没传」会静默通过。
    expect(onSessionStarted).toHaveBeenCalledWith('sess-1', 'https://chat.z.ai');
    coordinator.onFailed({ taskId: 'task-1', error: 'cancelled' });
    await pending;
  });

  it('reports the CN station when that is the tab it picked', async () => {
    const { coordinator, pending, onSessionStarted } = startAgainstTab('https://zchat.z.ai/');
    await settle();

    coordinator.onStarted({ taskId: 'task-1', chatSessionId: 'sess-cn' });

    expect(onSessionStarted).toHaveBeenCalledWith('sess-cn', 'https://zchat.z.ai');
    coordinator.onFailed({ taskId: 'task-1', error: 'cancelled' });
    await pending;
  });

  it('does not report the site from the active-site fallback when the tab says otherwise', async () => {
    // ⚠️ **这条防的是「拿最近活跃站凑数」** —— 桩把活跃站设成国区站、而标签页在国际站，
    // 回调必须报**国际站**（标签页是硬证据）。若实现改成读活跃站，这条立刻红。
    const { coordinator, pending, onSessionStarted } = startAgainstTab('https://chat.z.ai/');
    await settle();

    coordinator.onStarted({ taskId: 'task-1', chatSessionId: 'sess-2' });

    expect(onSessionStarted.mock.calls[0]?.[1]).toBe('https://chat.z.ai');
    coordinator.onFailed({ taskId: 'task-1', error: 'cancelled' });
    await pending;
  });

  it('reports the callback only once, even if started fires again', async () => {
    const { coordinator, pending, onSessionStarted } = startAgainstTab('https://zchat.z.ai/');
    await settle();

    coordinator.onStarted({ taskId: 'task-1', chatSessionId: 'sess-1' });
    coordinator.onStarted({ taskId: 'task-1', chatSessionId: 'sess-1' });

    expect(onSessionStarted).toHaveBeenCalledTimes(1);
    coordinator.onFailed({ taskId: 'task-1', error: 'cancelled' });
    await pending;
  });
});