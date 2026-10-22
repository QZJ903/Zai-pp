/**
 * **工具调用面板**：一轮回答里执行过的工具，收成一块可折叠的紧凑列表。
 *
 * ## 两层折叠（与上游 inline-agent 控制台同构）
 *
 * ① **块级** —— 折叠头「已调用工具（N 次）」开合整块；
 * ② **行级** —— 每行自己是按钮（`aria-expanded` + `hidden` 详情），**默认收起**。
 *    上游 `createAgentToolRow` 就是这么做的，两层缺一不可：
 *    只有块级折叠时，块一展开所有行的详情会一次性全铺出来，长正文
 *    （例如 `shell_exec` 的长输出）会把后面的工具行冲散。
 *
 * 每行 = 圆点 + 工具名 + **结果摘要**（`result.summary`）+ 状态，展开看详情。
 * 摘要与详情由调用方注入（`formatStatus` / `formatDetail`），本模块只管
 * **结构、样式、查找与增删**。
 *
 * ## 三件事都归它管，因为三者用的是同一套 DOM 约定
 *
 * ① **挂载** —— 往 `resolveHost`（z.ai 上是 `#response-content-container`）末尾追加；
 * ② **更新** —— 同一轮里每多一个工具就往列表里加一行，不重建整块；
 * ③ **查找/移除** —— 靠 `data-zpp-tool-key` 上的 **restore id**（见 `resolveKey`），
 *    它是「这一块属于哪一条回答」的唯一标识。
 *
 * ## ⚠️ 依赖全部注入，本模块不 import 任何 runtime / i18n / 站点模块
 *
 * 与 `core/ui/tool-result-renderer.ts` 同一形态。这样它既不拖 i18n 资源链
 * （内容脚本与主世界共用同一份产物），也让测试能脱离真实页面跑。
 *
 * ⚠️ **本模块刻意不含任何 `position: fixed` 的浮层**（用户 2026-10-12 的既有决策：
 * 「面板要、浮窗不要」—— 浮窗指上游 `showContentToast` 那条底部提示条）。
 * 失败可见性**只走面板里那一行的状态**，不弹提示。
 */

import type { ToolCardResult, ToolExecutionRecord } from '../types';
import { injectInjectedThemeStyles, syncInjectedTheme } from './injected-theme';

/** 块根节点的类名（样式与查找都锚在它上面）。 */
const BLOCK_CLASS = 'zpp-tool-block';

/** 块根节点的 id —— 只给**当前这块**用，页面上同一时刻只有一块带 id。 */
export const TOOL_BLOCK_ELEMENT_ID = 'zpp-tool-block';

/** 样式节点 id（幂等注入的判据）。 */
const STYLE_ID = 'zpp-tool-block-css';

/** 折叠状态属性。 */
const COLLAPSED_ATTR = 'data-collapsed';

/** 恢复标识属性 —— 「这一块属于哪条回答」的唯一真源。 */
const RESTORE_KEY_ATTR = 'data-zpp-tool-key';

/**
 * 行级展开标记 —— 与 DOM 上的 `aria-expanded` 同义，用于测试与断言。
 *
 * ⚠️ **真源是 `aria-expanded`（无障碍属性），这个 data 属性只是镜像** ——
 * 两者不一致时以 `aria-expanded` 为准（它是屏幕阅读器读的那个）。
 */
const ROW_EXPANDED_ATTR = 'data-zpp-tool-expanded';

/**
 * 行标识属性 —— **只用于「整块重画时保住展开态」**（见 `rowKeyOf`）。
 *
 * ⚠️ 它**不是**恢复锚点（那是块级的 `data-zpp-tool-key`），不落库、不进桥。
 */
const ROW_KEY_ATTR = 'data-zpp-tool-row';

/**
 * DOM 焦点标记 —— 让**连续两轮**落到不同的块上。
 *
 * ⚠️ 页面上同时可能有多个块（历史消息各一块 + 当前这块），而
 * `getElementById` 只能找到带 id 的那个 ⇒ **写 id 之前必须先把上一个的 id 摘掉**。
 * 摘 id 不能靠 `querySelector` 扫全页（每一轮都要扫一遍，白费），靠这个属性 O(1) 定位。
 */
const ACTIVE_ATTR = 'data-zpp-tool-active';

export interface ToolBlockDependencies {
  /**
   * 把块挂进页面的哪个元素。
   *
   * ⚠️ **找不到时返回 `null`，由调用方决定重试** —— 本模块不做重试调度
   * （那是编排层的事，见 `core/ui/tool-block-restore.ts`）。
   */
  resolveHost: (message: Element) => Element | null;
  /** 取当前会话里所有助手消息（按 DOM 顺序）。 */
  listMessages: () => Element[];
  /** 一行状态的文案（成功 / 失败 / 执行中）。由调用方按 locale 给。 */
  formatStatus: (execution: ToolExecutionRecord) => string;
  /** 一行详情的文本；返回空串表示不挂详情。 */
  formatDetail: (result: ToolCardResult) => string;
  /** 详情优先交给它渲染（能画成卡片就画）；返回 false 时退回纯文本。 */
  renderDetail?: (target: HTMLElement, result: ToolCardResult) => boolean;
  /** 注入 `document`（测试用）。 */
  document?: Document;
}

function doc(dependencies: ToolBlockDependencies): Document {
  return dependencies.document ?? document;
}

/**
 * 造一块空面板（只有折叠头，还没有任何行）。
 *
 * ⚠️ **折叠头是「点一下切换折叠」的按钮**：用 `role="button"` + `tabindex` 让键盘也能开合，
 * 而不是只挂 click（那是上游的做法，键盘用户打不开）。
 */
export function createToolBlockShell(
  dependencies: ToolBlockDependencies,
  options: { restoreKey?: string; collapsed?: boolean } = {},
): HTMLElement {
  const root = doc(dependencies);
  const block = root.createElement('div');
  block.className = BLOCK_CLASS;
  if (options.restoreKey) block.setAttribute(RESTORE_KEY_ATTR, options.restoreKey);
  block.setAttribute(COLLAPSED_ATTR, options.collapsed ? 'true' : 'false');

  const header = root.createElement('div');
  header.className = `${BLOCK_CLASS}-header`;
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  header.innerHTML = `
    <svg class="${BLOCK_CLASS}-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
    <span class="${BLOCK_CLASS}-title"></span>
    <svg class="${BLOCK_CLASS}-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
  `;

  const toggle = (): void => {
    const collapsed = block.getAttribute(COLLAPSED_ATTR) === 'true';
    block.setAttribute(COLLAPSED_ATTR, collapsed ? 'false' : 'true');
  };
  header.addEventListener('click', toggle);
  header.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggle();
  });

  const body = root.createElement('div');
  body.className = `${BLOCK_CLASS}-body`;

  block.append(header, body);
  return block;
}

/**
 * 把一份执行记录渲染进面板（清空重画）。
 *
 * ⚠️ **整块重画而不是增量插入**：一轮里最多几个工具，重画的代价可以忽略，
 * 而增量插入要维护「哪一行对应哪条执行」的映射 —— 那个映射一旦漂移就是
 * 「状态串到别的工具上」这种很难查的表现。
 * ⚠️⚠️ **但重画必须保住行级展开态**（`collectExpandedRowKeys` / `rowKey`）——
 * 实时链路上每执行一步就会重画一次（`publishLiveSession` → `renderRecord` →
 * 本函数），不保住的话**用户刚点开的那一行会被下一次重画收起来**。
 * 上游没有这个问题，因为它的实时路径是增量 append + 原地 `setAgentToolRowResult`。
 * ⚠️ **行数取 `title` 的文案由调用方给**（`formatTitle`），本模块只知道「有几行」。
 */
export function updateToolBlockContent(
  block: HTMLElement,
  executions: readonly ToolExecutionRecord[],
  dependencies: ToolBlockDependencies,
  formatTitle: (count: number) => string,
): void {
  const root = doc(dependencies);

  const title = block.querySelector(`.${BLOCK_CLASS}-title`);
  if (title) title.textContent = formatTitle(executions.length);

  const body = block.querySelector(`.${BLOCK_CLASS}-body`);
  if (!body) return;

  // ⚠️ **在清空之前**读一遍展开态（下面要整块重画）。
  const expandedKeys = collectExpandedRowKeys(body);
  body.textContent = '';

  executions.forEach((execution, index) => {
    const item = root.createElement('div');
    item.className = `${BLOCK_CLASS}-item`;
    const rowKey = rowKeyOf(execution, index);
    item.setAttribute(ROW_KEY_ATTR, rowKey);

    const toggle = root.createElement('div');
    toggle.className = `${BLOCK_CLASS}-item-toggle`;
    toggle.setAttribute('role', 'button');
    toggle.setAttribute('tabindex', '0');

    const dot = root.createElement('div');
    dot.className = `${BLOCK_CLASS}-dot`;

    const name = root.createElement('span');
    name.className = `${BLOCK_CLASS}-item-name`;
    name.textContent = execution.name;

    // ⚠️ **结果摘要进行内**（与上游控制台的已完成行同形：`工具名 · 结果摘要`）——
    // 折叠态下每行只有「工具名 + 状态」时，所有行长得一模一样，看不出做了什么。
    // ⚠️ 执行中的那一行 `summary` 就是「执行中」（编排层塞的占位），所以这里
    // **不需要按 pending 分叉**。
    const summary = root.createElement('span');
    summary.className = `${BLOCK_CLASS}-item-summary`;
    summary.textContent = execution.result.summary ?? '';

    const status = root.createElement('span');
    status.className = execution.result.ok
      ? `${BLOCK_CLASS}-item-status`
      : `${BLOCK_CLASS}-item-status error`;
    // ⚠️ 执行中的那一行 `ok` 为 true（见编排层的 pending 占位），
    // 所以「是不是失败」只看 `ok`，不看是否 pending。
    status.textContent = dependencies.formatStatus(execution);

    const detail = dependencies.formatDetail(execution.result);
    // ⚠️ **详情若与行内摘要完全相同，就不挂详情框、也不给 chevron** ——
    // 详情公式（`formatZaiToolDetail`）第一段恒为 `result.summary`，所以
    // 「没有 detail、没有 output」的结果（最典型的是**执行中那一行**，
    // 它的 summary 就是「执行中」）会格式化出「只有摘要一行」的详情。
    // 那在面板里是一个**点了没反应的死控件**：行内已经显示了同一句话。
    // ⚠️ 这是**有意的分叉**（上游控制台无条件画 chevron，展开后只有一行摘要）；
    // 判据安全：只要有 `detail` 或 `output`，格式化结果就必然比 summary 长。
    const hasDetail = detail !== '' && detail !== (execution.result.summary ?? '');
    const detailId = hasDetail ? `${BLOCK_CLASS}-detail-${index}` : '';

    toggle.append(dot, name, summary, status);

    // ⚠️ **没有详情的行不画 chevron** —— 画了就是一个「点了没反应」的假控件。
    if (hasDetail) {
      const chevron = root.createElement('span');
      chevron.className = `${BLOCK_CLASS}-item-chevron`;
      // 与块头用同一枚图标（静态可信标记，非外部内容）。
      chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
      toggle.appendChild(chevron);
    }

    item.appendChild(toggle);

    if (hasDetail) {
      const detailEl = root.createElement('div');
      detailEl.className = `${BLOCK_CLASS}-item-detail`;
      detailEl.id = detailId;
      toggle.setAttribute('aria-controls', detailId);
      const rendered = dependencies.renderDetail?.(detailEl, execution.result) ?? false;
      // ⚠️ 渲染器返回 false 表示「它不认识这个结果」—— 那时才退回纯文本，
      // 否则会出现「卡片画好了又被文本盖住」。
      if (!rendered) detailEl.textContent = detail;
      item.appendChild(detailEl);
    }

    // ⚠️ **默认收起**（上游 `createAgentToolRow`：`aria-expanded="false"` + `hidden`）——
    // 展开后长正文（例如 `shell_exec` 的长输出）会把后面的工具行冲散。
    const expanded = hasDetail && expandedKeys.has(rowKey);
    setRowExpanded(item, toggle, hasDetail ? detailId : '', expanded);

    if (hasDetail) {
      const flip = (): void => {
        setRowExpanded(item, toggle, detailId, toggle.getAttribute('aria-expanded') !== 'true');
      };
      toggle.addEventListener('click', flip);
      toggle.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        flip();
      });
    }

    body.appendChild(item);
  });
}

/**
 * 一条执行记录的**行标识** —— 只用于「重画时保住展开态」，不落库、不出现在 DOM 上。
 *
 * ⚠️ 优先 `callId`（同一次调用的稳定标识）；拿不到时退回「名字 + 序号」。
 * 退回值在列表重排后会指到别的行 —— 可接受：那种记录本来就没有稳定标识，
 * 而失败方向只是「展开态没保住」，不影响内容正确性。
 */
function rowKeyOf(execution: ToolExecutionRecord, index: number): string {
  return execution.callId ? `id:${execution.callId}` : `at:${execution.name}:${index}`;
}

/** 读当前已展开的行（整块重画前调用）。 */
function collectExpandedRowKeys(body: Element): Set<string> {
  const keys = new Set<string>();
  for (const item of body.querySelectorAll<HTMLElement>(`.${BLOCK_CLASS}-item`)) {
    if (item.getAttribute(ROW_EXPANDED_ATTR) !== 'true') continue;
    const key = item.getAttribute(ROW_KEY_ATTR);
    if (key) keys.add(key);
  }
  return keys;
}

/** 翻转一行的展开态（`aria-expanded` 是真源，`hidden` 与 data 属性是它的投影）。 */
function setRowExpanded(
  item: HTMLElement,
  toggle: HTMLElement,
  detailId: string,
  expanded: boolean,
): void {
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  item.setAttribute(ROW_EXPANDED_ATTR, expanded ? 'true' : 'false');
  const detail = detailId ? item.querySelector<HTMLElement>(`.${BLOCK_CLASS}-item-detail`) : null;
  if (detail) detail.hidden = !expanded;
}

/**
 * 按 restore key 找块。
 *
 * ⚠️ **不用 `getElementById`** —— 那个 id 只挂在「当前这块」上（见 `ACTIVE_ATTR` 的说明），
 * 而这里要找的可能是历史消息上的任意一块。
 */
export function findToolBlock(restoreKey: string, dependencies: ToolBlockDependencies): HTMLElement | null {
  const root = doc(dependencies);
  return root.querySelector<HTMLElement>(`.${BLOCK_CLASS}[${RESTORE_KEY_ATTR}="${cssEscape(restoreKey)}"]`);
}

/** 把块挂到某条消息里。宿主找不到时返回 false（由调用方决定是否重试）。 */
export function appendToolBlockToMessage(
  message: Element,
  block: HTMLElement,
  dependencies: ToolBlockDependencies,
): boolean {
  const host = dependencies.resolveHost(message);
  if (!host) return false;
  // ⚠️ 只写 id 给「当前这块」—— 写之前先摘掉上一个的（页面上同时存在多块）。
  const previous = doc(dependencies).querySelector<HTMLElement>(`[${ACTIVE_ATTR}]`);
  if (previous && previous !== block) {
    previous.removeAttribute('id');
    previous.removeAttribute(ACTIVE_ATTR);
  }
  block.id = TOOL_BLOCK_ELEMENT_ID;
  block.setAttribute(ACTIVE_ATTR, '');
  host.appendChild(block);
  return true;
}

/** 把块从它所在的消息里摘掉（换会话 / 记录失效时用）。 */
export function removeToolBlock(block: HTMLElement): void {
  // ⚠️ **摘块之前先摘 id 与焦点标记** —— 块可能已被页面摘掉（脱连），
  // 而 `appendToolBlockToMessage` 摘「上一个带 `data-zpp-tool-active` 的块」
  // 时用的是 `querySelector`（只看**在文档里**的节点）⇒ 脱连块上残留的
  // `id="zpp-tool-block"` 会让 `getElementById` 在那之后返回 null
  // （页面上明明有一块，id 却查不到）。两行的事，别留给下一个读代码的人。
  block.removeAttribute('id');
  block.removeAttribute(ACTIVE_ATTR);
  block.remove();
}

/**
 * 注入样式（幂等）。变量块与主题同步在这里各调一次，不依赖「谁先谁后」。
 *
 * ⚠️⚠️ **详情框的 `max-height: 160px` 与「详情是三段式」是配套的一对，别单独调**：
 * MCP 类工具（Shell Local / 用户自配的第三方 MCP）成功时 `detail` 按构造就是
 * `output` 的缩进渲染（`core/mcp/client.ts` 的 `normalizeMcpToolResult`），
 * 所以三段式会让同一份数据以两种形态各出现一次 —— 而这个高度把 `output:` 那段
 * 压到滚动区之外（真机截图里 shell_status 就是被 160px 切在第 9 行）。
 * **调高它 = 把那份重复放出来。** 取值与上游 `inline-agent/renderer.ts` 的
 * `.zpp-agent-tool-summary` 同值。
 *
 * ⚠️ **样式模板串里不能写中文注释** —— `scripts/i18n-coverage-audit.mjs` 会把
 * 模板串里的中文当成「硬编码文案」报出来（实测踩过）。说明写在这里。
 */
export function injectToolBlockStyles(dependencies: ToolBlockDependencies): void {
  injectInjectedThemeStyles();
  syncInjectedTheme();
  if (doc(dependencies).getElementById(STYLE_ID)) return;
  const style = doc(dependencies).createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.${BLOCK_CLASS} {
  margin-top: 8px;
}
.${BLOCK_CLASS}-header {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  color: var(--zpp-ui-text-muted);
  font-size: 12px;
  line-height: 18px;
}
.${BLOCK_CLASS}-header:hover,
.${BLOCK_CLASS}-header:focus-visible {
  color: var(--zpp-ui-text);
}
.${BLOCK_CLASS}-header:focus-visible {
  outline: 2px solid var(--zpp-ui-accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.${BLOCK_CLASS}-icon {
  width: 16px;
  height: 16px;
  color: var(--zpp-ui-accent);
  flex-shrink: 0;
}
.${BLOCK_CLASS}-title {
  font-weight: 500;
  color: inherit;
}
.${BLOCK_CLASS}-chevron {
  width: 12px;
  height: 12px;
  color: inherit;
  transition: transform 0.2s ease;
  margin-left: 2px;
}
.${BLOCK_CLASS}[${COLLAPSED_ATTR}="true"] .${BLOCK_CLASS}-chevron {
  transform: rotate(-90deg);
}
.${BLOCK_CLASS}-body {
  overflow-y: auto;
  transition: max-height 0.25s ease, opacity 0.2s ease;
  max-height: min(60vh, 520px);
  opacity: 1;
  padding-left: 20px;
  margin-top: 6px;
}
.${BLOCK_CLASS}[${COLLAPSED_ATTR}="true"] .${BLOCK_CLASS}-body {
  max-height: 0;
  opacity: 0;
  margin-top: 0;
}
.${BLOCK_CLASS}-item {
  padding: 5px 8px;
  margin: 2px 0;
  border: 1px solid var(--zpp-ui-border-muted);
  border-radius: 8px;
  background: var(--zpp-ui-surface-muted);
  font-size: 13px;
  color: var(--zpp-ui-text);
  line-height: 1.5;
}
.${BLOCK_CLASS}-item-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}
.${BLOCK_CLASS}-item-toggle:focus-visible {
  outline: 2px solid var(--zpp-ui-accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.${BLOCK_CLASS}-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--zpp-ui-accent);
}
.${BLOCK_CLASS}-item-name {
  flex: none;
  font-family: 'SF Mono', Monaco, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--zpp-ui-accent);
  overflow-wrap: anywhere;
}
.${BLOCK_CLASS}-item-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--zpp-ui-text-muted);
}
.${BLOCK_CLASS}-item-status {
  flex: none;
  color: var(--zpp-ui-success);
  margin-left: 6px;
}
.${BLOCK_CLASS}-item-status.error {
  color: var(--zpp-ui-error);
}
.${BLOCK_CLASS}-item-chevron {
  flex: none;
  width: 10px;
  height: 10px;
  color: var(--zpp-ui-text-subtle);
  transition: transform 0.15s ease;
}
.${BLOCK_CLASS}-item-chevron svg {
  display: block;
  width: 100%;
  height: 100%;
}
.${BLOCK_CLASS}-item-toggle[aria-expanded="true"] .${BLOCK_CLASS}-item-chevron {
  transform: rotate(180deg);
}
.${BLOCK_CLASS}-item-detail {
  margin-top: 4px;
  padding: 6px 8px;
  max-height: 160px;
  border-radius: 8px;
  background: var(--zpp-ui-accent-panel);
  color: var(--zpp-ui-text-muted);
  font-family: 'SF Mono', Monaco, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow: auto;
  overflow-wrap: anywhere;
  overscroll-behavior: contain;
}
.${BLOCK_CLASS}-item-detail[hidden] {
  display: none;
}
`;
  doc(dependencies).head.appendChild(style);
}

/** 属性选择器里的值要转义（restore key 是哈希串，理论上安全，但不值得赌）。 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}