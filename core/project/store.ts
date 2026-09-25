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
    // 纯改名（titleEdited）不该有绑定副作用：清 pending 是「加入会话」的语义，
    // 而改名只是改标题 —— 顺手清掉会让用户刚设的「下一条新会话用此项目」莫名失效。
    pendingProjectId: manualTitle !== null
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

export async function getProjectPromptContextForConversation(
  conversationId: string,
): Promise<ProjectPromptContext | null> {
  const state = await getProjectContextState();
  const membership = state.conversations.find((item) => item.conversationId === conversationId);
  if (!membership) return null;
  const project = state.projects.find((item) => item.id === membership.projectId);
  if (!project) return null;
  const instructions = project.instructions.trim();
  if (!instructions) return null;
  return {
    projectId: project.id,
    projectName: project.name,
    instructions,
  };
}

export function formatProjectPromptContext(context: ProjectPromptContext): string {
  return [
    '## Project Context',
    `Project: ${context.projectName}`,
    '',
    '### Project Instructions',
    context.instructions,
  ].join('\n').trim();
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

function selectConversationTitle(incoming: unknown, existing: unknown): string {
  const incomingTitle = typeof incoming === 'string' ? incoming.trim() : '';
  if (incomingTitle && !isPlaceholderProjectConversationTitle(incomingTitle)) return incomingTitle;
  return normalizeConversationTitle(existing);
}

function normalizeConversationUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}
