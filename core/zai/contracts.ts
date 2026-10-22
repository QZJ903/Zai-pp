/**
 * Zai++ (zai-plus-plus → z.ai) 协议常量。
 *
 * 站点定义、路由、签名密钥、时间窗、SSE envelope/phase 命名，以及 agent 模式的
 * 标志位。所有值均来自真机抓包。
 */

/** z.ai 的站点标识。 */
export type ZaiSiteId = 'cn' | 'global';

/** 一个站点的全部站点相关地址。三者的取值必须同源，所以放在一档里。 */
export interface ZaiSiteDefinition {
  readonly id: ZaiSiteId;
  /** 站点的 origin（**精确值**，判信任时按相等比对，绝不做后缀匹配）。 */
  readonly origin: string;
  /** 站点主页（带尾斜杠）：自动化「新对话」时找/开的目标标签页。 */
  readonly homeUrl: string;
  /** 该站标签页的匹配模式（`chrome.tabs.query` / 广播筛选共用）。 */
  readonly tabUrlPattern: string;
}

/**
 * 站点表。
 *
 * ⚠️ **两个站点跑的是同一份前端产物**（同一个 CDN 路径下的 `prod-fe-*` 资源），
 * 路由 / 请求体形状 / 历史端点形状 / DOM 锚点**逐项同构**；差异只有
 * `enable_captcha`（国区站 false）、登录方式、以及页面自己给同源请求加的 `x-region`。
 * ⇒ 适配的实质是「认两个 origin」，不是「维护两套适配层」。
 *
 * ⚠️ **`origin` 是精确值**：判「这个请求/标签页是不是我们的站」一律走
 * `isZaiSiteOrigin`（集合相等），**不要写成 `endsWith('.z.ai')`** ——
 * 站点自己有 `zcode.z.ai`、`space-z.ai` 之类的同域子站，后缀匹配会把信任范围
 * 从「两个站」放大到「整个 z.ai 域」。
 */
export const ZAI_SITES: Readonly<Record<ZaiSiteId, ZaiSiteDefinition>> = {
  cn: {
    id: 'cn',
    origin: 'https://zchat.z.ai',
    homeUrl: 'https://zchat.z.ai/',
    tabUrlPattern: '*://zchat.z.ai/*',
  },
  global: {
    id: 'global',
    origin: 'https://chat.z.ai',
    homeUrl: 'https://chat.z.ai/',
    tabUrlPattern: '*://chat.z.ai/*',
  },
};

/**
 * **默认站点**（国区站）。
 *
 * ⚠️ **它只服务「没有页面上下文」的场景**：手里只有一个会话 id，不知道它属于哪个站时
 * 按它兜底。**有页面上下文的链路一律按当前页 origin 就地判定**，不许读这个常量
 * （否则在国际站上跑的内容脚本会去拼国区站的链接）。
 *
 * ⚠️ 选国区站作默认的理由是**用户的实际网络**：国内访问 `chat.z.ai` 会被导流到国区站，
 * 所以「默认」应当与用户真正会落到的那个站一致。
 */
export const ZAI_DEFAULT_SITE_ID: ZaiSiteId = 'cn';

/** 两个站点的 origin（顺序 = 黄金顺序，仅用于展示与遍历；判据一律走集合相等）。 */
export const ZAI_WEB_ORIGINS: readonly string[] = [ZAI_SITES.cn.origin, ZAI_SITES.global.origin];

/** 两个站点的 tab URL 匹配模式（广播 / `chrome.tabs.query` 要逐个模式查）。 */
export const ZAI_TAB_URL_PATTERNS: readonly string[] = [
  ZAI_SITES.cn.tabUrlPattern,
  ZAI_SITES.global.tabUrlPattern,
];

/** 把任意 origin / URL 归一成「站点 origin」；认不出的返回 null。 */
export function resolveZaiSiteOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    return null;
  }
  return ZAI_WEB_ORIGINS.includes(origin) ? origin : null;
}

/** 这个 origin / URL 是不是本站点集合里的一员。**精确相等，不做后缀匹配。** */
export function isZaiSiteOrigin(value: string | null | undefined): boolean {
  return resolveZaiSiteOrigin(value) !== null;
}

/** 由 origin / URL 反查站点定义；认不出的返回 null。 */
export function resolveZaiSite(value: string | null | undefined): ZaiSiteDefinition | null {
  const origin = resolveZaiSiteOrigin(value);
  if (!origin) return null;
  return Object.values(ZAI_SITES).find((site) => site.origin === origin) ?? null;
}

/**
 * **默认站点**的 origin。
 *
 * ⚠️ **只给「没有页面上下文、且拿不到更具体归属」的兜底用** —— 详见
 * `ZAI_DEFAULT_SITE_ID` 的说明。有页面上下文的链路请用 `resolveZaiSite(location.origin)`。
 */
export const ZAI_WEB_ORIGIN = ZAI_SITES[ZAI_DEFAULT_SITE_ID].origin;

/** **默认站点**的主页（带尾斜杠）。同 `ZAI_WEB_ORIGIN` 的适用范围说明。 */
export const ZAI_HOME_URL = ZAI_SITES[ZAI_DEFAULT_SITE_ID].homeUrl;

/** **默认站点**的标签页匹配模式。同 `ZAI_WEB_ORIGIN` 的适用范围说明。 */
export const ZAI_TAB_URL_PATTERN = ZAI_SITES[ZAI_DEFAULT_SITE_ID].tabUrlPattern;

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
 *
 * ⚠️ **它不是本项目的凭据** —— 这个值是站点前端硬编码的常量，公开的参照实现里
 * 同值（zhipu-ai-proxy 的 `intl-sign.js`、GLM-Free-API 的 `zai.go`）。
 * 它随扩展下发给页面是**架构必然**：签名发生在页面主世界（`fetch-hook` 要给页面
 * 自己发出的请求补 `X-Signature`），任何在浏览器内代签的方案都避不开。
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
 * ⚠️ **面板自己的 DOM 靠它被认出来**（`core/zai/project-panel.ts` 把它绑成
 * `PANEL_BOUND_ATTR`，用于重挂时先卸旧的）。
 * ⚠️ 它**曾经还有一个用途**：让模式判定能把面板子树排除掉（面板的图标按钮激活时
 * 也写 `data-active`）。**那个用途已随模式判定一起删掉**（站点只剩 agent，
 * 见 `core/zai/mode.ts`）—— 但属性本身仍承重，**不能删**。
 */
export const ZAI_PROJECT_PANEL_ATTR = 'data-zpp-project-panel';

/**
 * 内容脚本用 `DOM_TASK_FAILED` 回传「用户主动停止」时带的错误码。
 *
 * ⚠️ **必须两处同源**：生产端（`zai.content.ts` 的 `terminateDomTaskAsStopped` 与
 * `CANCEL_DOM_TASK` handler）发它，判定端（`dom-task-coordinator` 的 `onFailed`）
 * 靠它把 `phase` 定成 `'cancelled'`。**两边各写一遍字面量就是「生产端与判定端
 * 各写一遍」的老形态** —— 改一处另一处不报错、只是那一档静默失效。
 */
export const ZAI_DOM_TASK_CANCELLED_CODE = 'cancelled';