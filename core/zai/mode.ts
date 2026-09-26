/**
 * z.ai 侧边栏的**当前模式**（chat / agent）与「新会话」的落点。
 *
 * ⚠️ 模式真源是页面自己的 Svelte store（`$APP_SCENE`），**隔离世界读不到**；页面也
 * **不**把它写进 URL（`?mode=` 只在导航那一刻存在、随即被 `delete`）或任何 DOM 属性。
 * 唯一可读的投影是**侧边栏那两个模式 tab 上的 `data-active`**。
 *
 * 页面模板把这两个 tab 的**顺序写死**：`Chat 模式` 在前、`Agent 模式` 在后
 * （标签文案随语言变，顺序不变）。所以取 `#sidebar` 里前两个带 `data-active` 的按钮，
 * 第二个的 `data-active === "true"` 即为 agent 模式。
 *
 * ⚠️ **不要改用 `localStorage.last_mode`** —— 页面只写不读（`getItem` 全仓 0 次），
 * 拿它当判定依据等于依赖一个页面自己都不认的字段。
 */

import { ZAI_PROJECT_PANEL_ATTR } from './contracts';

/** 侧边栏里带模式标记的按钮。 */
export const ZAI_SIDEBAR_MODE_TAB_SELECTOR = '#sidebar button[data-active]';

/** agent 模式的首页地址：页面入口读到 `mode=agent` 后会设置场景并删掉该参数。 */
export const ZAI_AGENT_HOME_PATH = '/?mode=agent';

/** chat（默认）模式的首页地址。 */
export const ZAI_CHAT_HOME_PATH = '/';

/**
 * 读侧边栏当前是不是 agent 模式。
 *
 * 读不到（侧边栏未渲染、页面结构变了）时按 **chat** 处理 —— 那是与今天一致的旧行为，
 * 不会把用户带到一个预期之外的模式。
 *
 * ⚠️ **必须排除扩展自己的项目面板子树**：面板就插在 `#sidebar` 里，它的图标按钮
 * 在激活时会写 `data-active="true"`（`project-panel.ts` 的 `createIconButton`）。
 * 不排除的话，一旦面板按钮排到模式 tab 前面（或模式 tab 移出 `#sidebar`），
 * `tabs[1]` 就会读到面板那个按钮 → 误判成 agent。**这个错读方向是「读不到按 chat」
 * 那条回退覆盖不到的**，所以要在选择阶段就排掉。
 */
export function readZaiSidebarAgentMode(root: ParentNode): boolean {
  let tabs: Element[];
  try {
    tabs = Array.from(root.querySelectorAll(ZAI_SIDEBAR_MODE_TAB_SELECTOR))
      .filter((element) => !element.closest(`[${ZAI_PROJECT_PANEL_ATTR}]`));
  } catch {
    return false;
  }
  const agentTab = tabs[1];
  return agentTab?.getAttribute('data-active') === 'true';
}

/** 当前模式下「开新会话」应该去的地址。 */
export function zaiNewConversationPath(agentMode: boolean): string {
  return agentMode ? ZAI_AGENT_HOME_PATH : ZAI_CHAT_HOME_PATH;
}