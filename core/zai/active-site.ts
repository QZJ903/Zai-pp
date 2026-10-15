/**
 * 「当前站点」的跨上下文记录 —— 给**没有页面上下文**的链路用。
 *
 * ## 它解决什么
 *
 * 大部分链路有页面上下文：内容脚本就在 z.ai 页面上，直接读 `location.origin`
 * 反查站点即可（`resolveZaiSite`）。但有几处**手里只有一个会话 id**，不知道它
 * 属于哪个站 —— 最典型的是侧边栏的项目页（记录里的 `url` 缺失或失效时，要按
 * 会话 id 重拼一个可打开的链接）。
 *
 * ## 为什么是 `chrome.storage.local` 而不是 `storage.session`
 *
 * ⚠️ **`storage.session` 内容脚本默认访问不到** —— 它只对受信上下文（service worker /
 * 扩展页面）开放，内容脚本属于非受信上下文。要放开必须调
 * `chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })`，
 * 而那是**整个 storage area 级别**的开关，会连带把已有的 session key
 * （MCP capability lease、工具授权）一并对内容脚本开放 —— 白送一块攻击面。
 *
 * `storage.local` 则是内容脚本已经在写的（auth 捕获走的就是它），不需要新增权限
 * 或访问级别。语义上「最近在用哪个站」跨浏览器重启保留也说得通。
 *
 * ⚠️ **写入方是内容脚本**（它才知道页面在哪一站），**读取方主要是侧边栏**。
 * 后台自己那几处走的是「记录里带的站点」，不读这里（见 `AutomationGLMSession.siteOrigin`）。
 *
 * ⚠️ **读不到 / 认不出时返回默认站点** —— 失败方向是「拼出默认站的链接」，
 * 与「拼一个 `'#'`」或「抛错」相比是安全的一侧。
 */

import { ZAI_DEFAULT_SITE_ID, ZAI_SITES, resolveZaiSiteOrigin } from './contracts';

export const ZAI_ACTIVE_SITE_STORAGE_KEY = 'glm_pp_active_site';

/**
 * 记下「当前这个页面属于哪个站」。由内容脚本在启动时调用一次（幂等）。
 *
 * ⚠️ **只认站点集合里的 origin** —— 认不出就**不写**，避免把别的页面（或将来某个
 * 未知子域）的 origin 记为「当前站」。失败方向安全：留着上一条记录，比写进一条
 * 永远不会被 `resolveZaiSiteOrigin` 认出的垃圾值好。
 */
export async function rememberActiveZaiSite(pageOrigin: string): Promise<boolean> {
  const siteOrigin = resolveZaiSiteOrigin(pageOrigin);
  if (!siteOrigin) return false;
  try {
    await chrome.storage.local.set({
      [ZAI_ACTIVE_SITE_STORAGE_KEY]: { origin: siteOrigin, at: Date.now() },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 读「当前站点」的 origin；没有记录 / 记录不合法 / storage 读不到时返回**默认站点**。
 *
 * ⚠️ **不用 `Promise.race` 加超时** —— 这里与 auth 读取那两处不同：那个场景下
 * 调用方有 `inFlight` 槽位会被永久占住；这里每次都是一次性的读，挂住只是这一次
 * 调用慢，不会累积。保持简单。
 */
export async function readActiveZaiSiteOrigin(): Promise<string> {
  const fallback = ZAI_SITES[ZAI_DEFAULT_SITE_ID].origin;
  try {
    const data = await chrome.storage.local.get(ZAI_ACTIVE_SITE_STORAGE_KEY) as Record<string, unknown>;
    const record = data[ZAI_ACTIVE_SITE_STORAGE_KEY];
    if (!record || typeof record !== 'object') return fallback;
    const origin = (record as { origin?: unknown }).origin;
    return resolveZaiSiteOrigin(typeof origin === 'string' ? origin : null) ?? fallback;
  } catch {
    return fallback;
  }
}