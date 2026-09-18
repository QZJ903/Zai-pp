import type { RuntimeCommandHandler } from '../../core/messaging/runtime-command-registry';
import {
  createAutomationRuntimeHandlers,
  type AutomationRuntimeHandlerDependencies,
} from './automation-runtime-handlers';
import {
  createUsageRuntimeHandlers,
  type UsageRuntimeHandlerDependencies,
} from './usage-runtime-handlers';

export interface BackgroundRuntimeHandlerDependencies {
  usage: UsageRuntimeHandlerDependencies;
  automation: AutomationRuntimeHandlerDependencies;
}

export function createBackgroundRuntimeHandlers(
  dependencies: BackgroundRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    ...createUsageRuntimeHandlers(dependencies.usage),
    ...createAutomationRuntimeHandlers(dependencies.automation),
  ]);
}
