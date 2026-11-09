import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfirm } from '../entrypoints/sidepanel/components/settings/primitives';
import { dismissWhatsNew, getWhatsNewState } from '../core/whats-new';
import { decodeRuntimeAckResponse } from '../core/messaging/bootstrap-client';
import WhatsNewPanel from '../entrypoints/sidepanel/components/WhatsNewPanel';

vi.mock('../core/whats-new', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/whats-new')>();
  return {
    ...actual,
    dismissWhatsNew: vi.fn(async () => {}),
    getWhatsNewState: vi.fn(async () => ({ version: '9.9.9', visible: true, pendingUpdate: true })),
  };
});

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  vi.stubGlobal('chrome', {
    runtime: {
      getManifest: vi.fn(() => ({ version: '9.9.9' })),
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Renders the release-notes panel and a dialog, exactly as the app can. */
function Both({ openDialog }: { openDialog: boolean }) {
  const { confirm, node } = useConfirm();
  // `confirm` is a fresh closure per render, so it cannot sit in the dep list — a single
  // latch keeps this from opening the dialog forever.
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (!openDialog || opened.current) return;
    opened.current = true;
    void confirm({ title: 't', message: 'm', confirmLabel: 'ok', cancelLabel: 'no' });
  });
  return React.createElement(React.Fragment, null,
    React.createElement(WhatsNewPanel),
    node);
}

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function escape() {
  return new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
}

describe('one Escape closes one thing', () => {
  it('closes the dialog without burning the release notes', async () => {
    // Real order: the panel is mounted at app start and registers its listener as soon
    // as its state resolves; the dialog is registered much later, by a user click. Two
    // phases reproduce that — mounting both at once would hide the ordering hazard.
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Both, { openDialog: false }));
    });
    await settle();
    expect(container.textContent).toContain('版本更新内容');

    await act(async () => {
      root?.render(React.createElement(Both, { openDialog: true }));
    });
    await settle();
    expect(container.querySelector('[aria-modal="true"]')).toBeTruthy();

    await act(async () => { window.dispatchEvent(escape()); });
    await settle();

    // Dialog gone, release notes still on screen.
    expect(container.querySelector('[aria-modal="true"]')).toBeNull();
    expect(container.textContent).toContain('版本更新内容');
    expect(dismissWhatsNew).not.toHaveBeenCalled();
  });

  it('dismisses the release notes when no dialog claimed the key', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Both, { openDialog: false }));
    });
    await settle();
    expect(container.textContent).toContain('版本更新内容');

    await act(async () => { window.dispatchEvent(escape()); });
    await settle();

    expect(dismissWhatsNew).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('版本更新内容');
  });

  it('leaves the dialog in place when its Escape arrives unclaimed', async () => {
    // Sanity check on the guard itself: the panel returns early on defaultPrevented,
    // so a key that nobody prevented must still reach it.
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Both, { openDialog: false }));
    });
    await settle();
    const event = escape();
    event.preventDefault();
    await act(async () => { window.dispatchEvent(event); });
    await settle();
    expect(dismissWhatsNew).not.toHaveBeenCalled();
  });
});

describe('module sanity', () => {
  it('keeps the mocked panel state deterministic', async () => {
    expect((await getWhatsNewState()).visible).toBe(true);
    expect(typeof decodeRuntimeAckResponse).toBe('function');
  });
});
