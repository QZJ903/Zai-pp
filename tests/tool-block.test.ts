import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendToolBlockToMessage,
  applyBlockCollapseDefault,
  createToolBlockShell,
  findToolBlock,
  findToolBlockInMessage,
  injectToolBlockStyles,
  retargetToolBlockKey,
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

const STYLE_ID = 'zpp-tool-block-css';

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

/** 块的折叠头（`role="button"` + `aria-expanded` 都挂在它身上）。 */
function headerOf(block: HTMLElement): HTMLElement {
  return block.querySelector<HTMLElement>('.zpp-tool-block-header')!;
}

afterEach(() => {
  document.body.innerHTML = '';
  document.getElementById(STYLE_ID)?.remove();
  vi.restoreAllMocks();
});

describe('tool block shell', () => {
  it('renders the collapsed header with a title slot', () => {
    const block = createToolBlockShell(deps(), { restoreKey: 'r1', collapsed: true });
    expect(block.className).toBe('zpp-tool-block');
    expect(block.getAttribute('data-zpp-tool-key')).toBe('r1');
    expect(block.getAttribute('data-collapsed')).toBe('true');
    expect(block.querySelector('.zpp-tool-block-title')).not.toBeNull();
    expect(block.querySelector('.zpp-tool-block-body')).not.toBeNull();
  });

  it('toggles collapsed state on click', () => {
    const block = createToolBlockShell(deps(), { collapsed: true });
    const header = block.querySelector<HTMLElement>('.zpp-tool-block-header')!;
    header.click();
    expect(block.getAttribute('data-collapsed')).toBe('false');
    header.click();
    expect(block.getAttribute('data-collapsed')).toBe('true');
  });

  it('toggles collapsed state from the keyboard too', () => {
    const block = createToolBlockShell(deps(), { collapsed: true });
    const header = block.querySelector<HTMLElement>('.zpp-tool-block-header')!;
    // ⚠️ 上游只挂 click —— 键盘用户打不开。这条守的是「我们补上了键盘通路」。
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(block.getAttribute('data-collapsed')).toBe('false');
    header.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(block.getAttribute('data-collapsed')).toBe('true');
  });

  /**
   * ⚠️⚠️ 折叠头是 `role="button"` —— 只翻 `data-collapsed` 时屏幕阅读器读到的是
   * 一个**没有状态**的按钮。三档写入点（建块初值 / 用户开合 / 按默认态重算）
   * 必须都同步 `aria-expanded`，漏任何一处都只表现为「状态停在上一次的值」。
   */
  it('mirrors the collapsed state onto the header aria-expanded', () => {
    const collapsedBlock = createToolBlockShell(deps(), { collapsed: true });
    expect(headerOf(collapsedBlock).getAttribute('aria-expanded')).toBe('false');

    const expandedBlock = createToolBlockShell(deps(), { collapsed: false });
    expect(headerOf(expandedBlock).getAttribute('aria-expanded')).toBe('true');

    // 用户亲手开合
    headerOf(collapsedBlock).click();
    expect(collapsedBlock.getAttribute('data-collapsed')).toBe('false');
    expect(headerOf(collapsedBlock).getAttribute('aria-expanded')).toBe('true');
    headerOf(collapsedBlock).click();
    expect(headerOf(collapsedBlock).getAttribute('aria-expanded')).toBe('false');

    // 按默认态重算（`applyBlockCollapseDefault` 那条写入点）
    applyBlockCollapseDefault(expandedBlock, true);
    expect(expandedBlock.getAttribute('data-collapsed')).toBe('true');
    expect(headerOf(expandedBlock).getAttribute('aria-expanded')).toBe('false');
    applyBlockCollapseDefault(expandedBlock, false);
    expect(headerOf(expandedBlock).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('tool block content', () => {
  it('draws one row per execution and sets the title count', () => {
    const block = createToolBlockShell(deps());
    updateToolBlockContent(block, [execution(), execution({ name: 'web_search' })], deps(), (n) => `${n} tools`);

    expect(block.querySelector('.zpp-tool-block-title')?.textContent).toBe('2 tools');
    const names = [...block.querySelectorAll('.zpp-tool-block-item-name')].map((el) => el.textContent);
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
    expect(block.querySelector('.zpp-tool-block-item-status')?.className)
      .toContain('error');
  });

  it('redraws instead of appending when called twice', () => {
    const block = createToolBlockShell(deps());
    updateToolBlockContent(block, [execution()], deps(), () => 't');
    updateToolBlockContent(block, [execution({ name: 'web_search' })], deps(), () => 't');
    const names = [...block.querySelectorAll('.zpp-tool-block-item-name')].map((el) => el.textContent);
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
    expect(block.querySelector('.zpp-tool-block-item-detail')?.textContent).toBe('CARD');
  });

  it('falls back to plain text when the renderer declines', () => {
    const block = createToolBlockShell(deps());
    updateToolBlockContent(
      block,
      [execution({ result: { ok: true, summary: 'done', detail: 'RAW' } as ToolCardResult })],
      deps({ renderDetail: () => false }),
      () => 't',
    );
    expect(block.querySelector('.zpp-tool-block-item-detail')?.textContent).toBe('RAW');
  });

  it('omits the detail element when there is no detail text', () => {
    const block = createToolBlockShell(deps());
    updateToolBlockContent(block, [execution()], deps(), () => 't');
    expect(block.querySelector('.zpp-tool-block-item-detail')).toBeNull();
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
    expect(block.querySelector('.zpp-tool-block-item-summary')?.textContent)
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
    return block.querySelectorAll<HTMLElement>('.zpp-tool-block-item-toggle')[index];
  }

  function detailOf(block: HTMLElement, index = 0): HTMLElement | null {
    return block.querySelectorAll<HTMLElement>('.zpp-tool-block-item-detail')[index] ?? null;
  }

  it('starts collapsed and expands on click', () => {
    const block = render();
    const toggle = toggleOf(block);
    // ⚠️ **纯文本详情默认收起**（上游 `createAgentToolRow`：`aria-expanded="false"` + `hidden`）——
    // 长正文（第三方 MCP 返回的正文可达数千字符）会把后面的工具行冲散。
    // ⚠️ 可操作的卡片详情是另一档（默认展开），见下面那组用例。
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

  /**
   * ⚠️⚠️ **同页多块是设计内形态**（历史消息各一块 + 当前这块），而行下标在每块里
   * 都从 0 重来 ⇒ 用下标当 id 会让第二块的 `-detail-0` 撞第一块，
   * `aria-controls` 按 id 解析时命中文档里**第一个**匹配元素。
   * 判据是 HTML 的 id 唯一性 —— 与「看起来对不对」无关。
   */
  it('gives every row detail a document-unique id', () => {
    // ⚠️ **必须挂进 document** —— `getElementById` 只在文档树里查，脱连的块一律查不到。
    const first = render();
    const second = render();
    document.body.append(first, second);

    const ids = [...document.querySelectorAll('.zpp-tool-block-item-detail')]
      .map((el) => el.id)
      .filter(Boolean);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);

    // `aria-controls` 必须指向**自己这块**的那个详情，不是别人的。
    for (const block of [first, second]) {
      const toggle = toggleOf(block);
      const controlled = toggle.getAttribute('aria-controls');
      expect(controlled).toBeTruthy();
      expect(document.getElementById(controlled!)).toBe(detailOf(block));
    }
  });

  it('does not draw a chevron or a toggle for rows without detail', () => {
    const block = render([execution()]);
    // ⚠️ 没有详情的行挂开关 = 一个点了没反应的死控件。
    expect(block.querySelector('.zpp-tool-block-item-chevron')).toBeNull();
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
    expect(block.querySelector('.zpp-tool-block-item-chevron')).toBeNull();
    expect(block.querySelector('.zpp-tool-block-item-detail')).toBeNull();
  });
});

describe('tool block row-level collapse: card details start expanded', () => {
  const withDetail = (name = 'skill_draft_create') => execution({
    callId: `xml:${name}`,
    name,
    result: { ok: true, summary: 'done', detail: 'RAW DETAIL' } as ToolCardResult,
  });

  /** 带结构化输出的结果（真实渲染器认的就是 `output.kind`）。 */
  const withCardOutput = (name = 'skill_draft_create') => execution({
    callId: `xml:${name}`,
    name,
    result: {
      ok: true,
      summary: 'done',
      detail: 'RAW DETAIL',
      output: { kind: 'skill_draft' },
    } as ToolCardResult,
  });

  /**
   * 详情渲染成卡片的依赖 —— **只认结构化结果**（`output.kind` 存在），
   * 与生产里 `renderDetail` → `renderToolResultWithRegistry` 的判据同形。
   */
  function cardDeps(): ToolBlockDependencies {
    return deps({
      renderDetail: (target, result) => {
        if (!result.output || typeof result.output !== 'object') return false;
        target.textContent = 'CARD';
        return true;
      },
    });
  }

  function render(executions: ToolExecutionRecord[], useDeps = cardDeps()): HTMLElement {
    const block = createToolBlockShell(useDeps);
    updateToolBlockContent(block, executions, useDeps, () => 't');
    return block;
  }

  function toggleOf(block: HTMLElement, index = 0): HTMLElement {
    return block.querySelectorAll<HTMLElement>('.zpp-tool-block-item-toggle')[index];
  }

  function detailOf(block: HTMLElement, index = 0): HTMLElement | null {
    return block.querySelectorAll<HTMLElement>('.zpp-tool-block-item-detail')[index] ?? null;
  }

  it('starts expanded when the detail is an actionable card', () => {
    const block = render([withCardOutput()]);
    // ⚠️ 卡片是整轮里唯一要用户动手的地方（「保存 Skill」「导入记忆」），
    // 藏在折叠里等于没交付。
    expect(toggleOf(block).getAttribute('aria-expanded')).toBe('true');
    expect(detailOf(block)?.hidden).toBe(false);
  });

  it('keeps text details collapsed in the same block', () => {
    // 同一块里混排：卡片行展开、纯文本行收起 —— 判据是**每一行各自的详情形态**，
    // 不是「这一块里有卡片就全展开」。
    const block = render([
      withDetail('shell_exec'),
      withCardOutput('skill_draft_create'),
    ]);
    expect(toggleOf(block, 0).getAttribute('aria-expanded')).toBe('false');
    expect(toggleOf(block, 1).getAttribute('aria-expanded')).toBe('true');
    expect(detailOf(block, 0)?.hidden).toBe(true);
    expect(detailOf(block, 1)?.hidden).toBe(false);
  });

  it('keeps a card row collapsed once the user collapses it', () => {
    const block = render([withCardOutput()]);
    toggleOf(block).click();
    expect(toggleOf(block).getAttribute('aria-expanded')).toBe('false');

    // ⚠️⚠️ **重画时用户的意愿优先于默认值** —— 实时链路上每执行一步就整块重画一次，
    // 只记「已展开的集合」的话，收起来这个动作会丢、卡片行被重新展开。
    updateToolBlockContent(block, [withCardOutput()], cardDeps(), () => 't');
    expect(toggleOf(block).getAttribute('aria-expanded')).toBe('false');
    expect(detailOf(block)?.hidden).toBe(true);
  });

  it('still expands a text row when the user opens it', () => {
    const block = render([withDetail('shell_exec')], deps());
    toggleOf(block).click();
    expect(toggleOf(block).getAttribute('aria-expanded')).toBe('true');

    updateToolBlockContent(block, [withDetail('shell_exec')], deps(), () => 't');
    expect(toggleOf(block).getAttribute('aria-expanded')).toBe('true');
  });

  it('re-expands a row that becomes a card after being default-collapsed', () => {
    // ⚠️⚠️ **这一格是「拿上次有效态当用户意愿」的漏洞**：某行首次渲染时渲染器没认出来
    // （`rendered === false`）⇒ 默认收起；之后它变成卡片行时，用户从没点过它，
    // 就应该按**新的默认态**展开 —— 否则「保存 Skill」永远藏在收起的行里。
    let recognize = false;
    const deps2 = () => deps({
      renderDetail: (target, result) => {
        if (!recognize || !result.output || typeof result.output !== 'object') return false;
        target.textContent = 'CARD';
        return true;
      },
    });

    const block = createToolBlockShell(deps2());
    updateToolBlockContent(block, [withCardOutput()], deps2(), () => 't');
    expect(toggleOf(block).getAttribute('aria-expanded'), '首次没认出来 ⇒ 收起').toBe('false');

    recognize = true;
    updateToolBlockContent(block, [withCardOutput()], deps2(), () => 't');
    // 用户没点过 ⇒ 按新的默认态（卡片 ⇒ 展开）。
    expect(toggleOf(block).getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the user choice even when the row stops being a card', () => {
    // 反过来：用户亲手展开过一行，之后那一行退化成纯文本，也不该被强行收起。
    let recognize = true;
    const deps2 = () => deps({
      renderDetail: (target, result) => {
        if (!recognize || !result.output || typeof result.output !== 'object') return false;
        target.textContent = 'CARD';
        return true;
      },
    });

    const block = createToolBlockShell(deps2());
    updateToolBlockContent(block, [withCardOutput()], deps2(), () => 't');
    // 用户亲手收起（默认是展开的）。
    toggleOf(block).click();
    expect(toggleOf(block).getAttribute('aria-expanded')).toBe('false');

    recognize = false;
    updateToolBlockContent(block, [withCardOutput()], deps2(), () => 't');
    expect(toggleOf(block).getAttribute('aria-expanded'), '用户收起的意愿要保住').toBe('false');
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
    expect(blockB.id).toBe('zpp-tool-block');
    expect(document.getElementById('zpp-tool-block')).toBe(blockB);
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
    expect(block.id).toBe('zpp-tool-block');

    removeToolBlock(block);

    expect(block.isConnected).toBe(false);
    // ⚠️ **脱连的块必须同时摘掉 id 与焦点标记** —— `appendToolBlockToMessage`
    // 摘「上一个带 `data-zpp-tool-active` 的块」时用的是 `querySelector`
    //（只看**在文档里**的节点）⇒ 脱连块上残留的 `id="zpp-tool-block"`
    // 会让 `getElementById` 在那之后返回 null（页面上明明有一块，id 却查不到）。
    expect(block.id).toBe('');
    expect(block.hasAttribute('data-zpp-tool-active')).toBe(false);
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
/**
 * **同一条消息里只许有一块面板**。
 *
 * ⚠️⚠️ 真机症状：刷新后同一条回答上下叠两个「已调用工具（N 次）」，上面那个点不开详情
 * —— 那是两条腿（历史 / 存储）没合流时各画一块。块键是记录 id、两腿天生不同
 * （`history:<uuid>` / `storage:<hash>`）⇒ 按 id 找永远找不到对方。
 * `findToolBlockInMessage` 按**宿主**找，是这条不变式的唯一入口。
 */
describe('tool block: one block per message', () => {
  it('finds an existing block by host even when the restore key differs', () => {
    const message = buildMessage('anchor-1');
    const block = createToolBlockShell(deps(), { restoreKey: 'storage:abc' });
    expect(appendToolBlockToMessage(message, block, deps())).toBe(true);

    // 按块键找不到（键不同）。
    expect(findToolBlock('history:anchor-1', deps())).toBeNull();
    // 但按宿主能找到 —— 这正是「不许叠第二块」的判据。
    expect(findToolBlockInMessage(message, deps())).toBe(block);
  });

  it('returns null for a message that has no block yet', () => {
    const message = buildMessage('anchor-2');
    expect(findToolBlockInMessage(message, deps())).toBeNull();
  });

  it('does not see blocks living in another message', () => {
    const first = buildMessage('anchor-3');
    const second = buildMessage('anchor-4');
    const block = createToolBlockShell(deps(), { restoreKey: 'storage:xyz' });
    appendToolBlockToMessage(first, block, deps());

    expect(findToolBlockInMessage(second, deps())).toBeNull();
    expect(findToolBlockInMessage(first, deps())).toBe(block);
  });

  it('rewrites the restore key when a block is adopted by another record', () => {
    const message = buildMessage('anchor-5');
    const block = createToolBlockShell(deps(), { restoreKey: 'storage:old' });
    appendToolBlockToMessage(message, block, deps());

    retargetToolBlockKey(block, 'history:anchor-5');

    // 键归一之后，按新键也能找到它 —— 下一次投递就不用再走兜底。
    expect(findToolBlock('history:anchor-5', deps())).toBe(block);
    expect(findToolBlock('storage:old', deps())).toBeNull();
  });
});
