/**
 * 项目上下文的**挑选与呈现** —— 全部是纯函数，不碰存储。
 *
 * 与 `core/project/store.ts` 分开，是因为**内容脚本也要用同一套规则**：首条建会话
 * （`/chats/new`）时地址栏还没有 `/c/<id>`，那一刻唯一可用的真源是**待绑项目**。
 * 让内容脚本从 store 走会把整个 repository（连带 IndexedDB 层）打进 bundle；
 * 而让它自己写一遍挑选逻辑，就成了「生产端与判定端各写一遍」（静默失效的温床）。
 * 所以规则只有这一处定义。
 */
import type { ProjectContextState, ProjectPromptContext } from './types';

/**
 * 一次请求要用的项目信息。
 *
 * ⚠️ **`projectId` 与 `context` 是两个独立结论**：
 * - `projectId` 决定**项目记忆**能不能入选（`filterMemoriesByProjectScope` 按它过滤）；
 * - `context` 是**项目指令**的提示词文本，项目没写指令时为 null。
 *
 * 把这两件事绑成一个「有没有指令」的判定，会让**只存了记忆、没写指令的项目**
 * 连带把记忆也丢掉 —— 这正是首条建会话曾经的表现。
 */
export interface ProjectPromptSelection {
  projectId: string;
  context: string | null;
}

/** 某条会话所属项目的选择结果。会话未归入项目时返回 null。 */
export function selectConversationProjectPrompt(
  state: ProjectContextState,
  conversationId: string,
): ProjectPromptSelection | null {
  const membership = state.conversations.find((item) => item.conversationId === conversationId);
  if (!membership) return null;
  return selectProject(state, membership.projectId);
}

/**
 * **待绑项目**的选择结果。
 *
 * ⚠️ 这是**首条建会话**唯一的项目来源：`/chats/new` 发生在页面跳 `/c/<id>` 之前，
 * 那一刻没有会话 id 可查归属，只有 pending 是已知的
 * （「下一条新会话使用此项目」与面板的「在项目下开启新会话」都会先置它）。
 */
export function selectPendingProjectPrompt(
  state: ProjectContextState,
): ProjectPromptSelection | null {
  if (!state.pendingProjectId) return null;
  return selectProject(state, state.pendingProjectId);
}

/** 项目指令在提示词里的呈现格式。 */
export function formatProjectPromptContext(context: ProjectPromptContext): string {
  return [
    '## Project Context',
    `Project: ${context.projectName}`,
    '',
    '### Project Instructions',
    context.instructions,
  ].join('\n').trim();
}

function selectProject(
  state: ProjectContextState,
  projectId: string,
): ProjectPromptSelection | null {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return null;
  const instructions = project.instructions.trim();
  return {
    projectId: project.id,
    context: instructions
      ? formatProjectPromptContext({
        projectId: project.id,
        projectName: project.name,
        instructions,
      })
      : null,
  };
}