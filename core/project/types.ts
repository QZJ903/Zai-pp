export const PROJECT_CONTEXT_SCHEMA_VERSION = 2 as const;

export interface ProjectContext {
  id: string;
  name: string;
  description: string;
  instructions: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectConversation {
  conversationId: string;
  projectId: string;
  title: string;
  url: string;
  addedAt: number;
  lastSeenAt: number;
  /**
   * 标题是**用户手动改过**的。为真时，后续从页面回填的自动标题一律不覆盖它
   * （自动回填每轮都会跑，不加这道闸门的话手动改名下一轮就没了）。
   */
  titleEdited?: boolean;
}

export interface ProjectContextState {
  schemaVersion: typeof PROJECT_CONTEXT_SCHEMA_VERSION;
  projects: ProjectContext[];
  conversations: ProjectConversation[];
  pendingProjectId: string | null;
}

export interface ProjectContextCreateInput {
  name: string;
  description?: string;
  instructions?: string;
}

export interface ProjectContextUpdateInput {
  name?: string;
  description?: string;
  instructions?: string;
}

export interface ProjectConversationInput {
  conversationId: string;
  title?: string;
  url?: string;
  /** 这次是**用户手动改名**：标题按原样采用，并打上 `titleEdited` 闸门。 */
  titleEdited?: boolean;
}

export interface ProjectPromptContext {
  projectId: string;
  projectName: string;
  instructions: string;
}

export interface CurrentGLMConversation {
  conversationId: string;
  title: string;
  url: string;
}
