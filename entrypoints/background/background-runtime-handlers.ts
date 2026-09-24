import type { RuntimeCommandHandler } from '../../core/messaging/runtime-command-registry';
import {
  createAutomationRuntimeHandlers,
  type AutomationRuntimeHandlerDependencies,
} from './automation-runtime-handlers';
import {
  createUsageRuntimeHandlers,
  type UsageRuntimeHandlerDependencies,
} from './usage-runtime-handlers';
import {
  createZaiModelRuntimeHandlers,
  type ZaiModelRuntimeHandlerDependencies,
} from './zai-model-handlers';

export interface BackgroundRuntimeHandlerDependencies {
  usage: UsageRuntimeHandlerDependencies;
  automation: AutomationRuntimeHandlerDependencies;
  zaiModel: ZaiModelRuntimeHandlerDependencies;
}

export function createBackgroundRuntimeHandlers(
  dependencies: BackgroundRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    ...createUsageRuntimeHandlers(dependencies.usage),
    ...createAutomationRuntimeHandlers(dependencies.automation),
    ...createZaiModelRuntimeHandlers(dependencies.zaiModel),
  ]);
}
