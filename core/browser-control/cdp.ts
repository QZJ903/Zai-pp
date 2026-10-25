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

    await this.sendCommand('Runtime.enable');
    await this.sendCommand('Page.enable');
    await this.sendCommand('DOM.enable');
    await this.sendCommand('Accessibility.enable');
    await this.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
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

  async sendCommand<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (this.attachedTabId === null) {
      throw new BrowserControlError('browser_control_not_attached', 'No browser tab is attached.', {
        retryable: true,
      });
    }
    const result = await this.getDebuggerApi().sendCommand(
      this.getSession(),
      method,
      params,
    );
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
        if (!source.tabId) return;
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

export function toBrowserControlError(error: unknown): BrowserControlError {
  if (error instanceof BrowserControlError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const retryable =
    message.includes('Cannot access') ||
    message.includes('No tab with id') ||
    message.includes('not attached') ||
    message.includes('detached') ||
    message.includes('target closed');
  return new BrowserControlError('browser_control_failed', message, { retryable });
}
