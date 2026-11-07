import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsController } from '../entrypoints/sidepanel/controllers/useSettingsController';

/**
 * Clearing all memories is ONE background command, not one delete per record.
 *
 * ⚠️⚠️ This file used to assert the opposite behaviour: a loop that deleted rows
 * one by one and treated "that row is already gone" as success (the goal was
 * "none of these ids exist", so a row that was already missing had already met
 * it). Clearing now happens in a single transaction, so that race cannot occur
 * and the assertion is gone with it — keeping it would suggest the clear is
 * still per-record.
 *
 * What is worth pinning now: one command (per-record deletion is what made this
 * unusably slow), and a real failure still reaching the caller.
 */

const calls: string[] = [];
let clearFailure: Error | null = null;

vi.mock('../entrypoints/sidepanel/controllers/library-controller', () => ({
  libraryController: {
    getMemories: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
    deleteMemory: async () => { calls.push('deleteMemory'); },
    clearMemories: async () => {
      calls.push('clearMemories');
      if (clearFailure) throw clearFailure;
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
  calls.length = 0;
  clearFailure = null;
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

describe('clear all memories', () => {
  it('issues one clear command instead of one delete per record', async () => {
    await mount();
    await act(async () => {
      await expect(captured!.handleClearAllMemories()).resolves.toBeUndefined();
    });
    expect(calls).toEqual(['clearMemories']);
  });

  it('still surfaces a real storage failure', async () => {
    clearFailure = new Error('quota exceeded');
    await mount();
    await act(async () => {
      await expect(captured!.handleClearAllMemories()).rejects.toThrow('quota exceeded');
    });
  });
});
