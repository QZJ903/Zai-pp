/**
 * 输入框的**斜杠命令补全**：在聊天输入框里敲 `/`（且 `/` 之后还没打空格）时，
 * 弹出一列技能候选，↑↓ 翻、Enter/Tab 选中、Esc 关。
 *
 * 选中后把输入框内容换成 `/<技能名> `、光标落到末尾 —— 与手打
 * `/技能名 参数` 的形态一致，`core/skill/parser.ts` 的 `parseSkillCommand`
 * 就能照常认出它（提示词侧本来就有这条通道，缺的只是「让用户看得见有哪些技能」）。
 *
 * ⚠️ **本模块是纯 DOM 的，不直接碰 runtime 也不 import 技能清单** ——
 * 候选列表、输入框解析、外壳解析、写值都由调用方以依赖形式注入。
 * 这样它既不拖 i18n 资源以外的任何东西，也让测试能脱离真实页面跑。
 *
 * ## 三处与页面形态有关的假设（都真机实测过，见各自的常量）
 *
 * ① **输入框会被页面重建**（实测 20 秒观测期内换了 2 个节点）⇒ 监听必须可重挂，
 *    不能装一次就完事。
 * ② **锚点取「外壳」而不是 textarea** —— 两者矩形差得不小，取 textarea 会让浮层
 *    压进输入框内部。见 `resolveZaiComposerShell`。
 * ③ **Enter 必须抢在页面处理之前** —— 页面只在 `keydown` 上触发一次发送。
 *    我们把监听挂在 `document` 的**捕获**阶段并用 `stopImmediatePropagation()` 掐断。
 *    实测：页面的 `preventDefault` 发生在「我们的捕获之后、我们的冒泡之前」
 *    ⇒ 页面处理器排在我们后面，掐得住。
 */

import { injectInjectedThemeStyles, syncInjectedTheme } from './injected-theme';

/**
 * 一个候选。**只带展示必需的两样** —— 调用方不必把整个技能对象递进来。
 */
export interface SkillPopupItem {
  name: string;
  description: string;
}

export interface SkillPopupCopy {
  /** 底部操作提示（如「↑↓ 导航 · Enter 选择 · Esc 关闭」）。 */
  hint: string;
}

const DEFAULT_COPY: SkillPopupCopy = {
  hint: '↑↓ Navigate · Enter Select · Esc Close',
};

/** 浮层与锚点之间的间距。 */
const POPUP_GAP_PX = 6;

/** 浮层宽度上限。宽度取锚点的一半（候选列表不需要跟输入框一样宽）。 */
const MAX_POPUP_WIDTH_PX = 280;

/** 浮层宽度相对锚点宽度的比例。 */
const POPUP_WIDTH_RATIO = 0.5;

/** 浮层高度上限（超出滚动，见样式里的 `overflow-y: auto`）。 */
const MAX_VISIBLE_ITEMS_PX = 220;

const STYLE_ID = 'dpp-skill-popup-css';

const POPUP_CLASS = 'dpp-skill-popup';
const ITEM_CLASS = 'dpp-skill-item';
const ACTIVE_CLASS = 'dpp-active';
const TRIGGER_CLASS = 'dpp-skill-trigger';
const DESC_CLASS = 'dpp-skill-desc';
const HINT_CLASS = 'dpp-skill-hint';

/**
 * 会触发浮层行为的按键。
 *
 * ⚠️ **归我们管的按键在浮层可见时要掐断** —— 尤其是 Enter：页面在它上面发消息，
 * 不掐就会「选个技能把消息发出去了」。其余四个掐断是为了不让 ↑↓ 把光标移走、
 * Esc 触发页面的其他关闭逻辑。
 */
const HANDLED_KEYS = ['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'Escape'] as const;

/**
 * 「这个按键是不是真人按的」。
 *
 * ⚠️ **用一个可变持有者而不是直接读 `event.isTrusted`** —— jsdom 造不出可信事件，
 * 直接读就没法给「真人按键被处理」和「合成按键被放行」两个分支都写用例。
 * 同一形态在 `core/ui/tool-result-renderer.ts` 的 `userClickGuard` 里已有先例；
 * 默认实现就是真实检查。
 */
export const keydownTrustGuard: { isTrusted(event: Event): boolean } = {
  isTrusted(event: Event) {
    return event.isTrusted;
  },
};

/**
 * 「这个按键是不是正在输入法组字」。
 *
 * ⚠️⚠️ **`isComposing` 与 `isTrusted` 是两个独立的属性，不能互相替代**：
 * 用输入法打字时按 Enter 确认候选词，那个 keydown **是真人按的**（`isTrusted` 为真）
 * 且 **`isComposing` 为真**。只判 `isTrusted` 拦不住它 ⇒
 * **中文 / 日文技能名会在用输入法输入的过程中被「Enter 选中」抢走**，
 * 表现是「想确认候选词，结果技能被选中了」。
 *
 * ⚠️ **归我们管的五个键都可能在组字期按下**（Enter/Tab 确认、↑↓ 翻候选、Esc 取消组字）
 * ⇒ 判据放在按键分派的最前面，对这五个一视同仁。
 * ⚠️ 同一形态在 `core/ui/tool-result-renderer.ts` 的 `userClickGuard` 已有先例。
 */
export const compositionGuard: { isComposing(event: KeyboardEvent): boolean } = {
  isComposing(event: KeyboardEvent) {
    return event.isComposing;
  },
};

export interface SkillPopupDependencies {
  /**
   * 取当前输入框。**每次现取** —— 页面会重建它，缓存会指向已脱连的旧节点。
   */
  resolveInput: () => HTMLTextAreaElement | null;
  /**
   * 取定位锚点（输入区外壳）。**建议注入 `resolveZaiComposerShell`** ——
   * 取不到时本模块回落到输入框自己（位置差一点，但功能不受影响）。
   */
  resolveAnchor: (input: HTMLTextAreaElement) => HTMLElement | null;
  /**
   * 把值写进输入框，并让页面的绑定状态跟着更新（要派发事件）。
   *
   * ⚠️ **由调用方注入生产里那个已被真机验证的原语**，不要在本模块里另写一份：
   * 写输入框的值这件事在自动化发送链上还有七个调用点，两份实现会各自漂移。
   */
  setInputValue: (input: HTMLTextAreaElement, value: string) => void;
  /** 注入 `document`（测试用；缺省用全局）。 */
  document?: Document;
  /** 注入 `window`（测试用；缺省用全局）。 */
  window?: Window;
}

let popupEl: HTMLElement | null = null;
let items: SkillPopupItem[] = [];
let filtered: SkillPopupItem[] = [];
let activeIdx = 0;
let textarea: HTMLTextAreaElement | null = null;
let copy: SkillPopupCopy = DEFAULT_COPY;
let deps: SkillPopupDependencies | null = null;
let rootObserver: MutationObserver | null = null;
let remountScheduled = false;
let initialized = false;

/**
 * 装（或更新）补全浮层。
 *
 * ⚠️ **可反复调用**：状态同步的广播会在运行期多次触发（用户刚导入一个技能就该能补全到它），
 * 所以每次调用都要把候选刷到最新。已装过时**按当前输入重算一遍**，
 * 而不是只替换 `items` —— 浮层渲染的是**过滤后的**那份，只换 `items`
 * 会让正开着的浮层停在旧列表上（要等用户再敲一个字符才更新）。
 */
export function initSkillPopup(
  initialItems: SkillPopupItem[],
  nextCopy: Partial<SkillPopupCopy> = {},
  dependencies: SkillPopupDependencies,
): void {
  deps = dependencies;
  items = initialItems;
  copy = { ...DEFAULT_COPY, ...nextCopy };
  if (initialized) {
    refreshFromInput();
    return;
  }
  initialized = true;
  injectStyles();
  watchInput();
  doc().addEventListener('keydown', onKeydown, true);
  doc().addEventListener('mousedown', onClickOutside);
}

export function stopSkillPopup(): void {
  if (!initialized) return;
  initialized = false;
  rootObserver?.disconnect();
  rootObserver = null;
  remountScheduled = false;
  textarea?.removeEventListener('input', onInput);
  textarea = null;
  doc().removeEventListener('keydown', onKeydown, true);
  doc().removeEventListener('mousedown', onClickOutside);
  popupEl?.remove();
  popupEl = null;
  doc().getElementById(STYLE_ID)?.remove();
  items = [];
  filtered = [];
  activeIdx = 0;
  copy = DEFAULT_COPY;
  deps = null;
}

function doc(): Document {
  return deps?.document ?? document;
}

function win(): Window {
  return deps?.window ?? window;
}

// ---------------------------------------------------------------------------
// 输入框绑定（含重挂）
// ---------------------------------------------------------------------------

/**
 * 盯住输入框：它被页面换掉之后要把 `input` 监听重新挂到新节点上。
 *
 * ⚠️ **这是必需的，不是兜底** —— 实测换会话时输入框会被重建（20 秒里换了 2 个），
 * 不重挂的话补全在换过会话之后**静默失效**（浮层再也不出现，其余功能一切正常）。
 * ⚠️ **回调按帧合流**：页面在流式输出期间每秒产生大量 DOM 变动，
 * 每次都做一次「输入框还在不在」的检查没有必要。
 */
function watchInput(): void {
  attachInput();
  rootObserver?.disconnect();
  rootObserver = new MutationObserver(() => {
    if (remountScheduled) return;
    remountScheduled = true;
    win().requestAnimationFrame(() => {
      remountScheduled = false;
      if (!textarea || !doc().contains(textarea)) {
        textarea?.removeEventListener('input', onInput);
        textarea = null;
        attachInput();
      }
    });
  });
  rootObserver.observe(doc().body, { childList: true, subtree: true });
}

function attachInput(): void {
  if (textarea) return;
  const el = deps?.resolveInput() ?? null;
  if (!el) return;
  textarea = el;
  el.addEventListener('input', onInput);
}

// ---------------------------------------------------------------------------
// 输入 / 按键
// ---------------------------------------------------------------------------

function onInput(): void {
  refreshFromInput();
}

/**
 * 按输入框当前内容重算候选并决定显隐。
 *
 * ⚠️ **单独抽出来是因为有两个触发者**：用户敲字（`input` 事件），
 * 以及**运行期状态同步**（技能清单变了要按当前输入重算）。两处各写一遍
 * 会在改判据时分叉 —— 一边认得出、另一边认不出。
 */
function refreshFromInput(): void {
  if (!textarea || !doc().contains(textarea)) return;
  const value = textarea.value;

  // 判据与技能命令的解析口径一致：`/` 开头，且还没进入参数部分。
  if (value.startsWith('/') && !value.slice(1).includes(' ')) {
    const query = value.slice(1).toLowerCase();
    filtered = query === ''
      ? [...items]
      : items.filter((item) => item.name.toLowerCase().startsWith(query));
    if (filtered.length > 0) {
      activeIdx = 0;
      showPopup();
      return;
    }
  }
  hidePopup();
}

function onKeydown(event: KeyboardEvent): void {
  if (!isVisible()) return;
  if (!HANDLED_KEYS.includes(event.key as (typeof HANDLED_KEYS)[number])) return;

  // ⚠️⚠️ **组字期一律放行（不掐）** —— 见 `compositionGuard` 的说明。
  // 这条必须排在 `keydownTrustGuard` 之前：组字期的按键是**可信的**，那道守卫拦不住。
  if (compositionGuard.isComposing(event)) return;

  // ⚠️ **不可信的合成按键一律放行（不掐）**。这条是**纯防御**，当前没有已知生产者：
  // 全仓（含 `packages/` / `scripts/`）唯一一处合成键盘事件是 `zai.content.ts` 的
  // `dispatchEnterKey`，而它**只有定义、零调用点**（自动化发送链走的是
  // `form.requestSubmit()` 与点 `#send-message-button` 两条路，都不经过键盘）。
  // 留着是挡「将来某个合成键盘事件的发送方」被我们误掐 ——
  // 补全若把别人的 Enter 吃掉，那条链会**静默失效**（表现是「点了运行、什么都没发生」）。
  // 真人按键 `isTrusted` 恒为 true，所以这条守卫只挡我们自己或页面派发的。
  if (!keydownTrustGuard.isTrusted(event)) return;

  // ⚠️⚠️ **两个都要调，缺一不可**：`preventDefault` 只取消浏览器的默认行为、
  // **拦不住页面自己挂的监听**；掐断靠 `stopImmediatePropagation`。
  // Enter 尤其要紧 —— 页面在它上面发消息。
  event.preventDefault();
  event.stopImmediatePropagation();

  switch (event.key) {
    case 'ArrowDown':
      activeIdx = (activeIdx + 1) % filtered.length;
      highlightActive();
      break;
    case 'ArrowUp':
      activeIdx = (activeIdx - 1 + filtered.length) % filtered.length;
      highlightActive();
      break;
    case 'Tab':
    case 'Enter':
      selectSkill(filtered[activeIdx]);
      break;
    case 'Escape':
      hidePopup();
      break;
  }
}

function onClickOutside(event: MouseEvent): void {
  if (!isVisible()) return;
  if (popupEl?.contains(event.target as Node)) return;
  if (event.target === textarea) return;
  hidePopup();
}

/**
 * 选中一个候选：把输入框内容替换成 `/<名字> `。
 *
 * ⚠️ **写值走调用方注入的原语**（见 `SkillPopupDependencies.setInputValue`）——
 * 页面用的是受控绑定，直接赋 `value` 不会让它的内部状态跟上。
 */
function selectSkill(item: SkillPopupItem | undefined): void {
  if (!textarea || !item || !deps) return;
  const nextValue = `/${item.name} `;
  deps.setInputValue(textarea, nextValue);
  textarea.focus();
  textarea.setSelectionRange(nextValue.length, nextValue.length);
  hidePopup();
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function showPopup(): void {
  if (!textarea) return;

  if (!popupEl) {
    popupEl = doc().createElement('div');
    popupEl.className = POPUP_CLASS;
    doc().body.appendChild(popupEl);
  }

  // ⚠️ **锚点优先取外壳**（见模块头 ②）：以输入框自己的矩形为锚，浮层会压进输入区内部。
  const anchor = deps?.resolveAnchor(textarea) ?? textarea;
  const rect = anchor.getBoundingClientRect();
  Object.assign(popupEl.style, {
    display: 'block',
    left: `${rect.left}px`,
    bottom: `${win().innerHeight - rect.top + POPUP_GAP_PX}px`,
    width: `${Math.min(rect.width * POPUP_WIDTH_RATIO, MAX_POPUP_WIDTH_PX)}px`,
  });

  rebuildItems();
}

/**
 * 重建候选项。
 *
 * ⚠️ **用 `textContent` 逐节点搭，不用 `innerHTML` 拼串** —— 技能的
 * `description` 来自用户导入的 `SKILL.md`（GitHub 导入 / 本地导入都是**外部内容**），
 * 拼串就得靠转义兜着；逐节点赋值在结构上不可能被注入，也就不需要那个转义函数。
 */
function rebuildItems(): void {
  if (!popupEl) return;
  popupEl.textContent = '';

  filtered.forEach((item, index) => {
    const row = doc().createElement('div');
    row.className = index === activeIdx ? `${ITEM_CLASS} ${ACTIVE_CLASS}` : ITEM_CLASS;

    const head = doc().createElement('div');
    head.className = 'dpp-skill-head';
    const trigger = doc().createElement('code');
    trigger.className = TRIGGER_CLASS;
    trigger.textContent = `/${item.name}`;
    head.appendChild(trigger);

    const description = doc().createElement('div');
    description.className = DESC_CLASS;
    description.textContent = item.description;

    row.append(head, description);
    row.addEventListener('mouseenter', () => {
      activeIdx = index;
      highlightActive();
    });
    row.addEventListener('mousedown', (event) => {
      // 按下就选中，别等 click —— 输入框失焦会先把浮层关掉。
      event.preventDefault();
      // 按下时会话可能已经切走、输入框被换过，所以再取一次当前候选。
      selectSkill(filtered[index]);
    });
    popupEl!.appendChild(row);
  });

  const hint = doc().createElement('div');
  hint.className = HINT_CLASS;
  hint.textContent = copy.hint;
  popupEl.appendChild(hint);
}

function highlightActive(): void {
  if (!popupEl) return;
  [...popupEl.querySelectorAll(`.${ITEM_CLASS}`)].forEach((el, index) => {
    el.classList.toggle(ACTIVE_CLASS, index === activeIdx);
    if (index === activeIdx) el.scrollIntoView({ block: 'nearest' });
  });
}

function hidePopup(): void {
  if (popupEl) popupEl.style.display = 'none';
}

function isVisible(): boolean {
  return popupEl !== null && popupEl.style.display !== 'none';
}

// ---------------------------------------------------------------------------
// 样式
// ---------------------------------------------------------------------------

/**
 * 注入浮层样式。
 *
 * ⚠️ **配色复用共享主题变量（`--dpp-ui-*`），不自带一套色板** ——
 * 页面里已有两块注入 UI 用着同一套变量，自带色板会让三处的深浅色各自漂移。
 * 变量块与主题同步在这里各调一次，**不依赖「谁先谁后」**（同
 * `core/ui/tool-result-renderer.ts` 的处理）—— 否则一旦顺序变了，
 * 所有 `var(--dpp-ui-*)` 会解析成空值（深色页面上表现为浮层整体看不见）。
 */
function injectStyles(): void {
  injectInjectedThemeStyles();
  syncInjectedTheme();
  if (doc().getElementById(STYLE_ID)) return;
  const style = doc().createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.${POPUP_CLASS} {
  position: fixed;
  z-index: 99999;
  display: none;
  box-sizing: border-box;
  padding: 4px;
  border: 1px solid var(--dpp-ui-border);
  border-radius: 12px;
  background: var(--dpp-ui-surface);
  box-shadow: var(--dpp-ui-shadow-lg, 0 10px 28px oklch(0 0 0 / 0.2));
  color: var(--dpp-ui-text);
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
  max-height: ${MAX_VISIBLE_ITEMS_PX}px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.${ITEM_CLASS} {
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.${ITEM_CLASS}.${ACTIVE_CLASS} {
  background: var(--dpp-ui-surface-muted);
}
.dpp-skill-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.${TRIGGER_CLASS} {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dpp-ui-accent-soft);
  color: var(--dpp-ui-accent);
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 13px;
  font-weight: 600;
}
.${DESC_CLASS} {
  margin-top: 2px;
  color: var(--dpp-ui-text-subtle);
  font-size: 11px;
  /* Descriptions come from user-imported SKILL.md files and have no length bound,
     so clamp them to one line — a single long description would otherwise eat the
     whole visible list (capped at 220px). */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${HINT_CLASS} {
  margin-top: 4px;
  padding: 4px 0 2px;
  border-top: 1px solid var(--dpp-ui-border-muted);
  color: var(--dpp-ui-text-subtle);
  font-size: 10px;
  text-align: center;
}
`;
  doc().head.appendChild(style);
}