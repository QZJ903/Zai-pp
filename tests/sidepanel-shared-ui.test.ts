import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SegmentedControl,
  Slider,
  Spinner,
  SubTabs,
} from '../entrypoints/sidepanel/components/settings/primitives';
import RouteErrorBoundary from '../entrypoints/sidepanel/components/RouteErrorBoundary';

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
    unobserve() {}
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false })),
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const TABS = [
  { key: 'a', label: 'A' },
  { key: 'b', label: 'B' },
  { key: 'c', label: 'C' },
  { key: 'd', label: 'D' },
];

function tabButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button[role="tab"]')) as HTMLButtonElement[];
}

function selectedIndex(): number {
  return tabButtons().findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
}

function focusedIndex(): number {
  return tabButtons().indexOf(document.activeElement as HTMLButtonElement);
}

function SubTabsHarness({ onChange }: { onChange: (key: string) => void }) {
  const [value, setValue] = React.useState('a');
  return React.createElement(SubTabs, {
    tabs: TABS,
    value,
    onChange: (key: string) => { setValue(key); onChange(key); },
    ariaLabel: 'probe',
  });
}

async function press(key: string) {
  await act(async () => {
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });
}

describe('SubTabs roving focus', () => {
  it('moves focus together with the selection on every arrow press', async () => {
    const seen: string[] = [];
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(SubTabsHarness, { onChange: (key) => seen.push(key) }));
    });
    tabButtons()[0].focus();

    await press('ArrowRight');
    expect({ selected: selectedIndex(), focused: focusedIndex() }).toEqual({ selected: 1, focused: 1 });
    await press('ArrowRight');
    expect({ selected: selectedIndex(), focused: focusedIndex() }).toEqual({ selected: 2, focused: 2 });
    await press('ArrowRight');
    expect({ selected: selectedIndex(), focused: focusedIndex() }).toEqual({ selected: 3, focused: 3 });
    // Every press reaches the caller exactly once — the old shape re-sent the same key
    // because it recomputed the target from the still-focused first tab.
    expect(seen).toEqual(['b', 'c', 'd']);
  });

  it('wraps backwards from the first tab instead of jumping arbitrarily', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(SubTabsHarness, { onChange: () => {} }));
    });
    tabButtons()[1].focus();
    await press('ArrowRight');
    expect(selectedIndex()).toBe(2);

    await press('ArrowLeft');
    expect({ selected: selectedIndex(), focused: focusedIndex() }).toEqual({ selected: 1, focused: 1 });
  });

  it('supports Home and End', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(SubTabsHarness, { onChange: () => {} }));
    });
    tabButtons()[0].focus();
    await press('End');
    expect({ selected: selectedIndex(), focused: focusedIndex() }).toEqual({ selected: 3, focused: 3 });
    await press('Home');
    expect({ selected: selectedIndex(), focused: focusedIndex() }).toEqual({ selected: 0, focused: 0 });
  });
});

describe('SegmentedControl roving focus', () => {
  function Harness({ onChange }: { onChange: (key: string) => void }) {
    const [value, setValue] = React.useState('a');
    return React.createElement(SegmentedControl, {
      options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
      value,
      onChange: (key: string) => { setValue(key); onChange(key); },
      ariaLabel: 'probe',
    });
  }
  function radios(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll('button[role="radio"]')) as HTMLButtonElement[];
  }

  it('keeps a single tab stop on the selected option', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Harness, { onChange: () => {} }));
    });
    expect(radios().map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
  });

  it('moves focus and selection with the arrow keys', async () => {
    const seen: string[] = [];
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Harness, { onChange: (key) => seen.push(key) }));
    });
    radios()[0].focus();
    await press('ArrowRight');
    expect(seen).toEqual(['b']);
    expect(document.activeElement).toBe(radios()[1]);
    expect(radios()[1].getAttribute('aria-checked')).toBe('true');
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
  });
});

describe('Slider', () => {
  function fire(el: HTMLInputElement, type: 'input' | 'change', value: string) {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  it('labels the range input through htmlFor', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Slider, {
        label: 'opacity', value: 0.3, min: 0, max: 1, step: 0.05, onChange: () => {},
      }));
    });
    const input = container.querySelector('input[type="range"]') as HTMLInputElement;
    const label = container.querySelector('label') as HTMLLabelElement;
    expect(input.id).toBeTruthy();
    expect(label.getAttribute('for')).toBe(input.id);
    expect(label.textContent).toBe('opacity');
  });

  it('persists once on release instead of once per detent', async () => {
    const commits: number[] = [];
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Slider, {
        label: 'opacity',
        value: 0.3,
        min: 0,
        max: 1,
        step: 0.05,
        onCommit: (next: number) => { commits.push(next); },
      }));
    });
    const input = container.querySelector('input[type="range"]') as HTMLInputElement;

    await act(async () => {
      for (const next of ['0.35', '0.4', '0.45', '0.5']) fire(input, 'input', next);
    });
    expect(commits).toEqual([]);
    // The thumb follows the pointer while nothing has been written yet.
    expect(input.value).toBe('0.5');

    await act(async () => { fire(input, 'change', '0.5'); });
    expect(commits).toEqual([0.5]);
  });

  it('keeps the committed position when the save succeeds', async () => {
    const saved: number[] = [];
    function Harness() {
      const [value, setValue] = React.useState(0.3);
      return React.createElement(Slider, {
        label: 'opacity',
        value,
        min: 0,
        max: 1,
        step: 0.05,
        onCommit: (next: number) => { saved.push(next); setValue(next); },
      });
    }
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Harness));
    });
    const input = container.querySelector('input[type="range"]') as HTMLInputElement;
    await act(async () => {
      fire(input, 'input', '0.45');
      fire(input, 'change', '0.45');
    });
    expect(saved).toEqual([0.45]);
    expect(input.value).toBe('0.45');
  });

  it('falls back to the stored value when the save fails', async () => {
    function Harness() {
      return React.createElement(Slider, {
        label: 'opacity',
        value: 0.3,
        min: 0,
        max: 1,
        step: 0.05,
        // The value is never adopted, so the draft has to be dropped on rejection.
        onCommit: () => Promise.reject(new Error('quota')),
      });
    }
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Harness));
    });
    const input = container.querySelector('input[type="range"]') as HTMLInputElement;
    await act(async () => {
      fire(input, 'input', '0.9');
    });
    expect(input.value).toBe('0.9');
    await act(async () => {
      fire(input, 'change', '0.9');
      await Promise.resolve();
    });
    expect(input.value).toBe('0.3');
  });
});

describe('RouteErrorBoundary', () => {
  function Boom(): React.ReactNode {
    throw new Error('render exploded');
  }

  it('keeps the shell alive and offers a reload when a page throws', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await act(async () => {
        root = createRoot(container);
        root.render(React.createElement(RouteErrorBoundary, {
          title: 'page failed',
          reloadLabel: 'reload',
          children: React.createElement(Boom),
        }));
      });
      expect(container.textContent).toContain('page failed');
      expect(container.querySelector('button')?.textContent).toBe('reload');
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('passes children through while nothing throws', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(RouteErrorBoundary, {
        title: 'page failed',
        reloadLabel: 'reload',
        children: React.createElement('p', null, 'fine'),
      }));
    });
    expect(container.textContent).toBe('fine');
  });
});

describe('Spinner', () => {
  // No provider needed: the i18n context ships a default translator (DEFAULT_LOCALE is
  // zh-CN), which is exactly what a component outside the settings route would see.
  it('falls back to the localized loading label instead of hard-coded English', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Spinner));
    });
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('加载中...');
  });

  it('accepts an explicit label', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Spinner, { label: 'saving' }));
    });
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('saving');
  });
});
