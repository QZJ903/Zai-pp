/**
 * 项目面板里「点一条会话」的导航。
 *
 * 抽成注入式模块（与启动链的编排同一手法）是为了**能被测试直接调** ——
 * 这段逻辑原本写在内容脚本里，而内容脚本不能被测试 import（模块顶层就执行
 * `defineContentScript`），于是它只能靠读源码的接线断言去守。而这里恰恰有一个
 * 真实缺陷要守：见 `resolveZaiConversationUrl` 的说明（跨站会话被拼到当前站而跳不过去）。
 */

import { resolveZaiConversationUrl } from './chat-session';

export interface ZaiConversationNavigationDeps {
  /** 当前页所属站点的 origin（内容脚本传 `currentSiteOrigin()`）。 */
  currentOrigin: string;
  /** 真正执行跳转（生产传 `window.location.assign`）。 */
  assign: (url: string) => void;
}

/**
 * 跳到某条会话：**站点取自记录本身**，不是当前页。
 *
 * ⚠️⚠️ 两个站各有一份会话，同一条会话**只存在于它自己那一站**。在国际站的页面上点一条
 * 国区站的会话时，正确行为是**换掉 origin 把用户带过去**；按「与当前页同源」判会把它
 * 拼成当前站的 `/c/<id>`，那一站没有这条会话 —— 表现就是**跳转失败**。
 *
 * `currentOrigin` 只在该记录**没有可用 url** 时当兜底（记录里连 url 都没有，
 * 说明它是按 id 绑进来的，只能假设会话在本页这一站）。
 */
export function navigateToZaiConversation(
  conversation: { conversationId: string; url?: string | null },
  deps: ZaiConversationNavigationDeps,
): void {
  deps.assign(resolveZaiConversationUrl(conversation, deps.currentOrigin));
}