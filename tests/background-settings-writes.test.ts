import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DataSubPage from '../entrypoints/sidepanel/components/settings/DataSubPage';
import GeneralSubPage from '../entrypoints/sidepanel/components/settings/GeneralSubPage';
import { useSettingsController } from '../entrypoints/sidepanel/controllers/useSettingsController';
import { I18nProvider } from '../entrypoints/sidepanel/i18n';
import { useBanner } from '../entrypoints/sidepanel/components/settings/primitives';

let container: HTMLDivElement;
let root: Root | null;
let sent: Array<{ type?: string; payload?: unknown }>;
let saveBehaviour: 'ok' | 'fail';
let storage: Record<string, unknown>;
let memoriesResponse: unknown[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  sent = [];
  saveBehaviour = 'ok';
  storage = {
    zai_pp_background: {
      enabled: true, type: 'url', url: 'https://ok.example/a.png', imageData: '', opacity: 0.3,
    },
  };
  memoriesResponse = [];
  vi.stubGlobal('chrome', {
    i18n: { getUILanguage: vi.fn(() => 'zh-CN') },
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => (Array.isArray(keys)
          ? Object.fromEntries(keys.map((key) => [key, storage[key]]))
          : { [keys]: storage[keys] })),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(storage, values); }),
        remove: vi.fn(async () => {}),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn(async (message: { type?: string; payload?: unknown }) => {
        sent.push({ type: message?.type, payload: message?.payload });
        switch (message?.type) {
          case 'GET_MEMORIES': return memoriesResponse;
          case 'GET_CONFIG': return { version: '9.9.9' };
          case 'GET_BACKGROUND': return storage.zai_pp_background;
          case 'GET_TAB_KEEPALIVE_SETTINGS': return { enabled: false };
          case 'SAVE_BACKGROUND':
            if (saveBehaviour === 'fail') return { ok: false, error: 'quota_bytes_exceeded' };
            storage.zai_pp_background = message.payload;
            return { ok: true };
          case 'CLEAR_BACKGROUND':
            if (saveBehaviour === 'fail') return { ok: false, error: 'quota_bytes_exceeded' };
            delete storage.zai_pp_background;
            return { ok: true };
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

function Harness() {
  const banner = useBanner();
  const state = useSettingsController({
    error: (error) => banner.show('error', String((error as Error)?.message ?? error)),
  });
  if (state.loading) return React.createElement('div', null, 'loading');
  return React.createElement(React.Fragment, null,
    banner.node,
    React.createElement(GeneralSubPage, { state }));
}

async function render() {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(I18nProvider, null, React.createElement(Harness)));
  });
  await settle();
}

async function settle() {
  for (let index = 0; index < 10; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function backgroundSwitch(): HTMLButtonElement {
  const switches = Array.from(container.querySelectorAll('button[aria-pressed]')) as HTMLButtonElement[];
  const found = switches[1];
  expect(found, '自定义背景开关没找到').toBeTruthy();
  return found;
}

function opacityInput(): HTMLInputElement {
  return container.querySelector('input[type="range"]') as HTMLInputElement;
}

function fireRange(value: string, type: 'input' | 'change') {
  const input = opacityInput();
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event(type, { bubbles: true }));
}

describe('background switch', () => {
  it('does not flip before the write lands', async () => {
    await render();
    expect(backgroundSwitch().getAttribute('aria-pressed')).toBe('true');

    let release: (() => void) | null = null;
    const pending = vi.fn();
    const original = chrome.runtime.sendMessage as unknown as (message: { type?: string }) => Promise<unknown>;
    (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn((message: { type?: string; payload?: unknown }) => {
      sent.push({ type: message?.type, payload: message?.payload });
      if (message?.type === 'SAVE_BACKGROUND') {
        pending();
        return new Promise((resolve) => { release = () => resolve({ ok: true }); });
      }
      return original(message as { type?: string });
    }) as unknown;

    await act(async () => {
      backgroundSwitch().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(pending).toHaveBeenCalledTimes(1);
    // Still showing the stored value while the request is in flight.
    expect(backgroundSwitch().getAttribute('aria-pressed')).toBe('true');

    await act(async () => { release?.(); });
    await settle();
    expect(backgroundSwitch().getAttribute('aria-pressed')).toBe('false');
  });

  it('stays on the stored value and reports when the write fails', async () => {
    await render();
    saveBehaviour = 'fail';
    await act(async () => {
      backgroundSwitch().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(backgroundSwitch().getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('quota_bytes_exceeded');
  });

  it('does not leak a never-saved value into the next write', async () => {
    await render();
    saveBehaviour = 'fail';
    await act(async () => {
      backgroundSwitch().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(backgroundSwitch().getAttribute('aria-pressed')).toBe('true');

    saveBehaviour = 'ok';
    await act(async () => {
      fireRange('0.55', 'input');
      fireRange('0.55', 'change');
    });
    await settle();

    const saves = sent.filter((entry) => entry.type === 'SAVE_BACKGROUND');
    expect(saves).toHaveLength(2);
    // The failed toggle must not ride along: `enabled` stays whatever the store held.
    expect((saves[1].payload as { enabled: boolean }).enabled).toBe(true);
    expect((saves[1].payload as { opacity: number }).opacity).toBeCloseTo(0.55);
  });
});

describe('opacity slider', () => {
  it('writes once per gesture, not once per detent', async () => {
    await render();
    await act(async () => {
      for (const value of ['0.35', '0.4', '0.45', '0.5']) fireRange(value, 'input');
    });
    await settle();
    expect(sent.filter((entry) => entry.type === 'SAVE_BACKGROUND')).toHaveLength(0);

    await act(async () => { fireRange('0.5', 'change'); });
    await settle();
    expect(sent.filter((entry) => entry.type === 'SAVE_BACKGROUND')).toHaveLength(1);
  });
});

describe('memory count', () => {
  // The count lives on the Data tab; a General-page harness cannot see it (an earlier
  // version of this test asserted on general text and passed for the wrong reason —
  // "3" matched "3 分钟" in the keepalive description).
  function CountHarness() {
    const banner = useBanner();
    const state = useSettingsController({ error: () => {} });
    if (state.loading) return React.createElement('div', null, 'loading');
    return React.createElement(DataSubPage, { state });
  }

  async function renderCount() {
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(I18nProvider, null, React.createElement(CountHarness)));
    });
    await settle();
  }

  function memoryTotal(): string {
    const label = Array.from(container.querySelectorAll('span'))
      .find((node) => node.textContent === '记忆总数');
    expect(label, '记忆总数那一行没找到').toBeTruthy();
    return label!.parentElement?.textContent?.replace('记忆总数', '').trim() ?? '';
  }

  function countListener(): (message: unknown) => void {
    const calls = (chrome.runtime.onMessage.addListener as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[0][0] as (message: unknown) => void;
  }

  it('starts from the mount-time read', async () => {
    await renderCount();
    expect(memoryTotal()).toBe('0');
  });

  /**
   * 挂载期那条读**只量长度、不解码**。
   *
   * 这个区别是判据本身：走 `decodeMemoryList` 的话，一条形状不合的记忆（这里缺
   * `createdAt`）会让整次读抛错 ⇒ 总数显示成占位符而不是「共 3 条」。
   * 导出与清空那两处仍然解码 —— 它们要的是记录本身。
   */
  it('counts records it could not decode', async () => {
    memoriesResponse = [
      { id: 1, type: 'user', name: 'ok', content: 'ok', description: '', tags: [], pinned: false, createdAt: 1, updatedAt: 1, accessCount: 0, lastAccessedAt: 1 },
      { id: 2, type: 'user', name: 'also ok', content: 'ok', description: '', tags: [], pinned: false, createdAt: 1, updatedAt: 1, accessCount: 0, lastAccessedAt: 1 },
      // 缺必需字段 —— 解码会抛，但长度仍然算得出来。
      { id: 3, type: 'user' },
    ];
    await renderCount();
    expect(memoryTotal()).toBe('3');
  });

  it('follows the broadcast instead of the mount-time snapshot', async () => {
    await renderCount();
    await act(async () => {
      countListener()({ type: 'STATE_UPDATED', memories: [{}, {}, {}] });
    });
    await settle();
    expect(memoryTotal()).toBe('3');
  });

  it('overwrites the previous count with the newest commit', async () => {
    await renderCount();
    await act(async () => {
      countListener()({ type: 'STATE_UPDATED', memories: [{}, {}, {}, {}] });
    });
    await settle();
    await act(async () => {
      countListener()({ type: 'STATE_UPDATED', memories: [{}] });
    });
    await settle();
    expect(memoryTotal()).toBe('1');
  });

  it('ignores a broadcast without a memory array', async () => {
    await renderCount();
    await act(async () => {
      countListener()({ type: 'STATE_UPDATED' });
    });
    await settle();
    expect(memoryTotal()).toBe('0');
  });
});
