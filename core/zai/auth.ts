/**
 * z.ai 认证（token / user_id / fe 版本 / 设备指纹）的持久化。
 *
 * DOM 注入方案下，认证信息不再由后台自包含生成 guest token
 * （generateGuestZaiAuth / readZaiFeVersion 已删除），只来自：
 *
 *   1. content script 从主世界 fetch hook 捕获的现场（query 里的 token/user_id、
 *      header 里的 Authorization / X-FE-Version / x-device-id）写进 chrome.storage.local；
 *   2. 页面 localStorage 里的 `token`（REFRESH_ZAI_AUTH 时由隔离世界兜底读取）。
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

export async function loadZaiAuthFromStorage(): Promise<ZaiAuth | null> {
  try {
    const data = await chrome.storage.local.get(ZAI_AUTH_STORAGE_KEY) as Record<string, unknown>;
    const value = data[ZAI_AUTH_STORAGE_KEY] as ZaiAuth | undefined;
    return normalizeZaiAuth(value ?? null);
  } catch {
    return null;
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
 * 只在捕获到 token 时才写；写不进则留给 REFRESH_ZAI_AUTH 的 localStorage 兜底。
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