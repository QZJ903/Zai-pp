import {
  definePayloadlessRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import type {
  BackgroundConfig,
} from '../../core/types';
import {
  definePersistencePayloadRuntimeCommandHandler,
} from './runtime-handler';

export interface LocalPreferenceRuntimeHandlerDependencies {
  broadcastStateUpdate(excludeTabId?: number): Promise<void>;
  getBackgroundConfig(): Promise<BackgroundConfig | null>;
  saveBackgroundConfig(config: BackgroundConfig): Promise<void>;
  clearBackgroundConfig(): Promise<void>;
  broadcastBackgroundUpdate(config: BackgroundConfig | null): Promise<void>;
}

export function createLocalPreferenceRuntimeHandlers(
  dependencies: LocalPreferenceRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    definePayloadlessRuntimeCommandHandler('GET_BACKGROUND', () => (
      dependencies.getBackgroundConfig()
    )),
    definePersistencePayloadRuntimeCommandHandler('SAVE_BACKGROUND', async (config) => {
      await dependencies.saveBackgroundConfig(config);
      await dependencies.broadcastBackgroundUpdate(config);
      return { ok: true as const };
    }),
    definePayloadlessRuntimeCommandHandler('CLEAR_BACKGROUND', async () => {
      await dependencies.clearBackgroundConfig();
      await dependencies.broadcastBackgroundUpdate(null);
      return { ok: true as const };
    }),
  ]);
}