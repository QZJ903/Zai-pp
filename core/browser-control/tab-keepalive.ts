/**
 * **让若干个后台标签页继续正常跑** —— 一条独立于浏览器控制的 CDP 会话（按标签各一条）。
 *
 * ## 为什么需要它
 *
 * 本项目的续跑链跑在**页面里**：扩展把 prompt 写进输入框、让页面自己提交，然后靠页面的
 * fetch-hook 读 SSE、靠内容脚本的续跑循环往下推。而 Chrome 会把后台标签节流：
 * 隐藏超过 5 分钟可能直接冻结（定时器 / Promise 回调 / 事件处理全部暂停），
 * 在那之前 `setTimeout` 也已经降到每秒一次。
 *
 * 表现是「只打开了网页、没有后续」：发送链靠 80–150ms 的短轮询串起来
 * （`waitForSendButtonEnabled` 4 秒预算、`waitForSendEvidence` 5 秒预算），
 * 被节流到每秒一次之后，预算还没走完几轮就超时 ⇒ 判「没发出去」⇒ 收尾。
 *
 * ## 两条命令就够
 *
 * - `Emulation.setFocusEmulationEnabled { enabled: true }` —— 页面自报 focused；
 * - `Page.setWebLifecycleState { state: 'active' }` —— 解除冻结。
 *
 * 合起来让后台标签「以为自己在前台」：rAF 正常跑、定时器准确、输入事件照常派发，
 * 而**窗口可以是最小化的**。⚠️ 这与「这个标签是不是真的在前台」无关 —— 不需要抢焦点。
 *
 * ## ⚠️⚠️ 前台不挂 —— 判据在**本类**，不在页面
 *
 * 挂上 debugger 会让 Chrome 在**所有窗口**顶部画一条「Zai++ started debugging this browser」
 * （Chromium 走 `ShowGlobally`，不是只画在被调试的那个窗口）。而**前台页面本来不被节流**，
 * 挂上去是纯代价。⇒ 只有「真在后台」时才挂。
 *
 * ⚠️⚠️ **绝不能用页面自己的 `document.hidden` 当判据**：`Emulation.setFocusEmulationEnabled`
 * 会把页面**自报 visible** —— 挂上之后页面自己看到的就是「我在前台」，下一轮判定就会卸掉，
 * 卸掉之后又变 hidden ⇒ **在 attach / detach 之间无限来回跳**，横幅反复出现，
 * 而「等响应」那段长窗口里大概率正处于卸掉的状态 ⇒ 保活等于没起作用。
 * ⇒ 判据只能用**不受 CDP 模拟影响**的源：`chrome.tabs.get(tabId).active` +
 * `chrome.windows.get(windowId).focused`。
 *
 * ## ⚠️ 为什么另起一套会话，不复用 `BrowserConnection`
 *
 * 那个类是**单例**且只持一个 `attachedTabId`，`attach()` 第一件事就是「挂着别的就先 detach」
 * ⇒ 浏览器控制去驱动目标标签时，会把这里的保活顶掉。
 *
 * ## ⚠️ 已知代价
 *
 * - **横幅全局可见**：只要保活挂着，Chrome 会在**所有窗口**显示
 *   「Zai++ started debugging this browser」，且它的 Cancel 会掐掉本扩展**全部** CDP 会话
 *   （包括浏览器控制那份）。拦不住，这是浏览器给用户的知情权。⇒ 所以调用方要**尽量缩短**
 *   挂着的窗口（见内容脚本 `submitContinuationViaPage`：只在发送链那几秒要它）。
 * - **DevTools / 刷新会静默顶掉**：用户在页面上按 F12 或刷新页面，会话就没了，**不报错**。
 *   所以 `want()` 每次都会重新 `sync`（掉线就重挂、在线就重发那两条命令）。
 */

const DEBUGGER_PROTOCOL_VERSION = '1.3';

/** 保活所需的注入点。 */
export interface TabKeepAliveDependencies {
  chromeApi?: typeof chrome;
}

export class TabKeepAliveSession {
  private readonly chromeApi: typeof chrome | undefined;
  /**
   * **想要**保活的标签（内容脚本的意图）。
   *
   * ⚠️⚠️ **必须是集合，不能是单个 `tabId`** —— 两个自动化并发时会有两条。
   * 用一个字段时它们互相顶掉，表现为「后台那个的续跑静默断掉」。
   */
  private readonly wanted = new Set<number>();
  /**
   * **实际**挂着的标签（`wanted` ∩ 真在后台）。
   *
   * ⚠️ 与 `wanted` 分开：前者是「要不要」，后者是「此刻挂没挂」。前台标签在 `wanted` 里
   * 但不在这里 —— 这样切到前台时只需 detach，不必丢掉调用方的意图。
   */
  private readonly attached = new Set<number>();
  private listenersRegistered = false;

  constructor(dependencies: TabKeepAliveDependencies = {}) {
    this.chromeApi = dependencies.chromeApi ?? (typeof chrome === 'undefined' ? undefined : chrome);
  }

  /** 当前**实际**保活着的标签（只读快照，测试与诊断用）。 */
  get attachedTabIds(): readonly number[] {
    return [...this.attached];
  }

  /** 这条标签是否正被保活。`closeTab` 的保护判据用它。 */
  isKeepingAlive(tabId: number): boolean {
    return this.attached.has(tabId);
  }

  /**
   * 内容脚本说「我需要保活」。
   *
   * ⚠️ **只是登记意图**，挂不挂由 `sync` 按前台/后台决定。
   */
  async want(tabId: number): Promise<void> {
    this.wanted.add(tabId);
    this.registerListeners();
    await this.sync(tabId);
  }

  /** 内容脚本说「不需要了」—— 立刻卸掉这条。 */
  async unwant(tabId: number): Promise<void> {
    this.wanted.delete(tabId);
    await this.detach(tabId);
  }

  /** 丢掉全部意图并卸掉全部会话（页面卸载 / 扩展停用时用）。 */
  async clear(): Promise<void> {
    const all = [...this.attached];
    this.wanted.clear();
    for (const tabId of all) await this.detach(tabId).catch(() => undefined);
  }

  /**
   * **按当前前台状态重算某条标签该不该挂** —— 唯一的挂载决策点。
   *
   * ⚠️ 判据是 `tab.active && window.focused`（**不受 CDP 模拟影响**的源，见文件头）。
   * ⚠️ 查不到标签（已关 / chrome 报错）按「前台」处理 ⇒ 不挂。失败方向安全：
   * 少挂一次只是可能被节流，多挂一次则会让用户看到横幅。
   */
  async sync(tabId: number): Promise<void> {
    if (!this.wanted.has(tabId)) {
      await this.detach(tabId);
      return;
    }
    if (await this.isInForeground(tabId)) {
      await this.detach(tabId);
      return;
    }
    await this.attach(tabId);
  }

  /** 所有 `wanted` 标签重算一遍（标签切换 / 窗口焦点变化时调）。 */
  async syncAll(): Promise<void> {
    for (const tabId of [...this.wanted]) await this.sync(tabId).catch(() => undefined);
  }

  /**
   * 这条标签此刻是不是**真的**在前台（标签可见 + 它所在的窗口有焦点）。
   *
   * ⚠️⚠️ **不能用页面里的 `document.hidden`** —— 见文件头：它会被我们自己的
   * `Emulation.setFocusEmulationEnabled` 改成 false。
   */
  private async isInForeground(tabId: number): Promise<boolean> {
    const chromeApi = this.chromeApi;
    if (!chromeApi?.tabs?.get) return true;
    try {
      const tab = await chromeApi.tabs.get(tabId);
      if (tab.active !== true) return false;
      if (typeof tab.windowId !== 'number' || !chromeApi.windows?.get) return true;
      const window = await chromeApi.windows.get(tab.windowId);
      return window.focused === true;
    } catch {
      // 查不到（标签已关 / chrome 出错）⇒ 按「前台」处理，不挂。
      return true;
    }
  }

  /** 开始保活某条标签；已经在保活它时是幂等的。 */
  private async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) {
      // ⚠️ **在线也要重发那两条命令** —— 页面换了文档（导航 / 刷新）之后模拟状态不跟过去。
      await this.applyBackgroundEmulation(tabId);
      return;
    }
    const debuggerApi = this.getDebuggerApi();

    await this.attachReleasingStaleSession(debuggerApi, tabId);
    this.attached.add(tabId);
    try {
      await this.applyBackgroundEmulation(tabId);
    } catch (error) {
      // 命令发失败就把这条会话收回去 —— 留一条挂着的空会话只会挡住浏览器控制。
      // ⚠️ 这里与 `detach()` 的「失败保留绑定」不同：这条路的意图是**丢弃**这条会话，
      // 所以 detach 本身也失败时仍要移除（否则下一次 `sync` 会以为还连着、只重发命令）。
      await this.detach(tabId).catch(() => { this.attached.delete(tabId); });
      throw error;
    }
  }

  /**
   * **attach 时若撞上「同一条标签上已有本扩展的会话」，先放掉它再重试一次。**
   *
   * 撞上的形态是 `Another debugger is already attached to the tab with id: N.`
   * （Chromium `debugger_api_constants.cc` 的 `kAlreadyAttachedError`）——
   * 这句话**含自己**，容易被误读成「别的扩展」，实际是按 `agent_host` + `extension_id`
   * 匹配到的**本扩展**另一个 client host。唯一现实来源是浏览器控制那条会话
   * （`BrowserConnection`）还挂在同一条标签上。
   *
   * ## 为什么可以放心 detach
   *
   * `chrome.debugger.detach` 是**扩展作用域**的：只放我们自己挂的会话，碰不到 DevTools。
   * 三个方向都安全：
   * - 竞争者是浏览器控制残留 / 泄漏 ⇒ 放掉、重试成功（这正是修的那一格）；
   * - 竞争者是用户按的 F12 ⇒ 我们这侧 detach 返回 `Debugger is not attached…`（被吞掉），
   *   重试仍失败 ⇒ 行为与不重试时**完全一致**，不会误伤；
   * - 浏览器控制挂在**别的**标签上 ⇒ `{ tabId }` 只作用于这一条，无附带损伤。
   *
   * ⚠️ **只重试一次、不循环** —— 再失败就按原有语义抛给调用方（那里是 `void` + 内部 catch，
   * 退回「无保活保护」的旧行为）。
   * ⚠️ 走到这里时 `attached` 里**还没有**这条（`attach` 在成功之后才 add）⇒
   * 这次 detach **不可能**放掉我们自己刚建好的会话。
   */
  private async attachReleasingStaleSession(
    debuggerApi: typeof chrome.debugger,
    tabId: number,
  ): Promise<void> {
    try {
      await debuggerApi.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
    } catch (error) {
      if (!isAlreadyAttachedError(error)) throw error;
      await debuggerApi.detach({ tabId }).catch(() => undefined);
      await debuggerApi.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
    }
  }

  /**
   * 解除某条标签的保活（或全部）。
   *
   * ⚠️ **必须按标签解** —— 不带参数会把**所有**标签的会话一起解掉，那正是并发时代
   * 「一方收尾、另一方被静默断掉」的成因。无参形式只留给整站收摊。
   */
  async detach(tabId?: number): Promise<void> {
    if (tabId === undefined) {
      for (const id of [...this.attached]) await this.detach(id).catch(() => undefined);
      return;
    }
    if (!this.attached.has(tabId)) return;
    try {
      await this.getDebuggerApi().detach({ tabId });
      // ⚠️ **成功之后才移除** —— 见下面 catch 的说明。
      this.attached.delete(tabId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 已经掉了（DevTools 顶掉 / 标签关了）不是错误 —— 目标状态已经达成。
      //
      // ⚠️⚠️ **两种「标签没了」的措辞都要认，它们来自不同的 API**：
      // - `No tab with id: N.` —— `chrome.tabs.get/remove` 系；
      // - `No tab with given id N.` —— `chrome.debugger` 系（Chromium
      //   `debugger_api_constants.cc` 的 `kNoTargetError` 模板 `"No * with given id *."`，
      //   经 `FormatErrorMessage` 展开后 `given` 卡在中间）。
      // 只认前者的话，最典型的一种 detach 失败会掉进下面的「保留绑定」分支 ⇒
      // 循环早已结束、保活其实早没了，但集合里还留着它 ⇒ 模型接着关那条标签
      // 会被 `closeTab` 的保护判据拒掉，直到下一轮 `sync` 才自愈。
      if (
        message.includes('not attached') ||
        message.includes('No tab with id') ||
        message.includes('No tab with given id')
      ) {
        this.attached.delete(tabId);
        return;
      }
      // ⚠️⚠️ **其它错误时保留这条绑定** —— 先移除再 await 的话，这里内部状态与浏览器实际
      // 状态会分叉：之后 `sync(sameTab)` 会重走 `debuggerApi.attach`，而浏览器侧会话
      // 可能还挂着 ⇒ Chrome 报「another debugger already attached」⇒ 被调用方的空 catch
      // 吞掉 ⇒ **保活从此静默不可用**。保留绑定让下一次 `sync` 走「在线重发」那条腿。
      throw error;
    }
  }

  private async applyBackgroundEmulation(tabId: number): Promise<void> {
    const debuggerApi = this.getDebuggerApi();
    const session = { tabId };
    // ⚠️ **两条都要发，缺一条都不完整**：
    // 只发 lifecycle ⇒ 页面不冻结，但仍自报 hidden，靠 `visibilityState` 判活的逻辑照旧停；
    // 只发 focus ⇒ 自报 visible，但冻结/节流仍在。
    // ⚠️⚠️ **第一条会把页面的 `document.hidden` 改成 false** —— 所以前台判定绝不能用它，
    // 见文件头。这两条命令是「让页面以为自己在前台」，不是「页面真的在前台」。
    await debuggerApi.sendCommand(session, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    await debuggerApi.sendCommand(session, 'Page.setWebLifecycleState', { state: 'active' });
  }

  /**
   * 标签切换 / 窗口焦点变化 ⇒ 重算。
   *
   * ⚠️ **这两个监听是「前台不挂」能真正生效的关键**：用户切回 z.ai 标签时，必须**立刻**
   * 卸掉（横幅随之消失），而不是等下一次 `want()`。
   * ⚠️ **监听里的判据与 `sync` 同源**，不另写一套。
   * ⚠️ 只注册一次（`listenersRegistered`）。
   */
  private registerListeners(): void {
    if (this.listenersRegistered) return;
    const chromeApi = this.chromeApi;
    if (!chromeApi?.tabs?.onActivated || !chromeApi?.debugger?.onDetach) return;
    chromeApi.tabs.onActivated.addListener(() => { void this.syncAll(); });
    chromeApi.windows?.onFocusChanged?.addListener(() => { void this.syncAll(); });
    chromeApi.debugger.onDetach.addListener((source) => {
      if (typeof source.tabId !== 'number') return;
      // ⚠️ **只摘这一条** —— 并发时其它标签的会话必须留着。
      this.attached.delete(source.tabId);
    });
    this.listenersRegistered = true;
  }

  private getDebuggerApi(): typeof chrome.debugger {
    const debuggerApi = this.chromeApi?.debugger;
    if (!debuggerApi?.attach || !debuggerApi.sendCommand || !debuggerApi.detach) {
      // 与 `BrowserConnection` 同码：调用方按「这个环境不支持浏览器控制」处理。
      throw new Error('chrome.debugger is unavailable in this extension context.');
    }
    return debuggerApi;
  }
}

/**
 * 这条错误是不是「同一条标签上已有本扩展的会话」。
 *
 * ⚠️ 措辞来自 Chromium `debugger_api_constants.cc` 的 `kAlreadyAttachedError`
 * `"Another debugger is already attached to the * with id: *."` —— 展开后是
 * `Another debugger is already attached to the tab with id: 7.`。
 * ⚠️ **判据收到 `already attached` 就够**：`detach` 侧那两条措辞（`not attached` /
 * `No tab with …`）不含这两个词，不会误判。
 */
function isAlreadyAttachedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('already attached');
}