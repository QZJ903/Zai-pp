import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerDefaultToolResultRenderers,
  renderToolResultWithRegistry,
  userClickGuard,
  type ToolResultRendererActions,
} from '../core/ui/tool-result-renderer';
import type { ToolCardResult } from '../core/types';

/**
 * 卡片动作只由**真实用户手势**触发（`event.isTrusted`）。jsdom 合成不出 trusted
 * 事件，所以可信点击通过替换导出的 `userClickGuard` 持有者来模拟；不可信那条
 * 用真实守卫，断言 `element.click()`（isTrusted=false）什么都不做。
 */
function trustedClick(element: HTMLElement | null): void {
  element?.click();
}

function createActions(): ToolResultRendererActions & {
  saveSkill: ReturnType<typeof vi.fn>;
  importMemories: ReturnType<typeof vi.fn>;
} {
  return {
    saveSkill: vi.fn(async () => ({ ok: true })),
    importMemories: vi.fn(async () => ({ ok: true, count: 2 })),
  };
}

function skillDraftResult(): ToolCardResult {
  return {
    ok: true,
    summary: 'Skill draft ready',
    output: {
      kind: 'skill_draft',
      draft: {
        name: 'audit',
        description: 'Review contrast-sensitive output.',
        instructions: 'Check dark theme text.',
        memoryEnabled: true,
      },
    },
  };
}

function memoryImportResult(): ToolCardResult {
  return {
    ok: true,
    summary: 'Memory import preview ready (2)',
    output: {
      kind: 'memory_import_preview',
      memories: [{ name: 'alpha' }, { name: 'beta' }],
      duplicates: 1,
      rejected: 0,
    },
  };
}

describe('tool result renderer registry', () => {
  beforeEach(() => {
    userClickGuard.isTrusted = () => true;
  });

  afterEach(() => {
    userClickGuard.isTrusted = (event) => event.isTrusted;
    vi.useRealTimers();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.documentElement.classList.remove('dark', 'light');
    document.body.classList.remove('zpp-theme-dark', 'zpp-theme-light');
  });

  it('renders a Skill draft card with a save action', () => {
    registerDefaultToolResultRenderers(createActions());
    const target = document.createElement('div');

    const rendered = renderToolResultWithRegistry({
      target,
      result: skillDraftResult(),
      locale: 'en',
    });

    expect(rendered).toBe(true);
    expect(target.querySelector('.zpp-skill-draft-result')).not.toBeNull();
    expect(target.textContent).toContain('/audit');
    expect(target.textContent).toContain('Review contrast-sensitive output.');
    expect(target.textContent).toContain('Save Skill');
    expect(document.getElementById('zpp-injected-theme-css')).not.toBeNull();
  });

  it('renders a memory import preview card with an import action', () => {
    registerDefaultToolResultRenderers(createActions());
    const target = document.createElement('div');

    const rendered = renderToolResultWithRegistry({
      target,
      result: memoryImportResult(),
      locale: 'en',
    });

    expect(rendered).toBe(true);
    expect(target.querySelector('.zpp-memory-import-result')).not.toBeNull();
    expect(target.textContent).toContain('2 memories · 1 duplicates');
    expect(target.textContent).toContain('- alpha');
    expect(target.textContent).toContain('- beta');
    expect(target.textContent).toContain('Import memories');
  });

  it('saves the Skill through the injected action on a trusted click', async () => {
    const actions = createActions();
    registerDefaultToolResultRenderers(actions);
    const target = document.createElement('div');
    renderToolResultWithRegistry({ target, result: skillDraftResult(), locale: 'en' });

    trustedClick(target.querySelector<HTMLButtonElement>('.zpp-result-action'));

    expect(actions.saveSkill).toHaveBeenCalledTimes(1);
    expect(actions.saveSkill.mock.calls[0]?.[0]).toMatchObject({ name: 'audit' });
  });

  it('imports memories through the injected action on a trusted click', async () => {
    const actions = createActions();
    registerDefaultToolResultRenderers(actions);
    const target = document.createElement('div');
    renderToolResultWithRegistry({ target, result: memoryImportResult(), locale: 'en' });

    trustedClick(target.querySelector<HTMLButtonElement>('.zpp-result-action'));

    expect(actions.importMemories).toHaveBeenCalledTimes(1);
    expect(actions.importMemories.mock.calls[0]?.[0]).toEqual([{ name: 'alpha' }, { name: 'beta' }]);
  });

  it('ignores synthetic (untrusted) clicks on card actions', () => {
    // 恢复真实守卫：jsdom 的 click 报 isTrusted=false，正是要拦的页面世界合成点击。
    userClickGuard.isTrusted = (event) => event.isTrusted;
    const actions = createActions();
    registerDefaultToolResultRenderers(actions);
    const target = document.createElement('div');
    renderToolResultWithRegistry({ target, result: skillDraftResult(), locale: 'en' });

    trustedClick(target.querySelector<HTMLButtonElement>('.zpp-result-action'));

    expect(actions.saveSkill).not.toHaveBeenCalled();
  });

  it('reports a domain failure from the action instead of claiming success', async () => {
    const actions = createActions();
    actions.saveSkill.mockResolvedValueOnce({ ok: false, error: 'skill_exists' });
    registerDefaultToolResultRenderers(actions);
    const target = document.createElement('div');
    renderToolResultWithRegistry({ target, result: skillDraftResult(), locale: 'en' });

    trustedClick(target.querySelector<HTMLButtonElement>('.zpp-result-action'));
    await vi.waitFor(() => {
      expect(target.querySelector<HTMLButtonElement>('.zpp-result-action')?.textContent)
        .toBe('skill_exists');
    });
  });

  it('keeps the success label and stays disabled after saving', async () => {
    const actions = createActions();
    registerDefaultToolResultRenderers(actions);
    const target = document.createElement('div');
    renderToolResultWithRegistry({ target, result: skillDraftResult(), locale: 'en' });
    const button = target.querySelector<HTMLButtonElement>('.zpp-result-action')!;

    trustedClick(button);
    await vi.waitFor(() => expect(button.textContent).toBe('Saved'));

    // 成功是终态：文案不回退、按钮不可再点（再点等于重复写库）。
    expect(button.disabled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(button.textContent).toBe('Saved');
  });

  it('keeps the success label and stays disabled after importing memories', async () => {
    const actions = createActions();
    registerDefaultToolResultRenderers(actions);
    const target = document.createElement('div');
    renderToolResultWithRegistry({ target, result: memoryImportResult(), locale: 'en' });
    const button = target.querySelector<HTMLButtonElement>('.zpp-result-action')!;

    trustedClick(button);
    await vi.waitFor(() => expect(button.textContent).toBe('Imported 2'));

    expect(button.disabled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(button.textContent).toBe('Imported 2');
  });

  it('reports a failure when the transport returns nothing at all', async () => {
    // 传输层失败（扩展上下文失效 / sendMessage 抛错）返回的是 `undefined`。
    // 判 `=== false` 会把它当成功 → 按钮写「已导入 N 条」，而库里什么都没写。
    const actions = createActions();
    actions.importMemories.mockResolvedValueOnce(undefined);
    registerDefaultToolResultRenderers(actions);
    const target = document.createElement('div');
    renderToolResultWithRegistry({ target, result: memoryImportResult(), locale: 'en' });
    const button = target.querySelector<HTMLButtonElement>('.zpp-result-action')!;

    trustedClick(button);
    await vi.waitFor(() => expect(button.textContent).toBe('Import failed'));

    // 失败要恢复可点（否则用户连重试都做不到）。
    expect(button.disabled).toBe(false);
  });

  it('maps a known domain failure code to copy instead of showing the raw code', async () => {
    const actions = createActions();
    actions.importMemories.mockResolvedValueOnce({ ok: false, error: 'invalid_memories' });
    registerDefaultToolResultRenderers(actions);
    const target = document.createElement('div');
    renderToolResultWithRegistry({ target, result: memoryImportResult(), locale: 'en' });
    const button = target.querySelector<HTMLButtonElement>('.zpp-result-action')!;

    trustedClick(button);
    await vi.waitFor(() => expect(button.textContent).toBe('These drafts cannot be imported'));
  });

  it('shows the raw message for an unmapped failure, since it carries more than a generic label', async () => {
    const actions = createActions();
    actions.saveSkill.mockResolvedValueOnce({ ok: false, error: 'storage quota exceeded' });
    registerDefaultToolResultRenderers(actions);
    const target = document.createElement('div');
    renderToolResultWithRegistry({ target, result: skillDraftResult(), locale: 'en' });
    const button = target.querySelector<HTMLButtonElement>('.zpp-result-action')!;

    trustedClick(button);
    await vi.waitFor(() => expect(button.textContent).toBe('storage quota exceeded'));
  });

  it('re-enables the button after a failure so the action can be retried', async () => {
    const actions = createActions();
    actions.saveSkill.mockResolvedValueOnce({ ok: false, error: 'skill_exists' });
    registerDefaultToolResultRenderers(actions);
    const target = document.createElement('div');
    renderToolResultWithRegistry({ target, result: skillDraftResult(), locale: 'en' });
    const button = target.querySelector<HTMLButtonElement>('.zpp-result-action')!;

    trustedClick(button);
    await vi.waitFor(() => expect(button.textContent).toBe('skill_exists'));

    expect(button.disabled).toBe(false);
  });

  it('falls through for results it cannot render', () => {
    registerDefaultToolResultRenderers(createActions());
    const target = document.createElement('div');

    const rendered = renderToolResultWithRegistry({
      target,
      result: { ok: true, summary: 'ok', output: { kind: 'something_else' } },
      locale: 'en',
    });

    expect(rendered).toBe(false);
    expect(target.childElementCount).toBe(0);
  });

  it('gates on the declared kind, not just the presence of the payload shape', () => {
    registerDefaultToolResultRenderers(createActions());
    const target = document.createElement('div');

    // 形状对得上（memories 是数组、计数是数字），只有 kind 不是自己认的那个 ——
    // 必须拒绝，否则别的工具的同类结果会被这张卡片抢走。
    const rendered = renderToolResultWithRegistry({
      target,
      result: {
        ok: true,
        summary: 'ok',
        output: { kind: 'something_else', memories: [{ name: 'alpha' }], duplicates: 0, rejected: 0 },
      },
      locale: 'en',
    });

    expect(rendered).toBe(false);
    expect(target.childElementCount).toBe(0);
  });

  it('gates the Skill card on its declared kind too', () => {
    registerDefaultToolResultRenderers(createActions());
    const target = document.createElement('div');

    const rendered = renderToolResultWithRegistry({
      target,
      result: {
        ok: true,
        summary: 'ok',
        output: {
          kind: 'something_else',
          draft: {
            name: 'audit',
            description: 'desc',
            instructions: 'instructions long enough',
            memoryEnabled: false,
          },
        },
      },
      locale: 'en',
    });

    expect(rendered).toBe(false);
    expect(target.childElementCount).toBe(0);
  });

  it('refuses to draw a card for a failed result even when the output shape is complete', () => {
    // 「失败但 output 形状完整」时若画出卡片，那个按钮是可点的，而背后没有可保存的东西。
    registerDefaultToolResultRenderers(createActions());
    const target = document.createElement('div');
    const failed = skillDraftResult();
    failed.ok = false;

    const rendered = renderToolResultWithRegistry({ target, result: failed, locale: 'en' });

    expect(rendered).toBe(false);
    expect(target.childElementCount).toBe(0);
  });

  it('applies the same ok guard to the memory import card', () => {
    // 两个渲染器各有一条守卫 —— 只测 skill 那条会让 memory 那条的守卫被删掉而不红。
    registerDefaultToolResultRenderers(createActions());
    const target = document.createElement('div');
    const failed = memoryImportResult();
    failed.ok = false;

    const rendered = renderToolResultWithRegistry({ target, result: failed, locale: 'en' });

    expect(rendered).toBe(false);
    expect(target.childElementCount).toBe(0);
  });

  it('omits nameless entries from the preview list instead of printing "undefined"', () => {
    registerDefaultToolResultRenderers(createActions());
    const target = document.createElement('div');
    const result = memoryImportResult();
    (result.output as { memories: unknown[] }).memories = [
      { name: 'alpha' },
      { name: undefined },
      {},
    ];

    renderToolResultWithRegistry({ target, result, locale: 'en' });

    const list = target.querySelector('.zpp-result-text')!;
    expect(list.textContent).toBe('- alpha');
    expect(list.textContent).not.toContain('undefined');
  });

  it('falls through for malformed structured output', () => {
    registerDefaultToolResultRenderers(createActions());
    const target = document.createElement('div');

    const rendered = renderToolResultWithRegistry({
      target,
      result: {
        ok: true,
        summary: 'ok',
        output: { kind: 'memory_import_preview', memories: 'not-an-array', duplicates: 0, rejected: 0 },
      },
      locale: 'en',
    });

    expect(rendered).toBe(false);
    expect(target.childElementCount).toBe(0);
  });

  it('syncs the theme class itself instead of relying on the global theme watch', () => {
    // 卡片路径不经过 `installInjectedThemeWatch()`：变量块注入了、但 `body` 上的
    // `zpp-theme-*` 类没人写的话，`var(--zpp-ui-*)` 会落到浅色那一套 ——
    // 深色页面上就是「深色底 + 深色字」。所以卡片必须自己同步一次。
    document.documentElement.classList.add('dark');
    registerDefaultToolResultRenderers(createActions());
    const target = document.createElement('div');

    renderToolResultWithRegistry({ target, result: skillDraftResult(), locale: 'en' });

    expect(document.body.classList.contains('zpp-theme-dark')).toBe(true);
    expect(document.body.classList.contains('zpp-theme-light')).toBe(false);
  });

  it('leaves the theme class off when the page expresses no theme', () => {
    // 页面两个类都不在时要摘掉我们的类，交回 `prefers-color-scheme` 兜底；
    // 留着旧类会盖住媒体查询（两者特异度相同、后者在样式表后面）。
    document.body.classList.add('zpp-theme-dark');
    registerDefaultToolResultRenderers(createActions());
    const target = document.createElement('div');

    renderToolResultWithRegistry({ target, result: skillDraftResult(), locale: 'en' });

    expect(document.body.classList.contains('zpp-theme-dark')).toBe(false);
  });

  it('paints the card action label from the theme, never from a literal white', () => {
    // ⚠️ 实心 accent 底上写死白色是读不出来的：浅色 accent 上白字只有 3.74:1，
    // 深色 accent 上只有 2.27:1（`injected-theme-contrast.test.ts` 算的是配色本身，
    // 这里守的是「代码里确实用了那个 token」）。
    registerDefaultToolResultRenderers(createActions());
    const target = document.createElement('div');
    renderToolResultWithRegistry({ target, result: skillDraftResult(), locale: 'en' });

    const css = document.getElementById('zpp-result-css')?.textContent ?? '';
    const actionBlock = css.slice(
      css.indexOf('.zpp-result-action {'),
      css.indexOf('.zpp-result-action:disabled'),
    );
    expect(actionBlock.length).toBeGreaterThan(0);
    expect(actionBlock).toContain('color: var(--zpp-ui-accent-contrast)');
    expect(actionBlock).not.toMatch(/color:\s*(white|#|rgb|hsl|oklch)/i);
  });
});
