import { describe, expect, it } from 'vitest';
import {
  formatProjectPromptContext,
  selectConversationProjectPrompt,
  selectPendingProjectPrompt,
} from '../core/project/prompt-context';
import { filterMemoriesByProjectScope } from '../core/memory/scope';
import type { Memory, ProjectContextState } from '../core/types';

/**
 * 关键不变式：**「项目归属」与「项目有没有写指令」是两件事**。
 *
 * 只存了项目记忆、没写指令的项目，也必须给出 `projectId` —— 否则
 * `filterMemoriesByProjectScope` 会把它的项目记忆整批当作「不属于当前项目」过滤掉。
 * 首条建会话（`/chats/new`）曾经就是这个表现：项目记忆要等第二轮才生效。
 */
function stateWith(overrides: Partial<ProjectContextState> = {}): ProjectContextState {
  return {
    schemaVersion: 2,
    pendingProjectId: 'project-memories-only',
    projects: [
      {
        id: 'project-memories-only',
        name: '记忆项目',
        description: '',
        instructions: '',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'project-with-instructions',
        name: '指令项目',
        description: '',
        instructions: '总是用中文回答',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    conversations: [
      {
        conversationId: 'conv-1',
        projectId: 'project-memories-only',
        title: 'T',
        url: '',
        addedAt: 1,
        lastSeenAt: 1,
      },
    ],
    ...overrides,
  };
}

function memory(id: number, scope: Memory['scope'], projectId: string | undefined): Memory {
  return {
    id,
    syncId: `sync-${id}`,
    scope,
    projectId,
    type: 'topic',
    name: `memory-${id}`,
    content: `content-${id}`,
    description: '',
    tags: [],
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    accessCount: 0,
    lastAccessedAt: 1,
  };
}

describe('project prompt context selection', () => {
  it('returns a projectId for a pending project that has only memories', () => {
    const selection = selectPendingProjectPrompt(stateWith());

    expect(selection?.projectId).toBe('project-memories-only');
    // 没写指令 → 没有指令文本，但**项目归属仍然成立**。
    expect(selection?.context).toBeNull();
  });

  it('returns a projectId for a conversation in a memories-only project', () => {
    const selection = selectConversationProjectPrompt(stateWith(), 'conv-1');

    expect(selection?.projectId).toBe('project-memories-only');
    expect(selection?.context).toBeNull();
  });

  it('formats instructions when the project has them', () => {
    const selection = selectPendingProjectPrompt(
      stateWith({ pendingProjectId: 'project-with-instructions' }),
    );

    expect(selection?.projectId).toBe('project-with-instructions');
    expect(selection?.context).toContain('## Project Context');
    expect(selection?.context).toContain('Project: 指令项目');
    expect(selection?.context).toContain('总是用中文回答');
  });

  it('returns null when there is no pending project, an unknown project, or no membership', () => {
    expect(selectPendingProjectPrompt(stateWith({ pendingProjectId: null }))).toBeNull();
    expect(selectPendingProjectPrompt(stateWith({ pendingProjectId: 'ghost' }))).toBeNull();
    expect(selectConversationProjectPrompt(stateWith(), 'unknown-conversation')).toBeNull();
  });

  it('keeps that project memories survive the scope filter once the projectId is supplied', () => {
    const memories = [
      memory(1, 'global', undefined),
      memory(2, 'project', 'project-memories-only'),
      memory(3, 'project', 'another-project'),
    ];
    const selection = selectPendingProjectPrompt(stateWith());

    // 拿到 projectId：本项目记忆入选。
    expect(
      filterMemoriesByProjectScope(memories, selection?.projectId).map((item) => item.id),
    ).toEqual([1, 2]);
    // 丢掉 projectId（修复前的首条行为）：项目记忆整批被过滤。
    expect(filterMemoriesByProjectScope(memories, null).map((item) => item.id)).toEqual([1]);
  });

  it('renders the instruction block in the released format', () => {
    expect(formatProjectPromptContext({
      projectId: 'p',
      projectName: 'Alpha',
      instructions: 'Keep it short.',
    })).toBe([
      '## Project Context',
      'Project: Alpha',
      '',
      '### Project Instructions',
      'Keep it short.',
    ].join('\n'));
  });
});