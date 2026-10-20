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
  ]);
}
