/**
 * GLM++ (glm-plus-plus → chat.z.ai) 协议常量。
 *
 * 这些常量是把 glm-pp 骨架对接到 chat.z.ai 的「协议翻译层」的地基：
 * 域名、路由、签名密钥、时间窗、SSE envelope/phase 命名，以及 agent 模式的
 * 标志位。所有值均来自真机抓包。
 */

export const ZAI_WEB_ORIGIN = 'https://chat.z.ai';

/** chat.z.ai 主页（带尾斜杠）：自动化「新对话」时找/开的目标标签页。 */
export const ZAI_HOME_URL = 'https://chat.z.ai/';

/** chat.z.ai 标签页的匹配模式（`chrome.tabs.query` / 广播筛选共用的唯一来源）。 */
export const ZAI_TAB_URL_PATTERN = '*://chat.z.ai/*';

/**
 * chat.z.ai 前端实际使用的路由。
 *
 * 两类，**判据不同**（见 `request-codec.ts` 的两份名单）：
 * - **可增强**（`completion` / `chatNew`）：请求体里有提示词，我们要注入。
 * - **历史**（`chatDetail` / `chatMessages`）：响应体里有**我们注入过的文本**与
 *   模型吐的工具 XML，我们要剥掉。它们**不可增强** —— 请求体里没有提示词。
 *
 * ⚠️ **`{id}` 是变量段**（会话 id）。匹配时展开成「单个路径段」，并排除若干已知
 * 字面量段 —— 见 `request-codec.ts` 的 `ZAI_CHAT_ID_LITERAL_SEGMENTS`。
 */
export const ZAI_WEB_ROUTES = {
  completion: '/api/v2/chat/completions',
  chatNew: '/api/v1/chats/new',
  chatDetail: '/api/v1/chats/{id}',
  chatMessages: '/api/v1/chats/{id}/messages/batch',
} as const;

export type ZaiWebRouteName = keyof typeof ZAI_WEB_ROUTES;

/**
 * **可增强**路由的白名单。
 *
 * ⚠️⚠️ **路由匹配 ≠ 该增强** —— 这两件事必须分开。历史上它们是隐含合一的
 * （`matchZaiWebRoute` 匹配上就进增广分支），而加进历史路由后那样会**当场打碎请求**：
 * `POST /api/v1/chats/{id}/messages/batch` 的 body 是 `{"ids":[…]}`，
 * 内容脚本那边只认 `chatNew`、其余一律当 `completion` ⇒ `rewriteZaiLastUserMessage`
 * 会**无条件写上 `signature_prompt`** ⇒ body 变成 `{"ids":[…],"signature_prompt":"<两万字>"}`。
 *
 * ⚠️ **`AUGMENT_REQUEST_BODY` 在桥的豁免表里**（逐字段取值 + 默认值），未知 route
 * 会静默落到 `'completion'` ⇒ **这份名单是唯一那道门**。
 */
export const ZAI_AUGMENTABLE_WEB_ROUTES = [
  'completion',
  'chatNew',
] as const;

export type ZaiAugmentableWebRoute = (typeof ZAI_AUGMENTABLE_WEB_ROUTES)[number];

/** **历史**路由：响应体要剥掉内部文本与工具 XML，请求不增强。 */
export const ZAI_HISTORY_WEB_ROUTES = [
  'chatDetail',
  'chatMessages',
] as const;

export type ZaiHistoryWebRoute = (typeof ZAI_HISTORY_WEB_ROUTES)[number];

/**
 * 签名密钥（intl-sign.js == zai.go，测试向量已交叉验证）。
 * 第二层 HMAC 的 key 是 wKey 的 hex 字符串本身（UTF-8 字节），不是解码字节。
 */
export const ZAI_SIGNATURE_SECRET = 'key-@@@@)))()((9))-xxxx&&&%%%%%';

/** 签名时间窗：5 分钟。timeSlot = floor(tsMs / 300000)。 */
export const ZAI_SIGNATURE_TIME_SLOT_MS = 300_000;

/** 扩展自己发的请求带此 header，fetch hook 见之即直通（防自钩）。 */
export const ZAI_BYPASS_HOOK_HEADER = 'X-ZAI-PP-Bypass-Hook';

/** agent 模式没有单独端点，靠 features.flags / chats/new.type 的这个标志区分。 */
export const ZAI_AGENT_FLAG = 'general_agent';

/** SSE envelope：每条 `data: {"type":"chat:completion","data":{"phase":...}}`。 */
export const ZAI_SSE_ENVELOPE_TYPE = 'chat:completion';

/** 输入框选择器。发送链、背景应用层都读它，只在这一处定义。 */
export const ZAI_CHAT_INPUT_SELECTOR = '#chat-input';

/**
 * SSE phase 的已知取值：`thinking` / `answer` 带文本三语义；`tool_call` /
 * `tool_response` 只在 agent 模式出现（服务端沙箱工具，扩展本地不劫持）；`done` 收尾。
 *
 * ⚠️ **只是个联合类型，没有运行时数组** —— 判 phase 的地方一律**按形状识别、不按取值过滤**
 * （见 `core/zai/stream-codec.ts` 的三条判据），所以这份清单的用途是**文档与类型提示**，
 * 不是校验表；末尾那个 `(string & {})` 表示服务端新增相位时不报错。
 */
export type ZaiSsePhase =
  | 'thinking'
  | 'answer'
  | 'tool_call'
  | 'tool_response'
  | 'other'
  | 'search'
  | 'done'
  | (string & {});

/** main-world ↔ isolated postMessage 协议的消息源标识。 */
export const ZAI_MSG_SOURCE = 'zai-pp';

/**
 * 侧边栏「项目」面板的标记属性（面板根节点与项目 section 都带）。
 *
 * ⚠️ **放这里是为了让模式判定能排除面板子树**：面板的图标按钮激活时也写
 * `data-active`，而 `readZaiSidebarAgentMode` 取的是「`#sidebar` 里带 `data-active`
 * 的第 2 个按钮」——不排除就会读到面板自己的按钮（见 `core/zai/mode.ts`）。
 * 两处各写一遍属性名就是「生产端与判定端各写一遍」。
 */
export const ZAI_PROJECT_PANEL_ATTR = 'data-dpp-project-panel';

/**
 * 内容脚本用 `DOM_TASK_FAILED` 回传「用户主动停止」时带的错误码。
 *
 * ⚠️ **必须两处同源**：生产端（`zai.content.ts` 的 `terminateDomTaskAsStopped` 与
 * `CANCEL_DOM_TASK` handler）发它，判定端（`dom-task-coordinator` 的 `onFailed`）
 * 靠它把 `phase` 定成 `'cancelled'`。**两边各写一遍字面量就是「生产端与判定端
 * 各写一遍」的老形态** —— 改一处另一处不报错、只是那一档静默失效。
 */
export const ZAI_DOM_TASK_CANCELLED_CODE = 'cancelled';