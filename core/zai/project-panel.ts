/**
 * z.ai 侧边栏的「项目」面板。
 *
 * 在侧边栏账号行**正上方**插一块固定区域，按项目列出已归入的会话，
 * 让用户不用打开扩展侧边栏就能管项目。
 *
 * 与上游 ds++ 的同名功能有一处根本差别：**这里不读页面原生历史列表**。
 * 上游要把原生列表按项目重新组织，前提是能从 DOM 认出「这一行是哪个会话」；
 * z.ai 的会话行上没有任何 id（只有 Svelte 的 `__className`），这条前提不成立。
 * 所以改成只从项目存储渲染 —— 会话标题与 URL 本来就在 `ProjectConversation` 里。
 *
 * 代价是**不隐藏原生列表里的行**（那需要行到会话 id 的映射）。这是刻意的：
 * 映射一旦错位，表现是「对话从侧边栏消失」，比「同一个对话出现两次」严重得多。
 */

import type {
  ProjectContext,
  ProjectContextState,
  ProjectConversation,
} from '../types';
import { isPlaceholderProjectConversationTitle } from '../project/title';
import { ZAI_PROJECT_PANEL_ATTR } from './contracts';

/** 面板、样式与浮层的注入标记。 */
const PANEL_ID = 'dpp-project-panel';
const PANEL_STYLE_ID = 'dpp-project-panel-css';
const MENU_ID = 'dpp-project-panel-menu';
/**
 * 面板根节点与项目 section 的标记属性。真源在 `contracts.ts` —— 模式判定
 * （`core/zai/mode.ts`）也要用它排除面板子树，见那里的说明。
 */
const PANEL_BOUND_ATTR = ZAI_PROJECT_PANEL_ATTR;

/** z.ai 侧边栏根节点（真机实测带 id）。 */
const SIDEBAR_ID = 'sidebar';

/** 账号行上的用户菜单按钮 id；面板插在它所属的 `mt-auto` 容器之前。 */
const USER_MENU_BUTTON_ID = 'nux-user-menu-btn';

/** 粒度：单个项目默认展开显示的会话数，超出折叠（与上游取值一致）。 */
const CONVERSATION_LIMIT = 5;

/**
 * 补名的重试时点（毫秒，相对触发那一刻）。
 *
 * 为什么需要延迟重试：新建会话的侧边栏那行**先是临时名**（「新会话」这类占位），
 * **等模型第一次回答完才换成真名**（真机观察）—— 而那一刻与「DOM 文本真的换掉」
 * 之间还差一次 Svelte 重渲染。所以每次触发都留两个时点：先立刻看一眼，
 * 再隔几秒兜一次。**只在触发时排，不做无限轮询。**
 */
const BACKFILL_RETRY_DELAYS_MS = [0, 2_500] as const;

/** 面板最大高度：超出后内部滚动，不吃掉历史列表的空间。 */
const PANEL_MAX_HEIGHT_PX = 240;

/** 浮层与锚点之间、以及浮层与视口边缘之间的最小间距。 */
const MENU_GAP_PX = 4;
const MENU_VIEWPORT_MARGIN_PX = 8;

export interface ProjectPanelConversation {
  conversationId: string;
  title: string;
  url: string;
}

export interface ProjectPanelLabels {
  title: string;
  empty: string;
  conversationCount: (count: number) => string;
  expandProject: (name: string) => string;
  collapseProject: (name: string) => string;
  showMore: string;
  showLess: string;
  moveCurrentToProject: (name: string) => string;
  removeCurrentFromProject: (name: string) => string;
  newConversationInProject: (name: string) => string;
  useNextConversation: (name: string) => string;
  cancelNextConversation: (name: string) => string;
  pendingBadge: string;
  conversationActions: string;
  removeFromProjectNamed: (name: string) => string;
  renameConversation: string;
  operationFailed: (message: string) => string;
  age: (timestamp: number) => string;
}

export interface ProjectPanelDependencies {
  /** 读项目状态；失败返回 null（面板保留上一次的展示）。 */
  loadState: () => Promise<ProjectContextState | null>;
  addConversation: (input: {
    projectId: string;
    conversation: ProjectPanelConversation;
  }) => Promise<void>;
  removeConversation: (conversationId: string) => Promise<void>;
  /** 手动改名：标题按原样采用，且不会被后续自动回填覆盖。 */
  renameConversation: (input: {
    projectId: string;
    conversationId: string;
    title: string;
  }) => Promise<void>;
  /**
   * 用会话列表里的真名补上占位标题（`Untitled conversation`）。
   *
   * 触发场景：**待绑新会话**绑定发生在首条消息那一刻，此时侧边栏还没渲染出那一行，
   * `getCurrentConversationTitle()` 只能返回占位串 —— 而那一刻之后再没有别的回填机会。
   * 面板挂着时由它补一次。**非占位标题不传**（见调用方）。
   */
  backfillConversationTitle: (input: {
    projectId: string;
    conversationId: string;
    title: string;
  }) => Promise<void>;
  setPending: (projectId: string | null) => Promise<void>;
  /** 当前打开的会话（从地址栏读，拿不到返回 null）。 */
  getCurrentConversation: () => ProjectPanelConversation | null;
  /** 打开某个已归入项目的会话。 */
  openConversation: (conversation: ProjectPanelConversation) => void;
  /** 在指定项目下开新对话：置待绑 + 回首页。 */
  startNewConversation: (projectId: string) => void;
  getLabels: () => ProjectPanelLabels;
  onError?: (error: unknown) => void;
}

export interface ProjectPanelController {
  /** 重新拉一次项目状态并重绘。 */
  refresh(): void;
  /** 只重绘（用缓存状态）—— 供「当前会话变了」这类不涉及状态拉取的变化调用。 */
  render(): void;
  /**
   * 立刻安排一次「补占位标题」检查，并**允许对当前会话重试**。
   *
   * 会话变化时必须调它：第一次补名尝试往往早于侧边栏渲染出那一行（拿不到真名就跳过），
   * 所以切到这条会话时要再给一次机会。
   */
  backfillNow(): void;
  stop(): void;
}

export function startProjectPanel(
  dependencies: ProjectPanelDependencies,
): ProjectPanelController {
  let stopped = false;
  let state: ProjectContextState | null = null;
  let statusMessage = '';
  /** 当前为哪条会话开着菜单（`null` = 没开）；供菜单按钮做 toggle。 */
  let openMenuConversationId: string | null = null;
  /** 当前菜单锚在哪个按钮上；用来区分「点别处」和「点锚点自己」。 */
  let openMenuAnchor: HTMLElement | null = null;
  /** 已尝试补过名的会话 id（防同一条反复补；失败会从集合里移出以便下次重试）。 */
  const backfillAttemptedIds = new Set<string>();
  /** 待执行的补名重试定时器（会话切换时整体取消）。 */
  const backfillTimers = new Set<ReturnType<typeof setTimeout>>();
  const expandedProjectIds = new Set<string>();
  const showAllProjectIds = new Set<string>();

  injectStyles();

  const reportError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    statusMessage = dependencies.getLabels().operationFailed(message);
    dependencies.onError?.(error);
    render();
  };

  const refresh = (): void => {
    if (stopped) return;
    void dependencies.loadState()
      .then((next) => {
        if (stopped || !next) return;
        applyState(next);
      })
      .catch(reportError);
  };

  const applyState = (next: ProjectContextState): void => {
    state = next;
    statusMessage = '';
    // 有会话的项目默认展开，省得每次都要点一下。
    for (const project of next.projects) {
      if (hasConversations(project.id, next.conversations)) expandedProjectIds.add(project.id);
    }
    for (const id of [...expandedProjectIds]) {
      if (!next.projects.some((project) => project.id === id)) expandedProjectIds.delete(id);
    }
    for (const id of [...showAllProjectIds]) {
      if (!next.projects.some((project) => project.id === id)) showAllProjectIds.delete(id);
    }
    render();
    backfillPlaceholderTitles();
  };

  /**
   * 给**占位标题**的会话补上会话列表里的真名。
   *
   * 为什么需要：**待绑新会话**的绑定发生在首条消息那一刻（`bindPendingProject`），
   * 此时页面还没跳 `/c/<id>`、侧边栏也没渲染出那一行 → `getCurrentConversationTitle()`
   * 只能返回占位串（如实传、不编造）。而那一刻之后再没有别的回填机会
   * （`refreshProjectConversation` 只在**已归入项目**的会话上跑，刚绑的那条正是它）。
   * 面板挂着时由它补一次。
   *
   * ⚠️ **只处理占位标题** —— 判定与后台共用 `isPlaceholderProjectConversationTitle`：
   * 已有真名（含用户重命名）的会话一律不动，否则改名会被顺手覆盖回去。
   * ⚠️ 只在**侧边栏那行真的存在**时才发（`getCurrentConversation` 给的就是它），
   * 拿不到真名就不发 —— 避免把占位串原样回写、白跑一次 IPC。
   */
  const backfillPlaceholderTitles = (): void => {
    if (stopped || !state) return;
    const current = dependencies.getCurrentConversation();
    if (!current) return;
    if (isPlaceholderProjectConversationTitle(current.title)) return;
    const membership = state.conversations.find(
      (item) => item.conversationId === current.conversationId,
    );
    if (!membership) return;
    if (!isPlaceholderProjectConversationTitle(membership.title)) return;
    if (backfillAttemptedIds.has(current.conversationId)) return;
    void sendTitleBackfill(membership.projectId, current.conversationId, current.title);
  };

  /**
   * 发一次补名，并登记「这条会话已尝试过」。失败时解除登记，让下次还有机会。
   *
   * ⚠️ **登记不等于永久放弃** —— `backfillNow()` 会先清掉当前会话的登记再重试，
   * 因为第一次尝试通常发生在侧边栏还没渲染出那一行的时候（那次会被跳过、不登记）。
   */
  const sendTitleBackfill = (
    projectId: string,
    conversationId: string,
    title: string,
  ): void => {
    backfillAttemptedIds.add(conversationId);
    void dependencies.backfillConversationTitle({ projectId, conversationId, title })
      .then(() => {
        if (stopped) return;
        refresh();
      })
      .catch(() => {
        // 补名失败静默：它不改变任何用户可见的状态（标题仍是占位串，与补名之前一样）。
        backfillAttemptedIds.delete(conversationId);
      });
  };

  /**
   * 安排一次补名：立刻试一次 + 隔几秒再试一次（见 `BACKFILL_RETRY_DELAYS_MS`）。
   *
   * ⚠️ 调用时机是「**有人告诉我们该看看了**」—— 切会话、或某一轮回答结束。
   * 不做轮询：新建会话的真名要等首答完成才出现，而「回答结束」本身就是那个信号
   * （内容脚本在 `handleResponseComplete` 里调它）。
   */
  const backfillNow = (): void => {
    if (stopped) return;
    clearBackfillTimers();
    const current = dependencies.getCurrentConversation();
    // 重新给这条会话一次机会：上次可能因为侧边栏那行还是临时名而被跳过（未登记）。
    if (current) backfillAttemptedIds.delete(current.conversationId);
    for (const delay of BACKFILL_RETRY_DELAYS_MS) {
      if (delay === 0) {
        backfillPlaceholderTitles();
        continue;
      }
      const timer = setTimeout(() => {
        backfillTimers.delete(timer);
        backfillPlaceholderTitles();
      }, delay);
      backfillTimers.add(timer);
    }
  };

  const clearBackfillTimers = (): void => {
    for (const timer of backfillTimers) clearTimeout(timer);
    backfillTimers.clear();
  };

  /** 改动类操作：等后台确认后重拉状态，而不是先改本地。 */
  const mutate = (operation: () => Promise<void>): void => {
    if (stopped) return;
    void operation()
      .then(() => {
        if (stopped) return;
        refresh();
      })
      .catch(reportError);
  };

  /**
   * 页面 DOM 变动时的**轻量**检查：只确认面板还挂在原地，不重绘。
   *
   * 关键：这里的触发源是整页变动（消息流式输出时每秒几十次）。若每次都重绘，
   * 重建出来的新 body 节点 `scrollTop` 恒为 0 —— 表现就是「滚到底下莫名其妙
   * 弹回最上面」。重绘只由**状态变化**和**用户操作**驱动；这里只在节点真被
   * 换掉时补挂并重画一次。
   */
  const ensureMounted = (): void => {
    if (stopped) return;
    try {
      const accountRow = findAccountRow();
      if (!accountRow) return;
      const mounted = ensurePanel(accountRow);
      if (!mounted) return;
      if (mounted.created) paint(mounted.panel);
    } catch (error) {
      console.warn('[GLM++] project panel mount check failed', error);
    }
  };

  const render = (): void => {
    if (stopped) return;
    try {
      const accountRow = findAccountRow();
      if (!accountRow) return;
      const mounted = ensurePanel(accountRow);
      if (!mounted) return;
      paint(mounted.panel);
    } catch (error) {
      console.warn('[GLM++] project panel render failed', error);
    }
  };

  const paint = (panel: HTMLElement): void => {
    const labels = dependencies.getLabels();
    const current = dependencies.getCurrentConversation();

    // 重绘会把所有行换掉，而浮层挂在 document.body、不在面板里 —— 不主动关掉它
    // 就会悬在已经换过的列表上，且 openMenuConversationId 指向已移除的旧按钮，
    // 导致再点同一行的 ⋯ 变成「只关不开」（看着像点了没反应）。
    closeConversationMenu();

    // 重绘会重建 body 节点，而新节点的 scrollTop 恒为 0 —— 把用户滚到的位置带过去。
    const previousScrollTop = panel
      .querySelector<HTMLElement>('.dpp-project-panel__body')?.scrollTop ?? 0;
    panel.textContent = '';

    const header = document.createElement('div');
    header.className = 'dpp-project-panel__header';
    const heading = document.createElement('span');
    heading.className = 'dpp-project-panel__heading';
    heading.textContent = labels.title;
    header.append(heading);
    panel.append(header);

    const body = document.createElement('div');
    body.className = 'dpp-project-panel__body';
    panel.append(body);

    if (!state || state.projects.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dpp-project-panel__empty';
      empty.textContent = labels.empty;
      body.append(empty);
    } else {
      for (const project of state.projects) {
        body.append(createProjectSection(project, current));
      }
    }

    if (statusMessage) {
      const status = document.createElement('div');
      status.className = 'dpp-project-panel__status';
      status.textContent = statusMessage;
      panel.append(status);
    }

    // 恢复滚动位置。内容变短时浏览器会自己夹到最大可滚位置，不用手工 clamp。
    if (previousScrollTop > 0) body.scrollTop = previousScrollTop;
  };

  const createProjectSection = (
    project: ProjectContext,
    current: ProjectPanelConversation | null,
  ): HTMLElement => {
    const labels = dependencies.getLabels();
    const expanded = expandedProjectIds.has(project.id);
    const conversations = state?.conversations
      .filter((item) => item.projectId === project.id)
      // 按最近打开排序：用 lastSeenAt，不是 addedAt。
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt) ?? [];
    const isPending = state?.pendingProjectId === project.id;
    const currentMembership = current
      ? state?.conversations.find((item) => item.conversationId === current.conversationId) ?? null
      : null;

    const section = document.createElement('div');
    section.className = 'dpp-project-panel__project';
    section.setAttribute(PANEL_BOUND_ATTR, 'true');

    const row = document.createElement('div');
    row.className = 'dpp-project-panel__project-row';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'dpp-project-panel__project-toggle';
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.title = expanded ? labels.collapseProject(project.name) : labels.expandProject(project.name);
    toggle.setAttribute('aria-label', toggle.title);

    const caret = document.createElement('span');
    caret.className = 'dpp-project-panel__caret';
    caret.textContent = expanded ? '▾' : '▸';
    const name = document.createElement('span');
    name.className = 'dpp-project-panel__project-name';
    name.textContent = project.name;
    const count = document.createElement('span');
    count.className = 'dpp-project-panel__project-count';
    count.textContent = labels.conversationCount(conversations.length);
    toggle.append(caret, name, count);
    toggle.addEventListener('click', () => {
      if (expandedProjectIds.has(project.id)) expandedProjectIds.delete(project.id);
      else expandedProjectIds.add(project.id);
      render();
    });

    // 项目行右侧的图标按钮组（hover / 聚焦时显现）：
    // 当前对话的归属操作 + 新会话 + 待绑开关。
    const actions = document.createElement('div');
    actions.className = 'dpp-project-panel__project-actions';

    if (current) {
      const sameProject = currentMembership?.projectId === project.id;
      actions.append(createIconButton({
        label: sameProject
          ? labels.removeCurrentFromProject(project.name)
          : labels.moveCurrentToProject(project.name),
        icon: sameProject ? ICON_UNLINK : ICON_ADD,
        active: sameProject,
        onClick: () => {
          mutate(() => (sameProject
            ? dependencies.removeConversation(current.conversationId)
            : dependencies.addConversation({ projectId: project.id, conversation: current })));
        },
      }));
    }

    actions.append(createIconButton({
      label: labels.newConversationInProject(project.name),
      icon: ICON_NEW_CONVERSATION,
      onClick: () => {
        mutate(async () => {
          await dependencies.setPending(project.id);
          dependencies.startNewConversation(project.id);
        });
      },
    }));

    actions.append(createIconButton({
      label: isPending
        ? labels.cancelNextConversation(project.name)
        : labels.useNextConversation(project.name),
      icon: ICON_CLOCK,
      active: isPending,
      onClick: () => {
        mutate(() => dependencies.setPending(isPending ? null : project.id));
      },
    }));

    row.append(toggle, actions);
    section.append(row);

    if (isPending) {
      const badge = document.createElement('div');
      badge.className = 'dpp-project-panel__pending';
      badge.textContent = labels.pendingBadge;
      section.append(badge);
    }

    if (expanded) {
      const list = document.createElement('div');
      list.className = 'dpp-project-panel__conversations';
      if (conversations.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dpp-project-panel__empty';
        empty.textContent = labels.empty;
        list.append(empty);
      } else {
        const showAll = showAllProjectIds.has(project.id);
        const visible = showAll ? conversations : conversations.slice(0, CONVERSATION_LIMIT);
        for (const conversation of visible) {
          list.append(createConversationRow(project, conversation));
        }
        if (conversations.length > CONVERSATION_LIMIT) {
          const more = document.createElement('button');
          more.type = 'button';
          more.className = 'dpp-project-panel__more';
          more.textContent = showAll ? labels.showLess : labels.showMore;
          more.addEventListener('click', () => {
            if (showAllProjectIds.has(project.id)) showAllProjectIds.delete(project.id);
            else showAllProjectIds.add(project.id);
            render();
          });
          list.append(more);
        }
      }
      section.append(list);
    }

    return section;
  };

  const createConversationRow = (
    project: ProjectContext,
    conversation: ProjectConversation,
  ): HTMLElement => {
    const labels = dependencies.getLabels();
    const row = document.createElement('div');
    row.className = 'dpp-project-panel__conversation';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'dpp-project-panel__conversation-title';
    open.textContent = conversation.title;
    open.title = conversation.title;
    open.addEventListener('click', () => {
      dependencies.openConversation({
        conversationId: conversation.conversationId,
        title: conversation.title,
        url: conversation.url,
      });
    });

    const age = document.createElement('span');
    age.className = 'dpp-project-panel__conversation-age';
    age.textContent = labels.age(conversation.lastSeenAt);

    const menuButton = document.createElement('button');
    menuButton.type = 'button';
    menuButton.className = 'dpp-project-panel__conversation-menu-button';
    menuButton.title = labels.conversationActions;
    menuButton.setAttribute('aria-label', labels.conversationActions);
    menuButton.innerHTML = ICON_MORE;
    menuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleConversationMenu(project, conversation, menuButton);
    });

    row.append(open, age, menuButton);
    row.dataset.dppConversationId = conversation.conversationId;
    return row;
  };

  /**
   * 就地改名：把标题按钮换成输入框。
   * 回车确认、Esc 取消、失焦取消 —— 改坏了不留痕。
   */
  const beginRename = (
    project: ProjectContext,
    conversation: ProjectConversation,
    titleButton: HTMLButtonElement,
  ): void => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dpp-project-panel__rename-input';
    input.value = conversation.title;
    input.setAttribute('aria-label', dependencies.getLabels().renameConversation);
    titleButton.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    const finish = (commit: boolean): void => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      input.replaceWith(titleButton);
      if (!commit || !next || next === conversation.title) return;
      mutate(() => dependencies.renameConversation({
        projectId: project.id,
        conversationId: conversation.conversationId,
        title: next,
      }));
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(false));
  };

  const createIconButton = (options: {
    label: string;
    icon: string;
    active?: boolean;
    onClick: () => void;
  }): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dpp-project-panel__icon-button';
    button.title = options.label;
    button.setAttribute('aria-label', options.label);
    if (options.active) button.dataset.active = 'true';
    button.innerHTML = options.icon;
    button.addEventListener('click', options.onClick);
    return button;
  };

  /**
   * 会话行的菜单按钮：**再点一次要能关掉**。
   *
   * ⚠️ 不能只调 `openConversationMenu` —— 它开完会挂一个 capture 阶段的
   * 「下一次点击就关闭」监听，而这次的点击正是那一次：菜单会被立刻关掉，
   * 用户看到的是「点了没反应 / 关不掉」。所以这里按「当前是否已为该行打开」切换。
   */
  const toggleConversationMenu = (
    project: ProjectContext,
    conversation: ProjectConversation,
    anchor: HTMLElement,
  ): void => {
    const isOpen = openMenuConversationId === conversation.conversationId;
    if (isOpen) {
      closeConversationMenu();
      return;
    }
    openConversationMenu(project, conversation, anchor);
  };

  /**
   * 会话行的 `⋯` 浮层。用 `position: fixed` 自建，不依赖页面自己的弹层组件
   * （z.ai 的菜单是 Svelte 内部状态驱动的，外部触发不了）。
   */
  const openConversationMenu = (
    project: ProjectContext,
    conversation: ProjectConversation,
    anchor: HTMLElement,
  ): void => {
    const labels = dependencies.getLabels();
    closeConversationMenu();

    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.className = 'dpp-project-panel__menu';
    menu.setAttribute('role', 'menu');

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'dpp-project-panel__menu-item';
    rename.setAttribute('role', 'menuitem');
    rename.innerHTML = `${ICON_RENAME}<span></span>`;
    rename.querySelector('span')!.textContent = labels.renameConversation;
    rename.addEventListener('click', () => {
      closeConversationMenu();
      const titleButton = document.querySelector<HTMLButtonElement>(
        `#${PANEL_ID} [data-dpp-conversation-id="${cssEscape(conversation.conversationId)}"] .dpp-project-panel__conversation-title`,
      );
      if (titleButton) beginRename(project, conversation, titleButton);
    });
    menu.append(rename);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'dpp-project-panel__menu-item';
    remove.setAttribute('role', 'menuitem');
    remove.innerHTML = `${ICON_UNLINK}<span></span>`;
    remove.querySelector('span')!.textContent = labels.removeFromProjectNamed(project.name);
    remove.addEventListener('click', () => {
      closeConversationMenu();
      mutate(() => dependencies.removeConversation(conversation.conversationId));
    });
    menu.append(remove);

    document.body.append(menu);
    positionMenu(menu, anchor);
    openMenuConversationId = conversation.conversationId;
    openMenuAnchor = anchor;

    // 点到别处 / 滚动 / 缩放就关掉。
    //
    // ⚠️ **点到锚点自己不算「别处」** —— 那个点击会走按钮自己的 toggle 处理器
    // （capture 阶段先关掉、冒泡阶段按钮又开一次，表现就是「再按 ⋯ 关不掉」）。
    // 这里放行锚点内的点击，让 toggle 去决定开关。
    setTimeout(() => {
      document.addEventListener('click', handleOutsideMenuClick, { once: true, capture: true });
      document.addEventListener('scroll', closeConversationMenu, { once: true, capture: true });
      window.addEventListener('resize', closeConversationMenu, { once: true, capture: true });
    }, 0);
  };

  const handleOutsideMenuClick = (event: MouseEvent): void => {
    const anchor = openMenuAnchor;
    if (anchor && event.target instanceof Node && anchor.contains(event.target)) return;
    closeConversationMenu();
  };

  const closeConversationMenu = (): void => {
    openMenuConversationId = null;
    openMenuAnchor = null;
    document.getElementById(MENU_ID)?.remove();
  };

  // 页面 DOM 变动时只做**挂载检查**（节点被 Svelte 换掉就补挂），不重绘 ——
  // 重绘会把滚动位置清零，而这里的触发源是整页变动（流式输出时每秒几十次）。
  const observer = new MutationObserver((records) => {
    if (stopped) return;
    const relevant = records.some((record) => !isPanelNode(record.target));
    if (relevant) ensureMounted();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  refresh();

  return {
    refresh,
    render,
    backfillNow,
    stop() {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      clearBackfillTimers();
      closeConversationMenu();
      document.getElementById(PANEL_ID)?.remove();
      document.getElementById(PANEL_STYLE_ID)?.remove();
    },
  };
}

/**
 * 把浮层贴到锚点上。用**实测的浮层尺寸**钳制 —— 不能用视口宽度当菜单宽度的上限，
 * 那样等于没钳（浮层会有一半落到屏幕外）。
 */
function positionMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const anchorRect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const margin = MENU_VIEWPORT_MARGIN_PX;

  // 默认贴在锚点下方；下方放不下就翻到上方。
  let top = anchorRect.bottom + MENU_GAP_PX;
  if (top + menuRect.height > window.innerHeight - margin) {
    top = Math.max(margin, anchorRect.top - menuRect.height - MENU_GAP_PX);
  }

  // 右对齐到锚点，再夹进视口。
  const left = Math.max(
    margin,
    Math.min(
      anchorRect.right - menuRect.width,
      window.innerWidth - menuRect.width - margin,
    ),
  );

  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(left)}px`;
}

/** 侧边栏根节点。 */
function getSidebar(): HTMLElement | null {
  return document.getElementById(SIDEBAR_ID);
}

/**
 * 定位账号行（面板插在它之前）。主路径走用户菜单按钮 —— 它带 id；
 * 兜底取侧边栏里最后一个 `mt-auto` 容器（`mt-auto` 正是把账号行顶到底部的类）。
 */
function findAccountRow(): HTMLElement | null {
  const sidebar = getSidebar();
  if (!sidebar) return null;

  const userButton = sidebar.querySelector<HTMLElement>(`#${USER_MENU_BUTTON_ID}`);
  if (userButton) {
    let element: HTMLElement | null = userButton;
    while (element && element !== sidebar) {
      if (element.classList.contains('mt-auto')) return element;
      element = element.parentElement;
    }
  }

  const candidates = Array.from(sidebar.querySelectorAll<HTMLElement>('.mt-auto'));
  return candidates.length > 0 ? candidates[candidates.length - 1]! : null;
}

function ensurePanel(accountRow: HTMLElement): { panel: HTMLElement; created: boolean } | null {
  const container = accountRow.parentElement;
  if (!container) return null;

  const existing = document.getElementById(PANEL_ID);
  if (existing && existing.parentElement === container && existing.nextElementSibling === accountRow) {
    return { panel: existing, created: false };
  }
  existing?.remove();

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'dpp-project-panel';
  panel.setAttribute(PANEL_BOUND_ATTR, 'true');
  container.insertBefore(panel, accountRow);
  return { panel, created: true };
}

function isPanelNode(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) return false;
  return element.id === PANEL_ID
    || element.id === MENU_ID
    || Boolean(element.closest(`#${PANEL_ID}, #${MENU_ID}`));
}

function hasConversations(projectId: string, conversations: readonly ProjectConversation[]): boolean {
  return conversations.some((conversation) => conversation.projectId === projectId);
}

/** 会话 id 是 UUID（不含引号/反斜杠），这里只做最小转义以防万一。 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** 图标用内联 SVG 字符串（与页面 Tailwind 类无关，样式全由面板自己的 CSS 控制）。 */
const ICON_ADD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_UNLINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8.5 12h7M9.5 7.5l-2 2a3.54 3.54 0 0 0 5 5l1-1M14.5 16.5l2-2a3.54 3.54 0 0 0-5-5l-1 1"/></svg>';
const ICON_NEW_CONVERSATION = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6.5 5.5h8a2 2 0 0 1 2 2v1M5 12.5v-5a2 2 0 0 1 2-2h1M5 12.5v4a2 2 0 0 0 2 2h5.5M5 12.5h7.5M17 13v6M14 16h6"/></svg>';
const ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>';
const ICON_MORE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 12h.01M12 12h.01M19 12h.01"/></svg>';
const ICON_RENAME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20h4l10-10a2.83 2.83 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4"/></svg>';

/**
 * 面板样式。刻意全部自包含（`dpp-project-panel__*` 前缀 + 自己的 style 节点），
 * 不继承页面 Tailwind 类，免得 z.ai 改版时样式跟着漂。
 */
function injectStyles(): void {
  if (document.getElementById(PANEL_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PANEL_STYLE_ID;
  style.textContent = `
    #${PANEL_ID} {
      display: flex;
      flex-direction: column;
      /* 面板插在一个 flex 列容器里（历史列表 + 横幅 + 账号行）。
         默认的 flex-shrink: 1 会把它压到内容高度以下 —— 于是内容只有两行也照样
         顶出滚动条。flex: none 让它按内容撑开，只有真超过 max-height 才滚动。 */
      flex: none;
      max-height: ${PANEL_MAX_HEIGHT_PX}px;
      margin: 0 6px 4px;
      padding: 4px 0;
      border-top: 1px solid rgba(0, 0, 0, 0.08);
      font-size: 12px;
      color: #1f1f1f;
    }

    /* 侧边栏收起时整块隐藏，避免溢出。 */
    #${SIDEBAR_ID}[data-collapsed="true"] #${PANEL_ID} {
      display: none !important;
    }

    #${PANEL_ID} .dpp-project-panel__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 2px 8px 4px;
    }

    #${PANEL_ID} .dpp-project-panel__heading {
      font-size: 11px;
      font-weight: 600;
      opacity: 0.55;
    }

    #${PANEL_ID} .dpp-project-panel__body {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
    }

    #${PANEL_ID} .dpp-project-panel__empty {
      padding: 6px 8px;
      font-size: 11px;
      opacity: 0.5;
    }

    #${PANEL_ID} .dpp-project-panel__project {
      margin-bottom: 1px;
    }

    #${PANEL_ID} .dpp-project-panel__project-row {
      display: flex;
      align-items: center;
      gap: 2px;
      min-height: 30px;
      border-radius: 8px;
    }

    #${PANEL_ID} .dpp-project-panel__project-row:hover {
      background: rgba(0, 0, 0, 0.05);
    }

    #${PANEL_ID} .dpp-project-panel__project-toggle {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 5px 6px;
      background: none;
      border: 0;
      border-radius: 8px;
      font: inherit;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }

    #${PANEL_ID} .dpp-project-panel__caret {
      flex: none;
      width: 9px;
      opacity: 0.5;
      font-size: 9px;
    }

    #${PANEL_ID} .dpp-project-panel__project-name {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      /* 700 而不是 600：中文系统字体（如 Windows 的微软雅黑）通常只有
         Regular / Bold 两档，600 会回落到 Regular，看不出加粗。 */
      font-weight: 700;
    }

    #${PANEL_ID} .dpp-project-panel__project-count {
      flex: none;
      font-size: 10px;
      opacity: 0.45;
    }

    /* 图标按钮组：**常显**，不做 hover 才显现。
       面板本身有高度上限，hover 显现会让用户先要「找到」按钮才能操作。 */
    #${PANEL_ID} .dpp-project-panel__project-actions {
      flex: none;
      display: flex;
      align-items: center;
      gap: 1px;
      padding-right: 3px;
    }

    #${PANEL_ID} .dpp-project-panel__icon-button {
      display: inline-grid;
      place-items: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      opacity: 0.55;
      cursor: pointer;
    }

    #${PANEL_ID} .dpp-project-panel__icon-button:hover,
    #${PANEL_ID} .dpp-project-panel__icon-button[data-active="true"] {
      background: rgba(0, 0, 0, 0.08);
      opacity: 1;
    }

    #${PANEL_ID} .dpp-project-panel__icon-button[data-active="true"] {
      color: #2563eb;
    }

    #${PANEL_ID} .dpp-project-panel__icon-button svg {
      width: 15px;
      height: 15px;
    }

    #${PANEL_ID} .dpp-project-panel__pending {
      margin: 1px 8px 3px;
      padding: 2px 6px;
      border-radius: 5px;
      background: rgba(59, 130, 246, 0.12);
      color: #2563eb;
      font-size: 10px;
    }

    #${PANEL_ID} .dpp-project-panel__conversations {
      padding: 1px 0 3px 13px;
    }

    #${PANEL_ID} .dpp-project-panel__conversation {
      display: flex;
      align-items: center;
      gap: 4px;
      min-height: 28px;
      border-radius: 6px;
    }

    #${PANEL_ID} .dpp-project-panel__conversation:hover {
      background: rgba(0, 0, 0, 0.05);
    }

    #${PANEL_ID} .dpp-project-panel__conversation-title {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 4px 5px;
      background: none;
      border: 0;
      border-radius: 6px;
      font: inherit;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }

    #${PANEL_ID} .dpp-project-panel__conversation-age {
      flex: none;
      font-size: 10px;
      opacity: 0.4;
    }

    /* 会话行的菜单按钮同样常显（与项目行图标一致）。 */
    #${PANEL_ID} .dpp-project-panel__conversation-menu-button {
      flex: none;
      display: inline-grid;
      place-items: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      opacity: 0.45;
      cursor: pointer;
    }

    #${PANEL_ID} .dpp-project-panel__conversation-menu-button:hover {
      background: rgba(0, 0, 0, 0.08);
      opacity: 1;
    }

    #${PANEL_ID} .dpp-project-panel__conversation-menu-button svg {
      width: 14px;
      height: 14px;
    }

    #${PANEL_ID} .dpp-project-panel__rename-input {
      flex: 1 1 auto;
      min-width: 0;
      margin: 1px 0;
      padding: 3px 5px;
      border: 1px solid rgba(59, 130, 246, 0.55);
      border-radius: 6px;
      background: #ffffff;
      font: inherit;
      color: inherit;
      outline: none;
    }

    #${PANEL_ID} .dpp-project-panel__more {
      display: block;
      width: calc(100% - 6px);
      margin: 1px 3px;
      padding: 3px 5px;
      background: none;
      border: 0;
      border-radius: 6px;
      font: inherit;
      font-size: 11px;
      color: inherit;
      opacity: 0.55;
      text-align: left;
      cursor: pointer;
    }

    #${PANEL_ID} .dpp-project-panel__more:hover {
      background: rgba(0, 0, 0, 0.05);
      opacity: 0.9;
    }

    #${PANEL_ID} .dpp-project-panel__status {
      padding: 3px 8px 1px;
      font-size: 10px;
      color: #dc2626;
    }

    #${MENU_ID} {
      position: fixed;
      z-index: 2147483000;
      display: grid;
      min-width: 178px;
      padding: 4px;
      border-radius: 10px;
      border: 1px solid rgba(0, 0, 0, 0.1);
      background: #ffffff;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
      font-size: 12px;
      color: #1f1f1f;
    }

    #${MENU_ID} .dpp-project-panel__menu-item {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr);
      align-items: center;
      gap: 8px;
      min-height: 32px;
      padding: 0 9px;
      background: none;
      border: 0;
      border-radius: 7px;
      font: inherit;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }

    #${MENU_ID} .dpp-project-panel__menu-item:hover {
      background: rgba(0, 0, 0, 0.06);
    }

    #${MENU_ID} .dpp-project-panel__menu-item svg {
      width: 15px;
      height: 15px;
      opacity: 0.6;
    }
  `;
  document.head.append(style);
}
