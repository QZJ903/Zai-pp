import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../entrypoints/sidepanel/i18n';
import PresetSubPage from '../entrypoints/sidepanel/components/settings/PresetSubPage';
import MemoryForm from '../entrypoints/sidepanel/components/MemoryForm';
import SavedPage from '../entrypoints/sidepanel/pages/SavedPage';
import AutomationPage from '../entrypoints/sidepanel/pages/AutomationPage';
import BrowserControlPage from '../entrypoints/sidepanel/pages/BrowserControlPage';
import PromptControlPanel from '../entrypoints/sidepanel/components/PromptControlPanel';
import { useSettingsController } from '../entrypoints/sidepanel/controllers/useSettingsController';

/**
 * Contracts owned by the settings / memory / saved / automation / browser pages.
 *
 * Every case here exists because the behaviour it pins was silently wrong and
 * nothing failed when it was: a form that saved into the wrong record, a control
 * that reported success while the store said otherwise, copy that leaked an
 * English technical string into a localized shell, a tag field that only split
 * on the ASCII comma, and a list that stopped updating because a display-only
 * read failed.
 */

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
  // `vi.unstubAllGlobals` does not undo `vi.spyOn`; leaving the
  // `document.createElement` spy installed would make the next test capture the
  // mock as its "real" implementation and recurse into itself.
  vi.restoreAllMocks();
});

async function settle(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function stubRuntime(sendMessage: (message: { type: string; payload?: unknown }) => unknown) {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async (message: { type: string; payload?: unknown }) => sendMessage(message)),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    storage: {
      local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: { create: vi.fn(async () => ({ id: 1 })) },
  });
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

function preset(id: string, name: string, content: string) {
  return { id, name, content, createdAt: 1, updatedAt: 1 };
}

function automationRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a0',
    name: '任务0',
    prompt: 'p',
    status: 'active',
    schedule: { kind: 'manual', expression: null, timezone: 'UTC', enabled: false, minimumIntervalMinutes: 15 },
    promptOptions: { model: null, fixedSession: false },
    zai: { chatSessionId: null, sessionUrl: null, siteOrigin: null },
    createdAt: 1, updatedAt: 1, lastRunAt: null, nextRunAt: null, lastError: null, version: 1,
    ...overrides,
  };
}

describe('preset form', () => {
  it('remounts on a different edit target instead of saving A content into B', async () => {
    const saved: Array<{ id?: string; name: string; content: string }> = [];
    stubRuntime((message) => {
      if (message.type === 'GET_PRESETS') return [preset('a', 'AAA', 'aaa content'), preset('b', 'BBB', 'bbb content')];
      if (message.type === 'GET_ACTIVE_PRESET') return null;
      if (message.type === 'SAVE_PRESET') {
        saved.push(message.payload as { id?: string; name: string; content: string });
        return { ok: true };
      }
      return { ok: true };
    });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(PresetSubPage));
    });
    await settle();

    const editButtons = () => Array.from(container.querySelectorAll('button[aria-label]'))
      .filter((button) => button.getAttribute('aria-label') === '编辑') as HTMLElement[];
    const nameInput = () => container.querySelector('form input[type="text"]') as HTMLInputElement;
    const contentArea = () => container.querySelector('form textarea') as HTMLTextAreaElement;

    await act(async () => { editButtons()[0].click(); });
    expect(nameInput().value).toBe('AAA');

    // Editing a second preset while the form is open must reload the form with
    // that record, not leave the first record's text in place.
    await act(async () => { editButtons()[1].click(); });
    expect(nameInput().value).toBe('BBB');
    expect(contentArea().value).toBe('bbb content');

    await act(async () => { setNativeValue(nameInput(), 'BBB renamed'); });
    const submit = Array.from(container.querySelectorAll('form button'))
      .find((button) => button.textContent === '更新') as HTMLElement;
    await act(async () => { submit.click(); });
    await settle();

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: 'b', name: 'BBB renamed', content: 'bbb content' });
  });

  it('reports missing fields instead of swallowing the submit', async () => {
    stubRuntime((message) => {
      if (message.type === 'GET_PRESETS') return [];
      if (message.type === 'GET_ACTIVE_PRESET') return null;
      return { ok: true };
    });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(PresetSubPage));
    });
    await settle();

    const create = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('新建')) as HTMLElement;
    await act(async () => { create.click(); });

    const form = container.querySelector('form')!;
    const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => { submit.click(); });

    // A bare `return` left the form open with no message at all.
    expect(form.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  });
});

describe('saved item tags', () => {
  it('splits on the fullwidth comma a Chinese IME produces', async () => {
    let savedTags: string[] | null = null;
    stubRuntime((message) => {
      if (message.type === 'GET_SAVED_ITEMS') return [];
      if (message.type === 'SAVE_SAVED_ITEM') {
        savedTags = (message.payload as { tags: string[] }).tags;
        return {
          id: 's1', kind: 'snippet', title: 'T', content: 'C', tags: savedTags, createdAt: 1, updatedAt: 1,
        };
      }
      return { ok: true };
    });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(SavedPage));
    });
    await settle();

    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setNativeValue(inputs[0] as HTMLInputElement, 'T');
      setNativeValue(container.querySelector('textarea') as HTMLTextAreaElement, 'C');
      setNativeValue(inputs[1] as HTMLInputElement, '工作，重要');
    });

    const save = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === '保存') as HTMLElement;
    await act(async () => { save.click(); });
    await settle();

    expect(savedTags).toEqual(['工作', '重要']);
  });
});

describe('memory form tags', () => {
  it('splits on the fullwidth comma a Chinese IME produces', async () => {
    let savedTags: string[] | null = null;
    stubRuntime(() => ({ ok: true }));

    function Harness() {
      return React.createElement(MemoryForm, {
        initial: null,
        onSave: (memory: { tags: string[] }) => { savedTags = memory.tags; },
        onCancel: () => undefined,
      });
    }

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(I18nProvider, null, React.createElement(Harness)));
    });
    await settle();

    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setNativeValue(inputs[0] as HTMLInputElement, 'N');
      setNativeValue(container.querySelector('textarea') as HTMLTextAreaElement, 'C');
      setNativeValue(inputs[1] as HTMLInputElement, '工作，重要');
    });

    await act(async () => {
      (container.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    });
    await settle();

    expect(savedTags).toEqual(['工作', '重要']);
  });
});

describe('automation page failure copy', () => {
  it('renders localized copy for a schedule validation failure', async () => {
    stubRuntime((message) => {
      if (message.type === 'GET_AUTOMATIONS') return [];
      if (message.type === 'GET_AUTOMATION_RUNS_BATCH') return {};
      if (message.type === 'GET_ZAI_MODELS') return { models: [], source: 'live' };
      return { ok: true };
    });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(I18nProvider, null, React.createElement(AutomationPage)));
    });
    await settle(6);

    const create = Array.from(container.querySelectorAll('button'))
      .find((button) => /New|新建/.test(button.textContent ?? '')) as HTMLElement;
    await act(async () => { create.click(); });

    const form = container.querySelector('.ds-form')!;
    const kindSelect = Array.from(form.querySelectorAll('select'))
      .find((select) => select.value === 'manual') as HTMLSelectElement;
    await act(async () => {
      setNativeValue(form.querySelector('input') as HTMLInputElement, 'T');
      setNativeValue(form.querySelector('textarea') as HTMLTextAreaElement, 'P');
      setNativeValue(kindSelect, 'cron');
    });

    const expression = Array.from(form.querySelectorAll('input'))
      .find((input) => (input as HTMLInputElement).placeholder === '0 9 * * *') as HTMLInputElement;
    await act(async () => { setNativeValue(expression, 'bad cron'); });

    const submit = Array.from(form.querySelectorAll('button'))
      .find((button) => /Create|创建/.test(button.textContent ?? '') && !/New|新建/.test(button.textContent ?? '')) as HTMLElement;
    await act(async () => { submit.click(); });
    await settle();

    // The parser's own English sentence must not reach the banner: the same
    // code table the failure card uses already has copy for this code. (The
    // provider resolves to `en` under jsdom, so this asserts the English entry.)
    const text = container.textContent ?? '';
    expect(text).not.toContain('Cron expression must have 5 fields');
    expect(text).toContain('Cron expression could not be parsed');
  });

  it('saves a record whose stored shape carries an ok field', async () => {
    // The automation decoder spreads the stored record verbatim, so a record
    // that happens to carry `ok: false` must still be saved — reading it as a
    // domain failure would show an empty banner and drop the write.
    let savedPayload: unknown = null;
    stubRuntime((message) => {
      if (message.type === 'GET_AUTOMATIONS') return [];
      if (message.type === 'GET_AUTOMATION_RUNS_BATCH') return {};
      if (message.type === 'GET_ZAI_MODELS') return { models: [], source: 'live' };
      if (message.type === 'CREATE_AUTOMATION') {
        savedPayload = message.payload;
        return automationRecord({ id: 'new', name: '新任务', ok: false });
      }
      return { ok: true };
    });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(I18nProvider, null, React.createElement(AutomationPage)));
    });
    await settle(6);

    const create = Array.from(container.querySelectorAll('button'))
      .find((button) => /New|新建/.test(button.textContent ?? '')) as HTMLElement;
    await act(async () => { create.click(); });

    const form = container.querySelector('.ds-form')!;
    await act(async () => {
      setNativeValue(form.querySelector('input') as HTMLInputElement, '新任务');
      setNativeValue(form.querySelector('textarea') as HTMLTextAreaElement, 'P');
    });
    const submit = Array.from(form.querySelectorAll('button'))
      .find((button) => /Create|创建/.test(button.textContent ?? '') && !/New|新建/.test(button.textContent ?? '')) as HTMLElement;
    await act(async () => { submit.click(); });
    await settle(6);

    expect(savedPayload).not.toBeNull();
    // A domain failure would leave the form open with an error banner instead.
    expect(container.querySelector('.ds-form')).toBeNull();
    expect(container.textContent).not.toContain('Operation failed');
  });

  it('fetches every automation\'s recent runs in one batched request', async () => {
    const automations = Array.from({ length: 4 }, (_, index) => automationRecord({ id: `a${index}`, name: `任务${index}` }));
    const seen: string[] = [];
    stubRuntime((message) => {
      seen.push(message.type);
      if (message.type === 'GET_AUTOMATIONS') return automations;
      if (message.type === 'GET_AUTOMATION_RUNS_BATCH') return {};
      if (message.type === 'GET_ZAI_MODELS') return { models: [], source: 'live' };
      return { ok: true };
    });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(AutomationPage));
    });
    await settle(6);

    expect(seen.filter((type) => type === 'GET_AUTOMATION_RUNS_BATCH')).toHaveLength(1);
    expect(seen).not.toContain('GET_AUTOMATION_RUNS');
  });

  it('keeps the task list when only the runs read fails', async () => {
    let runsFail = false;
    const automations = [automationRecord()];
    const listeners: Array<(message: unknown) => void> = [];
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async (message: { type: string }) => {
          if (message.type === 'GET_AUTOMATIONS') return automations;
          if (message.type === 'GET_AUTOMATION_RUNS_BATCH') {
            if (runsFail) throw new Error('runs batch timed out');
            return {};
          }
          if (message.type === 'GET_ZAI_MODELS') return { models: [], source: 'live' };
          return { ok: true };
        }),
        onMessage: {
          addListener: (listener: (message: unknown) => void) => { listeners.push(listener); },
          removeListener: vi.fn(),
        },
      },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(AutomationPage));
    });
    await settle(6);
    expect(container.textContent).toContain('任务0');

    // A second task appears elsewhere while the runs read is failing.
    automations.push(automationRecord({ id: 'a1', name: '任务1' }));
    runsFail = true;
    await act(async () => {
      for (const listener of listeners) listener({ type: 'AUTOMATIONS_UPDATED' });
      // Longer than the reload-coalescing window, otherwise the reload has not
      // started yet and the assertions below read the pre-broadcast render.
      await new Promise((resolve) => { setTimeout(resolve, 120); });
    });
    await settle();

    // The list is committed before the runs are read, so a runs failure no
    // longer hides a task that was created elsewhere.
    expect(container.textContent).toContain('任务1');
    expect(container.textContent).toContain('runs batch timed out');
  });

  it('collapses two broadcasts that arrive in separate tasks into one reload', async () => {
    let listReads = 0;
    const listeners: Array<(message: unknown) => void> = [];
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async (message: { type: string }) => {
          if (message.type === 'GET_AUTOMATIONS') { listReads += 1; return []; }
          if (message.type === 'GET_AUTOMATION_RUNS_BATCH') return {};
          if (message.type === 'GET_ZAI_MODELS') return { models: [], source: 'live' };
          return { ok: true };
        }),
        onMessage: {
          addListener: (listener: (message: unknown) => void) => { listeners.push(listener); },
          removeListener: vi.fn(),
        },
      },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(AutomationPage));
    });
    await settle(6);
    const before = listReads;

    // One finished run emits both of these in a row. They arrive as two separate
    // `chrome.runtime` messages, i.e. in two separate tasks — delivering them in
    // one tick would let even a microtask-based merge pass.
    await act(async () => {
      for (const listener of listeners) listener({ type: 'AUTOMATIONS_UPDATED' });
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      for (const listener of listeners) listener({ type: 'AUTOMATION_RUNS_UPDATED' });
      await new Promise((resolve) => { setTimeout(resolve, 150); });
    });
    await settle();

    expect(listReads - before).toBe(1);
  });

  it('surfaces a failed open-session instead of dropping the rejection', async () => {
    // The realistic failure is a missing `tabs` permission (the Firefox manifest
    // does not request it) — not an invalidated context: reloading the extension
    // rebuilds the side panel, so the panel can never run against a dead one.
    const failure = new Error('This extension does not have permission to use tabs.');
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async (message: { type: string }) => {
          if (message.type === 'GET_AUTOMATIONS') {
            return [automationRecord({
              id: 'a1',
              name: '任务',
              zai: { chatSessionId: 'c1', sessionUrl: 'https://chat.z.ai/c/c1', siteOrigin: 'https://chat.z.ai' },
            })];
          }
          if (message.type === 'GET_AUTOMATION_RUNS_BATCH') return {};
          if (message.type === 'GET_ZAI_MODELS') return { models: [], source: 'live' };
          return { ok: true };
        }),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
      tabs: { create: vi.fn(async () => { throw failure; }) },
    });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(AutomationPage));
    });
    await settle(6);

    const open = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('打开会话')) as HTMLElement;
    await act(async () => { open.click(); });
    await settle();

    expect(container.textContent).toContain('This extension does not have permission to use tabs.');
  });
});

describe('browser control page failure copy', () => {
  const settings = {
    enabled: true,
    targetTabId: 5,
    includeSnapshotAfterActions: true,
    maxSnapshotNodes: 400,
    maxSnapshotTextBytes: 24_000,
  };
  const state = {
    supported: true,
    enabled: true,
    attached: true,
    targetTabId: 5,
    target: null,
    targets: [],
    error: null,
  };

  async function mountPage() {
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(I18nProvider, null, React.createElement(BrowserControlPage)));
    });
    await settle(6);
  }

  it('wraps a failed detach in localized copy', async () => {
    stubRuntime((message) => {
      if (message.type === 'GET_BROWSER_CONTROL_SETTINGS') return settings;
      if (message.type === 'GET_BROWSER_CONTROL_STATE') return state;
      if (message.type === 'DETACH_BROWSER_CONTROL') {
        return { ok: false, error: 'No browser tab is attached.' };
      }
      return { ok: true };
    });

    await mountPage();
    const detach = Array.from(container.querySelectorAll('button'))
      .find((button) => /Detach|断开附着/.test(button.textContent ?? '')) as HTMLElement;
    await act(async () => { detach.click(); });
    await settle();

    const text = container.textContent ?? '';
    expect(text).toContain('Could not detach');
    expect(text).toContain('No browser tab is attached.');
  });

  it('wraps a failed state read in localized copy', async () => {
    stubRuntime((message) => {
      if (message.type === 'GET_BROWSER_CONTROL_SETTINGS') return settings;
      if (message.type === 'GET_BROWSER_CONTROL_STATE') {
        return { ok: false, error: 'No tab with id: 99.' };
      }
      return { ok: true };
    });

    await mountPage();

    const text = container.textContent ?? '';
    expect(text).toContain('Could not read browser control state');
    expect(text).toContain('No tab with id: 99.');
  });

  it('wraps a failed enable toggle in localized copy', async () => {
    stubRuntime((message) => {
      if (message.type === 'GET_BROWSER_CONTROL_SETTINGS') return settings;
      if (message.type === 'GET_BROWSER_CONTROL_STATE') return state;
      if (message.type === 'SET_BROWSER_CONTROL_ENABLED') {
        return { ok: false, error: 'chrome.debugger is unavailable.' };
      }
      return { ok: true };
    });

    await mountPage();
    const toggle = container.querySelector('button[aria-pressed]') as HTMLButtonElement;
    await act(async () => { toggle.click(); });
    await settle();

    const text = container.textContent ?? '';
    expect(text).toContain('Could not switch browser tools');
    expect(text).toContain('chrome.debugger is unavailable.');
  });

  it('wraps a failed target selection in localized copy', async () => {
    const target = {
      id: 7,
      windowId: 1,
      groupId: -1,
      active: false,
      currentWindow: false,
      title: 'Docs',
      url: 'https://example.com/docs',
      controllable: true,
    };
    stubRuntime((message) => {
      if (message.type === 'GET_BROWSER_CONTROL_SETTINGS') return settings;
      if (message.type === 'GET_BROWSER_CONTROL_STATE') {
        return { ...state, attached: false, targets: [target] };
      }
      if (message.type === 'SET_BROWSER_CONTROL_TARGET') {
        return { ok: false, error: 'This tab cannot be controlled by chrome.debugger.' };
      }
      return { ok: true };
    });

    await mountPage();
    const row = Array.from(container.querySelectorAll('button'))
      .find((button) => (button.textContent ?? '').includes('Docs')) as HTMLElement;
    await act(async () => { row.click(); });
    await settle();

    const text = container.textContent ?? '';
    expect(text).toContain('Failed to select target tab');
    expect(text).toContain('This tab cannot be controlled by chrome.debugger.');
  });

  it('rolls the slider back to the stored value when the save fails', async () => {
    stubRuntime((message) => {
      if (message.type === 'GET_BROWSER_CONTROL_SETTINGS') return settings;
      if (message.type === 'GET_BROWSER_CONTROL_STATE') return state;
      if (message.type === 'SAVE_BROWSER_CONTROL_SETTINGS') {
        return { ok: false, error: 'Storage write failed.' };
      }
      return { ok: true };
    });

    await mountPage();

    const range = () => container.querySelectorAll('input[type="range"]')[0] as HTMLInputElement;
    const slider = range();
    expect(slider.value).toBe('400');

    await act(async () => { setNativeValue(slider, '900'); });
    expect(slider.value).toBe('900');

    await act(async () => {
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => { setTimeout(resolve, 30); });
    });
    await settle();

    // The write failed, so the thumb must not keep claiming the new number.
    expect(range().value).toBe('400');
    expect(container.textContent).toContain('Could not save browser control settings');
  });
});

describe('prompt controls concurrent saves', () => {
  function promptRuntime(options: { firstSaveFails: boolean; saveDelayMs?: number; getOverride?: () => unknown }) {
    let saves = 0;
    const payloads: Array<Record<string, unknown>> = [];
    const stored = { memoryEnabled: true, systemPromptEnabled: true, presetCadence: 'default', forceResponseLanguage: 'auto' };
    let current: Record<string, unknown> = { ...stored };

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async (message: { type: string; payload?: Record<string, unknown> }) => {
          if (message.type === 'GET_PROMPT_INJECTION_SETTINGS') {
            return options.getOverride ? options.getOverride() : { ...current };
          }
          if (message.type === 'SAVE_PROMPT_INJECTION_SETTINGS') {
            saves += 1;
            const mine = saves;
            payloads.push(JSON.parse(JSON.stringify(message.payload)));
            await new Promise((resolve) => { setTimeout(resolve, options.saveDelayMs ?? 40); });
            if (mine === 1 && !options.firstSaveFails) {
              current = message.payload!;
              return message.payload;
            }
            return { ok: false, error: 'forced failure' };
          }
          return { ok: true };
        }),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    });

    return { payloads, stored: () => current };
  }

  /** The switch reflects its background colour: blue = on, border = off. */
  function switchStates() {
    return Array.from(container.querySelectorAll('button'))
      .filter((button) => (button.className ?? '').includes('rounded-full'))
      .map((button) => (button.style.background.includes('border') ? 'off' : 'on'));
  }

  async function mountAndToggleBoth() {
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(I18nProvider, null, React.createElement(PromptControlPanel)));
    });
    await settle(4);
    const toggles = () => Array.from(container.querySelectorAll('button'))
      .filter((button) => (button.className ?? '').includes('rounded-full')) as HTMLButtonElement[];
    await act(async () => {
      toggles()[0].click();
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      toggles()[1].click();
      await new Promise((resolve) => { setTimeout(resolve, 300); });
    });
  }

  it('leaves both switches on the stored values when both saves fail', async () => {
    promptRuntime({ firstSaveFails: true });
    await mountAndToggleBoth();

    // A whole-object revert brought back the first click's snapshot, so the
    // first switch stayed on a value the store never held.
    expect(switchStates()).toEqual(['on', 'on']);
  });

  it('keeps the first change when only the second save fails', async () => {
    const runtime = promptRuntime({ firstSaveFails: false });
    await mountAndToggleBoth();

    // The second save's rollback must not undo the first save's success.
    expect(switchStates()).toEqual(['off', 'on']);
    expect(runtime.stored()).toMatchObject({ memoryEnabled: false, systemPromptEnabled: true });
  });

  it('keeps both changes when the two clicks land in the same tick', async () => {
    const runtime = promptRuntime({ firstSaveFails: false, saveDelayMs: 20 });
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(I18nProvider, null, React.createElement(PromptControlPanel)));
    });
    await settle(4);
    const toggles = () => Array.from(container.querySelectorAll('button'))
      .filter((button) => (button.className ?? '').includes('rounded-full')) as HTMLButtonElement[];
    // No re-render between the two clicks: the second handler still holds the
    // pre-click snapshot, so the payload has to read the live value instead.
    await act(async () => {
      toggles()[0].click();
      toggles()[1].click();
      await new Promise((resolve) => { setTimeout(resolve, 200); });
    });

    expect(runtime.payloads[1]).toMatchObject({ memoryEnabled: false, systemPromptEnabled: false });
    expect(runtime.stored()).toMatchObject({ memoryEnabled: false, systemPromptEnabled: false });
  });

  it('builds the second payload from the first click, not from the pre-click state', async () => {
    const runtime = promptRuntime({ firstSaveFails: false, saveDelayMs: 30 });
    await mountAndToggleBoth();

    // Two clicks inside one tick used to read the same rendered snapshot, so the
    // second payload silently re-armed the first switch.
    expect(runtime.payloads[1]).toMatchObject({ memoryEnabled: false, systemPromptEnabled: false });
  });
});

describe('memory JSON import', () => {
  /**
   * The import path opens a real file picker, so the test drives it through a
   * stubbed `createElement`: the input auto-selects one file and fires `change`
   * on `click()`, which is what the browser does after the user picks a file.
   */
  function stubFilePicker() {
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = realCreate(tag) as HTMLElement;
      if (tag !== 'input') return element;
      const input = element as HTMLInputElement;
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [{ name: 'memories.json' }],
      });
      input.click = () => { void input.onchange?.(new Event('change')); };
      return element;
    }) as typeof document.createElement);
  }

  function importLabels() {
    return {
      arrayError: 'Import file must be a memory array',
      jsonError: 'Invalid JSON format',
      entryInvalid: (index: number, field: string) => `Memory #${index} has an invalid "${field}" field.`,
    };
  }

  async function mountController() {
    let captured: ReturnType<typeof useSettingsController> | null = null;
    function Harness() { captured = useSettingsController(); return null; }
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Harness));
    });
    await settle(4);
    return captured!;
  }

  it('reports a syntax error as invalid JSON instead of the parser position string', async () => {
    const results: Array<{ ok: boolean; error?: string }> = [];
    stubRuntime(() => ({ ok: true }));
    stubFilePicker();
    const controller = await mountController();

    await act(async () => {
      await controller.handleImport(importLabels(), (result) => { results.push(result); }, async () => '{ broken');
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ ok: false, error: 'Invalid JSON format' });
  });

  it('points at the offending record when the background rejects a field', async () => {
    const results: Array<{ ok: boolean; error?: string }> = [];
    stubRuntime((message) => {
      if (message.type === 'IMPORT_MEMORY_DRAFTS') {
        return { ok: false, error: 'memories[3].content must be a non-empty string' };
      }
      return { ok: true };
    });
    stubFilePicker();
    const controller = await mountController();

    await act(async () => {
      await controller.handleImport(importLabels(), (result) => { results.push(result); }, async () => '[{}]');
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    });

    // Zero-based in the decoder, one-based for the person reading the file.
    expect(results[0]).toEqual({
      ok: false,
      error: 'Memory #4 has an invalid "content" field.',
    });
  });

  it('surfaces a file read failure instead of dropping the rejection', async () => {
    const results: Array<{ ok: boolean; error?: string }> = [];
    stubRuntime(() => ({ ok: true }));
    stubFilePicker();
    const controller = await mountController();

    await act(async () => {
      await controller.handleImport(importLabels(), (result) => { results.push(result); }, async () => {
        throw new Error('NotReadableError: the file is locked');
      });
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    });

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('NotReadableError');
  });
});

describe('background configuration writes', () => {
  it('rejects a failed opacity commit so the slider can roll back', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async (message: { type: string }) => {
          if (message.type === 'GET_MEMORIES') return [];
          if (message.type === 'GET_CONFIG') return { version: '9.9.9' };
          if (message.type === 'GET_TAB_KEEPALIVE_SETTINGS') return { enabled: false };
          if (message.type === 'GET_BACKGROUND') {
            return { enabled: true, type: 'url', url: 'https://example.com/a.png', imageData: '', opacity: 0.5 };
          }
          if (message.type === 'SAVE_BACKGROUND') {
            return { ok: false, error: 'Storage write failed.' };
          }
          return { ok: true };
        }),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    });

    let captured: ReturnType<typeof useSettingsController> | null = null;
    function Harness() { captured = useSettingsController(); return null; }
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Harness));
    });
    await settle(4);

    // `Slider` rolls its draft value back only when `onCommit` rejects; a
    // swallowed error leaves the thumb on a number that was never written.
    await expect(captured!.handleOpacityCommit(0.8)).rejects.toBeTruthy();
  });


  it('re-reads the stored config when the mount-time read failed', async () => {
    const stored = {
      enabled: true,
      type: 'url',
      url: 'https://example.com/wallpaper.png',
      imageData: '',
      opacity: 0.5,
    };
    const writes: Array<Record<string, unknown>> = [];
    let backgroundReads = 0;

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async (message: { type: string; payload?: unknown }) => {
          if (message.type === 'GET_MEMORIES') return [];
          if (message.type === 'GET_CONFIG') return { version: '9.9.9' };
          if (message.type === 'GET_TAB_KEEPALIVE_SETTINGS') return { enabled: false };
          if (message.type === 'GET_BACKGROUND') {
            backgroundReads += 1;
            // The mount-time read fails; the retry inside the write succeeds.
            if (backgroundReads === 1) throw new Error('Extension context invalidated');
            return { ...stored };
          }
          if (message.type === 'SAVE_BACKGROUND') {
            writes.push(message.payload as Record<string, unknown>);
            return { ok: true };
          }
          return { ok: true };
        }),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    });

    let captured: ReturnType<typeof useSettingsController> | null = null;
    function Harness() {
      captured = useSettingsController();
      return null;
    }

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Harness));
    });
    await settle(4);

    await act(async () => {
      await captured!.handleOpacityCommit(0.8);
    });
    await settle();

    // A failed read is not "no background": the write must merge into what is
    // actually stored rather than persist the empty default over it.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      enabled: true,
      type: 'url',
      url: 'https://example.com/wallpaper.png',
      opacity: 0.8,
    });
  });
});
