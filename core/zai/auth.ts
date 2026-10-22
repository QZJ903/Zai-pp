/**
 * z.ai 认证（token / user_id / fe 版本 / 设备指纹）的持久化。
 *
 * DOM 注入方案下，认证信息不再由后台自包含生成 guest token
 * （generateGuestZaiAuth / readZaiFeVersion 已删除），只来自：
 *
 *   1. content script 从主世界 fetch hook 捕获的现场（query 里的 token/user_id、
 *      header 里的 Authorization / X-FE-Version / x-device-id）写进 chrome.storage.local；
 *   2. 页面 localStorage 里的 `token` —— 由内容脚本在**启动时**主动读一次并推进 storage
 *      （`refreshZaiAuth`），不等用户发出第一条消息。
 *
 * 注意：auth 只读写入扩展自己的 chrome.storage.local，绝不改写页面 storage。
 *
 * ## 为什么按站点分桶
 *
 * z.ai 有两个站点（`zchat.z.ai` 国区站 / `chat.z.ai` 国际站），跑同一份前端产物，
 * 但**两站的 token 互相不认**（跨站请求是 401）。`chrome.storage.local` 是扩展级共享的，
 * 而两站的页面 `localStorage` 各自独立 ⇒ 只有一份 token 时，后加载的那一站会把
 * 另一站的 token 覆盖掉，另一站读回来必然 401。
 *
 * 所以每个站点一个 storage key。**写入侧按捕获页面的 origin 分桶**
 * —— 内容脚本就在页面上，`location.origin` 是这件事的 ground truth，不需要任何推断。
 *
 * ⚠️ **分桶必须是一桶一个 key，不能把 `{ [origin]: ZaiAuth }` 装进一个 key**：
 * 两站各有一个内容脚本实例、各有独立的模块内存，而 `chrome.storage.local.set` 是
 * **整键替换**——若同写一个键，就是「读整张表 → 改自己那格 → 写回整张表」，
 * 两个实例会互相覆盖（后写者把先写者那格吞掉）。一桶一个 key 时各自写各自的键，
 * 天然不存在这个竞争。
 */

import { ZAI_DEFAULT_SITE_ID, ZAI_SITES, resolveZaiSite } from './contracts';

/**
 * 分桶之前的**单槽** auth 键。
 *
 * ⚠️ **仍然要读它**，且它**永不删除** —— 见 `loadZaiAuthFromStorage` 的兼容分支。
 * 现有用户的登录态就存在这里，分桶之后它是「目标站的桶还没有值时」的来源。
 */
export const ZAI_AUTH_STORAGE_KEY = 'zaiCachedAuth';

/** 分桶 auth 键的前缀；完整键是 `zaiCachedAuth:<siteId>`。 */
export const ZAI_AUTH_SITE_STORAGE_KEY_PREFIX = 'zaiCachedAuth:';

/**
 * 某个站点的 auth 存储键。认不出站点时按**默认站**收口（与 `ZAI_DEFAULT_SITE_ID` 同口径）。
 *
 * ⚠️ **这个收口只服务读侧** —— 读的时候总得有一个键去查，而「拼出一个站点表之外的键」
 * 等于永远读不回（静默空值）。写侧**不跟着收口**：`saveZaiAuthToStorage` 会先自己
 * `resolveZaiSite` 判一次，认不出就拒写，避免把别站的 token 写进默认站的桶。
 */
export function zaiAuthStorageKeyForSite(siteOrigin: string): string {
  const site = resolveZaiSite(siteOrigin) ?? ZAI_SITES[ZAI_DEFAULT_SITE_ID];
  return `${ZAI_AUTH_SITE_STORAGE_KEY_PREFIX}${site.id}`;
}

export interface ZaiAuth {
  token: string;
  userId: string | null;
  /**
   * 页面 `prod-fe` 版本。**当前只有写侧**（捕获时存、merge 时保留旧值），没有地方读它：
   * 真正要用 fe 版本的地方走 `readFeVersion()`（从 `performance.getEntriesByType` 现读）。
   * 留着是因为它是捕获链的原始记录，且与上游 `ZaiAuth` 同构。
   */
  feVersion: string | null;
  /** 页面 `x-device-id`。同样只有写侧，理由见 `feVersion`。 */
  deviceId: string | null;
  /** 记录时间（ms）。 */
  capturedAt: number;
  /**
   * token 过期时间。**当前没有消费者** —— 缓存里有 token 就一直用，没有「拿它做过期判断」
   * 这一步（上游同构）。⚠️ 所以 token 失效时的表现是「请求被服务端拒」，不是「提前刷新」。
   */
  expiresAt: number | null;
}

export interface ZaiAuthCaptureInput {
  token?: string | null;
  userId?: string | null;
  feVersion?: string | null;
  deviceId?: string | null;
}

// ---------------------------------------------------------------------------
// chrome.storage.local 读写
// ---------------------------------------------------------------------------

/**
 * 读存储的上界（**可选**，由调用方显式传入才生效）。
 *
 * ⚠️ **必须有它**：扩展上下文半死时 `chrome.storage.local.get` 的 promise
 * **不是 reject，而是永不 settle** —— 外层的 `try/catch` 接不到一个不落地的 promise，
 * 于是所有 `await` 它的地方都会永久挂住。两个有 `inFlight` 槽位的调用方
 * （标题解析器、模型清单抓取器）会把槽位一直占着，之后每次触发都落「已跳过」分支、
 * **不会自愈**。信号式上界（`AbortSignal.timeout`）对 storage 无效，只能用竞速。
 *
 * ⚠️ **写路径刻意不传它** —— `mergeZaiAuthFromCapture` 要读旧记录再覆盖写，
 * 读到 null 会把 `userId` / `feVersion` / `deviceId` / `expiresAt` 一起写成 null。
 * 「读不到就当没有」对只取 token 的调用方是对的，对合并写是错的。
 *
 * 取值与 `conversation-title.ts` 的 `TITLE_REQUEST_TIMEOUT_MS` 同量级 ——
 * 那一处的 5 秒上界只盖住网络腿，这是它前面的那条腿。
 */
export const AUTH_READ_TIMEOUT_MS = 5_000;

/**
 * 读某个站点的登录态。**调用方必须显式给出站点** —— 这是「读到的 token 属于哪一站」
 * 的唯一依据（`siteOrigin` 省略时只会读到单槽兼容值，见下）。
 *
 * 取值顺序：
 *   1. **目标站自己的桶** —— 命中即返回，不看单槽（桶里的值来自该站页面，是 ground truth）；
 *   2. 桶没有值时读**单槽**（分桶之前的存量值），但要过一道**站点归属闸门**（见
 *      `legacyAuthMatchesSite`）—— 判得出属于别的站就返回 null，否则照用。
 *
 * ⚠️ **第 2 步不搬迁、不删除单槽**：它是一道只读兜底，不是迁移步骤。写入永远只写
 * 目标站自己的桶，所以不存在「搬迁写入与分桶写入抢同一个键」这种问题。
 * 单槽的实际作用窗口很短 —— 页面一刷新，`refreshZaiAuth` 就会把该站页面的 token
 * 写进它自己的桶，之后读路径根本不会走到单槽。
 */
export async function loadZaiAuthFromStorage(
  timeoutMs?: number,
  siteOrigin?: string,
): Promise<ZaiAuth | null> {
  const read = (async (): Promise<ZaiAuth | null> => {
    const siteKey = siteOrigin ? zaiAuthStorageKeyForSite(siteOrigin) : null;
    // 两个键一次取回：多一次往返没有收益，且分两次读会拉大「两次读之间站点变了」的窗口。
    const keys = siteKey ? [siteKey, ZAI_AUTH_STORAGE_KEY] : [ZAI_AUTH_STORAGE_KEY];
    const data = await chrome.storage.local.get(keys) as Record<string, unknown>;
    if (siteKey) {
      const siteAuth = normalizeZaiAuth(data[siteKey] ?? null);
      if (siteAuth) return siteAuth;
    }
    const legacy = normalizeZaiAuth(data[ZAI_AUTH_STORAGE_KEY] ?? null);
    if (!legacy) return null;
    if (!siteOrigin) return legacy;
    return legacyAuthMatchesSite(legacy, siteOrigin) ? legacy : null;
  })().catch(() => null);

  if (timeoutMs === undefined) return read;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    // ⚠️ 超时只是**不再等**，底层那次 `storage.get` 仍悬着（storage API 没有取消手段）。
    // 这是有意的：让它自己落地、被 GC 回收，好过为它引入一套取消协议。
    return await Promise.race([read, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 写某个站点的登录态。**站点必填**，且**认不出的站点一律拒写**（返回 false）。
 *
 * ⚠️ **拒写而不是落默认桶**：`zaiAuthStorageKeyForSite` 对认不出的 origin 会收口到默认站
 * （读侧需要那个行为，否则会拼出一个永远读不回的键），但**写侧不能跟着收口** ——
 * 那会把一个别站的 token 写进默认站的桶里，让默认站读到一个不属于它的 token。
 * 拒写的最坏结果只是「这次没写进去」（调用方本来就不看返回值，见下），
 * 而落默认桶的结果是**污染另一个站**。
 *
 * ⚠️ **返回 false 现在有两种来源**：① 记录里没有可用 token；② 认不出站点。
 * 唯一的返回值消费者是内容脚本的 `REFRESH_ZAI_AUTH` 分支（把它当 `hasToken` 回给后台），
 * 而那个分支当前无人发送 —— 但仍要注意别把 false 一律读成「没 token」。
 */
export async function saveZaiAuthToStorage(
  auth: ZaiAuth,
  siteOrigin: string,
): Promise<boolean> {
  const normalized = normalizeZaiAuth(auth);
  if (!normalized?.token) return false;
  const site = resolveZaiSite(siteOrigin);
  if (!site) return false;
  try {
    await chrome.storage.local.set({ [zaiAuthStorageKeyForSite(site.origin)]: normalized });
    return true;
  } catch {
    return false;
  }
}

/**
 * 把 content script 捕获到的零散字段合并进**该站桶**里的 auth
 * （不覆盖新捕获 token 之外的旧字段）。
 * 只在捕获到 token 时才写 —— 写不进不影响功能：fetch hook 那条捕获链会在下一次请求时再写，
 * 内容脚本启动时也会主动推一次页面 localStorage 的 token。
 *
 * ⚠️ **旧字段的来源是「本桶，桶为空时退到单槽」** —— 这里调的就是
 * `loadZaiAuthFromStorage`，而它的取值顺序是「本桶 → 单槽（过归属闸门）」
 * ⇒ **本桶还没有值时会从单槽取**。写的时候要如实知道这一点：
 *
 * ⚠️⚠️ **桶空 + 单槽是别站的访客 token 时，别站的 `userId` / `feVersion` / `deviceId` /
 * `expiresAt` 会被带进本桶**（访客一律放行，见 `legacyAuthMatchesSite`）。
 * 这几个字段目前没有任何读侧消费者（只有 `token` 被读），所以后果是脏数据而不是错误行为；
 * 且触发条件很窄 —— 只在该站桶从未被写过、而单槽恰好有值时成立，页面一加载
 * `refreshZaiAuth` 就会把本桶填上，之后读路径不再碰单槽。
 * ⚠️ **要收紧就得让这次读「只看本桶」**，而那会与「单槽作为迁移兜底、不被改写」的
 * 口径分叉 —— 动手前先确认那几个字段真有人读。
 */
export async function mergeZaiAuthFromCapture(
  capture: ZaiAuthCaptureInput,
  siteOrigin: string,
): Promise<boolean> {
  const token = firstNonEmpty(capture.token);
  if (!token) return false;
  // ⚠️ 这一次读**刻意不带任何上界**：它是「读旧记录再覆盖写」，
  // 读到 null 会把下面的字段一起写成 null。
  const existing = await loadZaiAuthFromStorage(undefined, siteOrigin);
  const next: ZaiAuth = {
    token,
    userId: firstNonEmpty(capture.userId) ?? existing?.userId ?? readZaiUserIdFromToken(token),
    feVersion: firstNonEmpty(capture.feVersion) ?? existing?.feVersion ?? null,
    deviceId: firstNonEmpty(capture.deviceId) ?? existing?.deviceId ?? null,
    capturedAt: Date.now(),
    expiresAt: existing?.expiresAt ?? null,
  };
  return saveZaiAuthToStorage(next, siteOrigin);
}

export function normalizeZaiAuth(raw: unknown): ZaiAuth | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<ZaiAuth>;
  const token = firstNonEmpty(value.token);
  if (!token) return null;
  return {
    token,
    userId: firstNonEmpty(value.userId) ?? readZaiUserIdFromToken(token),
    feVersion: firstNonEmpty(value.feVersion),
    deviceId: firstNonEmpty(value.deviceId),
    capturedAt: finiteNumber(value.capturedAt) ?? 0,
    expiresAt: finiteNumber(value.expiresAt),
  };
}

/**
 * 从 JWT 里解出 user id（`id` claim），与 GLM-Free-API 的 decodeJWT 对齐，
 * 只用于「只拿到 token、没拿到 user_id」的兜底。
 */
export function readZaiUserIdFromToken(token: string): string | null {
  const payload = decodeZaiTokenPayload(token);
  return firstNonEmpty(payload?.id);
}

// ---------------------------------------------------------------------------
// 单槽值的站点归属
// ---------------------------------------------------------------------------

/**
 * 子域名以 `guest.` 开头即访客邮箱。
 *
 * ⚠️ **必须大小写不敏感，且盯着域名而不是本地部分前缀** —— 真机抓到的 guest 邮箱是
 * `Guest-…@guest.com`（**首字母大写**），按小写 `guest-` 前缀判会漏判。
 */
const ZAI_GUEST_EMAIL_RE = /@guest\.com$/i;

/**
 * 单槽里的 token 能不能算作 `siteOrigin` 那一站的。
 *
 * 依据是 JWT 的 `region` claim：`"cn"` 属国区站、`"global"` 属国际站。
 * 但**判定前必须先排除访客**：实测国区站的 guest token 也是 `region: "global"`，
 * 而它在国区站是能用的 —— 拿 `region` 硬判会把国区站自己的 guest 挡掉。
 *
 * ⚠️ **认不出就放行**（返回 true）：解不出 claim、邮箱是访客、`region` 缺失或值不认识时
 * 一律照用。放行的代价只是「用了别站的 token → 服务端 401 → 该链路降级」，
 * 而拦截的代价是「国区站自己的 guest 被误杀」。两者都安全，选误伤更小的那一侧。
 *
 * ⚠️ **`region` 只在这条只读兜底里用，绝不当「这个 token 能不能用于这一站」的门** ——
 * 运行时的唯一依据是**捕获页面的 origin**（写入侧的分桶）。
 */
function legacyAuthMatchesSite(auth: ZaiAuth, siteOrigin: string): boolean {
  const site = resolveZaiSite(siteOrigin);
  if (!site) return true;
  const payload = decodeZaiTokenPayload(auth.token);
  if (!payload) return true;
  const email = firstNonEmpty(payload.email);
  if (email && ZAI_GUEST_EMAIL_RE.test(email)) return true;
  const region = firstNonEmpty(payload.region);
  if (region === 'cn') return site.id === 'cn';
  if (region === 'global') return site.id === 'global';
  return true;
}

/** 解出 JWT 的 payload（第二段）。解不出返回 null。 */
function decodeZaiTokenPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  let decoded: string;
  try {
    decoded = base64UrlDecode(parts[1]);
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(decoded) as unknown;
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  let result = '';
  for (let i = 0; i < binary.length; i += 1) {
    result += String.fromCharCode(binary.charCodeAt(i));
  }
  return decodeURIComponent(
    result.split('').map((char) => (
      `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`
    )).join(''),
  );
}

function firstNonEmpty(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}