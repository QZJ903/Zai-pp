import {
  DEFAULT_LOCALE_PREFERENCE,
  getBrowserLanguageCandidates,
  normalizeLocalePreference,
  resolveLocalePreference,
  type LocalePreference,
  type ResolvedLocaleState,
} from './runtime';

export const LOCALE_PREFERENCE_STORAGE_KEY = 'glm_pp_locale_preference';

/**
 * 读存储的上界（**可选**，由调用方显式传入才生效）。
 *
 * ⚠️ **必须有它**：扩展上下文半死时 `chrome.storage.local.get` 的 promise
 * **不是 reject，而是永不 settle** —— 调用方的 `try/catch` 接不到一个不落地的 promise。
 * 而 `getResolvedLocaleState` 是 `loadAndSyncRuntimeState` 的 `Promise.all` 里
 * **唯一一条可能抛/可能挂的腿**（其余七条走 `sendRuntimeMessage`，自带兜底）⇒
 * 它挂住会让**整个运行时状态同步永不返回**。
 *
 * ⚠️ **信号式上界（`AbortSignal.timeout`）对 storage 无效**，只能用竞速。
 * 与 `core/zai/auth.ts` 的 `AUTH_READ_TIMEOUT_MS` 同一形态、同一个理由。
 */
export const LOCALE_READ_TIMEOUT_MS = 5_000;

export async function getLocalePreference(timeoutMs?: number): Promise<LocalePreference> {
  const read = (async (): Promise<LocalePreference> => {
    const data = await chrome.storage.local.get(LOCALE_PREFERENCE_STORAGE_KEY) as Record<string, unknown>;
    return normalizeLocalePreference(data[LOCALE_PREFERENCE_STORAGE_KEY]);
  })().catch(() => DEFAULT_LOCALE_PREFERENCE);

  if (timeoutMs === undefined) return read;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<LocalePreference>((resolve) => {
    timer = setTimeout(() => resolve(DEFAULT_LOCALE_PREFERENCE), timeoutMs);
  });
  try {
    // ⚠️ 超时只是**不再等**，底层那次 `storage.get` 仍悬着（storage API 没有取消手段）。
    return await Promise.race([read, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function saveLocalePreference(preference: LocalePreference): Promise<LocalePreference> {
  const normalized = normalizeLocalePreference(preference);
  if (normalized === DEFAULT_LOCALE_PREFERENCE) {
    await chrome.storage.local.remove(LOCALE_PREFERENCE_STORAGE_KEY);
    return normalized;
  }
  await chrome.storage.local.set({ [LOCALE_PREFERENCE_STORAGE_KEY]: normalized });
  return normalized;
}

export async function getResolvedLocaleState(
  timeoutMs?: number,
  browserLanguages = getBrowserLanguageCandidates(),
): Promise<ResolvedLocaleState> {
  const preference = await getLocalePreference(timeoutMs);
  return resolveLocalePreference(preference, browserLanguages);
}

export function watchLocalePreference(
  listener: (preference: LocalePreference) => void,
): () => void {
  const handleChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName !== 'local') return;
    if (!(LOCALE_PREFERENCE_STORAGE_KEY in changes)) return;
    listener(normalizeLocalePreference(changes[LOCALE_PREFERENCE_STORAGE_KEY].newValue));
  };

  chrome.storage.onChanged.addListener(handleChange);
  return () => chrome.storage.onChanged.removeListener(handleChange);
}
