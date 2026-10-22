export type {
  CurrentZaiConversation,
  ProjectContext,
  ProjectContextCreateInput,
  ProjectContextState,
  ProjectContextUpdateInput,
  ProjectConversation,
  ProjectConversationInput,
  ProjectPromptContext,
} from './types';

export { PROJECT_CONTEXT_SCHEMA_VERSION } from './types';

export {
  createEmptyProjectContextState,
  decodeCurrentZaiConversation,
  decodeProjectContext,
  decodeProjectContextState,
  decodeProjectConversation,
} from './codec';

export {
  formatProjectPromptContext,
  selectConversationProjectPrompt,
  selectPendingProjectPrompt,
  type ProjectPromptSelection,
} from './prompt-context';

export {
  addConversationToProject,
  bindPendingProjectConversation,
  createProjectContext,
  stageDeleteProjectContextAndMemoriesAlreadyLocked,
  getProjectContextState,
  getProjectContextStateAlreadyLocked,
  getProjectForConversation,
  getProjectPromptContextForConversation,
  PROJECT_CONTEXT_STORAGE_KEY,
  refreshProjectConversation,
  removeConversationFromProject,
  setPendingProjectContext,
  updateProjectContext,
} from './store';
