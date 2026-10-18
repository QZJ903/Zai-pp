import { describe, expect, it, vi } from 'vitest';
import { createDomTaskCoordinator } from '../core/zai/dom-task-coordinator';

/**
 * 新对话的站点要跟**用户此刻正在看的那个标签页**走。
 *
 * 起因：非固定会话不再继承记录里的站点（请求侧传 `null`）之后，站点由协调器判定。
 * 而旧判定会按 `ZAI_SITES` 的键顺序扫主页标签页 —— `cn` 在前，于是「两个站的主页
 * 都开着」时永远选国区站，与用户此刻所在的站无关；扫不到再读「最近活跃站」，
 * 而那个值可能被一个后台放着的国区站标签页钉住。
 *
 * ⇒ 新对话分支必须先看当前活动标签页；它不是 z.ai 页面时才退回旧判定。
 *
 * ⚠️ 写成**行为测试**（真调协调器、传桩、断言它开/复用了哪个 tab）——
 * 源码级断言只能问「源码里有没有 `active: true`」，问不出「它到底有没有生效」。
 */

interface HarnessOptions {
  /** 当前活动标签页的 URL；`null` = 当前标签页不是 z.ai。 */
  activeTabUrl: string | null;
  /** 已开着的标签页（按 `tabUrlPatterns` 查询时返回）。 */
  openTabs: Array<{ id: number; url: string }>;
  /** 「最近活跃站」—— 故意设成国区站，用来证明优先的是活动标签页、不是它。 */
  activeSiteOrigin?: string;
  /** 让「查活动标签页」这一步抛错（模拟权限 / API 失败）。 */
  activeTabQueryThrows?: boolean;
  /** 显式指定的站点（模拟固定会话）。 */
  siteOrigin?: string | null;
}

function startNewConversation(options: HarnessOptions) {
  const createdUrls: string[] = [];
  const messagedTabIds: number[] = [];
  const reportError = vi.fn();
  const coordinator = createDomTaskCoordinator({
    tabUrlPatterns: ['*://zchat.z.ai/*', '*://chat.z.ai/*'],
    queryTabs: vi.fn(async (query) => {
      if (query.active === true) {
        if (options.activeTabQueryThrows) throw new Error('tabs_query_failed');
        return options.activeTabUrl
          ? [{ id: 99, url: options.activeTabUrl, active: true, windowId: 1 } as chrome.tabs.Tab]
          : [];
      }
      return options.openTabs.map((tab) => ({
        id: tab.id,
        url: tab.url,
        active: false,
        windowId: 1,
      } as chrome.tabs.Tab));
    }),
    createTab: vi.fn(async (props) => {
      createdUrls.push(String(props.url));
      return { id: 50 } as chrome.tabs.Tab;
    }),
    sendTabMessage: vi.fn(async (tabId) => {
      messagedTabIds.push(tabId);
      return { ok: true };
    }),
    updateTab: vi.fn(async (tabId) => ({ id: tabId } as chrome.tabs.Tab)),
    readActiveSiteOrigin: vi.fn(async () => options.activeSiteOrigin ?? 'https://zchat.z.ai'),
    reportError,
  });

  const pending = coordinator.startTask(
    {
      taskId: 'task-1',
      kind: 'automation',
      prompt: 'run',
      chatSessionId: null,
      siteOrigin: options.siteOrigin ?? null,
    },
    { handshakeTimeoutMs: 1_000 },
  );
  return { coordinator, pending, createdUrls, messagedTabIds, reportError };
}

/** 等协调器把 pending 登记完（`resolveDomTab` 要查标签页，拍数不定）。 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function finish(coordinator: ReturnType<typeof createDomTaskCoordinator>, pending: Promise<unknown>) {
  coordinator.onFailed({ taskId: 'task-1', error: 'cancelled' });
  await pending;
}

describe('dom task new-conversation site selection', () => {
  it('opens the new conversation on the site of the active tab', async () => {
    const harness = startNewConversation({
      activeTabUrl: 'https://chat.z.ai/c/current-conversation',
      // 国区站的主页也开着 —— 旧实现会先命中它（站点表里 cn 在前）。
      openTabs: [{ id: 1, url: 'https://zchat.z.ai/' }],
    });
    await settle();

    expect(harness.createdUrls).toEqual(['https://chat.z.ai/']);
    expect(harness.messagedTabIds).not.toContain(1);
    await finish(harness.coordinator, harness.pending);
  });

  it('reuses the active site home tab when both sites have one open', async () => {
    const harness = startNewConversation({
      activeTabUrl: 'https://chat.z.ai/',
      openTabs: [
        { id: 1, url: 'https://zchat.z.ai/' },
        { id: 2, url: 'https://chat.z.ai/' },
      ],
    });
    await settle();

    expect(harness.createdUrls).toEqual([]);
    expect(harness.messagedTabIds).toEqual([2]);
    await finish(harness.coordinator, harness.pending);
  });

  it('falls back to the open home tab when the active tab is not a z.ai page', async () => {
    const harness = startNewConversation({
      activeTabUrl: 'https://example.com/',
      openTabs: [{ id: 1, url: 'https://zchat.z.ai/' }],
    });
    await settle();

    expect(harness.createdUrls).toEqual([]);
    expect(harness.messagedTabIds).toEqual([1]);
    await finish(harness.coordinator, harness.pending);
  });

  it('falls back to the old chain when querying the active tab fails', async () => {
    // ⚠️ 活动标签页只是「更贴近用户意图」的一层偏好，查失败不能把整次解析搞挂。
    const harness = startNewConversation({
      activeTabUrl: 'https://chat.z.ai/',
      openTabs: [{ id: 1, url: 'https://zchat.z.ai/' }],
      activeTabQueryThrows: true,
    });
    await settle();

    expect(harness.createdUrls).toEqual([]);
    expect(harness.messagedTabIds).toEqual([1]);
    expect(harness.reportError).toHaveBeenCalledWith(
      'dom_task_active_tab_query_failed',
      expect.any(Error),
    );
    await finish(harness.coordinator, harness.pending);
  });

  it('does not look at the active tab when a site is explicitly requested', async () => {
    // 固定会话：站点由会话归属决定，与用户此刻在看哪个站无关。
    const harness = startNewConversation({
      activeTabUrl: 'https://chat.z.ai/',
      openTabs: [],
      siteOrigin: 'https://zchat.z.ai',
    });
    await settle();

    expect(harness.createdUrls).toEqual(['https://zchat.z.ai/']);
    await finish(harness.coordinator, harness.pending);
  });
});
