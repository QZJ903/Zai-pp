import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GeneralSubPage from '../entrypoints/sidepanel/components/settings/GeneralSubPage';
import { useSettingsController } from '../entrypoints/sidepanel/controllers/useSettingsController';
import { I18nProvider } from '../entrypoints/sidepanel/i18n';
import { Slider, useConfirm } from '../entrypoints/sidepanel/components/settings/primitives';

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

/** 只读那条链用不到，但 `GeneralSubPage` 依赖 controller 的完整形状。 */
function stubRuntime(options: {
  onSave?: (payload: unknown) => Promise<unknown> | unknown;
  onClear?: () => Promise<unknown> | unknown;
} = {}) {
  const storage: Record<string, unknown> = {
    zai_pp_background: { enabled: true, type: 'url', url: 'https://ok/a.png', imageData: '', opacity: 0.3 },
  };
  vi.stubGlobal('chrome', {
    i18n: { getUILanguage: vi.fn(() => 'zh-CN') },
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => (Array.isArray(keys)
          ? Object.fromEntries(keys.map((key) => [key, storage[key]]))
          : { [keys]: storage[keys] })),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(storage, values); }),
        remove: vi.fn(async (key: string) => { delete storage[key]; }),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn(async (message: { type?: string; payload?: unknown }) => {
        switch (message?.type) {
          case 'GET_MEMORIES': return [];
          case 'GET_CONFIG': return { version: '9.9.9' };
          case 'GET_BACKGROUND': return storage.zai_pp_background;
          case 'GET_TAB_KEEPALIVE_SETTINGS': return { enabled: false };
          case 'SAVE_BACKGROUND':
            if (options.onSave) return options.onSave(message.payload);
            storage.zai_pp_background = message.payload;
            return { ok: true };
          case 'CLEAR_BACKGROUND':
            if (options.onClear) return options.onClear();
            delete storage.zai_pp_background;
            return { ok: true };
          default: return { ok: true };
        }
      }),
    },
  });
}

function GeneralHarness() {
  const state = useSettingsController({ error: () => {} });
  if (state.loading) return React.createElement('div', null, 'loading');
  return React.createElement(GeneralSubPage, { state });
}

async function renderGeneral() {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(I18nProvider, null, React.createElement(GeneralHarness)));
  });
  await settle();
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === text) as HTMLButtonElement | undefined;
}

function hasPreview(): boolean {
  return Boolean(buttonByText('清除背景'));
}

function fireRange(value: string, type: 'input' | 'change') {
  const input = container.querySelector('input[type="range"]') as HTMLInputElement;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event(type, { bubbles: true }));
}

describe('clear background joins the same write queue', () => {
  /**
   * 队列只盖住 `SAVE_BACKGROUND` 时的真实序列是
   * `SAVE start → CLEAR start → CLEAR done → SAVE done`
   * ⇒ 后完成的 SAVE 把 ref 改回清除前那份配置、`setBgConfirmedUrl` 又长出预览图，
   * 而存储其实是干净的。这条用例让 SAVE 挂住、期间点清除，再放开它。
   *
   * ⚠️ 进队列之后「点清除」不会立刻生效 —— 它排在还在飞的 SAVE 后面。所以断言分两段：
   * 点完那一刻清除按钮**还在**（排队中），放开 SAVE 之后才消失。
   */
  it('does not resurrect the preview when a queued save lands after the clear', async () => {
    let releaseSave: (() => void) | null = null;
    stubRuntime({
      onSave: () => new Promise((resolve) => { releaseSave = () => resolve({ ok: true }); }),
    });
    await renderGeneral();

    await act(async () => {
      fireRange('0.55', 'input');
      fireRange('0.55', 'change');
    });
    await settle();
    expect(hasPreview()).toBe(true);

    await act(async () => { buttonByText('清除背景')?.click(); });
    await settle();
    // 排在挂住的 SAVE 后面 ⇒ 还没执行
    expect(releaseSave).not.toBeNull();
    expect(hasPreview()).toBe(true);

    await act(async () => { releaseSave?.(); });
    await settle();

    // 先跑完 SAVE、再跑 CLEAR ⇒ 预览必须消失，不能被 SAVE 的 setBgConfirmedUrl 复活
    expect(hasPreview()).toBe(false);
  });

  it('runs the clear after the pending save, in FIFO order', async () => {
    const order: string[] = [];
    stubRuntime({
      onSave: () => {
        order.push('save');
        return new Promise((resolve) => { setTimeout(() => resolve({ ok: true }), 5); });
      },
      onClear: () => { order.push('clear'); return { ok: true }; },
    });
    await renderGeneral();

    await act(async () => {
      fireRange('0.7', 'input');
      fireRange('0.7', 'change');
    });
    await act(async () => { buttonByText('清除背景')?.click(); });
    // 让那条 setTimeout 落地（settle 只 flush 微任务）
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    await settle();

    expect(order).toEqual(['save', 'clear']);
    expect(hasPreview()).toBe(false);
  });
});

describe('language radio group roving', () => {
  it('keeps one tab stop and moves focus with the arrow keys', async () => {
    stubRuntime();
    await renderGeneral();

    const radios = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
      .filter((button) => button.closest('[aria-label="界面语言"]') !== null);
    const group = radios();
    expect(group).toHaveLength(3);
    // 只有选中项能 Tab 到。
    expect(group.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);

    group[0].focus();
    await act(async () => {
      group[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    await settle();
    expect(radios().indexOf(document.activeElement as HTMLButtonElement)).toBe(1);
  });
});

describe('Slider draft lifecycle', () => {
  function fire(el: HTMLInputElement, type: 'input' | 'change', value: string) {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  /**
   * `onCommit` 从有到无时草稿要释放：否则下次把它加回来，第一帧显示的是旧草稿
   * 而不是 `value`。调用点目前都是静态属性，所以这条只能靠直接切 prop 来撞。
   */
  it('drops the draft when the caller stops passing onCommit', async () => {
    function Harness({ commit }: { commit: boolean }) {
      const [value, setValue] = React.useState(0.3);
      return React.createElement(Slider, {
        label: 'x',
        value,
        min: 0,
        max: 1,
        step: 0.05,
        ...(commit ? { onCommit: (next: number) => setValue(next) } : {}),
      });
    }
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Harness, { commit: true }));
    });
    const input = () => container.querySelector('input[type="range"]') as HTMLInputElement;
    await act(async () => { fire(input(), 'input', '0.9'); });
    expect(input().value).toBe('0.9');

    // 撤掉 onCommit（此时草稿仍在 0.9，value 还是 0.3）
    await act(async () => {
      root?.render(React.createElement(Harness, { commit: false }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(input().value).toBe('0.3');

    // 再加回来：第一帧必须是 value，而不是残留的草稿
    await act(async () => {
      root?.render(React.createElement(Harness, { commit: true }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(input().value).toBe('0.3');
  });
});

describe('useConfirm keeps a single resolver', () => {
  it('still settles the superseded call after the state field was dropped', async () => {
    const answers: Array<Promise<boolean>> = [];
    function Harness() {
      const { confirm, node } = useConfirm();
      const opened = React.useRef(false);
      React.useEffect(() => {
        if (opened.current) return;
        opened.current = true;
        answers.push(confirm({ title: 'a', message: 'a', confirmLabel: 'ok', cancelLabel: 'no' }));
        answers.push(confirm({ title: 'b', message: 'b', confirmLabel: 'ok', cancelLabel: 'no' }));
      });
      return node;
    }
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Harness));
    });
    await expect(answers[0]).resolves.toBe(false);
    const second = await Promise.race([answers[1].then(() => 'settled'), Promise.resolve('pending')]);
    expect(second).toBe('pending');
  });
});
