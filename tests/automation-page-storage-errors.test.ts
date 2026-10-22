import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Automation } from '../core/automation/types';
import AutomationPage from '../entrypoints/sidepanel/pages/AutomationPage';

/**
 * 自动化页的**持久化错误语义**：加载失败不能投影成「空列表」，严格 storage 错误要
 * 保留最后一次已确认列表，广播是**失效信号**而不是权威数据，过期重载要丢弃。
 *
 * 从上游 `automation-page-storage-errors.test.ts` 移植，改动集中在 fixture：
 *  - 会话块改名为 `zai: {...}`（本项目是 `AutomationZaiSession`）
 *  - `promptOptions: { modelType, thinkingEnabled, refFileIds }` →
 *    `{ model, fixedSession }`
 *  - mock 里补 `GET_ZAI_MODELS`（本项目页面挂载时会拉模型清单，上游没有这一步）
 *
 * ⚠️ **四条断言本身自移植起未改过写法**（后续只在 fixture 侧做过增删）——
 * 它们测的是 fence 机制（`loadFence` / `hasConfirmedSnapshot` / `loadError`），
 * 而那一套在移植时是**行级对齐保留**的。
 *
 * ⚠️ 默认 locale 是 `zh-CN`（`core/i18n/types.ts` 的 `DEFAULT_LOCALE`），
 * 且测试不包 `I18nProvider` 时 `useI18n()` 给的是默认 zh 翻译器 ——
 * 所以空态文案就是 `暂无自动化`（与上游同一句）。
 */

let container: HTMLDivElement;
let root: Root | null;
let automationResponse: unknown;
let messageListener: ((message: { type?: string; automations?: unknown }) => void) | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  automationResponse = [automation];
  messageListener = null;
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async (message: { type?: string }) => {
        if (message.type === 'GET_AUTOMATIONS') return automationResponse;
        if (message.type === 'GET_AUTOMATION_RUNS') return [];
        // 本项目页面挂载时另拉模型清单（后台带 5 分钟缓存）。给一份最小合法清单，
        // 免得它走 fallback 分支往页面上写一条提示、干扰下面的文案断言。
        if (message.type === 'GET_ZAI_MODELS') {
          return { models: [{ id: 'glm-5.3', name: 'GLM-5.3' }], source: 'live' };
        }
        return { ok: true };
      }),
      onMessage: {
        addListener: vi.fn((listener) => {
          messageListener = listener;
        }),
        removeListener: vi.fn(),
      },
    },
    tabs: { create: vi.fn() },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Automation UI persistence errors', () => {
  it('shows an initial failure without projecting a false empty state', async () => {
    automationResponse = { ok: false, error: 'initial automation load failed' };
    await renderAutomationPage();

    expect(container.textContent).toContain('initial automation load failed');
    expect(container.textContent).not.toContain('暂无自动化');
  });

  it('shows a strict storage failure and keeps the last confirmed list', async () => {
    await renderAutomationPage();
    expect(container.textContent).toContain(automation.name);

    automationResponse = { ok: false, error: 'automation storage version is unsupported' };
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();

    expect(container.textContent).toContain('automation storage version is unsupported');
    expect(container.textContent).toContain(automation.name);
  });

  it('treats update notifications as invalidations instead of unvalidated data', async () => {
    await renderAutomationPage();
    automationResponse = { ok: false, error: 'authoritative reload failed' };

    await act(async () => {
      messageListener?.({
        type: 'AUTOMATIONS_UPDATED',
        automations: [{ ...automation, name: 'Unconfirmed broadcast automation' }],
      });
    });
    await settle();

    expect(container.textContent).toContain('authoritative reload failed');
    expect(container.textContent).toContain(automation.name);
    expect(container.textContent).not.toContain('Unconfirmed broadcast automation');
  });

  it('ignores a stale reload that finishes after a newer snapshot', async () => {
    await renderAutomationPage();
    const stale = deferred<unknown>();
    automationResponse = stale.promise;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    const newest = { ...automation, id: 'automation-newest', name: 'Newest automation' };
    automationResponse = [newest];
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    expect(container.textContent).toContain(newest.name);

    await act(async () => {
      stale.resolve([{ ...automation, name: 'Stale automation' }]);
    });
    await settle();

    expect(container.textContent).toContain(newest.name);
    expect(container.textContent).not.toContain('Stale automation');
  });
});

async function renderAutomationPage() {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(AutomationPage));
  });
  await settle();
}

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const automation: Automation = {
  id: 'automation-1',
  name: 'Confirmed automation',
  prompt: 'Run safely.',
  status: 'active',
  schedule: {
    kind: 'manual',
    expression: null,
    timezone: 'UTC',
    enabled: false,
    minimumIntervalMinutes: 0,
  },
  promptOptions: {
    model: null,
    fixedSession: false,
  },
  zai: {
    chatSessionId: null,
    sessionUrl: null,
    siteOrigin: null,
  },
  createdAt: 1_000,
  updatedAt: 1_000,
  lastRunAt: null,
  nextRunAt: null,
  lastError: null,
  version: 1,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}