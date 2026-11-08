import { getExtensionVersion } from './version';
import type { LocaleMessageKey } from './i18n';

export interface WhatsNewItem {
  id: string;
  titleKey: LocaleMessageKey;
}

export interface WhatsNewState {
  version: string;
  visible: boolean;
  pendingUpdate: boolean;
}

export const WHATS_NEW_ITEMS: WhatsNewItem[] = [
  { id: 'memory', titleKey: 'sidepanel.whatsNew.items.memory' },
  { id: 'skill', titleKey: 'sidepanel.whatsNew.items.skill' },
  { id: 'mcp', titleKey: 'sidepanel.whatsNew.items.mcp' },
  { id: 'browser-control', titleKey: 'sidepanel.whatsNew.items.browserControl' },
  { id: 'automation', titleKey: 'sidepanel.whatsNew.items.automation' },
];

const LAST_SEEN_VERSION_KEY = 'zai_pp_whats_new_dismissed_version';
const PENDING_UPDATE_VERSION_KEY = 'zai_pp_whats_new_pending_version';

export async function shouldShowWhatsNew(): Promise<boolean> {
  return (await getWhatsNewState()).visible;
}

export async function getWhatsNewState(): Promise<WhatsNewState> {
  const version = getExtensionVersion();
  const data = await chrome.storage.local.get([
    LAST_SEEN_VERSION_KEY,
    PENDING_UPDATE_VERSION_KEY,
  ]) as Record<string, unknown>;
  const pendingUpdate = data[PENDING_UPDATE_VERSION_KEY] === version;

  return {
    version,
    pendingUpdate,
    visible: pendingUpdate || data[LAST_SEEN_VERSION_KEY] !== version,
  };
}

export async function markWhatsNewPending(previousVersion?: string | null): Promise<void> {
  const version = getExtensionVersion();
  if (previousVersion === version) return;
  await chrome.storage.local.set({ [PENDING_UPDATE_VERSION_KEY]: version });
}

export async function hasPendingWhatsNew(): Promise<boolean> {
  return (await getWhatsNewState()).pendingUpdate;
}

/**
 * 清掉「有新版本」提示：记下已读版本、同时把待更新标记抹掉。
 *
 * ⚠️ **`set` + `remove` 两次调用无法合并** —— `chrome.storage` 没有「一次调用里
 * 既写又删」的 API，而两条命令打的是**不同的键**（`LAST_SEEN` 写入 / `PENDING` 删除），
 * 也不能靠「把 PENDING 写成非版本值」代替：那会永久留一个陈旧键，
 * 任何将来按 `'PENDING' in storage` 判的代码都会读出不同结论。
 *
 * ⚠️ 连带上 `WHATS_NEW_DISMISSED` 的 handler 还会调 `refreshWhatsNewBadge()`，
 * 它内部再读一次 storage ⇒ **这条命令最多串三次往返**。可以省掉第三次
 * （刚删完 PENDING，`pendingUpdate` 必然是 `false`），但那要把「已知状态」
 * 从 handler 一路传进 `background.ts` 的 `refreshWhatsNewBadge`，为一次
 * 「每个版本只点一次」的点击扩三处接口 —— 不划算。
 *
 * ⚠️ **失败方向是安全的**：任何一步失败都会让整条命令 rejection，
 * 用户看到「点了没反应」；不会出现「界面说关掉了、下次启动又弹」。
 */
export async function dismissWhatsNew(): Promise<void> {
  await chrome.storage.local.set({ [LAST_SEEN_VERSION_KEY]: getExtensionVersion() });
  await chrome.storage.local.remove(PENDING_UPDATE_VERSION_KEY);
}
