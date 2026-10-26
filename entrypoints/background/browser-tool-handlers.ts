import {
  definePayloadlessRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import type {
  BrowserControlSettings,
  BrowserControlState,
  BrowserControlTarget,
} from '../../core/browser-control/types';
import type { TabKeepaliveSettings } from '../../core/browser-control/keepalive-settings';
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
  /** 读「后台保活」开关。⚠️ 与浏览器控制的 settings 是两套，别混。 */
  getTabKeepaliveSettings(): Promise<TabKeepaliveSettings>;
  /** 写「后台保活」开关。⚠️ 关掉时实现方**必须**同时卸掉已挂的会话。 */
  setTabKeepaliveEnabled(enabled: boolean): Promise<TabKeepaliveSettings>;
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
    definePayloadlessRuntimeCommandHandler('GET_TAB_KEEPALIVE_SETTINGS', () => (
      dependencies.getTabKeepaliveSettings()
    )),
    // ⚠️ **不要求 tab-scoped sender** —— 侧边栏（扩展页面）也要能改这个开关，
    // 而它的 `context.tabId` 是 undefined。这条命令不操作任何具体标签。
    // ⚠️ **刻意不广播**（与 `SET_BROWSER_CONTROL_ENABLED` 不同）：那个开关的效果是
    // 全局的（工具目录、浏览器控制状态都要跟着变），而这个只影响「本扩展要不要给某个
    // z.ai 标签挂 debugger」，没有别的消费者需要立刻知道。
    // ⇒ 代价是：同时开两个侧边栏时，另一份的开关会停在旧值，直到那个页面重开
    // （它挂载时读 `GET_TAB_KEEPALIVE_SETTINGS`）。**刻意接受**，不为它新增一条广播类型。
    defineToolPayloadRuntimeCommandHandler('SET_TAB_KEEPALIVE_ENABLED', async (payload) => {
      await dependencies.setTabKeepaliveEnabled(payload.enabled);
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
