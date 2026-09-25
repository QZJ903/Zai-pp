import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startProjectPanel,
  type ProjectPanelController,
  type ProjectPanelDependencies,
  type ProjectPanelLabels,
} from '../core/zai/project-panel';
import type { ProjectContextState } from '../core/types';

const PANEL_ID = 'dpp-project-panel';
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
    setPending: vi.fn(async () => {}),
    getCurrentConversation: () => null,
    openConversation: vi.fn(),
    startNewConversation: vi.fn(),
    getLabels: () => LABELS,
    ...overrides,
  };
  return deps;
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
});
