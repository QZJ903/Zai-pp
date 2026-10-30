/**
 * 「上一次用户真正看着的那个 z.ai 页面属于哪一站」—— **写侧**。
 *
 * ## 语义（只有一条）
 *
 * 记下「此刻这个页面属于哪个站」，**且只在这个页面是用户眼前那一页时记**。
 * 用户没有在看任何 z.ai 页面时，值保持不动（读侧因此拿到的是「上一次」）。
 *
 * ⚠️⚠️ **「加载了就写」是错的** —— 后台标签页刷新一次就会把记录写歪：
 * 用户在国际站看着、后台那个国区站标签页刷新了，活跃站就变成国区站。所以**调用方必须先判可见性**
 * （见 `core/zai/capability-install.ts` 的启动链），本模块不替它判 —— 它拿不到可靠的前台事实，
 * 只有页面自己知道。
 *
 * ## 它只是读侧的**兜底**，不是主判据
 *
 * 读侧（`core/zai/current-site.ts`）先实时问浏览器「当前 tab 是哪一站」，只有问不到时才回落到
 * 这份记录。所以这里的精度要求很低：**「变更隐藏时不更新」不是缺陷** —— 那一刻用户已经不在
 * 看这个站了，记录停在旧值恰好是「沿用上一次」想要的语义。
 *
 * ## 为什么是 `chrome.storage.local` 而不是 `storage.session`
 *
 * ⚠️ **`storage.session` 内容脚本默认访问不到** —— 它只对受信上下文（service worker /
 * 扩展页面）开放，内容脚本属于非受信上下文。要放开必须调
 * `chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })`，
 * 而那是**整个 storage area 级别**的开关，会连带把已有的 session key
 * （MCP capability lease、工具授权）一并对内容脚本开放 —— 白送一块攻击面。
 *
 * `storage.local` 则是内容脚本已经在写的（auth 捕获走的就是它），不需要新增权限或访问级别；
 * 「上一次看着哪个站」跨浏览器重启保留也说得通。
 */

import { resolveZaiSiteOrigin } from './contracts';

/**
 * 存储键。⚠️ **名字是历史遗留**（当时语义是「最近活跃站」），现在存的是「上一次用户真正
 * 看着的站的 origin」。**不改名** —— `zai_pp_*` 键一改就等于丢值，而这里的值只是个兜底启发，
 * 丢了最多退回默认站，没有收益去动它。
 *
 * 形状：`{ origin: string; at: number }`。⚠️ **`at` 只留痕、没有消费者** ——
 * 本模块不校验新鲜度，读侧也不看它。别为它加「过期」判据。
 */
export const ZAI_VIEWED_SITE_STORAGE_KEY = 'zai_pp_active_site';

/**
 * 记下「这个页面属于哪个站」。由内容脚本在**页面是可见的**时候调用。
 *
 * ⚠️ **只认站点集合里的 origin** —— 认不出就**不写**，避免把别的页面（或将来某个
 * 未知子域）的 origin 记为「当前站」。失败方向安全：留着上一条记录，比写进一条
 * 永远不会被 `resolveZaiSiteOrigin` 认出的垃圾值好。
 */
export async function rememberViewedZaiSite(pageOrigin: string): Promise<boolean> {
  const siteOrigin = resolveZaiSiteOrigin(pageOrigin);
  if (!siteOrigin) return false;
  try {
    await chrome.storage.local.set({
      [ZAI_VIEWED_SITE_STORAGE_KEY]: { origin: siteOrigin, at: Date.now() },
    });
    return true;
  } catch {
    return false;
  }
}