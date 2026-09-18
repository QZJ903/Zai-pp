const GLM_DEFAULT_TITLE_SUFFIX = '探索未至之境';
const GLM_DEFAULT_TITLE = new RegExp(`^GLM\\s*[-|]\\s*${GLM_DEFAULT_TITLE_SUFFIX}$`, 'i');

export const PROJECT_UNTITLED_CONVERSATION = 'Untitled conversation';

export function isDefaultGLMConversationTitle(value: string): boolean {
  return GLM_DEFAULT_TITLE.test(value.trim());
}

export function isPlaceholderProjectConversationTitle(value: string): boolean {
  const title = value.trim();
  return title === PROJECT_UNTITLED_CONVERSATION || isDefaultGLMConversationTitle(title);
}

export function isUsableProjectConversationTitle(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const title = value.trim();
  return title.length > 0 && !isPlaceholderProjectConversationTitle(title);
}
