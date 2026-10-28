import type { RuntimeCommandHandler } from '../../core/messaging/runtime-command-registry';
import {
  createLibraryRuntimeHandlers,
  type LibraryRuntimeHandlerDependencies,
} from './library-handlers';
import {
  createLocalPreferenceRuntimeHandlers,
  type LocalPreferenceRuntimeHandlerDependencies,
} from './local-preference-handlers';
import {
  createMemoryRuntimeHandlers,
  type MemoryRuntimeHandlerDependencies,
} from './memory-handlers';
import {
  createSkillRuntimeHandlers,
  type SkillRuntimeHandlerDependencies,
} from './skill-handlers';

export interface PersistenceRuntimeHandlerDependencies {
  memory: MemoryRuntimeHandlerDependencies;
  skill: SkillRuntimeHandlerDependencies;
  library: LibraryRuntimeHandlerDependencies;
  localPreference: LocalPreferenceRuntimeHandlerDependencies;
}

export function createPersistenceRuntimeHandlers(
  dependencies: PersistenceRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    ...createMemoryRuntimeHandlers(dependencies.memory),
    ...createSkillRuntimeHandlers(dependencies.skill),
    ...createLibraryRuntimeHandlers(dependencies.library),
    ...createLocalPreferenceRuntimeHandlers(dependencies.localPreference),
  ]);
}
