import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectsPage from '../entrypoints/sidepanel/pages/ProjectsPage';
import type { ProjectContext, ProjectContextState } from '../core/project';

const EMPTY_PROJECT_STATE: ProjectContextState = {
  schemaVersion: 2,
  projects: [],
  conversations: [],
  pendingProjectId: null,
};

const CURRENT_CONVERSATION = {
  conversationId: 'session-1',
  title: '查看项目进展',
  url: 'https://chat.z.ai/chat/s/session-1',
};

let container: HTMLDivElement;
let root: Root | null;
let runtimeListeners: Array<(message: unknown) => void>;
let tabUpdatedListeners: Array<(tabId: number, changeInfo: { url?: string }) => void>;
let tabActivatedListeners: Array<() => void>;
let activeSiteStore: Record<string, unknown>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  runtimeListeners = [];
  tabUpdatedListeners = [];
  tabActivatedListeners = [];
  activeSiteStore = {};
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container.remove();
  vi.unstubAllGlobals();
});

describe('ProjectsPage', () => {
  it('renders a newly created project after background storage confirms it', async () => {
    let state = { ...EMPTY_PROJECT_STATE };
    const project = createProject('project-1', 'Alpha');
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_PROJECT_CONTEXT_STATE') return state;
      if (message.type === 'GET_MEMORIES') return [];
      if (message.type === 'GET_CURRENT_GLM_CONVERSATION') return { ok: true, conversation: CURRENT_CONVERSATION };
      if (message.type === 'CREATE_PROJECT_CONTEXT') {
        state = {
          ...state,
          projects: [project],
        };
        return project;
      }
      return { ok: true };
    });

    await renderProjectsPage(sendMessage);
    await enterProjectName('Alpha');
    await clickButton('创建项目');

    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).toContain('0 个对话，0 条项目记忆');
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'CREATE_PROJECT_CONTEXT',
      payload: { name: 'Alpha', instructions: '' },
    });
  });

  it('surfaces unavailable project backend instead of clearing the form silently', async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_PROJECT_CONTEXT_STATE') return EMPTY_PROJECT_STATE;
      if (message.type === 'GET_MEMORIES') return [];
      if (message.type === 'GET_CURRENT_GLM_CONVERSATION') return { ok: false, error: 'no_active_glm_conversation' };
      if (message.type === 'CREATE_PROJECT_CONTEXT') return null;
      return { ok: true };
    });

    await renderProjectsPage(sendMessage);
    await enterProjectName('Alpha');
    await clickButton('创建项目');

    expect(projectNameInput().value).toBe('Alpha');
    expect(container.textContent).toContain('项目后端不可用');
    expect(container.textContent).not.toContain('0 个对话，0 条项目记忆');
  });

  it('surfaces corrupt project repository values instead of accepting shallow shapes', async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_PROJECT_CONTEXT_STATE') {
        return {
          schemaVersion: 2,
          projects: [{ id: 'incomplete-project' }],
          conversations: [],
          pendingProjectId: null,
        };
      }
      if (message.type === 'GET_MEMORIES') return [];
      if (message.type === 'GET_CURRENT_GLM_CONVERSATION') return { ok: false };
      return { ok: true };
    });

    await renderProjectsPage(sendMessage);

    expect(container.textContent)
      .toContain('项目操作失败：projectContextResponse.projects[0].name must be a non-empty string');
  });

  it('surfaces an initial corrupt Memory snapshot without committing Project or empty state', async () => {
    const state: ProjectContextState = {
      ...EMPTY_PROJECT_STATE,
      projects: [createProject('project-1', 'Must not commit')],
    };
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_PROJECT_CONTEXT_STATE') return state;
      if (message.type === 'GET_MEMORIES') return [{ name: 'corrupt' }];
      if (message.type === 'GET_CURRENT_GLM_CONVERSATION') return { ok: false };
      return { ok: true };
    });

    await renderProjectsPage(sendMessage);

    expect(container.textContent).toContain(
      '项目操作失败：memoryResponse[0].id must be a positive safe integer',
    );
    expect(container.textContent).not.toContain('Must not commit');
    expect(container.textContent).not.toContain('暂无项目');
    expect(container.querySelector('.ds-skeleton')).toBeNull();
  });

  it('retains the last valid Project and Memory snapshot when a reload Memory is corrupt', async () => {
    let state: ProjectContextState = {
      ...EMPTY_PROJECT_STATE,
      projects: [createProject('project-1', 'Alpha')],
    };
    let memoryResponse: unknown = [createProjectMemory('memory-1', 'Alpha memory')];
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_PROJECT_CONTEXT_STATE') return state;
      if (message.type === 'GET_MEMORIES') return memoryResponse;
      if (message.type === 'GET_CURRENT_GLM_CONVERSATION') {
        return { ok: true, conversation: CURRENT_CONVERSATION };
      }
      if (message.type === 'UPDATE_PROJECT_CONTEXT') {
        state = {
          ...state,
          projects: [createProject('project-1', 'Beta must not commit')],
        };
        memoryResponse = [{ name: 'corrupt' }];
        return { ok: true };
      }
      return { ok: true };
    });

    await renderProjectsPage(sendMessage);
    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).toContain('Alpha memory');

    await clickButton('保存更改');

    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).toContain('Alpha memory');
    expect(container.textContent).not.toContain('Beta must not commit');
    expect(container.textContent).toContain(
      '项目操作失败：memoryResponse[0].id must be a positive safe integer',
    );
  });

  it('adds the current GLM conversation to the selected project', async () => {
    const project = createProject('project-1', 'Alpha');
    let state: ProjectContextState = {
      ...EMPTY_PROJECT_STATE,
      projects: [project],
    };
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_PROJECT_CONTEXT_STATE') return state;
      if (message.type === 'GET_MEMORIES') return [];
      if (message.type === 'GET_CURRENT_GLM_CONVERSATION') return { ok: true, conversation: CURRENT_CONVERSATION };
      if (message.type === 'ADD_CONVERSATION_TO_PROJECT') {
        state = {
          ...state,
          conversations: [{
            ...CURRENT_CONVERSATION,
            projectId: project.id,
            addedAt: 1,
            lastSeenAt: 2,
          }],
        };
        return { ok: true, conversation: state.conversations[0] };
      }
      return { ok: true };
    });

    await renderProjectsPage(sendMessage);
    await clickButton('加入当前对话');

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'ADD_CONVERSATION_TO_PROJECT',
      payload: {
        projectId: 'project-1',
        conversation: CURRENT_CONVERSATION,
      },
    });
    expect(container.textContent).toContain('查看项目进展');
  });

  it('surfaces project mutation failures instead of reloading as success', async () => {
    const project = createProject('project-1', 'Alpha');
    const state: ProjectContextState = {
      ...EMPTY_PROJECT_STATE,
      projects: [project],
    };
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_PROJECT_CONTEXT_STATE') return state;
      if (message.type === 'GET_MEMORIES') return [];
      if (message.type === 'GET_CURRENT_GLM_CONVERSATION') return { ok: true, conversation: CURRENT_CONVERSATION };
      if (message.type === 'UPDATE_PROJECT_CONTEXT') return { ok: false, error: 'update failed' };
      return { ok: true };
    });

    await renderProjectsPage(sendMessage);
    await clickButton('保存更改');

    expect(container.textContent).toContain('update failed');
  });

  it('does not let an older read replace a newer runtime invalidation reload', async () => {
    const stale = deferred<unknown>();
    const newestState: ProjectContextState = {
      ...EMPTY_PROJECT_STATE,
      projects: [createProject('project-newest', 'Newest project')],
    };
    let projectReads = 0;
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_PROJECT_CONTEXT_STATE') {
        projectReads += 1;
        return projectReads === 1 ? stale.promise : newestState;
      }
      if (message.type === 'GET_MEMORIES') return [];
      if (message.type === 'GET_CURRENT_GLM_CONVERSATION') return { ok: false, error: 'none' };
      return { ok: true };
    });

    await renderProjectsPage(sendMessage);
    await act(async () => {
      runtimeListeners.forEach((listener) => listener({ type: 'PROJECT_CONTEXT_UPDATED' }));
    });
    await settle();
    expect(container.textContent).toContain('Newest project');

    stale.resolve({
      ...EMPTY_PROJECT_STATE,
      projects: [createProject('project-stale', 'Stale project')],
    });
    await settle();

    expect(container.textContent).toContain('Newest project');
    expect(container.textContent).not.toContain('Stale project');
  });

  it('follows the active tab URL so switching chats updates the current conversation', async () => {
    const project = createProject('project-1', 'Alpha');
    const state: ProjectContextState = { ...EMPTY_PROJECT_STATE, projects: [project] };
    let conversation: unknown = { ok: false, error: 'none' };
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_PROJECT_CONTEXT_STATE') return state;
      if (message.type === 'GET_MEMORIES') return [];
      if (message.type === 'GET_CURRENT_GLM_CONVERSATION') return conversation;
      return { ok: true };
    });

    await renderProjectsPage(sendMessage);
    expect(container.textContent).toContain('当前活动标签页不是 Zai 对话');

    // 页面内切会话是 SPA 导航：侧边栏拿不到 focus，后台也不会广播 ——
    // 只能靠标签页 URL 变化驱动。
    conversation = { ok: true, conversation: CURRENT_CONVERSATION };
    await act(async () => {
      tabUpdatedListeners.forEach((listener) => listener(7, {
        url: 'https://chat.z.ai/c/session-1',
      }));
    });
    await settle();

    expect(container.textContent).toContain('查看项目进展');
    expect(container.textContent).not.toContain('当前活动标签页不是 Zai 对话');
  });

  it('links a conversation to the site that owns it, not to the current site', async () => {
    // ⚠️ **对应一个真实缺陷**：原来按「与当前页同源」判 —— 在国际站的侧边栏里，
    // 一条**国区站**的会话会被拼成当前站的 `/c/<id>`，而那一站没有它 ⇒ 跳转失败。
    // 两个站各有一份会话，同一条会话**只存在于它自己那一站**。
    const state: ProjectContextState = {
      ...EMPTY_PROJECT_STATE,
      projects: [createProject('project-1', 'Alpha')],
      conversations: [{
        conversationId: 'cn-1',
        projectId: 'project-1',
        title: '国区站的对话',
        url: 'https://zchat.z.ai/c/cn-1',
        addedAt: 1,
        lastSeenAt: 5,
      }],
    };
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_PROJECT_CONTEXT_STATE') return state;
      if (message.type === 'GET_MEMORIES') return [];
      if (message.type === 'GET_CURRENT_GLM_CONVERSATION') return { ok: false, error: 'none' };
      return { ok: true };
    });

    // ⚠️ **活跃站设成国际站** —— 这样「兜底站」与「记录里的站」是两个不同的值，
    // 判据才分得清链接是**按记录**来的还是被兜底站顶掉的（两者相同时这条断言恒真）。
    stubActiveSite('https://chat.z.ai');
    await renderProjectsPage(sendMessage);
    await settle();

    const link = container.querySelector<HTMLAnchorElement>('a[href*="/c/cn-1"]');
    expect(link).toBeTruthy();
    expect(link!.href).toBe('https://zchat.z.ai/c/cn-1');
  });

  it('falls back to a rebuilt URL when the stored one is not one of our sites', async () => {
    const state: ProjectContextState = {
      ...EMPTY_PROJECT_STATE,
      projects: [createProject('project-1', 'Alpha')],
      conversations: [{
        conversationId: 'c1',
        projectId: 'project-1',
        title: '导入来的对话',
        url: 'https://evil.test/c/c1',
        addedAt: 1,
        lastSeenAt: 5,
      }],
    };
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_PROJECT_CONTEXT_STATE') return state;
      if (message.type === 'GET_MEMORIES') return [];
      if (message.type === 'GET_CURRENT_GLM_CONVERSATION') return { ok: false, error: 'none' };
      return { ok: true };
    });

    await renderProjectsPage(sendMessage);
    await settle();

    const link = container.querySelector<HTMLAnchorElement>('a[href*="/c/c1"]');
    expect(link).toBeTruthy();
    expect(link!.href).not.toContain('evil.test');
    expect(link!.href).toMatch(/^https:\/\/(?:zchat|chat)\.z\.ai\/c\/c1$/);
  });

  it('ignores tab URL changes from unrelated sites', async () => {
    const state: ProjectContextState = {
      ...EMPTY_PROJECT_STATE,
      projects: [createProject('project-1', 'Alpha')],
    };
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_PROJECT_CONTEXT_STATE') return state;
      if (message.type === 'GET_MEMORIES') return [];
      if (message.type === 'GET_CURRENT_GLM_CONVERSATION') {
        return { ok: true, conversation: CURRENT_CONVERSATION };
      }
      return { ok: true };
    });

    await renderProjectsPage(sendMessage);
    const before = sendMessage.mock.calls.filter(
      (call) => (call[0] as { type: string }).type === 'GET_CURRENT_GLM_CONVERSATION',
    ).length;

    await act(async () => {
      tabUpdatedListeners.forEach((listener) => listener(9, { url: 'https://example.com/' }));
      // 只有 changeInfo.url 才值得看；状态类变更（loading 等）不触发刷新。
      tabUpdatedListeners.forEach((listener) => listener(9, {}));
    });
    await settle();

    const after = sendMessage.mock.calls.filter(
      (call) => (call[0] as { type: string }).type === 'GET_CURRENT_GLM_CONVERSATION',
    ).length;
    expect(after).toBe(before);
  });

  it('refreshes the current conversation when the active tab changes', async () => {
    const state: ProjectContextState = {
      ...EMPTY_PROJECT_STATE,
      projects: [createProject('project-1', 'Alpha')],
    };
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_PROJECT_CONTEXT_STATE') return state;
      if (message.type === 'GET_MEMORIES') return [];
      if (message.type === 'GET_CURRENT_GLM_CONVERSATION') {
        return { ok: true, conversation: CURRENT_CONVERSATION };
      }
      return { ok: true };
    });

    await renderProjectsPage(sendMessage);
    const before = sendMessage.mock.calls.filter(
      (call) => (call[0] as { type: string }).type === 'GET_CURRENT_GLM_CONVERSATION',
    ).length;

    await act(async () => {
      tabActivatedListeners.forEach((listener) => listener());
    });
    await settle();

    const after = sendMessage.mock.calls.filter(
      (call) => (call[0] as { type: string }).type === 'GET_CURRENT_GLM_CONVERSATION',
    ).length;
    expect(after).toBeGreaterThan(before);
  });
});

async function renderProjectsPage(sendMessage: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: vi.fn((listener: (message: unknown) => void) => {
          runtimeListeners.push(listener);
        }),
        removeListener: vi.fn((listener: (message: unknown) => void) => {
          runtimeListeners = runtimeListeners.filter((item) => item !== listener);
        }),
      },
    },
    tabs: {
      onUpdated: {
        addListener: vi.fn((listener: (tabId: number, changeInfo: { url?: string }) => void) => {
          tabUpdatedListeners.push(listener);
        }),
        removeListener: vi.fn(),
      },
      onActivated: {
        addListener: vi.fn((listener: () => void) => {
          tabActivatedListeners.push(listener);
        }),
        removeListener: vi.fn(),
      },
    },
    storage: {
      // 「最近活跃站」由内容脚本写在这把键上（见 `core/zai/active-site.ts`）。
      // 环境没桩时读不到 ⇒ 兜底站是默认站（国区站），所以需要区分两个站的用例
      // 得自己设一个值（见 `stubActiveSite`）。
      local: {
        get: vi.fn(async (key: string) => (key in activeSiteStore ? { [key]: activeSiteStore[key] } : {})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
  });

  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(ProjectsPage));
  });
}

/** 设「最近活跃站」的值（侧边栏兜底拼链接时读它）。 */
function stubActiveSite(origin: string) {
  activeSiteStore.glm_pp_active_site = { origin, at: 1 };
}

async function enterProjectName(value: string) {
  await enterInput('项目名称', value);
}

async function enterInput(placeholder: string, value: string) {
  const input = inputByPlaceholder(placeholder);
  await act(async () => {
    setInputValue(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function clickButton(label: string) {
  const button = Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function projectNameInput(): HTMLInputElement {
  return inputByPlaceholder('项目名称');
}

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = container.querySelector(`input[placeholder="${placeholder}"]`);
  expect(input).toBeInstanceOf(HTMLInputElement);
  return input as HTMLInputElement;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
}

function createProject(id: string, name: string): ProjectContext {
  return {
    id,
    name,
    description: '',
    instructions: '',
    createdAt: 1,
    updatedAt: 1,
  };
}

function createProjectMemory(id: string, name: string) {
  return {
    id: 1,
    syncId: id,
    scope: 'project',
    projectId: 'project-1',
    type: 'topic',
    name,
    content: 'content',
    description: '',
    tags: [],
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    accessCount: 0,
    lastAccessedAt: 1,
  };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
