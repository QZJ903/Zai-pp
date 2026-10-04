import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GeneralSubPage from '../entrypoints/sidepanel/components/settings/GeneralSubPage';
import { useSettingsController } from '../entrypoints/sidepanel/controllers/useSettingsController';
import { I18nProvider } from '../entrypoints/sidepanel/i18n';

/**
 * 「设置 → 通用 → 背景设置」的 URL 输入框契约。
 *
 * 预览图必须反映**已保存**的地址，而不是输入框里正在打的字。这个区别是本页面上
 * 唯一一处会造成**不可恢复**状态的地方：
 *
 *   预览跟随输入框 → 每敲一个字符都拿半截 URL 去加载 → 失败触发 `onError` →
 *   输入框被清空 → 用户永远填不完 URL。
 *
 * 而预览又是「自定义背景」开关与「清除背景」按钮的可用性判据
 * （`disabled={!bgPreview}` / `{bgPreview && <button>}`），所以输入框一旦被清空，
 * 那两个出口会**一起消失** —— 只剩「上传图片」能恢复。
 *
 * ⚠️ jsdom 默认不加载子资源，`<img>` 的 `error` 事件不会自己触发，所以这里
 * **手动派发**。不能依赖 jsdom 的默认行为 —— 那会让断言在缺陷代码上照样变绿。
 */

const SAVED_BAD_URL = 'https://bad.example/background.png';

let container: HTMLDivElement;
let root: Root | null;
let backgroundConfig: Record<string, unknown>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  backgroundConfig = {
    enabled: true,
    type: 'url',
    url: SAVED_BAD_URL,
    imageData: '',
    opacity: 0.3,
  };

  const storage: Record<string, unknown> = {};

  vi.stubGlobal('chrome', {
    // 语言固定成中文：断言里的按钮文案来自 i18n，跟随运行环境会让结果不确定。
    i18n: { getUILanguage: vi.fn(() => 'zh-CN') },
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => (
          Array.isArray(keys)
            ? Object.fromEntries(keys.map((key) => [key, storage[key]]))
            : { [keys]: storage[keys] }
        )),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(storage, values);
        }),
        remove: vi.fn(async (key: string | string[]) => {
          for (const item of Array.isArray(key) ? key : [key]) delete storage[item];
        }),
      },
      // I18nProvider 会订阅语言偏好变化；缺了它 Provider 挂载就抛。
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    runtime: {
      sendMessage: vi.fn(async (message: { type?: string }) => {
        switch (message?.type) {
          case 'GET_MEMORIES':
            return [];
          case 'GET_CONFIG':
            return { version: '9.9.9' };
          case 'GET_BACKGROUND':
            return backgroundConfig;
          default:
            return { ok: true };
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

/** 与 SettingsPage 的 general 子页同构：控制器 + 子页组件。 */
function Harness() {
  const state = useSettingsController();
  if (state.loading) return React.createElement('div', null, 'loading');
  return React.createElement(GeneralSubPage, { state });
}

async function renderSettings() {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(I18nProvider, null, React.createElement(Harness)));
  });
  await settle();
}

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function urlInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="url"]');
  if (!input) throw new Error('URL input not found');
  return input;
}

function previewImage(): HTMLImageElement | null {
  return container.querySelector<HTMLImageElement>('img[alt="背景预览"]');
}

function backgroundSwitch(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button.ds-switch');
  if (!button) throw new Error('background switch not found');
  return button;
}

function buttonByLabel(label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === label,
  ) ?? null;
}

/**
 * 写值必须走原型上的原生 setter。
 *
 * React 会在元素实例上接管 `value` 属性并维护一个 value tracker：直接
 * `input.value = x` 会同时更新 tracker，React 便认为「值没变」而**不触发 onChange**，
 * 于是输入根本没进 state —— 断言会在一段静默的假绿里通过。
 */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
}

/** 模拟用户逐字符输入：写值 + 派发 input（React 的受控输入靠这个事件回传）。 */
async function typeInto(input: HTMLInputElement, text: string) {
  let typed = input.value;
  for (const char of text) {
    typed += char;
    const next = typed;
    await act(async () => {
      setInputValue(input, next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  await settle();
}

describe('background URL input', () => {
  it('keeps the URL in the input when the saved preview fails to load', async () => {
    await renderSettings();

    const input = urlInput();
    expect(input.value).toBe(SAVED_BAD_URL);

    const image = previewImage();
    expect(image).toBeTruthy();
    expect(image!.getAttribute('src')).toBe(SAVED_BAD_URL);

    // 手动派发加载失败 —— jsdom 不会自己触发它。
    await act(async () => {
      image!.dispatchEvent(new Event('error'));
    });
    await settle();

    expect(input.value).toBe(SAVED_BAD_URL);
  });

  it('never points the preview at the text being typed', async () => {
    await renderSettings();

    await typeInto(urlInput(), 'https://typed.example');

    const image = previewImage();
    expect(image).toBeTruthy();
    // 预览只认已保存的地址；打字过程中它一次都不该跟着变。
    expect(image!.getAttribute('src')).toBe(SAVED_BAD_URL);
  });

  it('keeps the background switch and the clear button reachable while typing', async () => {
    await renderSettings();

    expect(buttonByLabel('清除背景')).toBeTruthy();
    expect(backgroundSwitch().disabled).toBe(false);

    await typeInto(urlInput(), 'https://typed.example');

    // 真实浏览器里，输入过程中挂载的预览图会**加载失败并派发 error**。
    // jsdom 不会自己触发，所以这里补上 —— 漏掉它，这条断言在缺陷代码上照样绿。
    const image = previewImage();
    if (image) {
      await act(async () => {
        image.dispatchEvent(new Event('error'));
      });
      await settle();
    }

    // 两个出口判的是「有没有已保存的背景」，与输入框里正在打什么无关，
    // 更不该被一次预览加载失败带走。
    expect(buttonByLabel('清除背景')).toBeTruthy();
    expect(backgroundSwitch().disabled).toBe(false);
  });

  it('adopts a newly confirmed URL as the preview source', async () => {
    await renderSettings();

    const input = urlInput();
    await act(async () => {
      setInputValue(input, 'https://good.example/next.png');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();

    const confirm = buttonByLabel('确认');
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    expect(previewImage()?.getAttribute('src')).toBe('https://good.example/next.png');
  });
});
