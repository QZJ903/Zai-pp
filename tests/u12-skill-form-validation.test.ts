import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import SkillForm from '../entrypoints/sidepanel/components/SkillForm';
import type { Skill } from '../core/types';

/**
 * Skills 表单的三档校验提示。
 *
 * ⚠️⚠️ 守的是「点了保存，什么都没发生」——这条链之前是**静默 `return`**：表单不关、
 * 不报错、也不保存。而三档用户的感受完全不同，所以必须分开说：
 * ① 名字空着 → 「请先填写名称」；
 * ② 名字打了字但归一是空（中文会被换成短横线再去掉）→ 必须说明字符集，
 *    否则用户看到「名称不能为空」会以为软件瞎了（他明明打了字）；
 * ③ 指令空着 → 「请填写指令」。
 *
 * ⚠️ 不套 `I18nProvider`：`i18n.tsx` 的 context 默认值就是 zh-CN 的 translator
 * （见那里的 `createContext`），而这组用例要断言的正是中文文案本身。
 */

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
});

const NAME_PLACEHOLDER = '名称（如 my-skill）';
// ⚠️ 指令框的 placeholder 里带换行，**不能拿它拼 CSS 选择器**（`Invalid selector`）。
// 按控件类型取：表里只有这一个 `textarea`。
const INSTRUCTIONS_PLACEHOLDER = 'textarea';

describe('SkillForm validation feedback', () => {
  it('tells the user to enter a name instead of silently doing nothing', async () => {
    const saved: Skill[] = [];
    await renderForm(saved);
    await submit();

    expect(container.textContent).toContain('请先填写名称');
    expect(saved).toHaveLength(0);
  });

  it('explains the character set when the name normalizes to empty', async () => {
    const saved: Skill[] = [];
    await renderForm(saved);
    // 中文会被 slug 化成空串 —— 这正是最容易被误报成「名称不能为空」的那一档。
    await enterByPlaceholder(NAME_PLACEHOLDER, '我的技能');
    await enterInstructions('做点什么');
    await submit();

    expect(container.textContent).not.toContain('请先填写名称');
    expect(container.textContent).toContain('只能包含小写字母、数字和短横线');
    expect(saved).toHaveLength(0);
  });

  it('tells the user the instructions are missing', async () => {
    const saved: Skill[] = [];
    await renderForm(saved);
    await enterByPlaceholder(NAME_PLACEHOLDER, 'my-skill');
    await submit();

    expect(container.textContent).toContain('请填写指令');
    expect(saved).toHaveLength(0);
  });

  it('saves once every field is valid', async () => {
    const saved: Skill[] = [];
    await renderForm(saved);
    await enterByPlaceholder(NAME_PLACEHOLDER, 'My Skill');
    await enterInstructions('按步骤执行');
    await submit();

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'my-skill', instructions: '按步骤执行' });
  });
});

async function renderForm(saved: Skill[]) {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(SkillForm, {
      onSave: (skill: Skill) => saved.push(skill),
      onCancel: () => undefined,
    }));
  });
}

async function submit() {
  const button = Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.trim() === '保存');
  expect(button, '找不到保存按钮').toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function enterInstructions(value: string) {
  const field = container.querySelector('textarea');
  expect(field, '找不到指令输入框').toBeTruthy();
  await setControlValue(field as HTMLTextAreaElement, value);
}

async function enterByPlaceholder(placeholder: string, value: string) {
  const field = container.querySelector(
    `input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`,
  ) as HTMLInputElement | HTMLTextAreaElement | null;
  expect(field, `找不到占位符为 ${placeholder} 的输入框`).toBeTruthy();
  await setControlValue(field as HTMLInputElement, value);
}

/**
 * ⚠️ 必须走**原型上的原生 setter** —— 直接 `field.value = x` 时 React 装的值追踪器
 * 收不到变更、`onChange` 不触发（受控组件仍是旧值）。
 */
async function setControlValue(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype = field instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
