import type { BrowserDialogState } from './types';

type DebuggerApi = typeof chrome.debugger;
type DebuggerSession = chrome.debugger.DebuggerSession;

// Dialogs are transient: entries older than this are treated as gone so a
// stale Page.javascriptDialogOpening record cannot be replayed later.
const BROWSER_DIALOG_MAX_AGE_MS = 30_000;

export class BrowserControlError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'BrowserControlError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class BrowserConnection {
  private readonly chromeApi: typeof chrome;
  private readonly dialogs = new Map<number, BrowserDialogState>();
  private attachedTabId: number | null = null;
  private detachListenerRegistered = false;
  private eventListenerRegistered = false;

  constructor(chromeApi: typeof chrome) {
    this.chromeApi = chromeApi;
  }

  get tabId(): number | null {
    return this.attachedTabId;
  }

  get attached(): boolean {
    return this.attachedTabId !== null;
  }

  getLatestDialog(tabId: number): BrowserDialogState | null {
    const dialog = this.dialogs.get(tabId) ?? null;
    if (!dialog) return null;
    if (Date.now() - dialog.seenAt > BROWSER_DIALOG_MAX_AGE_MS) {
      // Dialogs are transient; a stale entry must not be replayed for a
      // dialog that has long since been dismissed (dialog entry expiry).
      this.dialogs.delete(tabId);
      return null;
    }
    // The caller is actively using this entry: refresh it so a dialog the
    // user is still reading does not expire mid-interaction. The authoritative
    // removal is Page.javascriptDialogClosed; the age window is only a
    // fallback for missed close events.
    dialog.seenAt = Date.now();
    return dialog;
  }

  clearDialog(tabId: number): void {
    this.dialogs.delete(tabId);
  }

  async attach(tabId: number): Promise<void> {
    if (this.attachedTabId === tabId) return;
    if (this.attachedTabId !== null) await this.detach();

    const debuggerApi = this.getDebuggerApi();
    await debuggerApi.attach({ tabId }, '1.3');
    this.attachedTabId = tabId;
    this.registerListeners();

    try {
      await this.sendCommand('Runtime.enable');
      await this.sendCommand('Page.enable');
      await this.sendCommand('DOM.enable');
      await this.sendCommand('Accessibility.enable');
      await this.sendCommand('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    } catch (error) {
      // ⚠️⚠️ **初始化没走完就把绑定收回去** —— 留着的话下一次 `attach(同一标签)` 会走
      // 上面那条「同一条就 return」的早退，**一条 enable 都不重发** ⇒ 那几个 CDP 域永远
      // 没启用（`Accessibility.getFullAXTree` 依赖 `Accessibility.enable`、
      // `DOM.resolveNode` 依赖 `DOM.enable`），而 `attached` 报 `true`。
      // 那个中间态**没有任何出口**：`attach` 早退、`onDetach` 不触发、`detach` 又要有人调。
      //
      // ⚠️ **这里与 `detach()` 的「失败保留绑定」方向相反，是刻意的** —— 那条守的是
      // 「别在浏览器还挂着时先认账断开」，这条的意图是**丢弃**这条半成品会话。
      // 与 `TabKeepAliveSession.attach` 同口径。
      await this.detach().catch(() => { this.attachedTabId = null; });
      throw error;
    }
  }

  /**
   * 断开当前附着。
   *
   * ⚠️⚠️ **成功（或「本来就没挂」）之后才清 `attachedTabId`** —— 先清再 await 的话，
   * 一次非「已掉线」的失败会让内部状态与浏览器实际状态分叉：本地以为断了、Chrome 侧
   * 仍然挂着我们那条会话。而那个假状态**无法自愈**：
   * - `attach` 第一行是「已在同一条就 return」—— 本地是 null，所以会重新 attach，
   *   撞上 `Another debugger is already attached`（指的是**我们自己**那条僵尸会话）；
   * - `releaseUncontrollableTarget` 第一行读 `connection.tabId`，null 就直接跳过；
   * - `onDetach` 监听也是 `source.tabId !== this.attachedTabId` 才处理，null 时永不匹配。
   * ⇒ 只有 service worker 重启才能恢复。**与 `TabKeepAliveSession.detach` 同口径。**
   */
  async detach(): Promise<void> {
    if (this.attachedTabId === null) return;
    const tabId = this.attachedTabId;
    try {
      await this.getDebuggerApi().detach({ tabId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 「已经掉了」（DevTools 顶掉 / 标签关了 / 标签不存在）不是错误 —— 目标状态已达成。
      // ⚠️ 两种「标签没了」的措辞来自不同 API，都要认：
      // `chrome.tabs.*` 是 `No tab with id: N.`，`chrome.debugger.*` 是
      // `No tab with given id N.`（Chromium `kNoTargetError` 模板里 `given` 夹在中间）。
      if (
        message.includes('not attached') ||
        message.includes('No tab with id') ||
        message.includes('No tab with given id')
      ) {
        this.attachedTabId = null;
        return;
      }
      // ⚠️ **其它失败时保留 `attachedTabId`**，让调用方看到真实状态（仍是「已连接」），
      // 下一次 `detach` / `attach` 也能基于正确的前提做决定。
      throw error;
    }
    this.attachedTabId = null;
  }

  /**
   * 发一条 CDP 命令。
   *
   * ⚠️⚠️ **`signal` 是这条链上唯一的上界** —— `chrome.debugger.sendCommand` 本身
   * **没有超时**：页面卡死、标签被冻、CDP 会话半掉线时那个 Promise 可以永不 settle。
   * 而它的调用方一路都是裸 `await`（`service.ts` 的十几个动作 → `providerRegistry.execute`
   * → `executeRuntimeToolCall`），没有任何一环会放弃等待 ⇒ 一条挂住的 CDP 命令能让
   * 整条 `EXECUTE_TOOL_CALL` 卡死、`pendingExecutions` 永不减、续跑循环停在 `running`。
   *
   * ⚠️ **取消之后底层那次调用仍在飞** —— `Promise.race` 只是让我们不再等它。
   * 这是有意的取舍：留一个在飞的读命令无害（结果没人接），而「一直等」是致命的。
   */
  async sendCommand<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.attachedTabId === null) {
      throw new BrowserControlError('browser_control_not_attached', 'No browser tab is attached.', {
        retryable: true,
      });
    }
    /**
     * ⚠️⚠️ **abort 必须判在「发命令」之前，不能之后。**
     *
     * 原来这里是「先 `sendCommand(...)` 拿到 pending，再 `throwIfAborted(signal)`」——
     * 对 `Page.navigate` / `Input.dispatchMouseEvent` / `DOM.setFileInputFiles` 这些
     * **有副作用**的命令，signal 已经 abort 时命令**已经真的执行了**，而抛出去的文案还写着
     * "cancelled before it started"（说的是假话）。
     * `raceWithAbort` 只负责「不再等」，收不回已经发出去的那一条。
     *
     * ⚠️ 移到前面**不改变任何现有行为**：`!signal` 时本来就直接 return，不进这里；
     * 有 signal 且已 abort 时，原来也是抛同一个错（只是已经多执行了一次命令）。
     */
    if (signal) throwIfAborted(signal);
    const pending = this.getDebuggerApi().sendCommand(
      this.getSession(),
      method,
      params,
    );
    if (!signal) return ((await pending) ?? {}) as T;
    const result = await raceWithAbort(pending, signal);
    return (result ?? {}) as T;
  }

  private getSession(): DebuggerSession {
    if (this.attachedTabId === null) {
      throw new BrowserControlError('browser_control_not_attached', 'No browser tab is attached.', {
        retryable: true,
      });
    }
    return { tabId: this.attachedTabId };
  }

  private getDebuggerApi(): DebuggerApi {
    const debuggerApi = this.chromeApi.debugger;
    if (!debuggerApi?.attach || !debuggerApi.sendCommand || !debuggerApi.detach) {
      throw new BrowserControlError(
        'debugger_api_unavailable',
        'chrome.debugger is unavailable in this extension context.',
      );
    }
    return debuggerApi;
  }

  private registerListeners(): void {
    const debuggerApi = this.getDebuggerApi();
    if (!this.detachListenerRegistered) {
      debuggerApi.onDetach.addListener((source) => {
        if (source.tabId !== this.attachedTabId) return;
        this.attachedTabId = null;
      });
      this.detachListenerRegistered = true;
    }

    if (!this.eventListenerRegistered) {
      debuggerApi.onEvent.addListener((source, method, params) => {
        // ⚠️ **与 `TabKeepAliveSession.registerListeners` 同款判据** —— 两处守的是同一件事
        // （`DebuggerSession.tabId` 是否可用），口径必须一致。
        // ⚠️ 类型上它是 `tabId?: number`（**可选**，扩展/子会话的 session 不带 tabId），
        // 所以判定要写 `typeof !== 'number'`；不要写成 `!source.tabId` —— 那种写法顺带
        // 排掉了 `0`，而 `0` 在 Chrome 里不是合法 tab id，多挡一格只会让人以为事出有因。
        if (typeof source.tabId !== 'number') return;
        if (method === 'Page.javascriptDialogClosed') {
          // Authoritative removal: the browser reports the dialog is gone, so
          // the entry must not be replayed by a later handleDialog call.
          this.dialogs.delete(source.tabId);
          return;
        }
        if (method !== 'Page.javascriptDialogOpening') return;
        const payload = params as {
          type?: unknown;
          message?: unknown;
          defaultPrompt?: unknown;
        } | undefined;
        this.dialogs.set(source.tabId, {
          type: typeof payload?.type === 'string' ? payload.type : 'dialog',
          message: typeof payload?.message === 'string' ? payload.message : '',
          defaultPrompt: typeof payload?.defaultPrompt === 'string'
            ? payload.defaultPrompt
            : undefined,
          seenAt: Date.now(),
        });
      });
      this.eventListenerRegistered = true;
    }
  }
}

/**
 * `AbortSignal` 与一个可能永不 settle 的 Promise 竞速。
 *
 * ⚠️ **取消时抛的是 `BrowserControlError('browser_control_aborted')`，不是 `DOMException`** ——
 * 上层 `normalizeError` 会把非 `BrowserControlError` 一律折成 `browser_control_failed`
 * 且 `retryable: true`，那会让「这次动作被超时取消」看起来像「工具本身坏了、可以重试」。
 * ⚠️ **监听器必须摘** —— 一次动作会发十几条命令，每条都往同一个 signal 上挂 `abort`
 * 而不摘，长时间运行会累积成内存泄漏。
 */
function raceWithAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new BrowserControlError(
        'browser_control_aborted',
        'The browser command was cancelled before it completed.',
        { retryable: true },
      ));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new BrowserControlError(
    'browser_control_aborted',
    'The browser command was cancelled before it started.',
    { retryable: true },
  );
}
