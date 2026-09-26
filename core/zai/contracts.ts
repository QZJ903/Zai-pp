/**
 * GLM++ (glm-plus-plus → chat.z.ai) 协议常量。
 *
 * 这些常量是把 glm-pp 骨架对接到 chat.z.ai 的「协议翻译层」的地基：
 * 域名、路由、签名密钥、时间窗、SSE envelope/phase 命名，以及 agent 模式的
 * 标志位。所有值均来自真机抓包。
 */

export const ZAI_WEB_ORIGIN = 'https://chat.z.ai';

/**
 * chat.z.ai 前端实际使用的两个可增强路由。
 * completion 是 agent/chat 共用的补全端点；chatNew 是首条消息前建的会话。
 */
export const ZAI_WEB_ROUTES = {
  completion: '/api/v2/chat/completions',
  chatNew: '/api/v1/chats/new',
} as const;

export type ZaiWebRouteName = keyof typeof ZAI_WEB_ROUTES;

/**
 * 签名密钥（intl-sign.js == zai.go，测试向量已交叉验证）。
 * 第二层 HMAC 的 key 是 wKey 的 hex 字符串本身（UTF-8 字节），不是解码字节。
 */
export const ZAI_SIGNATURE_SECRET = 'key-@@@@)))()((9))-xxxx&&&%%%%%';

/** 签名时间窗：5 分钟。timeSlot = floor(tsMs / 300000)。 */
export const ZAI_SIGNATURE_TIME_SLOT_MS = 300_000;

/** 扩展自己发的请求带此 header，fetch hook 见之即直通（防自钩）。 */
export const ZAI_BYPASS_HOOK_HEADER = 'X-ZAI-PP-Bypass-Hook';

/** chat 模式默认 model；agent 模式用 glm-5.2。 */
export const ZAI_MODEL_CHAT = 'x-preview-l';
export const ZAI_MODEL_AGENT = 'glm-5.2';

/** agent 模式没有单独端点，靠 features.flags / chats/new.type 的这个标志区分。 */
export const ZAI_AGENT_FLAG = 'general_agent';

/** SSE envelope：每条 `data: {"type":"chat:completion","data":{"phase":...}}`。 */
export const ZAI_SSE_ENVELOPE_TYPE = 'chat:completion';

/** 输入框选择器。发送链、背景应用层都读它，只在这一处定义。 */
export const ZAI_CHAT_INPUT_SELECTOR = '#chat-input';

/**
 * SSE phase 全集。thinking/answer 带文本三语义；tool_call/tool_response 只在
 * agent 模式出现（服务端沙箱工具，扩展本地不劫持）；done 收尾。
 */
export const ZAI_SSE_PHASES = [
  'thinking',
  'answer',
  'tool_call',
  'tool_response',
  'other',
  'search',
  'done',
] as const;

export type ZaiSsePhase = (typeof ZAI_SSE_PHASES)[number] | (string & {});

/** main-world ↔ isolated postMessage 协议的消息源标识。 */
export const ZAI_MSG_SOURCE = 'zai-pp';

/** 扩展在 DOM/数据属性上暴露的诊断锚点（续跑状态机 + 面板）。 */
export const ZAI_DIAG_LOOP_ATTR = 'data-glmpp-agent-loop';
export const ZAI_DIAG_STEP_ATTR = 'data-glmpp-agent-step';
export const ZAI_DIAG_LOOP_CHECK_ATTR = 'data-glmpp-loop-check';
export const ZAI_DIAG_TOOL_RESULT_ATTR = 'data-glmpp-tool-result';
export const ZAI_DIAG_GLOBAL = '__GLMPP_DIAG__';

/**
 * 侧边栏「项目」面板的标记属性（面板根节点与项目 section 都带）。
 *
 * ⚠️ **放这里是为了让模式判定能排除面板子树**：面板的图标按钮激活时也写
 * `data-active`，而 `readZaiSidebarAgentMode` 取的是「`#sidebar` 里带 `data-active`
 * 的第 2 个按钮」——不排除就会读到面板自己的按钮（见 `core/zai/mode.ts`）。
 * 两处各写一遍属性名就是「生产端与判定端各写一遍」。
 */
export const ZAI_PROJECT_PANEL_ATTR = 'data-dpp-project-panel';