/**
 * 「用户此刻在看哪一站」—— **读侧**，给没有页面上下文的链路用（后台抓模型清单、自动化兜底选站）。
 *
 * ## 语义（只有一条）
 *
 * **用户正在看的那个 z.ai 页面属于哪一站，答案就是哪一站**；没有 z.ai 页面在看时，
 * 沿用**上一次**用户真正看着的那个站；再拿不到就退回默认站。
 *
 * ## 为什么先问浏览器、而不是先读存储
 *
 * 内容脚本只能知道自己「加载了」和「自己可见性变了」，**不知道同一窗口里另一个标签页
 * 变成了当前页**（`chrome.storage.local` 又是共享的，两个 z.ai 标签页各写各的、后写者赢）。
 * ⇒ 光靠存储值答不了「用户在看哪一站」。
 *
 * 后台能问出真正的事实：`chrome.tabs.query({ active: true, lastFocusedWindow: true })`
 * 拿到的就是「最后获得焦点的那个窗口的当前标签页」——
 * **多窗口各开一个站、用户切窗口的场景在这里天然正确**，不需要读页面的
 * `visibilityState`（那个在多个窗口同时可见时全是 `visible`，区分不出来）。
 *
 * ## 三段取值
 *
 * 1. **当前标签页**是站点集合里的一员 ⇒ 就用它；
 * 2. 拿不到（用户在看非 z.ai 页面 / 没开窗口 / 查询失败）⇒ 退回
 *    `core/zai/viewed-site.ts` 记下的「上一次真正看着的站」；
 * 3. 再拿不到（从没记录过 / 记录不合法）⇒ 默认站点。
 *
 * ⚠️⚠️ **第 2 步是「退回存储值」，不是「退回内置模型清单」** —— 查询失败时若直接返回一个
 * 空结论，下游抓模型清单会掉进兜底清单（表现是下拉只剩内置三条），比「用上一次的站」更差。
 *
 * ⚠️ **失败方向一律是「更保守的那一侧」**：任何一段出错都往下走，本函数**永不 reject**
 * —— 调用方（模型清单抓取器、标签页解析）都把它当作「总能给出一个 origin」。
 */

import { ZAI_DEFAULT_SITE_ID, ZAI_SITES, resolveZaiSiteOrigin } from './contracts';
import { ZAI_VIEWED_SITE_STORAGE_KEY } from './viewed-site';

/**
 * 实时查询与存储读的上界（**可选**，由调用方显式传入才生效）。
 *
 * ⚠️ **必须有它**：`chrome.storage.local.get` 在扩展上下文失效时**同步抛错**（能被 `catch`
 * 接住），但「读很慢」这一档没有天然上界；而 `chrome.tabs.query` 同样是异步 API。
 * 本函数的调用方里有持有 `inFlight` 槽位的（模型清单抓取器）—— 它挂住会让那个槽位
 * 一直被占、之后每次触发都返回同一个未完成的 promise。
 *
 * 取 3 秒：比网络侧的上界短得多，因为这里只是两次本地 API 往返。
 */
export const CURRENT_SITE_READ_TIMEOUT_MS = 3_000;

/**
 * 读「用户此刻在看哪一站」。
 *
 * @param timeoutMs 可选上界，由调用方显式传入才生效（见 {@link CURRENT_SITE_READ_TIMEOUT_MS}）。
 */
export async function readCurrentZaiSiteOrigin(timeoutMs?: number): Promise<string> {
  const fallback = ZAI_SITES[ZAI_DEFAULT_SITE_ID].origin;
  // ⚠️ 上界是**整条链共享的预算**，不是每段各一份 —— 否则最坏情况会变成 N 倍。
  const deadlineAt = timeoutMs === undefined ? null : Date.now() + timeoutMs;
  const remaining = (): number | undefined =>
    deadlineAt === null ? undefined : Math.max(0, deadlineAt - Date.now());

  // ⚠️⚠️ **超时只让这一段「查不到」，不能让整条链直接给默认站** —— 这一点是承重的：
  // 若超时直接返回 `fallback`，就跳过了第 2 段（上一次看着的站），给出的正是本文件头
  // 明确说「比用上一次的站更差」的那一档。而 `tabs.query` 慢的典型场景恰恰是扩展上下文
  // 出问题 —— 那一刻读 `storage.local` 往往还是通的，所以第 2 段值得用剩余预算再试一次。
  const active = await raceWithTimeout(readActiveTabSiteOrigin(), remaining(), null);
  if (active) return active;

  return (await raceWithTimeout(readViewedZaiSiteOrigin(), remaining(), null)) ?? fallback;
}

/**
 * 给一段读一个上界；超时返回 `timeoutValue` 而**不是** throw。
 *
 * ⚠️ 只给「查不到就往下走」的那几段用 —— 有写回路径的读**绝不能**这么处理
 * （超时收敛成一个正常返回值，会让调用方基于它算出下一步并写回去）。
 */
async function raceWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number | undefined,
  timeoutValue: T,
): Promise<T> {
  if (timeoutMs === undefined) return operation;

  let timer: ReturnType<typeof setTimeout> | undefined;
  // ⚠️ 超时只是**不再等**，底层那次调用仍悬着（`chrome.tabs` / `chrome.storage` 都没有取消手段）。
  operation.catch(() => undefined);
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 「最后获得焦点的那个窗口的当前标签页」属于哪一站；不是 z.ai 页面就返回 `null`。
 *
 * ⚠️ **`lastFocusedWindow` 不能写成 `currentWindow`** —— 在 service worker 里语义相同
 * （都没有「当前窗口」），但前者是**明确要求**，而后者依赖「无窗口上下文时退化为最后聚焦窗口」
 * 这一隐含行为。这里的判据是「用户在看哪个窗口」，应当写成它。
 */
async function readActiveTabSiteOrigin(): Promise<string | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    for (const tab of tabs) {
      const origin = resolveZaiSiteOrigin(tab.url);
      if (origin) return origin;
    }
  } catch {
    // 查询失败（浏览器 API 异常 / 扩展上下文失效）⇒ 交给存储兜底。
  }
  return null;
}

/**
 * 读「上一次用户真正看着的那个站」；没有记录 / 记录不合法 / 读不到时返回 `null`。
 *
 * ⚠️ **不校验 `at` 的新鲜度** —— 这里的语义就是「上一次」，没有过期概念。
 * 那个字段只留痕（见 `viewed-site.ts` 的说明）。
 */
async function readViewedZaiSiteOrigin(): Promise<string | null> {
  try {
    const data = await chrome.storage.local.get(ZAI_VIEWED_SITE_STORAGE_KEY) as Record<string, unknown>;
    const record = data[ZAI_VIEWED_SITE_STORAGE_KEY];
    if (!record || typeof record !== 'object') return null;
    const origin = (record as { origin?: unknown }).origin;
    return resolveZaiSiteOrigin(typeof origin === 'string' ? origin : null);
  } catch {
    return null;
  }
}