import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendToolBlockToMessage,
  createToolBlockShell,
  findToolBlock,
  injectToolBlockStyles,
  removeToolBlock,
  updateToolBlockContent,
  type ToolBlockDependencies,
} from '../core/ui/tool-block';
import type { ToolCardResult, ToolExecutionRecord } from '../core/types';

/**
 * 面板渲染层的用例。
 *
 * ⚠️ **依赖全部注入**（与生产里 `core/zai/tool-panel.ts` 传的同一组形状），
 * 所以这里既验模块本身，也顺带钉住「生产的注入能满足它的契约」。
 */

const STYLE_ID = 'dpp-tool-block-css';

function deps(overrides: Partial<ToolBlockDependencies> = {}): ToolBlockDependencies {
  return {
    resolveHost: (message) => message.querySelector('#response-content-container') ?? message,
    listMessages: () => [...document.querySelectorAll('.chat-assistant')],
    formatStatus: (execution) => (execution.result.ok ? 'done' : 'failed'),
    formatDetail: (result) => result.detail ?? '',
    document,
    ...overrides,
  };
}

function buildMessage(id: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = `message-${id}`;
  const bubble = document.createElement('div');
  bubble.className = 'chat-assistant';
  const host = document.createElement('div');
  host.id = 'response-content-container';
  bubble.appendChild(host);
  wrapper.appendChild(bubble);
  document.body.appendChild(wrapper);
  return bubble;
}

function execution(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    name: 'shell_exec',
    result: { ok: true, summary: 'done' } as ToolCardResult,
    ...overrides,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  document.getElementById(STYLE_ID)?.remove();
  vi.restoreAllMocks();
});

describe('tool block shell', () => {
  it('renders the collapsed header with a title slot', () => {
    const block = createToolBlockShell(deps(), { restoreKey: 'r1', collapsed: true });
    expect(block.className).toBe('dpp-tool-block');
    expect(block.getAttribute('data-dpp-tool-key')).toBe('r1');
    expect(block.getAttribute('data-collapsed')).toBe('true');
    expect(block.querySelector('.dpp-tool-block-title')).not.toBeNull();
    expect(block.querySelector('.dpp-tool-block-body')).not.toBeNull();
  });

  it('toggles collapsed state on click', () => {
    const block = createToolBlockShell(deps(), { collapsed: true });
    const header = block.querySelector<HTMLElement>('.dpp-tool-block-header')!;
    header.click();
    expect(block.getAttribute('data-collapsed')).toBe('false');
    header.click();
    expect(block.getAttribute('data-collapsed')).toBe('true');
  });

  it('toggles collapsed state from the keyboard too', () => {
    const block = createToolBlockShell(deps(), { collapsed: true });
    const header = block.querySelector<HTMLElement>('.dpp-tool-block-header')!;
    // ⚠️ 上游只挂 click —— 键盘用户打不开。这条守的是「我们补上了键盘通路」。
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(block.getAttribute('data-collapsed')).toBe('false');
    header.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(block.getAttribute('data-collapsed')).toBe('true');
  });
});

describe('tool block content', () => {
  it('draws one row per execution and sets the title count', () => {
    const block = createToolBlockShell(deps());
    updateToolBlockContent(block, [execution(), execution({ name: 'web_search' })], deps(), (n) => `${n} tools`);

    expect(block.querySelector('.dpp-tool-block-title')?.textContent).toBe('2 tools');
    const names = [...block.querySelectorAll('.dpp-tool-block-item-name')].map((el) => el.textContent);
    expect(names).toEqual(['shell_exec', 'web_search']);
  });

  it('marks a failed row with the error class', () => {
    const block = createToolBlockShell(deps());
    updateToolBlockContent(
      block,
      [execution({ result: { ok: false, summary: 'failed' } as ToolCardResult })],
      deps(),
      () => 't',
    );
    expect(block.querySelector('.dpp-tool-block-item-status')?.className)
      .toContain('error');
  });

  it('redraws instead of appending when called twice', () => {
    const block = createToolBlockShell(deps());
    updateToolBlockContent(block, [execution()], deps(), () => 't');
    updateToolBlockContent(block, [execution({ name: 'web_search' })], deps(), () => 't');
    const names = [...block.querySelectorAll('.dpp-tool-block-item-name')].map((el) => el.textContent);
    // ⚠️ 整块重画 —— 增量插入要维护「哪一行对应哪条执行」的映射，漂移即状态串行。
    expect(names).toEqual(['web_search']);
  });

  it('renders details through the injected renderer and skips text when it succeeds', () => {
    const block = createToolBlockShell(deps());
    const renderDetail = vi.fn((target: HTMLElement) => {
      target.textContent = 'CARD';
      return true;
    });
    updateToolBlockContent(
      block,
      [execution({ result: { ok: true, summary: 'done', detail: 'RAW' } as ToolCardResult })],
      deps({ renderDetail }),
      () => 't',
    );
    expect(renderDetail).toHaveBeenCalledOnce();
    // ⚠️ 渲染器成功时必须**不**再写纯文本，否则卡片会被文本盖住。
    expect(block.querySelector('.dpp-tool-block-item-detail')?.textContent).toBe('CARD');
  });

  it('falls back to plain text when the renderer declines', () => {
    const block = createToolBlockShell(deps());
    updateToolBlockContent(
      block,
      [execution({ result: { ok: true, summary: 'done', detail: 'RAW' } as ToolCardResult })],
      deps({ renderDetail: () => false }),
      () => 't',
    );
    expect(block.querySelector('.dpp-tool-block-item-detail')?.textContent).toBe('RAW');
  });

  it('omits the detail element when there is no detail text', () => {
    const block = createToolBlockShell(deps());
    updateToolBlockContent(block, [execution()], deps(), () => 't');
    expect(block.querySelector('.dpp-tool-block-item-detail')).toBeNull();
  });

  it('draws the result summary on the row, not only the status', () => {
    const block = createToolBlockShell(deps());
    updateToolBlockContent(
      block,
      [execution({ result: { ok: true, summary: '搜索完成，找到 8 条结果' } as ToolCardResult })],
      deps(),
      () => 't',
    );
    // ⚠️ 折叠态下每行只有「工具名 + 状态」时长得一模一样，看不出做了什么
    // ⇒ 摘要必须进行内（上游控制台的已完成行就是这个形态）。
    expect(block.querySelector('.dpp-tool-block-item-summary')?.textContent)
      .toBe('搜索完成，找到 8 条结果');
  });
});

describe('tool block row-level collapse', () => {
  const withDetail = () => execution({
    result: { ok: true, summary: 'done', detail: 'RAW DETAIL' } as ToolCardResult,
  });

  function render(executions: ToolExecutionRecord[] = [withDetail()]) {
    const block = createToolBlockShell(deps());
    updateToolBlockContent(block, executions, deps(), () => 't');
    return block;
  }

  function toggleOf(block: HTMLElement, index = 0): HTMLElement {
    return block.querySelectorAll<HTMLElement>('.dpp-tool-block-item-toggle')[index];
  }

  function detailOf(block: HTMLElement, index = 0): HTMLElement | null {
    return block.querySelectorAll<HTMLElement>('.dpp-tool-block-item-detail')[index] ?? null;
  }

  it('starts collapsed and expands on click', () => {
    const block = render();
    const toggle = toggleOf(block);
    // ⚠️ 默认收起（上游 `createAgentToolRow`：`aria-expanded="false"` + `hidden`）——
    // 长正文（web_fetch 的网页正文可达 4000 字符）会把后面的工具行冲散。
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(detailOf(block)?.hidden).toBe(true);

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(detailOf(block)?.hidden).toBe(false);

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(detailOf(block)?.hidden).toBe(true);
  });

  it('toggles a row from the keyboard too', () => {
    const block = render();
    const toggle = toggleOf(block);
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands rows independently', () => {
    const block = render([
      withDetail(),
      execution({ callId: 'xml:bbb', name: 'web_search', result: { ok: true, summary: 'done', detail: 'OTHER' } as ToolCardResult }),
    ]);
    toggleOf(block, 1).click();
    expect(toggleOf(block, 0).getAttribute('aria-expanded')).toBe('false');
    expect(toggleOf(block, 1).getAttribute('aria-expanded')).toBe('true');
    expect(detailOf(block, 0)?.hidden).toBe(true);
    expect(detailOf(block, 1)?.hidden).toBe(false);
  });

  it('keeps the expanded row open when the block is redrawn', () => {
    const block = render();
    toggleOf(block).click();

    // ⚠️⚠️ **实时链路上每执行一步就会整块重画一次**（publishLiveSession → renderRecord）。
    // 不保住展开态的话，用户刚点开的那一行会被下一次重画收起来。
    updateToolBlockContent(block, [withDetail()], deps(), () => 't');
    expect(toggleOf(block).getAttribute('aria-expanded')).toBe('true');
    expect(detailOf(block)?.hidden).toBe(false);
  });

  it('does not draw a chevron or a toggle for rows without detail', () => {
    const block = render([execution()]);
    // ⚠️ 没有详情的行挂开关 = 一个点了没反应的死控件。
    expect(block.querySelector('.dpp-tool-block-item-chevron')).toBeNull();
    expect(toggleOf(block).getAttribute('aria-expanded')).toBe('false');
    expect(detailOf(block)).toBeNull();
  });

  it('hides a detail box whose text is just the row summary', () => {
    // ⚠️ 详情公式的第一段恒为 `result.summary` ⇒「没有 detail、没有 output」的结果
    // （最典型的是**执行中那一行**）会格式化出「只有摘要一行」的详情。
    // 行内已经显示了同一句话，那种行不该给开关。
    const block = createToolBlockShell(deps({
      formatDetail: (result) => result.summary ?? '',
    }));
    updateToolBlockContent(block, [execution({ result: { ok: true, summary: '执行中' } as ToolCardResult })], deps({
      formatDetail: (result) => result.summary ?? '',
    }), () => 't');
    expect(block.querySelector('.dpp-tool-block-item-chevron')).toBeNull();
    expect(block.querySelector('.dpp-tool-block-item-detail')).toBeNull();
  });
});

describe('tool block placement', () => {
  it('appends into the response host, not the bubble', () => {
    const bubble = buildMessage('a');
    const block = createToolBlockShell(deps());
    expect(appendToolBlockToMessage(bubble, block, deps())).toBe(true);
    expect(block.parentElement?.id).toBe('response-content-container');
  });

  it('moves the active id off the previous block', () => {
    const first = buildMessage('a');
    const second = buildMessage('b');
    const blockA = createToolBlockShell(deps());
    const blockB = createToolBlockShell(deps());
    appendToolBlockToMessage(first, blockA, deps());
    appendToolBlockToMessage(second, blockB, deps());

    // ⚠️ 页面上同时存在多块，而 `id` 只能有一个 —— 不摘旧的会让
    // `getElementById` 一直指向上一次的那块。
    expect(blockA.id).toBe('');
    expect(blockB.id).toBe('dpp-tool-block');
    expect(document.getElementById('dpp-tool-block')).toBe(blockB);
  });

  it('reports failure when the host is not there yet', () => {
    const bubble = document.createElement('div');
    bubble.className = 'chat-assistant';
    document.body.appendChild(bubble);
    const block = createToolBlockShell(deps());
    // ⚠️ 这里要**严格**解析宿主（不回落消息本身）—— 生产的 `resolveZaiResponseHost`
    // 就是严格版：找不到返回 null，由编排层重试，而不是挂到消息上凑合。
    const strict = deps({ resolveHost: (message) => message.querySelector('#response-content-container') });
    expect(appendToolBlockToMessage(bubble, block, strict)).toBe(false);
    expect(block.isConnected).toBe(false);
  });

  it('finds a block by its restore key across messages', () => {
    const bubble = buildMessage('a');
    const block = createToolBlockShell(deps(), { restoreKey: 'key-1' });
    appendToolBlockToMessage(bubble, block, deps());
    expect(findToolBlock('key-1', deps())).toBe(block);
    expect(findToolBlock('key-2', deps())).toBeNull();
  });

  it('removes a block and clears its id and active marker', () => {
    const bubble = buildMessage('a');
    const block = createToolBlockShell(deps());
    appendToolBlockToMessage(bubble, block, deps());
    // 挂上时是「当前这块」（带 id + 焦点标记）。
    expect(block.id).toBe('dpp-tool-block');

    removeToolBlock(block);

    expect(block.isConnected).toBe(false);
    // ⚠️ **脱连的块必须同时摘掉 id 与焦点标记** —— `appendToolBlockToMessage`
    // 摘「上一个带 `data-dpp-tool-active` 的块」时用的是 `querySelector`
    //（只看**在文档里**的节点）⇒ 脱连块上残留的 `id="dpp-tool-block"`
    // 会让 `getElementById` 在那之后返回 null（页面上明明有一块，id 却查不到）。
    expect(block.id).toBe('');
    expect(block.hasAttribute('data-dpp-tool-active')).toBe(false);
  });
});

describe('tool block styles', () => {
  it('injects once and stays idempotent', () => {
    injectToolBlockStyles(deps());
    const first = document.getElementById(STYLE_ID);
    injectToolBlockStyles(deps());
    expect(document.getElementById(STYLE_ID)).toBe(first);
    expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1);
  });
});