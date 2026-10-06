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
 */

export const ZAI_AUTH_STORAGE_KEY = 'zaiCachedAuth';

export interface ZaiAuth {
  token: string;
  userId: string | null;
  feVersion: string | null;
  deviceId: string | null;
  /** 记录时间（ms）。 */
  capturedAt: number;
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

export async function loadZaiAuthFromStorage(
  timeoutMs?: number,
): Promise<ZaiAuth | null> {
  const read = (async (): Promise<ZaiAuth | null> => {
    const data = await chrome.storage.local.get(ZAI_AUTH_STORAGE_KEY) as Record<string, unknown>;
    const value = data[ZAI_AUTH_STORAGE_KEY] as ZaiAuth | undefined;
    return normalizeZaiAuth(value ?? null);
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

export async function saveZaiAuthToStorage(auth: ZaiAuth): Promise<boolean> {
  const normalized = normalizeZaiAuth(auth);
  if (!normalized?.token) return false;
  try {
    await chrome.storage.local.set({ [ZAI_AUTH_STORAGE_KEY]: normalized });
    return true;
  } catch {
    return false;
  }
}

export async function clearZaiAuthFromStorage(): Promise<void> {
  try {
    await chrome.storage.local.remove(ZAI_AUTH_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 把 content script 捕获到的零散字段合并进 storage 里的 auth（不覆盖新捕获 token 之外的旧字段）。
 * 只在捕获到 token 时才写 —— 写不进不影响功能：fetch hook 那条捕获链会在下一次请求时再写，
 * 内容脚本启动时也会主动推一次页面 localStorage 的 token。
 */
export async function mergeZaiAuthFromCapture(capture: ZaiAuthCaptureInput): Promise<boolean> {
  const token = firstNonEmpty(capture.token);
  if (!token) return false;
  const existing = await loadZaiAuthFromStorage();
  const next: ZaiAuth = {
    token,
    userId: firstNonEmpty(capture.userId) ?? existing?.userId ?? readZaiUserIdFromToken(token),
    feVersion: firstNonEmpty(capture.feVersion) ?? existing?.feVersion ?? null,
    deviceId: firstNonEmpty(capture.deviceId) ?? existing?.deviceId ?? null,
    capturedAt: Date.now(),
    expiresAt: existing?.expiresAt ?? null,
  };
  return saveZaiAuthToStorage(next);
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
  const parts = token.split('.');
  if (parts.length < 2) return null;
  let decoded: string;
  try {
    decoded = base64UrlDecode(parts[1]);
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(decoded) as { id?: unknown };
    return firstNonEmpty(payload?.id);
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