import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DataSubPage from '../entrypoints/sidepanel/components/settings/DataSubPage';
import { I18nProvider } from '../entrypoints/sidepanel/i18n';
import type { SettingsState } from '../entrypoints/sidepanel/controllers/useSettingsController';

/**
 * 数据页那三个异步动作的失败出口。
 *
 * 这三处 catch 的共同点：**不接就会变成 unhandled rejection**，用户看到的是
 * 「点了按钮、什么都没发生」，真实原因（存储坏 / 配额满）只在 DevTools 里。
 * 报表里 `handleExport` 曾经是唯一漏掉的那一处，所以这里逐条钉住三处都能出横幅。
 *
 * ⚠️ 断言落在**横幅里的那句话**上，而不是「有没有调用 banner.show」—— 后半句会被
 * 任何一个顺手加上的 show 满足。同时断言「带上了原因」，因为这三条文案的壳是
 * `X 失败：{error}`，丢详情就是这次要修的那一半。
 */

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  vi.stubGlobal('chrome', {
    i18n: { getUILanguage: vi.fn(() => 'zh-CN') },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function makeState(overrides: Partial<SettingsState>): SettingsState {
  return {
    loading: false,
    memoryCount: 3,
    handleExport: async () => {},
    handleExportLogs: async () => {},
    handleImport: () => {},
    handleClearAllMemories: async () => {},
    ...overrides,
  } as SettingsState;
}

async function render(state: SettingsState) {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(I18nProvider, null, React.createElement(DataSubPage, { state })));
  });
  await settle();
}

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === text);
  expect(found, `找不到按钮「${text}」`).toBeTruthy();
  return found as HTMLButtonElement;
}

async function click(button: HTMLButtonElement) {
  await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await settle();
}

describe('DataSubPage failure surfaces', () => {
  it('reports why exporting memories failed', async () => {
    const storageFailure = new Error('quota_bytes_exceeded');
    await render(makeState({ handleExport: async () => { throw storageFailure; } }));

    await click(buttonByText('导出记忆'));

    expect(container.textContent).toContain('导出记忆失败');
    expect(container.textContent).toContain('quota_bytes_exceeded');
  });

  it('reports why exporting diagnostic logs failed', async () => {
    const transportFailure = new Error('extension context invalidated');
    await render(makeState({ handleExportLogs: async () => { throw transportFailure; } }));

    await click(buttonByText('导出诊断日志'));

    expect(container.textContent).toContain('导出诊断日志失败');
    expect(container.textContent).toContain('extension context invalidated');
  });

  it('reports why clearing all memories failed', async () => {
    const memoryStoreFailure = new Error('indexeddb_read_failed');
    await render(makeState({ handleClearAllMemories: async () => { throw memoryStoreFailure; } }));

    await click(buttonByText('清除所有记忆'));
    // 确认框要先点掉，才轮到真正的清空动作。
    await click(buttonByText('清除所有记忆'));

    expect(container.textContent).toContain('清除记忆失败');
    expect(container.textContent).toContain('indexeddb_read_failed');
  });

  it('keeps the dialog closed and shows nothing after a cancel', async () => {
    const handleClearAllMemories = vi.fn(async () => {});
    await render(makeState({ handleClearAllMemories }));

    await click(buttonByText('清除所有记忆'));
    await click(buttonByText('取消'));

    expect(handleClearAllMemories).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('清除记忆失败');
  });
});
