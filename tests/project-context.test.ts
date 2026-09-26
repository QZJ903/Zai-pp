import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addConversationToProject,
  bindPendingProjectConversation,
  createProjectContext,
  formatProjectPromptContext,
  getProjectContextState,
  getProjectForConversation,
  getProjectPromptContextForConversation,
  refreshProjectConversation,
  removeConversationFromProject,
  setPendingProjectContext,
  updateProjectContext,
} from '../core/project';

let storage: Record<string, unknown>;

beforeEach(() => {
  storage = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          storage = { ...storage, ...values };
        }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session-based project context', () => {
  it('keeps one project membership per conversation', async () => {
    const first = await createProjectContext({ name: 'Alpha' });
    const second = await createProjectContext({ name: 'Beta' });

    await addConversationToProject(first.id, {
      conversationId: 'session-1',
      title: 'Draft',
      url: 'https://chat.z.ai/chat/s/session-1',
    });
    await addConversationToProject(second.id, {
      conversationId: 'session-1',
      title: 'Draft moved',
      url: 'https://chat.z.ai/chat/s/session-1',
    });

    const state = await getProjectContextState();
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0]).toMatchObject({
      conversationId: 'session-1',
      projectId: second.id,
      // 归属跟着移到新项目，但**标题保留** —— 标题只在已有值是占位串时才接受回填
      // （见 store.ts 的 selectConversationTitle）。这样用户重命名的名字不会被
      // 会话列表里的名字顺手改回去。
      title: 'Draft',
    });
    await expect(getProjectForConversation('session-1')).resolves.toMatchObject({ id: second.id });
  });

  it('binds pending project to the next conversation and clears pending state', async () => {
    const project = await createProjectContext({
      name: 'Plotforge',
      instructions: 'Keep track of story continuity.',
    });
    await setPendingProjectContext(project.id);

    const conversation = await bindPendingProjectConversation({
      conversationId: 'session-next',
      title: 'Chapter outline',
      url: 'https://chat.z.ai/chat/s/session-next',
    });
    const state = await getProjectContextState();
    const context = await getProjectPromptContextForConversation('session-next');

    expect(conversation?.projectId).toBe(project.id);
    expect(state.pendingProjectId).toBeNull();
    expect(formatProjectPromptContext(context!)).toContain('Project: Plotforge');
    expect(formatProjectPromptContext(context!)).toContain('Keep track of story continuity.');
  });

  it('does not consume the pending project on an automated title backfill', async () => {
    // 补名走 ADD、**不带 titleEdited**，但会话已在项目里 —— 它是**后台自动发生**的，
    // 用户没做任何动作，不能顺手把「下一条新会话用此项目」取消掉。
    // （纯改名那条由 titleEdited 覆盖，这里钉的是补名那条路径。）
    const project = await createProjectContext({ name: 'Alpha' });
    await addConversationToProject(project.id, {
      conversationId: 'session-1',
      title: 'Untitled conversation',
      url: 'https://chat.z.ai/c/session-1',
    });

    // 用户随后设了「下一条新会话用此项目」。
    await setPendingProjectContext(project.id);

    // 补名：同一个会话、同一个项目、只换标题。
    await addConversationToProject(project.id, {
      conversationId: 'session-1',
      title: '真实会话名',
      url: 'https://chat.z.ai/c/session-1',
    });

    const state = await getProjectContextState();
    expect(state.conversations[0]).toMatchObject({ title: '真实会话名' });
    // ⚠️ pending 必须**原样保留** —— 否则用户刚设的待绑被静默清空。
    expect(state.pendingProjectId).toBe(project.id);
  });

  it('still consumes the pending project when a conversation is newly added', async () => {
    // 对照组：「真的新绑进来一条会话」仍然要消费 pending（既有语义）。
    const project = await createProjectContext({ name: 'Alpha' });
    await setPendingProjectContext(project.id);

    await addConversationToProject(project.id, {
      conversationId: 'session-fresh',
      title: 'Chapter outline',
      url: 'https://chat.z.ai/c/session-fresh',
    });

    expect((await getProjectContextState()).pendingProjectId).toBeNull();
  });

  it('refreshes stale project conversation titles without letting default GLM titles overwrite real titles', async () => {
    const project = await createProjectContext({ name: 'Alpha' });

    await addConversationToProject(project.id, {
      conversationId: 'session-1',
      // 首条消息那一刻侧边栏还没渲染出那一行 → 只能给占位串。
      title: 'Untitled conversation',
      url: 'https://chat.z.ai/c/session-1',
    });
    await expect(getProjectContextState()).resolves.toMatchObject({
      conversations: [expect.objectContaining({ title: 'Untitled conversation' })],
    });

    // 有真名了就补上（这是「只针对占位标题」的那次回填）。
    await refreshProjectConversation({
      conversationId: 'session-1',
      title: '真实项目标题',
      url: 'https://chat.z.ai/c/session-1',
    });
    await expect(getProjectContextState()).resolves.toMatchObject({
      conversations: [expect.objectContaining({ title: '真实项目标题' })],
    });

    // 占位类标题（GLM 默认标题）不能覆盖真名。
    await refreshProjectConversation({
      conversationId: 'session-1',
      title: 'GLM-探索未至之境',
      url: 'https://chat.z.ai/c/session-1',
    });
    await expect(getProjectContextState()).resolves.toMatchObject({
      conversations: [expect.objectContaining({ title: '真实项目标题' })],
    });
  });

  it('only backfills onto a placeholder title, never overwrites an existing real title', async () => {
    const project = await createProjectContext({ name: 'Alpha' });
    await addConversationToProject(project.id, {
      conversationId: 'session-1',
      title: '我改过的名字',
      url: 'https://chat.z.ai/c/session-1',
    });

    // 之后每一次回填（每轮对话都会跑）都不该改写已有标题 —— 否则用户重命名的名字
    // 会被会话列表里的名字顺手改回去。
    await refreshProjectConversation({
      conversationId: 'session-1',
      title: '会话列表里的名字',
      url: 'https://chat.z.ai/c/session-1',
    });
    await expect(getProjectContextState()).resolves.toMatchObject({
      conversations: [expect.objectContaining({ title: '我改过的名字' })],
    });

    // 「加入别的项目」这种 upsert 同理：归属会移，标题不动。
    const other = await createProjectContext({ name: 'Beta' });
    await addConversationToProject(other.id, {
      conversationId: 'session-1',
      title: '会话列表里的新名字',
      url: 'https://chat.z.ai/c/session-1',
    });
    await expect(getProjectContextState()).resolves.toMatchObject({
      conversations: [expect.objectContaining({
        projectId: other.id,
        title: '我改过的名字',
      })],
    });
  });

  it('updates project instructions and removes conversation membership', async () => {
    const project = await createProjectContext({ name: 'Alpha', instructions: 'Old' });
    await addConversationToProject(project.id, { conversationId: 'session-1' });

    const updated = await updateProjectContext(project.id, {
      name: 'Alpha Prime',
      instructions: 'New',
    });
    await removeConversationFromProject('session-1');

    const state = await getProjectContextState();
    expect(updated.name).toBe('Alpha Prime');
    expect(state.projects[0].instructions).toBe('New');
    expect(state.conversations).toEqual([]);
  });
});
