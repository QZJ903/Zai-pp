/**
 * 「开新会话」该去哪个地址。
 *
 * ⚠️ **站点只剩 agent 模式**（chat 已从页面移除），所以这里只有一条恒定路径，
 * 不再做模式判定。
 *
 * 历史上这里有一个 `readZaiSidebarAgentMode(root)`：读 `#sidebar` 里带
 * `data-active` 的**第二个**按钮，判成 agent 就跳 `/?mode=agent`、否则跳 `/`。
 * 那个前提（页面模板把「Chat 模式」「Agent 模式」两个 tab 顺序写死）**已被真机推翻**：
 * 侧边栏现在只有 `['false','文件夹']` 与 `['true','网页端']` 两个 `data-active` 按钮。
 * 旧实现因此**恒判 agent** —— 结果碰巧正确，但判据完全是巧合。
 *
 * ⚠️ **`/?mode=agent` 是页面自己的入口**：入口读到 query 后设置 `$APP_SCENE`
 * 并把该参数删掉（页面内看不出当前模式）。**不要换成别的写法** —— 直接拼 `?mode=`
 * 之外的方案都没有真机依据。
 */

/** agent 模式的首页地址：页面入口读到 `mode=agent` 后会设置场景并删掉该参数。 */
export const ZAI_AGENT_HOME_PATH = '/?mode=agent';