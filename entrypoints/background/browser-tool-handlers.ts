import {
  definePayloadlessRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import type {
  BrowserControlSettings,
  BrowserControlState,
  BrowserControlTarget,
} from '../../core/browser-control/types';
import { defineToolPayloadRuntimeCommandHandler } from './runtime-handler';

export interface BrowserToolRuntimeHandlerDependencies {
  getBrowserControlSettings(): Promise<BrowserControlSettings>;
  saveBrowserControlSettings(
    patch: Partial<BrowserControlSettings>,
  ): Promise<BrowserControlSettings>;
  setBrowserControlEnabled(enabled: boolean): Promise<BrowserControlSettings>;
  getBrowserControlState(): Promise<BrowserControlState>;
  setBrowserControlTarget(tabId: number): Promise<BrowserControlTarget>;
  detachBrowserControl(): Promise<void>;
  startTabKeepAlive(tabId: number): Promise<void>;
  /** ⚠️ **必须带 tabId** —— 只解这一条标签的保活，并发时不能波及别人（见 `tab-keepalive.ts` 文件头）。 */
  stopTabKeepAlive(tabId: number): Promise<void>;
  broadcastToolDescriptorsUpdate(excludeTabId?: number): Promise<void>;
  broadcastBrowserControlUpdate(excludeTabId?: number): Promise<void>;
}

export function createBrowserToolRuntimeHandlers(
  dependencies: BrowserToolRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    definePayloadlessRuntimeCommandHandler('GET_BROWSER_CONTROL_SETTINGS', () => (
      dependencies.getBrowserControlSettings()
    )),
    defineToolPayloadRuntimeCommandHandler('SAVE_BROWSER_CONTROL_SETTINGS', async (payload, context) => {
      const settings = await dependencies.saveBrowserControlSettings(payload ?? {});
      await dependencies.broadcastToolDescriptorsUpdate(context.tabId);
      await dependencies.broadcastBrowserControlUpdate(context.tabId);
      return settings;
    }),
    defineToolPayloadRuntimeCommandHandler('SET_BROWSER_CONTROL_ENABLED', async (payload, context) => {
      const settings = await dependencies.setBrowserControlEnabled(payload.enabled);
      if (!payload.enabled) await dependencies.detachBrowserControl();
      await dependencies.broadcastToolDescriptorsUpdate(context.tabId);
      await dependencies.broadcastBrowserControlUpdate(context.tabId);
      return settings;
    }),
    definePayloadlessRuntimeCommandHandler('GET_BROWSER_CONTROL_STATE', () => (
      dependencies.getBrowserControlState()
    )),
    defineToolPayloadRuntimeCommandHandler('SET_BROWSER_CONTROL_TARGET', async (payload, context) => {
      const target = await dependencies.setBrowserControlTarget(payload.tabId);
      await dependencies.broadcastBrowserControlUpdate(context.tabId);
      return { ok: true as const, target };
    }),
    definePayloadlessRuntimeCommandHandler('DETACH_BROWSER_CONTROL', async (context) => {
      await dependencies.detachBrowserControl();
      await dependencies.broadcastBrowserControlUpdate(context.tabId);
      return { ok: true as const };
    }),
    // ⚠️ 标签 id 取自 `context.tabId`（浏览器给的 sender），**不由内容脚本传** ——
    // 自己报的 id 可以被伪造，而这条命令会往那个标签挂 debugger。
    definePayloadlessRuntimeCommandHandler('START_TAB_KEEPALIVE', async (context) => {
      if (typeof context.tabId !== 'number') {
        throw new Error('START_TAB_KEEPALIVE requires a tab-scoped sender.');
      }
      await dependencies.startTabKeepAlive(context.tabId);
      return { ok: true as const };
    }),
    definePayloadlessRuntimeCommandHandler('STOP_TAB_KEEPALIVE', async (context) => {
      // ⚠️⚠️ **必须按标签解** —— 不带 tabId 会把**所有**标签的保活一起解掉。
      // 两个自动化并发时，一方收尾就会把另一方正在用的会话摘掉，
      // 表现为「后台那个的续跑静默断掉」（见 `tab-keepalive.ts` 的文件头）。
      // ⚠️ 标签 id 同样取自 `context.tabId`（浏览器给的 sender），不由内容脚本传。
      if (typeof context.tabId !== 'number') {
        throw new Error('STOP_TAB_KEEPALIVE requires a tab-scoped sender.');
      }
      await dependencies.stopTabKeepAlive(context.tabId);
      return { ok: true as const };
    }),
  ]);
}
