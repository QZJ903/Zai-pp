import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import McpPage from '../entrypoints/sidepanel/pages/McpPage';
import { I18nProvider } from '../entrypoints/sidepanel/i18n';

/**
 * MCP 页「传输方式」单选组的 roving 契约。
 *
 * 这一组是手写的（自己的胶囊样式），不会从 `SegmentedControl` 继承 roving ——
 * 修之前整组每个按钮的 `tabIndex` 都是 0，Tab 会一个个穿过每个传输选项，
 * 方向键在组内无效。与 `GeneralSubPage` 的语言组、`SegmentedControl` 是同一形态的
 * 第三处（判据：WAI-ARIA APG Radio Group Pattern）。
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
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn(async (message: { type?: string }) => {
        switch (message?.type) {
          case 'GET_MCP_SERVERS': return [];
          case 'GET_MCP_CAPABILITY_SETTINGS': return { exposedServerIds: [], tools: {} };
          case 'GET_TOOL_CALL_HISTORY': return { records: [], dropped: 0 };
          case 'GET_PLATFORM_CAPABILITIES': return {
            kind: 'browser_extension',
            name: 'Chrome',
            capabilities: {
              storage: true, runtimeMessaging: true, downloads: true, assetUrl: true,
              sidePanel: true, nativeMessaging: true, alarms: true, tabs: true,
              tabGroups: true, debugger: true, browserControl: true, accessibilityTree: true,
            },
          };
          default: return { ok: true };
        }
      }),
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let index = 0; index < 10; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function transportRadios(): HTMLButtonElement[] {
  const group = container.querySelector('[role="radiogroup"][aria-label="传输方式"]')
    ?? Array.from(container.querySelectorAll('[role="radiogroup"]'))
      .find((node) => node.querySelectorAll('[role="radio"]').length > 1);
  if (!group) return [];
  return Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
}

/** 空列表时页头与空状态各有一个「新增」，取页头那个（文案是「新增」）。 */
async function openCreateForm() {
  const createButton = Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === '新增')
    ?? Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('新增 MCP 服务'));
  expect(createButton, '找不到新建按钮').toBeTruthy();
  await act(async () => { createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await settle();
}

async function press(key: string) {
  await act(async () => {
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });
}

describe('MCP transport radio group roving', () => {
  it('keeps a single tab stop on the selected transport', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(I18nProvider, null, React.createElement(McpPage)));
    });
    await settle();

    // 先点出「新建服务」表单，传输组只在那里出现。
    await openCreateForm();

    const radios = transportRadios();
    expect(radios.length).toBeGreaterThan(1);
    // 组内只有一个 Tab 停靠点，且落在选中项上。
    expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
    expect(radios.filter((radio) => radio.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    const checkedIndex = radios.findIndex((radio) => radio.getAttribute('aria-checked') === 'true');
    expect(radios[checkedIndex].tabIndex).toBe(0);
  });

  it('moves focus and selection together with the arrow keys', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(I18nProvider, null, React.createElement(McpPage)));
    });
    await settle();
    await openCreateForm();

    const radios = transportRadios();
    expect(radios.length).toBeGreaterThan(1);
    const start = radios.findIndex((radio) => radio.getAttribute('aria-checked') === 'true');
    radios[start].focus();

    const expectIndex = Math.min(start + 1, radios.length - 1);
    await press('ArrowRight');
    expect(radios[expectIndex].getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radios[expectIndex]);
    expect(radios[expectIndex].tabIndex).toBe(0);

    await press('ArrowLeft');
    expect(radios[start].getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radios[start]);
  });
});
