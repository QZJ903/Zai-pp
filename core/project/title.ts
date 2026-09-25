const GLM_DEFAULT_TITLE_SUFFIX = '探索未至之境';
const GLM_DEFAULT_TITLE = new RegExp(`^GLM\\s*[-|]\\s*${GLM_DEFAULT_TITLE_SUFFIX}$`, 'i');

/**
 * z.ai 的**站点默认标题**（`Z.ai - Advanced AI Chatbot & Agent powered by …`）。
 *
 * 它**不随会话变** —— 所以一旦它以会话标题的身份进了存储，说明当初取的是
 * `document.title` 而不是侧边栏那行的真实名字。按占位标题处理有两个作用：
 * 既不会被写进存储，也不会挡住后面拿到的真实标题。
 */
const ZAI_SITE_DEFAULT_TITLE = /^Z\.?\s*ai\s*[-|—]\s*advanced\s+ai\s+chatbot/i;

export const PROJECT_UNTITLED_CONVERSATION = 'Untitled conversation';

export function isDefaultGLMConversationTitle(value: string): boolean {
  return GLM_DEFAULT_TITLE.test(value.trim());
}

/** 站点默认标题也算占位（见 `ZAI_SITE_DEFAULT_TITLE` 的说明）。 */
export function isZaiSiteDefaultConversationTitle(value: string): boolean {
  return ZAI_SITE_DEFAULT_TITLE.test(value.trim());
}

export function isPlaceholderProjectConversationTitle(value: string): boolean {
  const title = value.trim();
  return title === PROJECT_UNTITLED_CONVERSATION
    || isDefaultGLMConversationTitle(title)
    || isZaiSiteDefaultConversationTitle(title);
}

export function isUsableProjectConversationTitle(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const title = value.trim();
  return title.length > 0 && !isPlaceholderProjectConversationTitle(title);
}
