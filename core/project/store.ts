import type {
  ProjectContext,
  ProjectContextCreateInput,
  ProjectContextState,
  ProjectContextUpdateInput,
  ProjectConversation,
  ProjectConversationInput,
  ProjectPromptContext,
} from './types';
import { PROJECT_UNTITLED_CONVERSATION, isPlaceholderProjectConversationTitle } from './title';
import { withSyncLocalStateLock } from '../persistence/local-state-lock';
import {
  createChromeStorageSlot,
  createVersionedRepository,
} from '../persistence/versioned-repository';
import {
  assertMemoryRecordsValidAlreadyLocked,
  deleteMemoriesForProjectAlreadyLocked,
} from '../memory/store';
import {
  createEmptyProjectContextState,
  projectContextCodec,
  removeProjectFromLegacyFields,
} from './codec';

export const PROJECT_CONTEXT_STORAGE_KEY = 'glm_pp_project_context';

const projectContextRepository = createVersionedRepository({
  label: 'projectContext',
  createDefault: createEmptyProjectContextState,
  codec: projectContextCodec,
  storage: createChromeStorageSlot(PROJECT_CONTEXT_STORAGE_KEY),
});

export async function getProjectContextState(): Promise<ProjectContextState> {
  return projectContextRepository.read();
}

export async function getProjectContextStateAlreadyLocked(): Promise<ProjectContextState> {
  return projectContextRepository.readAlreadyLocked();
}

export async function saveProjectContextStateForSyncApply(state: ProjectContextState): Promise<void> {
  await projectContextRepository.replaceAlreadyLocked(state);
}

async function writeProjectContextState(state: ProjectContextState): Promise<void> {
  await projectContextRepository.writeAfterReadAlreadyLocked(state);
}

export async function createProjectContext(input: ProjectContextCreateInput): Promise<ProjectContext> {
  return withProjectMutation(async (state) => {
    const now = Date.now();
    const project: ProjectContext = {
      id: crypto.randomUUID(),
      name: requiredTrimmed(input.name, 'Project name'),
      description: String(input.description ?? '').trim(),
      instructions: String(input.instructions ?? '').trim(),
      createdAt: now,
      updatedAt: now,
    };
    await writeProjectContextState({
      ...state,
      projects: [...state.projects, project],
    });
    return project;
  });
}

export async function updateProjectContext(
  projectId: string,
  patch: ProjectContextUpdateInput,
): Promise<ProjectContext> {
  return withProjectMutation(async (state) => {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const nextProject: ProjectContext = {
      ...project,
      ...(patch.name === undefined ? {} : { name: requiredTrimmed(patch.name, 'Project name') }),
      ...(patch.description === undefined ? {} : { description: String(patch.description).trim() }),
      ...(patch.instructions === undefined ? {} : { instructions: String(patch.instructions).trim() }),
      updatedAt: Date.now(),
    };

    await writeProjectContextState({
      ...state,
      projects: state.projects.map((item) => item.id === projectId ? nextProject : item),
    });
    return nextProject;
  });
}

export async function stageDeleteProjectContextAndMemoriesAlreadyLocked(
  projectId: string,
): Promise<() => Promise<number>> {
  const state = await projectContextRepository.readAlreadyLocked();
  await assertMemoryRecordsValidAlreadyLocked();
  return async () => {
    await deleteProjectContextState(state, projectId);
    return deleteMemoriesForProjectAlreadyLocked(projectId);
  };
}

async function deleteProjectContextState(
  state: ProjectContextState,
  projectId: string,
): Promise<void> {
  await writeProjectContextState(removeProjectFromLegacyFields({
    ...state,
    projects: state.projects.filter((project) => project.id !== projectId),
    conversations: state.conversations.filter((conversation) => conversation.projectId !== projectId),
    pendingProjectId: state.pendingProjectId === projectId ? null : state.pendingProjectId,
  }, projectId));
}

export async function addConversationToProject(
  projectId: string,
  input: ProjectConversationInput,
): Promise<ProjectConversation> {
  return withProjectMutation((state) => addConversationToProjectState(state, projectId, input));
}

async function addConversationToProjectState(
  state: ProjectContextState,
  projectId: string,
  input: ProjectConversationInput,
): Promise<ProjectConversation> {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const now = Date.now();
  const conversationId = requiredTrimmed(input.conversationId, 'Conversation id');
  const existing = state.conversations.find((item) => item.conversationId === conversationId);
  // 标题优先级：手动改名 > 已有的手动改名 > 页面自动回填。
  // ⚠️ 自动回填每轮都会跑（`refreshProjectConversation`），所以手动改名必须留一道闸门，
  // 否则改名活不过下一轮对话。
  const manualTitle = input.titleEdited === true ? requiredTrimmed(input.title, 'Conversation title') : null;
  const keepEdited = existing?.titleEdited === true;
  const conversation: ProjectConversation = {
    conversationId,
    projectId,
    title: manualTitle
      ?? (keepEdited ? existing!.title : selectConversationTitle(input.title, existing?.title)),
    url: normalizeConversationUrl(input.url ?? existing?.url),
    addedAt: existing?.addedAt ?? now,
    lastSeenAt: now,
    ...(manualTitle !== null || keepEdited ? { titleEdited: true } : {}),
  };

  await writeProjectContextState({
    ...state,
    projects: state.projects.map((item) => item.id === projectId ? { ...item, updatedAt: now } : item),
    conversations: [
      ...state.conversations.filter((item) => item.conversationId !== conversationId),
      conversation,
    ],
    // 清 pending 的语义是「这次**真的**新绑了一条会话进来」，所以只有
    // **本次新加入**（`existing === undefined`）才消费它。
    //
    // ⚠️ 另外两类写入都不能清：
    // - **纯改名**（`titleEdited`）—— 改名只是改标题，顺手清掉会让用户刚设的
    //   「下一条新会话用此项目」莫名失效；
    // - **自动补名**（走 ADD、不带 `titleEdited`，但会话已在项目里）—— 它是
    //   **后台自动发生**的，用户没做任何动作。按「已在项目里且 pending 同项目就清」
    //   写，会把用户刚设的 pending 静默取消掉。
    pendingProjectId: existing !== undefined || manualTitle !== null
      ? state.pendingProjectId
      : (state.pendingProjectId === projectId ? null : state.pendingProjectId),
  });

  return conversation;
}

export async function refreshProjectConversation(
  input: ProjectConversationInput,
): Promise<ProjectConversation | null> {
  return withProjectMutation(async (state) => {
    const conversationId = requiredTrimmed(input.conversationId, 'Conversation id');
    const existing = state.conversations.find((item) => item.conversationId === conversationId);
    if (!existing) return null;

    const now = Date.now();
    const conversation: ProjectConversation = {
      ...existing,
      // 手动改过名的会话只更新 lastSeenAt / url，标题不动。
      title: existing.titleEdited
        ? existing.title
        : selectConversationTitle(input.title, existing.title),
      url: normalizeConversationUrl(input.url ?? existing.url),
      lastSeenAt: now,
    };

    await writeProjectContextState({
      ...state,
      projects: state.projects.map((item) => item.id === existing.projectId ? { ...item, updatedAt: now } : item),
      conversations: state.conversations.map((item) => item.conversationId === conversationId ? conversation : item),
    });
    return conversation;
  });
}

export async function removeConversationFromProject(conversationId: string): Promise<void> {
  await withProjectMutation(async (state) => {
    await writeProjectContextState({
      ...state,
      conversations: state.conversations.filter((item) => item.conversationId !== conversationId),
    });
  });
}

export async function setPendingProjectContext(projectId: string | null): Promise<void> {
  await withProjectMutation(async (state) => {
    const exists = projectId === null || state.projects.some((project) => project.id === projectId);
    if (!exists) throw new Error(`Project not found: ${projectId}`);
    await writeProjectContextState({
      ...state,
      pendingProjectId: projectId,
    });
  });
}

export async function bindPendingProjectConversation(
  input: ProjectConversationInput,
): Promise<ProjectConversation | null> {
  return withProjectMutation(async (state) => {
    if (!state.pendingProjectId) return null;
    const projectExists = state.projects.some((project) => project.id === state.pendingProjectId);
    if (!projectExists) {
      await writeProjectContextState({ ...state, pendingProjectId: null });
      return null;
    }
    return addConversationToProjectState(state, state.pendingProjectId, input);
  });
}

function withProjectMutation<T>(
  operation: (state: ProjectContextState) => Promise<T>,
): Promise<T> {
  return withSyncLocalStateLock(async () => operation(await projectContextRepository.readAlreadyLocked()));
}

export async function getProjectForConversation(conversationId: string): Promise<ProjectContext | null> {
  const state = await getProjectContextState();
  const membership = state.conversations.find((item) => item.conversationId === conversationId);
  if (!membership) return null;
  return state.projects.find((project) => project.id === membership.projectId) ?? null;
}

/**
 * 挑选与呈现规则全部在 `prompt-context.ts`（纯函数，无 IO）—— 内容脚本也要用同一套，
 * 否则就成了「生产端与判定端各写一遍」。这里只做转出 + 一层带 IO 的包装。
 */
export {
  formatProjectPromptContext,
  selectConversationProjectPrompt,
  selectPendingProjectPrompt,
  type ProjectPromptSelection,
} from './prompt-context';
import {
  selectConversationProjectPrompt,
  type ProjectPromptSelection,
} from './prompt-context';

/**
 * 某会话的**项目指令上下文**：只在项目确实写了指令时非空。
 *
 * ⚠️ **这个函数的 null 不等于「没有项目」** —— 项目只存了记忆、没写指令时它也是 null。
 * 需要「项目归属」用 `getProjectForConversation`；需要「喂给请求的 projectId」用
 * `selectConversationProjectPrompt`（它的 selection 在没写指令时仍带 projectId）。
 */
export async function getProjectPromptContextForConversation(
  conversationId: string,
): Promise<ProjectPromptContext | null> {
  const state = await getProjectContextState();
  // `locale` 用缺省值即可：这里只拿 `selection.context` 判**有没有指令**，
  // 渲染好的那个字符串随即被丢掉，真正的渲染发生在 handler 里
  // （`formatProjectPromptContext(projectContext)` 带 locale 那一次）。
  const selection: ProjectPromptSelection | null = selectConversationProjectPrompt(state, conversationId);
  if (!selection?.context) return null;
  // 防御性分支：`selection` 只在项目存在时才产生，所以这里理论上拿得到。
  // 保留它不是死代码洁癖的反面 —— 它把「selection 与 state 必须同源」这个前提
  // 显式写出来，将来若 selection 变成异步/缓存来源，这一步就是唯一的安全网。
  const project = state.projects.find((item) => item.id === selection.projectId);
  if (!project) return null;
  return {
    projectId: project.id,
    projectName: project.name,
    instructions: project.instructions.trim(),
  };
}

function requiredTrimmed(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function normalizeConversationTitle(value: unknown): string {
  if (typeof value !== 'string') return PROJECT_UNTITLED_CONVERSATION;
  const title = value.trim();
  if (!title || isPlaceholderProjectConversationTitle(title)) return PROJECT_UNTITLED_CONVERSATION;
  return title;
}

/**
 * 标题只在**已有值是占位串**时才接受页面回填 —— 即「**只针对占位标题做补名**」。
 *
 * ⚠️ **不能写成「incoming 优先」**（那会让每次回填都覆盖已有标题）：
 * 会话一旦有了真名字（自动回填来的、或用户重命名来的），就不该再被会话列表里的名字
 * 改写 —— 否则用户在项目里改的名字会被下一轮对话顺手改回去。
 * 占位串（`Untitled conversation`）是唯一的例外：它不是「名字」，是「还没有名字」。
 */
function selectConversationTitle(incoming: unknown, existing: unknown): string {
  const existingTitle = normalizeConversationTitle(existing);
  if (existingTitle !== PROJECT_UNTITLED_CONVERSATION) return existingTitle;
  return normalizeConversationTitle(incoming);
}

function normalizeConversationUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}
