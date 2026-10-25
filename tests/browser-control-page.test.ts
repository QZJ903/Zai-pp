import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserControlSettings,
  BrowserControlState,
  BrowserControlTarget,
} from '../core/browser-control';
import BrowserControlPage from '../entrypoints/sidepanel/pages/BrowserControlPage';

let container: HTMLDivElement;
let root: Root | null;
let runtimeListener: ((message: unknown) => void) | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  runtimeListener = null;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('BrowserControlPage', () => {
  it('keeps the newest invalidation reload when an older read finishes later', async () => {
    const staleSettings = deferred<unknown>();
    const staleState = deferred<unknown>();
    const newestTarget = target(9, 'Newest target');
    let settingsReads = 0;
    let stateReads = 0;
    const sendMessage = vi.fn((message: { type: string }) => {
      if (message.type === 'GET_BROWSER_CONTROL_SETTINGS') {
        settingsReads += 1;
        return settingsReads === 1
          ? staleSettings.promise
          : Promise.resolve(settings(9));
      }
      if (message.type === 'GET_BROWSER_CONTROL_STATE') {
        stateReads += 1;
        return stateReads === 1
          ? staleState.promise
          : Promise.resolve(state(newestTarget));
      }
      return Promise.resolve({ ok: true });
    });
    stubChrome(sendMessage);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(BrowserControlPage));
    });
    await act(async () => runtimeListener?.({ type: 'BROWSER_CONTROL_UPDATED' }));
    await settle();
    expect(container.textContent).toContain('Newest target');

    staleSettings.resolve(settings(3));
    staleState.resolve(state(target(3, 'Stale target')));
    await settle();

    expect(container.textContent).toContain('Newest target');
    expect(container.textContent).not.toContain('Stale target');
  });

  it('localizes the z.ai exclusion and leaves other blocked reasons alone', async () => {
    // ⚠️ 后台给 z.ai 那行的 `reason` 是英文技术串（`core/browser-control` 写不了中文，
    // 会被 `i18n-coverage-audit` 判成硬编码文案）⇒ 面板按**同一个判据**换成中文。
    // 这条守的就是「面板与后台同源」这个唯一的接口：判据一旦分叉，用户会看到英文长句，
    // 而没有任何测试会红。
    const zaiTarget: BrowserControlTarget = {
      ...target(12, 'GLM'),
      url: 'https://chat.z.ai/c/0f1e2d3c',
      controllable: false,
      // 与生产逐字一致（`service.ts` 的 `getControllableState`）—— 这份 fixture 是手抄副本，
      // 分叉时不会报错，而这条用例的判据是「URL 命中就换中文」，所以文案本身必须跟着生产走。
      reason: 'Cannot target a z.ai tab: continuation keep-alive requires exclusive use of that tab\'s debugger attachment.',
    };
    const unsupportedTarget: BrowserControlTarget = {
      ...target(13, 'Local file'),
      url: 'file:///tmp/notes.txt',
      controllable: false,
      reason: 'Unsupported URL scheme for browser control: file',
    };
    const sendMessage = vi.fn((message: { type: string }) => {
      if (message.type === 'GET_BROWSER_CONTROL_SETTINGS') return Promise.resolve(settings(12));
      if (message.type === 'GET_BROWSER_CONTROL_STATE') {
        return Promise.resolve({
          ...state(zaiTarget),
          targets: [zaiTarget, unsupportedTarget],
        });
      }
      return Promise.resolve({ ok: true });
    });
    stubChrome(sendMessage);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(BrowserControlPage));
    });
    await settle();

    expect(container.textContent).toContain('z.ai 标签页不能作为控制目标');
    // 别的不可控原因原样显示后台那句（这里只有英文，没有本地化表）。
    expect(container.textContent).toContain('Unsupported URL scheme for browser control: file');
  });
});

function stubChrome(sendMessage: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: vi.fn((listener: (message: unknown) => void) => {
          runtimeListener = listener;
        }),
        removeListener: vi.fn(),
      },
    },
  });
}

function settings(targetTabId: number): BrowserControlSettings {
  return {
    enabled: true,
    targetTabId,
    includeSnapshotAfterActions: true,
    maxSnapshotNodes: 400,
    maxSnapshotTextBytes: 24_000,
  };
}

function state(activeTarget: BrowserControlTarget): BrowserControlState {
  return {
    supported: true,
    enabled: true,
    attached: true,
    targetTabId: activeTarget.id,
    target: activeTarget,
    targets: [activeTarget],
    error: null,
  };
}

function target(id: number, title: string): BrowserControlTarget {
  return {
    id,
    windowId: 1,
    groupId: -1,
    active: true,
    currentWindow: true,
    title,
    url: 'https://chat.z.ai/',
    controllable: true,
  };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
