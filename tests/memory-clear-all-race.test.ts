import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsController } from '../entrypoints/sidepanel/controllers/useSettingsController';

/**
 * 「清空全部记忆」遇到某条已经被删掉时**不能中断**。
 *
 * ⚠️⚠️ 判据是语义的：这个函数的目标是「让这些 id 都不存在」，已经不在了 ⇒ 目标已达成。
 * 而**记忆页的单条删除相反** —— 那里「不在了」是意外，要给用户一句人话。
 * 两条链路的处置**相反是有意的**，别统一。
 */

const deleted: number[] = [];
let failureMode: 'ok' | 'missing' | 'boom' = 'ok';

vi.mock('../entrypoints/sidepanel/controllers/library-controller', () => ({
  libraryController: {
    getMemories: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
    deleteMemory: async (id: number) => {
      if (failureMode === 'missing' && id === 2) throw new Error('memory_record_missing');
      if (failureMode === 'boom' && id === 2) throw new Error('quota exceeded');
      deleted.push(id);
    },
  },
}));

vi.mock('../entrypoints/sidepanel/runtime-client', () => ({
  sidepanelRuntimeClient: { request: async () => ({}) },
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;
let captured: ReturnType<typeof useSettingsController> | null = null;

function Harness() {
  captured = useSettingsController();
  return null;
}

async function mount() {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(Harness));
  });
}

beforeEach(() => {
  deleted.length = 0;
  failureMode = 'ok';
  captured = null;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container.remove();
  vi.clearAllMocks();
});

describe('clear all memories vs a concurrent delete', () => {
  it('keeps going when one row is already gone', async () => {
    failureMode = 'missing';
    await mount();
    await act(async () => {
      await expect(captured!.handleClearAllMemories()).resolves.toBeUndefined();
    });
    // 1 与 3 都删掉了；2 那条「已经不在了」不算失败。
    expect(deleted).toEqual([1, 3]);
  });

  it('still surfaces a real storage failure', async () => {
    failureMode = 'boom';
    await mount();
    await act(async () => {
      await expect(captured!.handleClearAllMemories()).rejects.toThrow('quota exceeded');
    });
  });
});
