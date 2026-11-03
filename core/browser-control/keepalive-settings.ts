/**
 * 「后台保活」的用户开关。
 *
 * ## 这个开关管什么
 *
 * 管的是**会挂调试横幅的那条保活** —— 也就是 `chrome.debugger` + 两条 CDP 命令
 * （`Emulation.setFocusEmulationEnabled` / `Page.setWebLifecycleState: active`）。
 *
 * ⚠️ **它不承诺「不产生横幅的保活方式」** —— 将来若有了（例如把发送链改成
 * 事件驱动之后完全不需要挂 debugger），那条路与本开关无关、不受它抑制。
 * 本开关的语义就是「允不允许挂 debugger」。
 *
 * ## 为什么默认**关**
 *
 * 横幅是**全局可见**的（Chrome 走 `ShowGlobally`，不是只画在被调试的窗口），
 * 而「默认给用户一个会挂调试横幅的扩展」不合理 —— 知情权应该是显式选择，
 * 不是默认塞给他。
 *
 * ⚠️ **代价**：默认关 = 后台标签会被 Chrome 节流到每秒一次 ⇒ 发送链那几条短轮询
 * 超时 ⇒ 判 `unsent` ⇒ 续跑静默收尾（表现是「只打开了网页、没有后续」）。
 * 所以设置项的描述文案必须写清「关掉可能失败」，让用户知道自己在换什么。
 *
 * ⚠️ **另一层缓解**：发送链已经改成事件驱动（`core/zai/event-wait.ts`），
 * 定时器被压到每秒一次不再直接导致漏判 —— 见该模块头部的实测数据。
 * 也就是说「关掉」比改造前更安全，但仍不能保证长时间后台跑得完。
 *
 * ## ⚠️ 权限层面拿不掉
 *
 * `debugger` **不能**声明成 `optional_permissions`（Chrome 官方明确排除它，
 * 同批还有 `declarativeNetRequest` / `devtools` / `geolocation` / `proxy` 等）。
 * 也就是说：**这个开关控制的是行为，不是权限** —— 安装时那两条权限警告永远在。
 */

import { createSerialOperationQueue } from '../persistence/serial-operation-queue';

/** `chrome.storage.local` 的键。与 `zai_pp_browser_control_settings` 同一套命名。 */
export const TAB_KEEPALIVE_STORAGE_KEY = 'zai_pp_tab_keepalive_settings';

/**
 * 这一个存储键的写入串行队列（与 `settings.ts` 同因、**各自一条**）。
 *
 * ⚠️ `saveTabKeepaliveSettings` 同样是「读 → 合并 → 写」：两个侧边栏同时拨开关时，
 * 后写者会拿旧快照覆盖前者。与浏览器控制那个键共用一个队列没有意义 —— 两个键互不相干。
 */
const tabKeepaliveSettingsOperations = createSerialOperationQueue();

export interface TabKeepaliveSettings {
  /** 允不允许挂 `chrome.debugger` 做保活。 */
  enabled: boolean;
}

export const DEFAULT_TAB_KEEPALIVE_SETTINGS: TabKeepaliveSettings = {
  enabled: false,
};

/**
 * 归一化。
 *
 * ⚠️ **缺省与非法值都回落 `false`**—— 与 `DEFAULT_*` 一致。
 * 这条判据的取向是「**默认不做会打扰用户的事**」：读不到就当成用户没开过，
 * 而不是替他打开一条会挂调试横幅的通道。
 */
export function normalizeTabKeepaliveSettings(input: unknown): TabKeepaliveSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_TAB_KEEPALIVE_SETTINGS };
  }
  const partial = input as Partial<TabKeepaliveSettings>;
  return { enabled: partial.enabled === true };
}

export async function getTabKeepaliveSettings(): Promise<TabKeepaliveSettings> {
  const data = await chrome.storage.local.get(TAB_KEEPALIVE_STORAGE_KEY) as Record<string, unknown>;
  return normalizeTabKeepaliveSettings(data[TAB_KEEPALIVE_STORAGE_KEY]);
}

export async function saveTabKeepaliveSettings(
  patch: Partial<TabKeepaliveSettings>,
): Promise<TabKeepaliveSettings> {
  return tabKeepaliveSettingsOperations.run(async () => {
    const current = await getTabKeepaliveSettings();
    const next = normalizeTabKeepaliveSettings({ ...current, ...patch });
    await chrome.storage.local.set({ [TAB_KEEPALIVE_STORAGE_KEY]: next });
    return next;
  });
}