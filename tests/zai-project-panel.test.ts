import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startProjectPanel,
  type ProjectPanelController,
  type ProjectPanelDependencies,
  type ProjectPanelLabels,
} from '../core/zai/project-panel';
import type { ProjectContextState } from '../core/types';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';

const PANEL_ID = 'dpp-project-panel';
/** 补名延时那次的时长（`BACKFILL_RETRY_DELAYS_MS` 的第二档）。 */
const BACKFILL_ADVANCE_MS = 2_500;
const MENU_ID = 'dpp-project-panel-menu';

const LABELS: ProjectPanelLabels = {
  title: 'Projects',
  empty: 'No projects yet',
  conversationCount: (count) => `${count} chats`,
  expandProject: (name) => `Expand ${name}`,
  collapseProject: (name) => `Collapse ${name}`,
  showMore: 'Show more',
  showLess: 'Show less',
  moveCurrentToProject: (name) => `Move current into ${name}`,
  removeCurrentFromProject: (name) => `Remove current from ${name}`,
  newConversationInProject: (name) => `New chat in ${name}`,
  useNextConversation: (name) => `Use ${name} next`,
  cancelNextConversation: (name) => `Stop using ${name} next`,
  pendingBadge: 'Next chat uses this project',
  conversationActions: 'Chat actions',
  removeFromProjectNamed: (name) => `Remove from ${name}`,
  renameConversation: 'Rename',
  operationFailed: (message) => `Failed: ${message}`,
  age: () => 'just now',
};

/** z.ai 侧边栏的最小骨架：容器 > [账号行]。面板要插在账号行之前。 */
function mountSidebar(): { container: HTMLElement; accountRow: HTMLElement } {
  document.body.innerHTML = `
    <div id="sidebar" data-collapsed="false">
      <div class="flex flex-col h-full">
        <div class="my-auto flex flex-col">
          <div class="relative flex flex-col">
            <div class="mt-auto border-t border-black/15">
              <div class="flex items-center gap-1">
                <button id="nux-user-menu-btn">account</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  const sidebar = document.getElementById('sidebar')!;
  const accountRow = sidebar.querySelector<HTMLElement>('.mt-auto')!;
  return { container: accountRow.parentElement!, accountRow };
}

function createState(overrides: Partial<ProjectContextState> = {}): ProjectContextState {
  return {
    schemaVersion: 2,
    projects: [],
    conversations: [],
    pendingProjectId: null,
    ...overrides,
  };
}

function createDependencies(
  state: ProjectContextState,
  overrides: Partial<ProjectPanelDependencies> = {},
): ProjectPanelDependencies & { refreshCalls: number } {
  const deps: ProjectPanelDependencies & { refreshCalls: number } = {
    refreshCalls: 0,
    async loadState() {
      deps.refreshCalls += 1;
      return state;
    },
    addConversation: vi.fn(async () => {}),
    removeConversation: vi.fn(async () => {}),
    renameConversation: vi.fn(async () => {}),
    resolveConversationTitle: vi.fn(async () => null),
    backfillConversationTitle: vi.fn(async () => {}),
    setPending: vi.fn(async () => {}),
    getCurrentConversation: () => null,
    openConversation: vi.fn(),
    startNewConversation: vi.fn(),
    getLabels: () => LABELS,
    ...overrides,
  };
  return deps;
}

/**
 * 推过补名延时那次（`BACKFILL_RETRY_DELAYS_MS` 的 2500ms）而不真等。
 *
 * ⚠️ **必须在 `backfillNow()` 之前**换成假计时器 —— 已经用真实 `setTimeout`
 * 注册过的定时器不会被 `useFakeTimers()` 接管，那时再推时间也不会触发。
 * 推完立刻换回真实计时器：`flush()` 依赖真实 `setTimeout(…, 0)`。
 */
async function withBackfillTimerAdvance<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const result = await run();
    await vi.advanceTimersByTimeAsync(BACKFILL_ADVANCE_MS);
    return result;
  } finally {
    vi.useRealTimers();
  }
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 项目行右侧的三个图标按钮：归属 / 新会话 / 待绑。 */
function projectIconButtons(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(`#${PANEL_ID} .dpp-project-panel__icon-button`),
  );
}

function iconButtonByLabel(label: string): HTMLButtonElement | undefined {
  return projectIconButtons().find((button) => button.getAttribute('aria-label') === label);
}

let controller: ProjectPanelController | null = null;

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  controller = null;
});

afterEach(() => {
  controller?.stop();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('zai project panel', () => {
  it('mounts directly above the account row and never inside the history list', async () => {
    const { container, accountRow } = mountSidebar();
    controller = startProjectPanel(createDependencies(createState()));
    await flush();

    const panel = document.getElementById(PANEL_ID);
    expect(panel).not.toBeNull();
    expect(panel!.parentElement).toBe(container);
    expect(panel!.nextElementSibling).toBe(accountRow);
  });

  it('renders projects with their conversations sorted by most recently opened', async () => {
    mountSidebar();
    const state = createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        { conversationId: 'c-old', projectId: 'p1', title: 'Older', url: '', addedAt: 1, lastSeenAt: 100 },
        { conversationId: 'c-new', projectId: 'p1', title: 'Newer', url: '', addedAt: 2, lastSeenAt: 900 },
      ],
    });
    controller = startProjectPanel(createDependencies(state));
    await flush();

    const titles = Array.from(
      document.querySelectorAll(`#${PANEL_ID} .dpp-project-panel__conversation-title`),
    ).map((node) => node.textContent);
    // lastSeenAt 倒序：最近打开的在前，不是 addedAt。
    expect(titles).toEqual(['Newer', 'Older']);
  });

  it('caps each project at five conversations until the user asks for more', async () => {
    mountSidebar();
    const conversations = Array.from({ length: 7 }, (_, index) => ({
      conversationId: `c-${index}`,
      projectId: 'p1',
      title: `Chat ${index}`,
      url: '',
      addedAt: 1,
      lastSeenAt: 100 + index,
    }));
    const state = createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations,
    });
    controller = startProjectPanel(createDependencies(state));
    await flush();

    const visible = () => document.querySelectorAll(`#${PANEL_ID} .dpp-project-panel__conversation`);
    expect(visible()).toHaveLength(5);

    const more = document.querySelector<HTMLButtonElement>(`#${PANEL_ID} .dpp-project-panel__more`);
    expect(more?.textContent).toBe(LABELS.showMore);
    more!.click();
    await flush();
    expect(visible()).toHaveLength(7);
  });

  it('collapses a project when its header is clicked', async () => {
    mountSidebar();
    const state = createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        { conversationId: 'c1', projectId: 'p1', title: 'Chat', url: '', addedAt: 1, lastSeenAt: 5 },
      ],
    });
    controller = startProjectPanel(createDependencies(state));
    await flush();
    expect(document.querySelectorAll(`#${PANEL_ID} .dpp-project-panel__conversation`)).toHaveLength(1);

    document.querySelector<HTMLButtonElement>(`#${PANEL_ID} .dpp-project-panel__project-toggle`)!.click();
    await flush();
    expect(document.querySelectorAll(`#${PANEL_ID} .dpp-project-panel__conversation`)).toHaveLength(0);
  });

  it('exposes the upstream icon actions: move-current, new chat, pending toggle', async () => {
    mountSidebar();
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
    }), {
      getCurrentConversation: () => ({ conversationId: 'c1', title: 'Current', url: '' }),
    }));
    await flush();

    const labels = projectIconButtons().map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual([
      LABELS.moveCurrentToProject('Work'),
      LABELS.newConversationInProject('Work'),
      LABELS.useNextConversation('Work'),
    ]);
  });

  it('hides the move-current button entirely when no chat is open', async () => {
    mountSidebar();
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
    })));
    await flush();

    // 上游只在有当前会话时才渲染这个按钮。
    expect(projectIconButtons()).toHaveLength(2);
    expect(iconButtonByLabel(LABELS.useNextConversation('Work'))).toBeDefined();
  });

  it('switches the move-current button to removal when the chat is already in the project', async () => {
    mountSidebar();
    const removeConversation = vi.fn(async () => {});
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        { conversationId: 'c1', projectId: 'p1', title: 'Current', url: '', addedAt: 1, lastSeenAt: 5 },
      ],
    }), {
      removeConversation,
      getCurrentConversation: () => ({ conversationId: 'c1', title: 'Current', url: '' }),
    }));
    await flush();

    const button = iconButtonByLabel(LABELS.removeCurrentFromProject('Work'));
    expect(button).toBeDefined();
    expect(button!.dataset.active).toBe('true');

    button!.click();
    await flush(4);
    expect(removeConversation).toHaveBeenCalledWith('c1');
  });

  it('moves the current chat into the project when it belongs elsewhere', async () => {
    mountSidebar();
    const addConversation = vi.fn(async () => {});
    const deps = createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        { conversationId: 'c1', projectId: 'other', title: 'Current', url: '', addedAt: 1, lastSeenAt: 5 },
      ],
    }), {
      addConversation,
      getCurrentConversation: () => ({ conversationId: 'c1', title: 'Current', url: '' }),
    });
    controller = startProjectPanel(deps);
    await flush();

    const before = deps.refreshCalls;
    iconButtonByLabel(LABELS.moveCurrentToProject('Work'))!.click();
    await flush(4);

    // 上游语义：不在本项目里就「移入」，由后台按会话 id upsert 覆盖旧归属。
    expect(addConversation).toHaveBeenCalledWith({
      projectId: 'p1',
      conversation: { conversationId: 'c1', title: 'Current', url: '' },
    });
    expect(deps.refreshCalls).toBeGreaterThan(before);
  });

  it('toggles the pending binding and marks the button active', async () => {
    mountSidebar();
    const setPending = vi.fn(async () => {});
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      pendingProjectId: 'p1',
    }), { setPending }));
    await flush();

    const button = iconButtonByLabel(LABELS.cancelNextConversation('Work'));
    expect(button).toBeDefined();
    expect(button!.dataset.active).toBe('true');
    expect(document.querySelector(`#${PANEL_ID} .dpp-project-panel__pending`)?.textContent)
      .toBe(LABELS.pendingBadge);

    button!.click();
    await flush(4);
    expect(setPending).toHaveBeenCalledWith(null);
  });

  it('starts a new chat by binding pending first, then leaving the conversation', async () => {
    mountSidebar();
    const setPending = vi.fn(async () => {});
    const startNewConversation = vi.fn();
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
    }), { setPending, startNewConversation }));
    await flush();

    iconButtonByLabel(LABELS.newConversationInProject('Work'))!.click();
    await flush(4);

    expect(setPending).toHaveBeenCalledWith('p1');
    // 顺序要紧：必须等待绑落库之后再跳，否则首条消息绑不上。
    expect(setPending.mock.invocationCallOrder[0]!)
      .toBeLessThan(startNewConversation.mock.invocationCallOrder[0]!);
  });

  it('opens a conversation through the injected port', async () => {
    mountSidebar();
    const openConversation = vi.fn();
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        {
          conversationId: 'c1',
          projectId: 'p1',
          title: 'Chat',
          url: 'https://chat.z.ai/c/c1',
          addedAt: 1,
          lastSeenAt: 5,
        },
      ],
    }), { openConversation }));
    await flush();

    document.querySelector<HTMLButtonElement>(`#${PANEL_ID} .dpp-project-panel__conversation-title`)!
      .click();
    await flush();

    expect(openConversation).toHaveBeenCalledWith({
      conversationId: 'c1',
      title: 'Chat',
      url: 'https://chat.z.ai/c/c1',
    });
  });

  it('opens a conversation menu anchored to its own button and removes on select', async () => {
    mountSidebar();
    const removeConversation = vi.fn(async () => {});
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        { conversationId: 'c1', projectId: 'p1', title: 'Chat', url: '', addedAt: 1, lastSeenAt: 5 },
      ],
    }), { removeConversation }));
    await flush();

    const anchor = document.querySelector<HTMLButtonElement>(
      `#${PANEL_ID} .dpp-project-panel__conversation-menu-button`,
    )!;
    // 给锚点一个真实矩形，positionMenu 才有东西可算。
    anchor.getBoundingClientRect = () => ({
      top: 700, bottom: 722, left: 200, right: 222, width: 22, height: 22,
      x: 200, y: 700, toJSON: () => ({}),
    } as DOMRect);
    anchor.click();
    await flush();

    const menu = document.getElementById(MENU_ID);
    expect(menu).not.toBeNull();
    const items = Array.from(
      menu!.querySelectorAll<HTMLButtonElement>('.dpp-project-panel__menu-item'),
    );
    // 重命名 + 从项目移除（顺序固定）。
    expect(items.map((item) => item.textContent)).toEqual([
      LABELS.renameConversation,
      LABELS.removeFromProjectNamed('Work'),
    ]);

    items[1]!.click();
    await flush(4);
    expect(removeConversation).toHaveBeenCalledWith('c1');
    expect(document.getElementById(MENU_ID)).toBeNull();
  });

  it('closes the menu when its own button is pressed again', async () => {
    mountSidebar();
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        { conversationId: 'c1', projectId: 'p1', title: 'Chat', url: '', addedAt: 1, lastSeenAt: 5 },
      ],
    })));
    await flush();

    const anchor = document.querySelector<HTMLButtonElement>(
      `#${PANEL_ID} .dpp-project-panel__conversation-menu-button`,
    )!;
    anchor.getBoundingClientRect = () => ({
      top: 700, bottom: 722, left: 200, right: 222, width: 22, height: 22,
      x: 200, y: 700, toJSON: () => ({}),
    } as DOMRect);

    anchor.click();
    await flush();
    expect(document.getElementById(MENU_ID)).not.toBeNull();

    // 再点一次同一个按钮 → 必须关掉，而不是「先关后开」看起来毫无反应。
    anchor.click();
    await flush();
    expect(document.getElementById(MENU_ID)).toBeNull();
  });

  it('renames a conversation inline on Enter and ignores Escape', async () => {
    mountSidebar();
    const renameConversation = vi.fn(async () => {});
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        { conversationId: 'c1', projectId: 'p1', title: 'Old name', url: '', addedAt: 1, lastSeenAt: 5 },
      ],
    }), { renameConversation }));
    await flush();

    const openMenu = () => {
      const anchor = document.querySelector<HTMLButtonElement>(
        `#${PANEL_ID} .dpp-project-panel__conversation-menu-button`,
      )!;
      anchor.getBoundingClientRect = () => ({
        top: 700, bottom: 722, left: 200, right: 222, width: 22, height: 22,
        x: 200, y: 700, toJSON: () => ({}),
      } as DOMRect);
      anchor.click();
    };

    // Esc 取消：不发请求，标题按钮还原。
    openMenu();
    await flush();
    document.querySelector<HTMLButtonElement>(`#${MENU_ID} .dpp-project-panel__menu-item`)!.click();
    await flush();
    const escapeInput = document.querySelector<HTMLInputElement>(
      `#${PANEL_ID} .dpp-project-panel__rename-input`,
    )!;
    expect(escapeInput.value).toBe('Old name');
    escapeInput.value = 'Discarded';
    escapeInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush(4);
    expect(renameConversation).not.toHaveBeenCalled();
    expect(document.querySelector(`#${PANEL_ID} .dpp-project-panel__rename-input`)).toBeNull();

    // 回车确认：把项目 id 与会话 id 一起发过去。
    openMenu();
    await flush();
    document.querySelector<HTMLButtonElement>(`#${MENU_ID} .dpp-project-panel__menu-item`)!.click();
    await flush();
    const input = document.querySelector<HTMLInputElement>(
      `#${PANEL_ID} .dpp-project-panel__rename-input`,
    )!;
    input.value = '  New name  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush(4);

    expect(renameConversation).toHaveBeenCalledWith({
      projectId: 'p1',
      conversationId: 'c1',
      title: 'New name',
    });
  });

  it('flips the menu above the anchor when it would overflow the viewport bottom', async () => {
    mountSidebar();
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        { conversationId: 'c1', projectId: 'p1', title: 'Chat', url: '', addedAt: 1, lastSeenAt: 5 },
      ],
    })));
    await flush();

    const anchor = document.querySelector<HTMLButtonElement>(
      `#${PANEL_ID} .dpp-project-panel__conversation-menu-button`,
    )!;
    // 锚点贴着视口底部：下方放不下，浮层必须翻到上方而不是被截掉。
    anchor.getBoundingClientRect = () => ({
      top: window.innerHeight - 30, bottom: window.innerHeight - 8,
      left: 200, right: 222, width: 22, height: 22,
      x: 200, y: window.innerHeight - 30, toJSON: () => ({}),
    } as DOMRect);

    // jsdom 不做布局，浮层尺寸恒为 0 —— 在原型上模拟一个真实高度。
    // ⚠️ 必须在打开之前装好：`positionMenu` 是同步跑的。
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function patched(this: Element) {
      if (this instanceof HTMLElement && this.classList.contains('dpp-project-panel__menu')) {
        return {
          top: 0, bottom: 40, left: 0, right: 178, width: 178, height: 40,
          x: 0, y: 0, toJSON: () => ({}),
        } as DOMRect;
      }
      return original.call(this);
    };

    try {
      anchor.click();
      await flush();

      const top = Number.parseFloat(document.getElementById(MENU_ID)!.style.top);
      // 翻到锚点上方，且不越出视口。
      expect(top).toBeLessThan(window.innerHeight - 30);
      expect(top).toBeGreaterThanOrEqual(0);
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it('surfaces a mutation failure without losing the last rendered state', async () => {
    mountSidebar();
    const onError = vi.fn();
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        { conversationId: 'c1', projectId: 'p1', title: 'Kept', url: '', addedAt: 1, lastSeenAt: 5 },
      ],
    }), {
      removeConversation: async () => { throw new Error('backend down'); },
      getCurrentConversation: () => ({ conversationId: 'c1', title: 'Kept', url: '' }),
      onError,
    }));
    await flush();

    iconButtonByLabel(LABELS.removeCurrentFromProject('Work'))!.click();
    await flush(4);

    expect(onError).toHaveBeenCalled();
    const status = document.querySelector(`#${PANEL_ID} .dpp-project-panel__status`);
    expect(status?.textContent).toContain('backend down');
    // 失败不能把已渲染的列表清空。
    expect(document.querySelectorAll(`#${PANEL_ID} .dpp-project-panel__conversation`)).toHaveLength(1);
  });

  it('keeps the last rendered state when a reload fails to decode', async () => {
    mountSidebar();
    let payload: ProjectContextState | null = createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
    });
    controller = startProjectPanel(createDependencies(createState(), {
      loadState: async () => payload,
    }));
    await flush();
    expect(document.querySelectorAll(`#${PANEL_ID} .dpp-project-panel__project`)).toHaveLength(1);

    payload = null;
    controller.refresh();
    await flush();
    // null 表示「读不到」，保留上一次的展示而不是清空。
    expect(document.querySelectorAll(`#${PANEL_ID} .dpp-project-panel__project`)).toHaveLength(1);
  });

  it('re-mounts the panel when the page re-renders the sidebar around it', async () => {
    mountSidebar();
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
    })));
    await flush();
    expect(document.getElementById(PANEL_ID)).not.toBeNull();

    // 模拟 Svelte 重渲染：把账号行连同我们插的节点一起换掉。
    const accountRow = document.querySelector<HTMLElement>('#sidebar .mt-auto')!;
    const container = accountRow.parentElement!;
    container.innerHTML = '<div class="mt-auto border-t"><button id="nux-user-menu-btn">account</button></div>';

    await new Promise((resolve) => setTimeout(resolve, 260));

    const remounted = document.getElementById(PANEL_ID);
    expect(remounted).not.toBeNull();
    expect(remounted!.nextElementSibling?.classList.contains('mt-auto')).toBe(true);
  });

  it('removes the panel, its menu and its styles on stop', async () => {
    mountSidebar();
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        { conversationId: 'c1', projectId: 'p1', title: 'Chat', url: '', addedAt: 1, lastSeenAt: 5 },
      ],
    })));
    await flush();
    document.querySelector<HTMLButtonElement>(
      `#${PANEL_ID} .dpp-project-panel__conversation-menu-button`,
    )!.click();
    await flush();
    expect(document.getElementById(MENU_ID)).not.toBeNull();

    controller.stop();
    controller = null;

    expect(document.getElementById(PANEL_ID)).toBeNull();
    expect(document.getElementById(MENU_ID)).toBeNull();
    expect(document.getElementById(`${PANEL_ID}-css`)).toBeNull();
  });

  it('does not rebuild the panel when unrelated page DOM churns around it', async () => {
    mountSidebar();
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        { conversationId: 'c1', projectId: 'p1', title: 'Chat', url: '', addedAt: 1, lastSeenAt: 5 },
      ],
    })));
    await flush();

    const bodyBefore = document.querySelector(`#${PANEL_ID} .dpp-project-panel__body`);
    expect(bodyBefore).not.toBeNull();

    // 模拟消息流式输出：页面 DOM 每秒变动几十次。这些变动**不能**触发重绘 ——
    // 重绘会换掉 body 节点，而新节点的 scrollTop 恒为 0，表现就是滚动位置被弹回顶部。
    const stream = document.createElement('div');
    document.body.append(stream);
    for (let i = 0; i < 5; i += 1) {
      stream.textContent = `chunk ${i}`;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(document.querySelector(`#${PANEL_ID} .dpp-project-panel__body`)).toBe(bodyBefore);
  });

  it('carries the scroll position over when the content really does change', async () => {
    mountSidebar();
    const state = createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        { conversationId: 'c1', projectId: 'p1', title: 'Chat', url: '', addedAt: 1, lastSeenAt: 5 },
      ],
    });
    controller = startProjectPanel(createDependencies(state));
    await flush();

    const bodyBefore = document.querySelector<HTMLElement>(`#${PANEL_ID} .dpp-project-panel__body`)!;
    // jsdom 不做真实布局，scrollTop 需要手工声明。
    bodyBefore.scrollTop = 80;

    // 内容真变了（多了一个项目）→ 必须重建，但要把滚动位置带过去。
    state.projects.push({
      id: 'p2', name: 'Personal', description: '', instructions: '', createdAt: 2, updatedAt: 2,
    });
    controller.render();
    await flush();

    const bodyAfter = document.querySelector<HTMLElement>(`#${PANEL_ID} .dpp-project-panel__body`)!;
    expect(bodyAfter).not.toBe(bodyBefore);
    expect(bodyAfter.scrollTop).toBe(80);
  });

  it('repaints from scratch after the page swaps the panel node out', async () => {
    mountSidebar();
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
    })));
    await flush();
    expect(document.querySelectorAll(`#${PANEL_ID} .dpp-project-panel__project`)).toHaveLength(1);

    // 把面板整个换掉，模拟 Svelte 重渲染 —— 新节点必须重新填充内容，
    // 不能因为「签名没变」而留空。
    document.getElementById(PANEL_ID)!.remove();
    controller.render();
    await flush();

    expect(document.querySelectorAll(`#${PANEL_ID} .dpp-project-panel__project`)).toHaveLength(1);
  });

  it('hides itself through the sidebar collapsed attribute rather than removing nodes', async () => {
    mountSidebar();
    controller = startProjectPanel(createDependencies(createState()));
    await flush();

    const style = document.getElementById(`${PANEL_ID}-css`)?.textContent ?? '';
    // 收起态靠 CSS 规则隐藏，DOM 保持挂载（展开时无需重挂）。
    expect(style).toContain('#sidebar[data-collapsed="true"] #dpp-project-panel');
  });

  it('keeps the action icons always visible instead of revealing them on hover', async () => {
    mountSidebar();
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        { conversationId: 'c1', projectId: 'p1', title: 'Chat', url: '', addedAt: 1, lastSeenAt: 5 },
      ],
    })));
    await flush();

    const style = document.getElementById(`${PANEL_ID}-css`)?.textContent ?? '';
    // 图标组与会话菜单按钮都不再靠 hover 才显现。
    expect(style).not.toContain('opacity: 0;');
    expect(style).not.toContain('project-row:hover .dpp-project-panel__project-actions');
    expect(style).not.toContain('conversation:hover .dpp-project-panel__conversation-menu-button');
  });

  it('sizes the panel by its content so a short list never scrolls', async () => {
    mountSidebar();
    controller = startProjectPanel(createDependencies(createState()));
    await flush();

    const style = document.getElementById(`${PANEL_ID}-css`)?.textContent ?? '';
    // 面板在 flex 列容器里必须 flex: none —— 默认的 flex-shrink:1 会把它压到
    // 内容高度以下，于是内容只有两行也照样顶出滚动条。
    expect(style).toMatch(/#dpp-project-panel \{[^}]*flex: none;/);
    // 内部滚动只留给真超过上限的情况。
    expect(style).toMatch(/\.dpp-project-panel__body \{[^}]*overflow-y: auto;/);
  });

  it('does nothing when the sidebar is absent', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    controller = startProjectPanel(createDependencies(createState()));
    await flush();
    expect(document.getElementById(PANEL_ID)).toBeNull();
  });

  it('backfills a placeholder title from the sidebar row', async () => {
    mountSidebar();
    const backfillConversationTitle = vi.fn(async () => {});
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        {
          conversationId: 'c1',
          projectId: 'p1',
          title: 'Untitled conversation',
          url: '',
          addedAt: 1,
          lastSeenAt: 5,
        },
      ],
    }), {
      backfillConversationTitle,
      getCurrentConversation: () => ({ conversationId: 'c1', title: '真实会话名', url: '' }),
    }));
    await flush(4);

    expect(backfillConversationTitle).toHaveBeenCalledWith({
      projectId: 'p1',
      conversationId: 'c1',
      title: '真实会话名',
    });
  });

  it('prefers the server-side title over the sidebar row', async () => {
    mountSidebar();
    const backfillConversationTitle = vi.fn(async () => {});
    const resolveConversationTitle = vi.fn(async () => '服务端真名');
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        {
          conversationId: 'c1',
          projectId: 'p1',
          title: 'Untitled conversation',
          url: '',
          addedAt: 1,
          lastSeenAt: 5,
        },
      ],
    }), {
      backfillConversationTitle,
      resolveConversationTitle,
      // 侧边栏那行**还是临时名**（页面没重拉列表）—— 服务端有真名就该用它。
      getCurrentConversation: () => ({ conversationId: 'c1', title: '新聊天', url: '' }),
    }));
    await flush(4);

    expect(resolveConversationTitle).toHaveBeenCalledWith('c1');
    expect(backfillConversationTitle).toHaveBeenCalledWith({
      projectId: 'p1',
      conversationId: 'c1',
      title: '服务端真名',
    });
  });

  it('falls back to the sidebar row when the server has no title yet', async () => {
    mountSidebar();
    const backfillConversationTitle = vi.fn(async () => {});
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        {
          conversationId: 'c1',
          projectId: 'p1',
          title: 'Untitled conversation',
          url: '',
          addedAt: 1,
          lastSeenAt: 5,
        },
      ],
    }), {
      backfillConversationTitle,
      resolveConversationTitle: vi.fn(async () => null),
      getCurrentConversation: () => ({ conversationId: 'c1', title: '侧边栏真名', url: '' }),
    }));
    await flush(4);

    expect(backfillConversationTitle).toHaveBeenCalledWith({
      projectId: 'p1',
      conversationId: 'c1',
      title: '侧边栏真名',
    });
  });

  it('retries the backfill when the server had no title yet, then succeeds', async () => {
    mountSidebar();
    const backfillConversationTitle = vi.fn(async () => {});
    // 第一次解析还没生成好标题 → null；第二次才有。
    const resolveConversationTitle = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('服务端真名');
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        {
          conversationId: 'c1',
          projectId: 'p1',
          title: 'Untitled conversation',
          url: '',
          addedAt: 1,
          lastSeenAt: 5,
        },
      ],
    }), {
      backfillConversationTitle,
      resolveConversationTitle,
      // 侧边栏也还没有真名 —— 这次解析应当**解除登记**，让下次还有机会。
      getCurrentConversation: () => ({ conversationId: 'c1', title: '新聊天', url: '' }),
    }));
    await flush(4);
    expect(backfillConversationTitle).not.toHaveBeenCalled();

    controller.backfillNow();
    await flush(4);

    expect(backfillConversationTitle).toHaveBeenCalledWith({
      projectId: 'p1',
      conversationId: 'c1',
      title: '服务端真名',
    });
  });

  it('leaves a conversation that already has a real title alone', async () => {
    mountSidebar();
    const backfillConversationTitle = vi.fn(async () => {});
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        {
          conversationId: 'c1',
          projectId: 'p1',
          // 用户重命名过的标题 —— 绝不能被会话列表里的名字改回去。
          title: '我改过的名字',
          titleEdited: true,
          url: '',
          addedAt: 1,
          lastSeenAt: 5,
        },
      ],
    }), {
      backfillConversationTitle,
      getCurrentConversation: () => ({ conversationId: 'c1', title: '会话列表里的名字', url: '' }),
    }));
    await flush(4);

    expect(backfillConversationTitle).not.toHaveBeenCalled();
  });

  it('does not backfill when the sidebar row is unavailable or itself a placeholder', async () => {
    mountSidebar();
    const backfillConversationTitle = vi.fn(async () => {});
    const state = createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        {
          conversationId: 'c1',
          projectId: 'p1',
          title: 'Untitled conversation',
          url: '',
          addedAt: 1,
          lastSeenAt: 5,
        },
      ],
    });

    // 侧边栏那行还没渲染出来 → getCurrentConversation 给的是占位串。
    controller = startProjectPanel(createDependencies(state, {
      backfillConversationTitle,
      getCurrentConversation: () => ({
        conversationId: 'c1',
        title: 'Untitled conversation',
        url: '',
      }),
    }));
    await flush(4);
    expect(backfillConversationTitle).not.toHaveBeenCalled();

    // 不在任何会话里 → 同样不发。
    controller.stop();
    controller = startProjectPanel(createDependencies(state, {
      backfillConversationTitle,
      getCurrentConversation: () => null,
    }));
    await flush(4);
    expect(backfillConversationTitle).not.toHaveBeenCalled();
  });

  it('attempts a stuck backfill only once, so a reload cannot loop', async () => {
    mountSidebar();
    // 后台没改动标题（占位串照旧）→ 重拉之后仍是占位，绝不能无限补。
    const deps = createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        {
          conversationId: 'c1',
          projectId: 'p1',
          title: 'Untitled conversation',
          url: '',
          addedAt: 1,
          lastSeenAt: 5,
        },
      ],
    }), {
      getCurrentConversation: () => ({ conversationId: 'c1', title: '真实会话名', url: '' }),
    });
    controller = startProjectPanel(deps);
    await flush(4);
    // 每次 refresh 都会触发一次补名检查，但同一条会话只发一次 IPC。
    controller.refresh();
    await flush(4);
    controller.refresh();
    await flush(4);

    expect(deps.backfillConversationTitle).toHaveBeenCalledTimes(1);
  });

  it('treats every new-conversation temp name as a placeholder, not a real title', async () => {
    // 建会话那一刻页面写进 `chat.title` 的就是这些临时名（页面自己的 i18n 词条），
    // 它们与 `Untitled conversation` 同性质 —— 都要能被真名覆盖掉。
    // ⚠️ 漏一项的后果是静默的：临时名被当真名落库后，闸门会从此拒绝真名。
    const tempNames = ['新聊天', '新任务', '新会话', '新对话', 'New Chat', 'New Task'];

    for (const tempName of tempNames) {
      mountSidebar();
      const backfillConversationTitle = vi.fn(async () => {});
      controller = startProjectPanel(createDependencies(createState({
        projects: [
          { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
        ],
        conversations: [
          {
            conversationId: 'c1',
            projectId: 'p1',
            title: tempName,
            url: '',
            addedAt: 1,
            lastSeenAt: 5,
          },
        ],
      }), {
        backfillConversationTitle,
        getCurrentConversation: () => ({ conversationId: 'c1', title: '真实会话名', url: '' }),
      }));
      await flush(4);

      expect(backfillConversationTitle, tempName).toHaveBeenCalledWith({
        projectId: 'p1',
        conversationId: 'c1',
        title: '真实会话名',
      });
      controller.stop();
      controller = null;
    }

    // 反向：真名不该被当成占位（否则每轮都会被回写一次）。
    mountSidebar();
    const realTitleBackfill = vi.fn(async () => {});
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        {
          conversationId: 'c1',
          projectId: 'p1',
          title: '新聊天天文台', // 只是以「新聊天」开头，不是临时名本身
          url: '',
          addedAt: 1,
          lastSeenAt: 5,
        },
      ],
    }), {
      backfillConversationTitle: realTitleBackfill,
      getCurrentConversation: () => ({ conversationId: 'c1', title: '另一个名字', url: '' }),
    }));
    await flush(4);
    expect(realTitleBackfill).not.toHaveBeenCalled();
  });

  it('retries the backfill when asked again, so the title can arrive after the first answer', async () => {
    mountSidebar();
    const state = createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        {
          conversationId: 'c1',
          projectId: 'p1',
          title: 'Untitled conversation',
          url: '',
          addedAt: 1,
          lastSeenAt: 5,
        },
      ],
    });
    let sidebarTitle = '新会话';
    const backfillConversationTitle = vi.fn(async () => {});
    controller = startProjectPanel(createDependencies(state, {
      backfillConversationTitle,
      getCurrentConversation: () => ({ conversationId: 'c1', title: sidebarTitle, url: '' }),
    }));
    await flush(4);

    // 此刻侧边栏那行还是临时名 → 不发（发了也只是把占位串原样回写）。
    expect(backfillConversationTitle).not.toHaveBeenCalled();

    // 首答完成后真名才出现；内容脚本在这时会调 backfillNow()。
    sidebarTitle = '真实会话名';
    controller.backfillNow();
    await flush(4);

    expect(backfillConversationTitle).toHaveBeenCalledWith({
      projectId: 'p1',
      conversationId: 'c1',
      title: '真实会话名',
    });
  });

  it('fires the deferred retry when the real name shows up right after the trigger', async () => {
    mountSidebar();
    let sidebarTitle = '新会话';
    const backfillConversationTitle = vi.fn(async () => {});
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        {
          conversationId: 'c1',
          projectId: 'p1',
          title: 'Untitled conversation',
          url: '',
          addedAt: 1,
          lastSeenAt: 5,
        },
      ],
    }), {
      backfillConversationTitle,
      getCurrentConversation: () => ({ conversationId: 'c1', title: sidebarTitle, url: '' }),
    }));
    await flush(4);
    expect(backfillConversationTitle).not.toHaveBeenCalled();

    // 触发那一刻侧边栏还是临时名（跳过），但延时那次赶上了真名。
    const panel = controller!;
    await withBackfillTimerAdvance(async () => {
      panel.backfillNow();
      sidebarTitle = '真实会话名';
    });
    await flush(4);

    expect(backfillConversationTitle).toHaveBeenCalledWith({
      projectId: 'p1',
      conversationId: 'c1',
      title: '真实会话名',
    });
  });

  it('cancels the deferred retry on stop so nothing fires after teardown', async () => {
    mountSidebar();
    let sidebarTitle = '新会话';
    const backfillConversationTitle = vi.fn(async () => {});
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        {
          conversationId: 'c1',
          projectId: 'p1',
          title: 'Untitled conversation',
          url: '',
          addedAt: 1,
          lastSeenAt: 5,
        },
      ],
    }), {
      backfillConversationTitle,
      getCurrentConversation: () => ({ conversationId: 'c1', title: sidebarTitle, url: '' }),
    }));
    await flush(4);

    controller.backfillNow();
    sidebarTitle = '真实会话名';
    const panel = controller!;
    await withBackfillTimerAdvance(async () => {
      panel.stop();
      controller = null;
    });
    await flush(4);

    expect(backfillConversationTitle).not.toHaveBeenCalled();
  });

  it('does not start a second resolve while one is still in flight', async () => {
    mountSidebar();
    // 手控的解析：第一次调用挂住不返回，模拟「网络还在飞」。
    // ⚠️ 用对象属性而不是裸变量 —— TS 的控制流分析看不到闭包里的赋值，
    // 会把裸变量收窄成 `null` 并让 `?.()` 报「never 不可调用」。
    const gate: { release: (() => void) | null } = { release: null };
    let calls = 0;
    const resolveConversationTitle = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => { gate.release = resolve; });
      }
      return '服务端真名';
    });
    controller = startProjectPanel(createDependencies(createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        {
          conversationId: 'c1',
          projectId: 'p1',
          title: 'Untitled conversation',
          url: '',
          addedAt: 1,
          lastSeenAt: 5,
        },
      ],
    }), {
      resolveConversationTitle,
      getCurrentConversation: () => ({ conversationId: 'c1', title: '新聊天', url: '' }),
    }));
    await flush(4);
    expect(resolveConversationTitle).toHaveBeenCalledTimes(1);

    // 解析还在飞时又来一次触发（切会话 + 回答结束几乎同时到是常态）——
    // 不能因为「清掉已尝试登记」而再发一个并发解析。
    controller.backfillNow();
    await flush(4);

    expect(resolveConversationTitle).toHaveBeenCalledTimes(1);

    gate.release?.();
    await flush(4);
  });

  it('does not write a title back for a conversation removed while the resolve was in flight', async () => {
    mountSidebar();
    // 解析挂住不返回 —— 模拟「网络还在飞」。
    const gate: { release: (() => void) | null } = { release: null };
    let calls = 0;
    const resolveConversationTitle = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => { gate.release = resolve; });
      }
      return '服务端真名';
    });
    const backfillConversationTitle = vi.fn(async () => {});
    // 用户在这个窗口里把会话移出了项目 → 后续 loadState 不再含该 membership。
    let removed = false;
    const withMembership = createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [
        {
          conversationId: 'c1',
          projectId: 'p1',
          title: 'Untitled conversation',
          url: '',
          addedAt: 1,
          lastSeenAt: 5,
        },
      ],
    });
    const withoutMembership = createState({
      projects: [
        { id: 'p1', name: 'Work', description: '', instructions: '', createdAt: 1, updatedAt: 1 },
      ],
      conversations: [],
    });
    controller = startProjectPanel(createDependencies(withMembership, {
      loadState: async () => (removed ? withoutMembership : withMembership),
      resolveConversationTitle,
      backfillConversationTitle,
      getCurrentConversation: () => ({ conversationId: 'c1', title: '新聊天', url: '' }),
    }));
    await flush(4);
    expect(resolveConversationTitle).toHaveBeenCalledTimes(1);

    // 窗口内移除 + 让面板重拉状态。
    removed = true;
    controller.refresh();
    await flush(4);

    // 放行那次在飞解析 —— 写回走 ADD（按会话 id upsert），发之前必须复检归属。
    gate.release?.();
    await flush(6);

    expect(backfillConversationTitle).not.toHaveBeenCalled();
  });
});

describe('zai project panel theme', () => {
  /**
   * 面板原先写死了浅色值（`#1f1f1f` 文字配 `#ffffff` 底），页面切深色后
   * 对比度掉到 1.10:1 —— 深色底上写深色字，等于看不见。
   * 现在色值一律走 `--dpp-ui-*`，由 `core/ui/injected-theme.ts` 按页面主题切换。
   *
   * ⚠️ 这组断言针对**注入后的样式文本**（不是源码字符串）—— 注释里的示例色值
   * 不该让断言变红，而运行时会真的生效的那些才该。
   */
  it('leaves no hardcoded color in the injected stylesheet', async () => {
    mountSidebar();
    controller = startProjectPanel(createDependencies(createState()));
    await flush();

    const css = document.getElementById(`${PANEL_ID}-css`)?.textContent ?? '';
    expect(css.length).toBeGreaterThan(0);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
    expect(css).not.toMatch(/\bhsla?\(/);
    expect(css).not.toMatch(/\boklch\(/);
  });

  it('routes the surfaces that must follow the page theme through shared variables', async () => {
    mountSidebar();
    controller = startProjectPanel(createDependencies(createState()));
    await flush();

    const css = document.getElementById(`${PANEL_ID}-css`)?.textContent ?? '';
    const panelBlock = blockOf(css, `#${PANEL_ID} {`);
    const menuBlock = blockOf(css, `#${MENU_ID} {`);

    // 正文色、分隔线、hover 叠加层 —— 这四处原先全是写死的。
    expect(panelBlock).toContain('color: var(--dpp-ui-text)');
    expect(panelBlock).toContain('border-top: 1px solid var(--dpp-ui-border)');
    expect(css).toContain('.dpp-project-panel__project-row:hover {\n      background: var(--dpp-ui-overlay-hover)');
    // 浮层（菜单、改名输入框）必须用 raised 面，不能与页面底色同值。
    expect(menuBlock).toContain('background: var(--dpp-ui-surface-raised)');
    expect(renameBlock(css)).toContain('background: var(--dpp-ui-surface-raised)');
    // 状态行与激活态图标是语义色，不是装饰色。
    expect(css).toContain('color: var(--dpp-ui-error)');
    expect(css).toContain('color: var(--dpp-ui-accent-strong)');
  });

  it('references no theme variable that the theme does not define', async () => {
    // ⚠️⚠️ **这条比「有没有裸色值」更要紧** —— 裸色值正则会放过写错的变量名，
    // 而 `var(--dpp-ui-accentt)` 这种拼错**不会报任何错**：声明在 computed-value
    // 阶段失效、颜色静默消失。逐名核对是唯一拦得住它的形态。
    mountSidebar();
    controller = startProjectPanel(createDependencies(createState()));
    await flush();

    const css = document.getElementById(`${PANEL_ID}-css`)?.textContent ?? '';
    const referenced = new Set([...css.matchAll(/var\((--dpp-ui-[a-z-]+)\)/g)].map((m) => m[1]!));
    expect(referenced.size).toBeGreaterThan(0);

    const defined = new Set(
      [...(document.getElementById('dpp-injected-theme-css')?.textContent ?? '')
        .matchAll(/(--dpp-ui-[a-z-]+)\s*:/g)].map((m) => m[1]!),
    );
    expect([...referenced].filter((name) => !defined.has(name))).toEqual([]);
  });

  it('brings the shared theme variables in from injectStyles, not from the caller', async () => {
    mountSidebar();
    controller = startProjectPanel(createDependencies(createState()));
    await flush();

    // 变量块必须已经注入 —— 面板只写 `var(--dpp-ui-*)` 的话，没有变量就是全空。
    expect(document.getElementById('dpp-injected-theme-css')).not.toBeNull();
  });

  it('calls the theme injection from inside injectStyles, not merely imports it', () => {
    // ⚠️⚠️ **不能用 `source.includes('injectInjectedThemeStyles()')`** —— 函数定义体
    // 自己就含这个子串（导入语句也算），把调用点整行删掉它照样为 true，等于没守。
    // 所以走 AST：在 `injectStyles` 的函数体范围内找这两次调用。
    const program = parseTypeScriptSource(
      'core/zai/project-panel.ts',
      readFileSync('core/zai/project-panel.ts', 'utf8'),
    );
    const range = findFunctionRange(program, 'injectStyles');
    expect(range, 'injectStyles 没找到').not.toBeNull();

    const calls: string[] = [];
    walkSourceAst(program, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return;
      const start = node.start ?? -1;
      if (start < range!.start || start > range!.end) return;
      calls.push(node.callee.name);
    });

    expect(calls).toContain('injectInjectedThemeStyles');
    expect(calls).toContain('syncInjectedTheme');

    // ⚠️ 光「出现过」还不够 —— 调用若被塞进 `if (false)` 或放在函数体第一条
    // `return` 之后，上面两条仍然为真。这里再钉一次**位置**：它们必须是函数体
    // 最前面两条语句（这两次调用是幂等的，放最前是刻意的语义）。
    const injectStylesBody = findFunctionBody(program, 'injectStyles');
    expect(injectStylesBody, 'injectStyles 的函数体没找到').not.toBeNull();
    const leadingCalls = injectStylesBody!.body.body.slice(0, 2).map((statement) => (
      t.isExpressionStatement(statement) && t.isCallExpression(statement.expression) &&
        t.isIdentifier(statement.expression.callee)
        ? statement.expression.callee.name
        : null
    ));
    expect(leadingCalls).toEqual(['injectInjectedThemeStyles', 'syncInjectedTheme']);
  });
});

/** `selector` 那个规则块的内容（不含选择器行与闭合括号）。 */
function blockOf(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `样式表里没有 ${selector}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('\n    }', start);
  expect(end, `${selector} 没有闭合`).toBeGreaterThan(start);
  return css.slice(start, end);
}

/** 改名输入框那条规则块（它的选择器带 `#id .class` 前缀，单独取一次）。 */
function renameBlock(css: string): string {
  return blockOf(css, `#${PANEL_ID} .dpp-project-panel__rename-input {`);
}

/** 顶层函数声明的函数体字符区间。 */
function findFunctionRange(program: t.Program, name: string): { start: number; end: number } | null {
  return findFunctionBody(program, name)?.range ?? null;
}

/** 顶层函数声明的 AST 函数体与它的字符区间。 */
function findFunctionBody(
  program: t.Program,
  name: string,
): { body: t.BlockStatement; range: { start: number; end: number } } | null {
  let found: { body: t.BlockStatement; range: { start: number; end: number } } | null = null;
  walkSourceAst(program, (node) => {
    if (found || !t.isFunctionDeclaration(node)) return;
    if (!t.isIdentifier(node.id, { name })) return;
    if (node.body.start == null || node.body.end == null) return;
    found = { body: node.body, range: { start: node.body.start, end: node.body.end } };
  });
  return found;
}
