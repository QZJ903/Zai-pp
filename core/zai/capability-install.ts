/**
 * 内容脚本**启动链**的编排层 —— 依赖全部注入，本模块不 import 任何站点模块。
 *
 * ## 为什么要有这一层
 *
 * 这段编排原本直接写在 `entrypoints/zai.content.ts` 的 `main()` 里，而那个文件
 * **不能被测试 import**（它在模块顶层执行 `defineContentScript(...)`）。
 * 于是「这几处安装有没有真的接上」只能靠**读源码做 AST 断言**去逼近 ——
 * 而 AST 断言只能问「源码里有没有出现这个名字」，问不出「它到底跑没跑到」。
 * 实测代价：这一类守卫先后被下面这些写法绕过（每一种都 `tsc` 干净）：
 * - 把调用挪进一个永不执行的嵌套函数 / 死类 / 死箭头函数；
 * - 在 `main()` 里再声明一个同名标识符（`const` / 解构 / `catch` 参数 / 形参）顶掉真身；
 * - 把真身改名、在文件末尾补一个同名函数靠**声明提升**接管调用点；
 * - 把 import 换成同名的本地 stub；
 * - 在同名可达函数体内塞一个**诱饵**同名函数，让「按名字找声明」落到它身上。
 *
 * ⇒ 把编排抽到本模块，测试就能**真的调它**并传桩依赖：判据从
 * 「源码里有没有这个名字」变成「**调了它之后，桩有没有被调**」——
 * 上面那一整族绕过在结构上不再成立（不是被堵住，是没有落点了）。
 *
 * ## 两条不变量（测试守着）
 *
 * ① **顺序**：安装顺序是有语义的，不是随手排的 —— 见 `installZaiCapabilities`
 *    内部注释里逐条的理由。
 * ② **不等 promise 的那几处必须仍然不等** —— `installBackgroundCapability` /
 *    `toolPanel.install` / `refreshZaiAuth` 都是「可选增强」，它们挂住启动链会
 *    让 `loadAndSyncRuntimeState` 迟迟不跑（而面板与背景都是「晚一点生效没关系」的东西）。
 *    ⚠️ **它们是 `void` 而不是 `await`，这是契约的一部分**，别顺手「修」成 await。
 */

/** 启动链需要的全部副作用 —— 由 `entrypoints/zai.content.ts` 传真实实现。 */
export interface ZaiCapabilityDeps {
  /** Stop 按钮观察器（挑战页收尾靠它，见 zai.content.ts 的说明）。 */
  installStopObserver: () => void;
  /** 地址变化观察（切会话通知 + 后台任务归属）。 */
  installSessionWatch: () => void;
  /** 拉一次背景配置并应用。**可选增强，调用方不 await**。 */
  installBackgroundCapability: () => Promise<void>;
  /** 注入 UI 主题变量并跟随页面明暗切换。 */
  installInjectedThemeWatch: () => void;
  /** 隐藏续跑 / nudge 模板气泡（我们自己注入的 prompt 被页面当用户消息渲染）。 */
  installContinuationBubbleHider: (options: { onHidden: (count: number) => void }) => void;
  /** 工具调用面板。**可选增强，调用方不 await**。 */
  installToolPanel: () => Promise<void>;
  /** 订阅「会话变了」，返回取消订阅函数。 */
  onSessionChange: (listener: () => void) => () => void;
  /** 面板的会话切换处理（丢旧记录 + 重拉存储腿）。 */
  handleSessionChange: () => void;
  /** 把页面 localStorage 的登录态 token 推进 chrome.storage。**调用方不 await**。 */
  refreshAuth: () => Promise<boolean>;
  /**
   * 记下「当前页面属于哪个站」—— **只在页面是可见的时候调**（见 `installZaiCapabilities`
   * 的 ⑧ / ⑧b）。
   *
   * ⚠️ **不 await** —— 写不进去只是那几条没有页面上下文的兜底链路退回默认站
   * （后台抓模型清单、自动化兜底选站），不该拖住启动。
   * ⚠️ **只有内容脚本知道这个事实**（后台读不到 `location`），所以必须由它写。
   */
  rememberViewedSite: () => Promise<boolean>;
  /**
   * 同步运行时状态（记忆 / 技能 / 工具目录 / 预设 / 联网开关）。**这一步要 await**。
   *
   * ⚠️ 返回值类型写成 `Promise<unknown>` 而不是 `Promise<void>` —— 生产的实现
   * （`loadAndSyncRuntimeState`）返回本次同步的落地结果，调用方这里不关心它。
   * 写成 `void` 会逼调用方包一层箭头把它丢掉（多一层没意义的包装）。
   */
  syncRuntimeState: () => Promise<unknown>;
  /**
   * 气泡隐藏时的回调。**可选，且生产当前不传。**
   *
   * ⚠️ 它原本的用途是打一条「隐藏了几条气泡」的日志，而那是**正常路径上的成功事件**
   * （每轮续跑都会发生）⇒ 按「不把诊断摆给用户看」的口径去掉了接线。
   * 钩子保留是为了**编排层不必为「没人听」写特例**（`onHidden` 那处照常转发）。
   */
  onContinuationBubblesHidden?: (count: number) => void;
}

/** 卸载链需要的副作用。 */
export interface ZaiCapabilityTeardownDeps {
  /** 卸掉斜杠补全（不卸会让它的**捕获阶段** keydown 监听变成孤儿、一直掐键）。 */
  disposeSkillPopup: () => void;
  /** 卸掉工具面板（不卸会留下一个观察孤儿）。 */
  disposeToolPanel: () => void;
}

/**
 * 装启动链上的全部能力。
 *
 * ⚠️⚠️ **返回的清理函数必须由调用方持有** —— 现在没有消费者（内容脚本活到页面卸载），
 * 但把它丢掉会让「将来要做热卸载」时无从下手；测试也用它验「订阅与监听确实登记了」。
 * ⚠️ 它现在清理**两样**：会话订阅 + 页面可见性监听（后者见 ⑧b）。
 */
export function installZaiCapabilities(deps: ZaiCapabilityDeps): () => void {
  // ① Stop 观察器最先装 —— 它要覆盖「页面刚起来就有 Stop」的窗口。
  deps.installStopObserver();
  // ② 地址观察要在订阅之前装，否则「启动到装完」之间的那次导航会被漏掉。
  deps.installSessionWatch();
  // ③ 背景配置：**不 await** —— 拿不到只是「背景晚一点生效」。
  void deps.installBackgroundCapability();
  deps.installInjectedThemeWatch();
  // ④ 气泡隐藏：站点选择器写死在 core/zai/continuation-bubble.ts 里，
  //    选择器错了只是气泡照旧可见、不连累主流程。
  deps.installContinuationBubbleHider({
    onHidden: (count) => deps.onContinuationBubblesHidden?.(count),
  });

  // ⑤ 工具面板：注入样式、启动「被页面重建后重挂」的观察、拉一次存储腿补真结果。
  //    ⚠️ **必须 `void` 且吞错**（`install` 内部已吞）—— 面板是可选增强，
  //    读取失败不该拦住后面的启动链（`syncRuntimeState` 还在后面）。
  void deps.installToolPanel();

  // ⑥ 切会话 ⇒ 面板丢掉旧会话的记录并重拉存储腿。
  //    ⚠️⚠️ **不接这条会出真缺陷**（真机实测）：旧会话记录的三条定位腿在新会话全 miss，
  //    兜底腿「第一个还没被占用的消息」把它挂到**新会话的消息**上
  //    ⇒ 页面上出现几个属于别的会话的工具面板。
  const unsubscribe = deps.onSessionChange(() => {
    deps.handleSessionChange();
  });

  // ⑦ 启动时把页面 localStorage 里的登录态 token 主动推进 chrome.storage。
  //    ⚠️ 后台 service worker 读不到页面 localStorage/performance，token 只能由内容脚本给；
  //    而 fetch hook 那条捕获链要**用户发出第一条消息**才会触发 —— 在此之前后台读 token
  //    只会拿到 null（表现：自动化页的模型下拉退化成内置兜底清单）。
  //    **不 await**：拿不到 token 只是那条兜底链失效，不该拖住启动。
  void deps.refreshAuth();

  // ⑧ 记下「当前页面属于哪个站」（读侧的兜底用）。
  //    ⚠️⚠️ **必须判可见性** —— 只在**这个页面就是用户眼前那一页**时写。后台放着的
  //    标签页刷新一次也会跑到这里，无条件写会把记录钉在后台那一站（用户在国际站看着、
  //    后台那个国区站标签页刷新了，记录就变成国区站）。
  //    ⚠️ **不 await** —— 写不进去只是那几条没有页面上下文的兜底链路退回默认站。
  if (document.visibilityState === 'visible') void deps.rememberViewedSite();

  // ⑧b 页面**重新可见**时再记一次 —— 那是「用户切回这一站」的那一刻，正是要记的时点。
  //    ⚠️ 「变隐藏」时**不写**：那一刻用户已经不在看这个站，而记录停在旧值恰好就是
  //    「沿用上一次」想要的语义（读侧优先实时查询，这份记录只是兜底）。
  //    ⚠️ **不 await**，与 ⑧ 同口径：写不进去只是兜底停在旧值。
  //    ⚠️ 本函数只从内容脚本的 `main()` 调一次（每个页面一个新 document），
  //    所以这里不另加幂等守卫。
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') void deps.rememberViewedSite();
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}

/**
 * 同步运行时状态 —— **这一步要 await**（后面的续跑 / 工具目录都依赖它落地）。
 *
 * ⚠️ 与上面那几处 `void` 分开成独立函数，是为了让「哪些要等、哪些不要等」这件事
 * 在类型上就看得见：这个返回 `Promise`，调用方**必须**处理它。
 * ⚠️ **形参只取它需要的那一个** —— 收整个 `ZaiCapabilityDeps` 会逼调用方
 * 在只做同步的场景下也凑齐另外十项。
 */
export function syncRuntimeStateBeforeUse(
  deps: Pick<ZaiCapabilityDeps, 'syncRuntimeState'>,
): Promise<unknown> {
  return deps.syncRuntimeState();
}

/**
 * 扩展上下文失效时把注入的 UI 全卸掉。
 *
 * ⚠️⚠️ **不卸的后果是「扩展重载后输入框打不了字」** —— 补全那个**捕获阶段**
 * keydown 监听还挂在 `document` 上、会一直掐断 Enter；面板的 MutationObserver
 * 还在观察一个再也无人消费的 DOM。两者都不报错。
 */
export function disposeZaiCapabilities(deps: ZaiCapabilityTeardownDeps): void {
  deps.disposeSkillPopup();
  deps.disposeToolPanel();
}

/**
 * `ZaiCapabilityDeps` 的**全部键名**（运行时值）。
 *
 * ⚠️⚠️ **它必须与上面的接口逐字对齐** —— 这是本项目里唯一一处「手抄的第二份清单」，
 * 而手抄必然分叉。防线是 `tests/zai-capability-install.test.ts` 的一条断言：
 * 桩依赖对象**按这份清单构造**，于是漏一个键 ⇒ `tsc` 立刻报「缺少属性」。
 * ⇒ **加新能力时改两处：接口 + 这份清单**（`tsc` 会替你发现漏改清单那一半）。
 *
 * ⚠️ 为什么需要它：内容脚本那侧的测试要断言「`main()` 传进去的依赖对象
 * 引用了真正的那些函数」，而接口在运行时不存在、拿不到键名。
 */
export const ZAI_CAPABILITY_DEP_KEYS = [
  'installStopObserver',
  'installSessionWatch',
  'installBackgroundCapability',
  'installInjectedThemeWatch',
  'installContinuationBubbleHider',
  'installToolPanel',
  'onSessionChange',
  'handleSessionChange',
  'refreshAuth',
  'rememberViewedSite',
  'syncRuntimeState',
  'onContinuationBubblesHidden',
] as const satisfies readonly (keyof ZaiCapabilityDeps)[];

// ---------------------------------------------------------------------------
// 地址变化观察（会话切换的两条消费者）
// ---------------------------------------------------------------------------

/** 地址观察需要的副作用与宿主对象。 */
export interface ZaiSessionWatchDeps {
  /** 把当前地址里的会话 id 补给还没拿到它的在跑任务（幂等）。 */
  reportLiveSession: () => void;
  /** 通知页面侧的订阅者「会话变了」。 */
  notifySessionChange: () => void;
  /** wxt 的 `wxt:locationchange` 注册器（拿不到时会抛，被吞掉）。 */
  addLocationChangeListener: (handler: () => void) => void;
  /** 轮询间隔（生产 1s；测试可压到 1ms）。 */
  intervalMs: number;
  /** 注入 `window`（测试用；缺省用全局）。 */
  window?: Window;
  /** 注入 `setInterval`（测试用；缺省用全局）。 */
  setInterval?: (handler: () => void, ms: number) => unknown;
}

/**
 * 装地址观察：三个监听源 + 一个轮询，全部走**同一个处理器**。
 *
 * ⚠️⚠️ **「同一个处理器」是这条链的要点** —— 三处各写一遍回调会让其中一处
 * 漏掉某个消费者（例如只有 `popstate` 那条调了 `notifySessionChange`），
 * 而那种分叉是静默的：地址变了、订阅者收不到。
 *
 * ⚠️ **为什么不用手包 `history.pushState`**：内容脚本跑在隔离世界，
 * 包不到页面自己那个 `history` 对象。
 * ⚠️ **1s 轮询留着**：地址切换发生在「模型开始回答前后」，远早于用户能按暂停。
 * ⚠️ **`wxt:locationchange` 拿不到时只记一行日志** —— 还有 popstate / hashchange / 轮询兜底，
 * 不该因为一个可选监听器不可用就整条链不装。
 */
export function installZaiSessionWatch(deps: ZaiSessionWatchDeps): void {
  const target = deps.window ?? window;
  const onLocationMaybeChanged = () => {
    deps.reportLiveSession();
    deps.notifySessionChange();
  };

  try {
    deps.addLocationChangeListener(onLocationMaybeChanged);
  } catch (error) {
    console.log('[Zai++] locationchange listener unavailable', error);
  }
  target.addEventListener('popstate', onLocationMaybeChanged);
  target.addEventListener('hashchange', onLocationMaybeChanged);
  (deps.setInterval ?? setInterval)(onLocationMaybeChanged, deps.intervalMs);
}

/** 会话变化通知链的注入项。 */
export interface ZaiSessionNotifyDeps {
  /** 取当前会话 id（拿不到返回 null）。 */
  getCurrentSessionId: () => string | null;
  /** 注入 `sessionChangeListeners`（生产里是模块级 Set）。 */
  listeners: Set<() => void>;
  /** 注入上一次通知出去的会话 id（生产里是模块级变量，靠 getter/setter 读写）。 */
  readLastNotified: () => string | null;
  writeLastNotified: (value: string | null) => void;
}

/**
 * 通知所有订阅者「会话变了」。
 *
 * ⚠️⚠️ **先比对会话 id，没真变就不打扰订阅者** —— 1s 轮询会每秒调到这里，
 * 不去重的话项目面板会被每秒重绘一次。
 * ⚠️ **单个 listener 抛错只记日志、不中断其余** —— 一个消费者的 bug 不该让
 * 另一个消费者收不到通知（`sessionChangeListeners` 里同时有面板与项目面板）。
 */
export function notifyZaiSessionChange(deps: ZaiSessionNotifyDeps): void {
  const sessionId = deps.getCurrentSessionId();
  if (sessionId === deps.readLastNotified()) return;
  deps.writeLastNotified(sessionId);
  for (const listener of deps.listeners) {
    try {
      listener();
    } catch (error) {
      console.log('[Zai++] session change listener failed', error);
    }
  }
}
