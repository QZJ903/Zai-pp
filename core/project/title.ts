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

/**
 * z.ai 的**新建会话临时标题**。刚建出来的会话在侧边栏里先是这个名字，
 * **等真名到了才换掉**（真机观察）。
 *
 * 与 `PROJECT_UNTITLED_CONVERSATION` 同性质：它不是「名字」，是「还没有名字」。
 * 必须按占位处理，否则一旦被写进存储，既有值就不再是占位 —— 真名到了也换不进去
 * （表现：标题永远停在临时名）。
 *
 * ⚠️ **清单的取值来自页面自己的 i18n 资源**（线上 bundle 的 `New Chat` / `New Task`
 * 两条中文词条），不是凭空猜的同义词 —— 判定必须与页面写进 `chats/new` 的
 * `chat.title` 逐字一致。英文条目一律小写，匹配前会 `toLowerCase`。
 *
 * ⚠️ 这份清单是**真机观察**来的；若日后发现别的字面量，加进这里即可
 * （所有判定都走 `isPlaceholderProjectConversationTitle`，改一处就够）。
 */
const ZAI_NEW_CONVERSATION_PLACEHOLDERS = new Set([
  // 页面建会话时写进 `chat.title` 的正式临时名（`New Chat` / `New Task` 的中文词条）。
  '新聊天',
  '新任务',
  // 早前观察到的同义临时名：保留是为了兼容已经落库的旧记录 ——
  // 它们现在仍是占位串，才能被真名覆盖掉。
  '新会话',
  '新对话',
  'new chat',
  'new conversation',
  'new task',
]);

export const PROJECT_UNTITLED_CONVERSATION = 'Untitled conversation';

export function isDefaultZaiConversationTitle(value: string): boolean {
  return GLM_DEFAULT_TITLE.test(value.trim());
}

/** 站点默认标题也算占位（见 `ZAI_SITE_DEFAULT_TITLE` 的说明）。 */
export function isZaiSiteDefaultConversationTitle(value: string): boolean {
  return ZAI_SITE_DEFAULT_TITLE.test(value.trim());
}

/** 「新聊天 / 新任务」这类**建会话时的临时名**也算占位。 */
export function isZaiNewConversationPlaceholderTitle(value: string): boolean {
  return ZAI_NEW_CONVERSATION_PLACEHOLDERS.has(value.trim().toLowerCase());
}

export function isPlaceholderProjectConversationTitle(value: string): boolean {
  const title = value.trim();
  return title === PROJECT_UNTITLED_CONVERSATION
    || isDefaultZaiConversationTitle(title)
    || isZaiSiteDefaultConversationTitle(title)
    || isZaiNewConversationPlaceholderTitle(title);
}
