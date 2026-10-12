import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initSkillPopup,
  stopSkillPopup,
  keydownTrustGuard,
  compositionGuard,
  type SkillPopupDependencies,
} from '../core/ui/skill-popup';
import { resolveZaiComposerInput, resolveZaiComposerShell } from '../core/zai/composer';

/**
 * 输入框斜杠命令补全的行为用例。
 *
 * ⚠️ **不接真内容脚本** —— 依赖全部注入（与生产里 `zai.content.ts` 传的同一组函数），
 * 所以这里既验了模块本身，也顺带验了「生产注入的那几个实现」确实能满足它的契约。
 */

const STYLE_ID = 'dpp-skill-popup-css';

/** 造一个「像 z.ai 输入区」的 DOM：外壳（圆角+背景）> 裁切层 > textarea。 */
function buildComposer(): HTMLTextAreaElement {
  document.body.innerHTML = `
    <div id="app">
      <div class="shell" style="border-radius:12px;background:rgb(255,255,255)">
        <div class="overflow-hidden" style="overflow:hidden">
          <textarea id="chat-input"></textarea>
        </div>
      </div>
    </div>
  `;
  const textarea = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
  // jsdom 不做布局，`getBoundingClientRect` 恒为零 ⇒ 给个可分辨的桩，
  // 让「锚点取外壳还是取 textarea」这件事在断言里能看出来。
  textarea.getBoundingClientRect = () => rect(29, 509, 555, 40);
  document.querySelector<HTMLElement>('.shell')!.getBoundingClientRect = () => rect(17, 497, 581, 107);
  return textarea;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, width, height,
    right: left + width, bottom: top + height, x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** 生产里 `zai.content.ts` 注入的那组依赖（写值换成可断言的桩）。 */
function productionDeps(overrides: Partial<SkillPopupDependencies> = {}): {
  deps: SkillPopupDependencies;
  written: string[];
} {
  const written: string[] = [];
  const deps: SkillPopupDependencies = {
    resolveInput: resolveZaiComposerInput,
    resolveAnchor: (input) => resolveZaiComposerShell(input),
    setInputValue: (_input, value) => { written.push(value); },
    ...overrides,
  };
  return { deps, written };
}

function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 当前浮层的 `display` —— 可直接断言的字符串（'' 表示可见：样式表在 jsdom 里不生效）。 */
function popupDisplay(): string {
  return document.querySelector<HTMLElement>('.dpp-skill-popup')!.style.display;
}

/**
 * 浮层此刻可见吗。
 *
 * ⚠️ **两种情况都算「不可见」**：元素压根没建（从未显示过）与元素存在但
 * `display: none`。用例关心的是「用户看不看得见」，**不是「元素在不在」** ——
 * 只断言后者会把「一直不显示」误判成失败。
 */
function popupVisible(): boolean {
  const popup = document.querySelector<HTMLElement>('.dpp-skill-popup');
  return popup !== null && popup.style.display !== 'none';
}

/** 派发一个「可信」的按键（jsdom 造不出真的，靠守卫的桩让它走真人那条路）。 */
function pressTrusted(key: string, target: EventTarget = document): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

/**
 * 派发一个「可信且正在输入法组字」的按键。
 *
 * ⚠️ **两个属性都要桩**：`isTrusted` 让那条守卫放行（组字期的按键确实是可信的），
 * `isComposing` 才是被测的那道判据 —— 只桩 `isTrusted` 的话测的是别的东西。
 */
function pressComposing(key: string, target: EventTarget = document): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true, isComposing: true,
  });
  target.dispatchEvent(event);
  return event;
}

const SKILLS = [
  { name: 'review', description: 'Review changes' },
  { name: 'test', description: 'Run tests' },
];

beforeEach(() => {
  keydownTrustGuard.isTrusted = () => true;
  compositionGuard.isComposing = (event) => event.isComposing;
  // jsdom 不实现 scrollIntoView，而高亮当前项时会调它。真机上有这个 API，
  // 所以这里补桩、**不改生产代码**（为一个浏览器必备的 API 加守卫是白加一层）。
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  stopSkillPopup();
  keydownTrustGuard.isTrusted = (event) => event.isTrusted;
  compositionGuard.isComposing = (event) => event.isComposing;
  document.body.innerHTML = '';
  document.getElementById(STYLE_ID)?.remove();
  vi.restoreAllMocks();
});

describe('skill popup lifecycle', () => {
  it('installs resources once and removes them idempotently', () => {
    buildComposer();
    const addListener = vi.spyOn(document, 'addEventListener');
    const removeListener = vi.spyOn(document, 'removeEventListener');
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const { deps } = productionDeps();

    initSkillPopup(SKILLS, { hint: 'hint' }, deps);
    initSkillPopup([{ name: 'other', description: 'x' }], { hint: 'hint' }, deps);

    expect(addListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    expect(addListener.mock.calls.filter(([type]) => type === 'mousedown')).toHaveLength(1);
    expect(document.getElementById(STYLE_ID)).not.toBeNull();

    stopSkillPopup();
    stopSkillPopup();

    expect(removeListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    expect(removeListener.mock.calls.filter(([type]) => type === 'mousedown')).toHaveLength(1);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(document.querySelector('.dpp-skill-popup')).toBeNull();
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });

  it('can restart cleanly after teardown', () => {
    const textarea = buildComposer();
    const { deps } = productionDeps();

    initSkillPopup(SKILLS, {}, deps);
    typeInto(textarea, '/');
    expect(document.querySelector('.dpp-skill-popup')).not.toBeNull();

    stopSkillPopup();
    initSkillPopup([{ name: 'test', description: 'Run tests' }], {}, deps);
    typeInto(textarea, '/t');

    expect(document.querySelector('.dpp-skill-trigger')?.textContent).toBe('/test');
  });

  it('refreshes the rendered list on every call, including while it is open', () => {
    const textarea = buildComposer();
    const { deps } = productionDeps();
    initSkillPopup(SKILLS, {}, deps);

    // ⚠️ **必须让浮层先处于可见态** —— 否则 `initSkillPopup` 里那句
    // 「可见时才重画」不会执行，这条用例就够不到它要测的分支（第一版就是这么假绿的）。
    typeInto(textarea, '/');
    expect(popupVisible()).toBe(true);

    initSkillPopup([{ name: 'zzz', description: 'later' }], {}, deps);
    const names = [...document.querySelectorAll('.dpp-skill-trigger')].map((el) => el.textContent);

    expect(names).toEqual(['/zzz']);
  });
});

describe('skill popup filtering and selection', () => {
  it('filters by prefix, case-insensitively', () => {
    const textarea = buildComposer();
    initSkillPopup(SKILLS, {}, productionDeps().deps);

    typeInto(textarea, '/re');
    expect([...document.querySelectorAll('.dpp-skill-trigger')].map((el) => el.textContent))
      .toEqual(['/review']);
  });

  it('hides again once the query has a space (argument part)', () => {
    const textarea = buildComposer();
    initSkillPopup(SKILLS, {}, productionDeps().deps);

    typeInto(textarea, '/');
    expect(popupVisible()).toBe(true);

    // 打了空格就进了参数部分 —— 浮层该收起来。
    typeInto(textarea, '/review ');
    expect(popupVisible()).toBe(false);
  });

  it('hides again when nothing matches', () => {
    const textarea = buildComposer();
    initSkillPopup(SKILLS, {}, productionDeps().deps);

    typeInto(textarea, '/');
    expect(popupVisible()).toBe(true);

    typeInto(textarea, '/nope');
    expect(popupVisible()).toBe(false);
  });

  it('writes "/name " into the input through the injected primitive', () => {
    const textarea = buildComposer();
    const { deps, written } = productionDeps();
    initSkillPopup(SKILLS, {}, deps);

    typeInto(textarea, '/rev');
    pressTrusted('Enter');

    expect(written).toEqual(['/review ']);
    expect(popupDisplay()).toBe('none');
  });

  it('moves the active item with arrow keys and wraps around', () => {
    const textarea = buildComposer();
    const { deps, written } = productionDeps();
    initSkillPopup(SKILLS, {}, deps);

    typeInto(textarea, '/');
    pressTrusted('ArrowDown');
    pressTrusted('Enter');

    expect(written).toEqual(['/test ']);
  });

  it('closes on Escape without writing anything', () => {
    const textarea = buildComposer();
    const { deps, written } = productionDeps();
    initSkillPopup(SKILLS, {}, deps);

    typeInto(textarea, '/');
    pressTrusted('Escape');

    expect(written).toEqual([]);
    expect(popupDisplay()).toBe('none');
  });

  it('renders descriptions as text, not markup', () => {
    const textarea = buildComposer();
    initSkillPopup(
      [{ name: 'evil', description: '<img src=x onerror="boom()">' }],
      {},
      productionDeps().deps,
    );

    typeInto(textarea, '/');
    const description = document.querySelector('.dpp-skill-desc')!;

    expect(description.textContent).toBe('<img src=x onerror="boom()">');
    expect(description.querySelector('img')).toBeNull();
  });
});

describe('skill popup key ownership', () => {
  it('swallows a trusted Enter so the page never sees it', () => {
    const textarea = buildComposer();
    const { deps } = productionDeps();
    initSkillPopup(SKILLS, {}, deps);
    typeInto(textarea, '/');

    const pageHandler = vi.fn();
    document.querySelector('.shell')!.addEventListener('keydown', pageHandler);
    const event = pressTrusted('Enter', textarea);

    expect(pageHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('lets a synthetic Enter through untouched (no known producer today, kept as defence)', () => {
    const textarea = buildComposer();
    const { deps, written } = productionDeps();
    initSkillPopup(SKILLS, {}, deps);
    typeInto(textarea, '/');

    const pageHandler = vi.fn();
    textarea.addEventListener('keydown', pageHandler);
    keydownTrustGuard.isTrusted = (event) => event.isTrusted;
    const event = pressTrusted('Enter', textarea);

    expect(pageHandler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(written).toEqual([]);
  });

  it('lets a composing Enter through (IME candidate confirmation)', () => {
    const textarea = buildComposer();
    const { deps, written } = productionDeps();
    initSkillPopup(SKILLS, {}, deps);
    typeInto(textarea, '/');

    // ⚠️ 输入法组字期按 Enter 是**可信按键**（`isTrusted` 为真），
    // 所以 `keydownTrustGuard` 拦不住它 —— 只有 `compositionGuard` 能。
    const pageHandler = vi.fn();
    textarea.addEventListener('keydown', pageHandler);
    const event = pressComposing('Enter', textarea);

    expect(pageHandler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(written).toEqual([]);
  });

  it('lets composing arrow keys and Escape through too', () => {
    const textarea = buildComposer();
    initSkillPopup(SKILLS, {}, productionDeps().deps);
    typeInto(textarea, '/');

    // 组字期的 ↑↓ 是在翻输入法候选、Esc 是取消组字，都不该被我们吃掉。
    for (const key of ['ArrowDown', 'ArrowUp', 'Tab', 'Escape']) {
      const event = pressComposing(key, textarea);
      expect(event.defaultPrevented, `${key} 不该被掐`).toBe(false);
    }
  });

  it('still swallows a trusted Enter that is NOT composing', () => {
    const textarea = buildComposer();
    const { deps, written } = productionDeps();
    initSkillPopup(SKILLS, {}, deps);
    typeInto(textarea, '/');

    // 反面：确认「组字守卫没有把真人按键一起放行」——
    // 组字期是 isComposing 为真的那一段，结束之后按 Enter 必须照常被我们接管。
    pressComposing('Enter', textarea);
    const after = pressTrusted('Enter', textarea);

    expect(after.defaultPrevented).toBe(true);
    expect(written).toEqual(['/review ']);
  });

  it('ignores keys entirely while the popup is hidden', () => {
    const textarea = buildComposer();
    initSkillPopup(SKILLS, {}, productionDeps().deps);

    const event = pressTrusted('Enter', textarea);

    expect(event.defaultPrevented).toBe(false);
  });
});

describe('skill popup anchoring', () => {
  it('anchors to the composer shell, not the textarea', () => {
    const textarea = buildComposer();
    initSkillPopup(SKILLS, {}, productionDeps().deps);

    typeInto(textarea, '/');
    const popup = document.querySelector<HTMLElement>('.dpp-skill-popup')!;

    // 外壳 left 17 / top 497（textarea 是 29 / 509）⇒ 取错锚点这两个数就对不上。
    expect(popup.style.left).toBe('17px');
    expect(popup.style.bottom).toBe(`${window.innerHeight - 497 + 6}px`);
    // 宽度同样按外壳算：min(581 × 0.5, 280) = 280
    expect(popup.style.width).toBe('280px');
  });

  it('falls back to the textarea when no shell can be found', () => {
    document.body.innerHTML = `<div><textarea id="chat-input"></textarea></div>`;
    const textarea = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    textarea.getBoundingClientRect = () => rect(29, 509, 555, 40);
    initSkillPopup(SKILLS, {}, productionDeps().deps);

    typeInto(textarea, '/');
    const popup = document.querySelector<HTMLElement>('.dpp-skill-popup')!;

    expect(popup.style.left).toBe('29px');
  });
});

describe('skill popup remounts after the page rebuilds the input', () => {
  it('re-attaches to a fresh textarea node', async () => {
    const textarea = buildComposer();
    const { deps } = productionDeps();
    initSkillPopup(SKILLS, {}, deps);

    // ⚠️⚠️ **必须先把浮层收起来再换节点** —— 否则「换完还是可见」可能是**换之前就可见**，
    // 断言恒真、这条用例什么都测不到（第一版就是这么假绿的：它连 listener 挂没挂都分辨不出）。
    typeInto(textarea, '/');
    expect(popupVisible()).toBe(true);
    typeInto(textarea, '/review ');
    expect(popupVisible()).toBe(false);

    // 页面换会话时会把输入框换掉（真机实测过）—— 补全必须跟到新节点上。
    const fresh = document.createElement('textarea');
    fresh.id = 'chat-input';
    textarea.replaceWith(fresh);

    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    typeInto(fresh, '/');
    expect(popupVisible()).toBe(true);
  });
});

describe('composer resolution (the injectable the popup depends on)', () => {
  it('prefers the single-source selector', () => {
    document.body.innerHTML = `
      <textarea id="decoy"></textarea>
      <textarea id="chat-input"></textarea>
    `;
    expect(resolveZaiComposerInput()?.id).toBe('chat-input');
  });

  it('treats a rounded, opaque ancestor as the shell', () => {
    const textarea = buildComposer();
    expect(resolveZaiComposerShell(textarea)?.className).toBe('shell');
  });

  it('skips the transparent clipping layer just above the textarea', () => {
    const textarea = buildComposer();
    // textarea 的直接父层是 overflow-hidden 且透明的 —— 浮层挂进去会被裁掉，
    // 所以它绝不能被当成外壳。
    expect(resolveZaiComposerShell(textarea)?.className).not.toBe('overflow-hidden');
  });

  it('returns null when nothing above qualifies', () => {
    document.body.innerHTML = `<div class="plain"><textarea id="chat-input"></textarea></div>`;
    const textarea = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    expect(resolveZaiComposerShell(textarea)).toBeNull();
  });
});