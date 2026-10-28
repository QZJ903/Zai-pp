import { describe, expect, it } from 'vitest';
import type { RuntimeMessageContext } from '../core/messaging/runtime-boundary';
import {
  TYPED_RUNTIME_COMMAND_TYPES,
  createRuntimeCommandRegistry,
  type RuntimeCommandHandler,
} from '../core/messaging/runtime-command-registry';
import type {
  LocalStateMutationStage,
} from '../core/persistence/local-state-mutation';
import {
  createSyncLocalApplyCoordinator,
  type SyncLocalApplyJournalPort,
  type SyncLocalStatePort,
  type SyncUndoPreimageV1,
} from '../core/sync/local-apply';
import { createSyncRecoveryBarrier } from '../core/sync/recovery-barrier';
import {
  createTrackedLocalStateMutationRunner,
} from '../entrypoints/background/local-state-mutation-runner';
import {
  createPersistenceMutationBindings,
} from '../entrypoints/background/persistence-mutation-bindings';

const context: RuntimeMessageContext = {
  runtimeId: 'extension-id',
  surface: 'extension_context',
  senderUrl: 'chrome-extension://extension-id/sidepanel.html',
  senderOrigin: 'chrome-extension://extension-id',
  tabId: 17,
  documentSessionId: 'document-1',
};

describe('background persistence recovery composition', () => {
  it('recovers a failed typed preset deletion from its durable journal after restart', async () => {
    const state = createDeletionState();
    const firstCoordinator = createSyncLocalApplyCoordinator(state.port, state.journal, {
      now: () => 10,
      createOperationId: () => 'delete-preset-first',
    });
    const firstBarrier = createSyncRecoveryBarrier({
      recover: firstCoordinator.recover,
      notifyRecovered: async () => undefined,
    });
    const firstRunner = createTrackedLocalStateMutationRunner({
      runWithRecovery: createRunWithRecovery(firstCoordinator),
      trackApply: (operation) => firstBarrier.trackApply(operation),
    });
    const firstRegistry = createDeletionRegistry(
      createDeletionBindings(state, firstRunner),
    );

    await expect(firstRegistry.dispatch({
      type: 'DELETE_PRESET',
      payload: { id: 'preset-1' },
    }, context)).rejects.toThrow('Local-state mutation failed and recovery remains pending');
    await expect(firstBarrier.ensureReady()).rejects.toThrow('journal clear blocked');

    expect(state.targetPresent).toBe(true);
    expect(state.currentJournal).not.toBeNull();

    state.clearBlocked = false;
    state.failMutation = false;
    const restartCoordinator = createSyncLocalApplyCoordinator(state.port, state.journal, {
      now: () => 20,
      createOperationId: () => 'delete-preset-restart',
    });
    const restartEvents: string[] = [];
    const restartBarrier = createSyncRecoveryBarrier({
      recover: restartCoordinator.recover,
      notifyRecovered: async (result) => {
        restartEvents.push(result.recovered ? 'recovered' : 'ready');
      },
    });
    const restartRunner = createTrackedLocalStateMutationRunner({
      runWithRecovery: createRunWithRecovery(restartCoordinator),
      trackApply: (operation) => restartBarrier.trackApply(operation),
    });
    const restartRegistry = createDeletionRegistry(
      createDeletionBindings(state, restartRunner),
    );

    await restartBarrier.ensureReady();
    expect(state.targetPresent).toBe(true);
    expect(state.currentJournal).toBeNull();
    expect(restartEvents).toEqual(['recovered']);

    await expect(restartRegistry.dispatch({
      type: 'DELETE_PRESET',
      payload: { id: 'preset-1' },
    }, context)).resolves.toEqual({ ok: true });

    expect(state.targetPresent).toBe(false);
    expect(state.currentJournal).toBeNull();
  });
});

function createDeletionRegistry(
  deletePreset: (id: string) => Promise<void>,
) {
  const presetHandler = {
    type: 'DELETE_PRESET' as const,
    async handle(envelope: { payload?: { id: string } }) {
      await deletePreset((envelope.payload as { id: string }).id);
      return { ok: true as const };
    },
  } as RuntimeCommandHandler;

  const typedHandlers = TYPED_RUNTIME_COMMAND_TYPES.map((type) => (
    type === 'DELETE_PRESET'
      ? presetHandler
      : {
          type,
          handle: async () => null,
        } as RuntimeCommandHandler
  ));
  return createRuntimeCommandRegistry({
    typedHandlers,
  });
}

function createDeletionBindings(
  state: DeletionState,
  runLocalStateMutation: <T>(stage: LocalStateMutationStage<T>) => Promise<T>,
) {
  return createPersistenceMutationBindings({
    runLocalStateMutation,
    stageDeletePresetAlreadyLocked: async (id) => {
      expect(id).toBe('preset-1');
      return async () => {
        state.targetPresent = false;
        if (state.failMutation) throw new Error('preset delete write failed');
      };
    },
    stageDeleteSkillAlreadyLocked: unusedMutationStage,
    stageDeleteSkillSourceAlreadyLocked: unusedMutationStage,
    importGitHubSkillSource: async () => unusedDependency(),
    importLocalSkillSource: async () => unusedDependency(),
    updateLocalSkillSource: async () => unusedDependency(),
    relocateLocalSkillSource: async () => unusedDependency(),
    updateGitHubSkillSource: async () => unusedDependency(),
    executeLocalSkillImporterToolCall: async () => unusedDependency(),
  }).deletePreset;
}

function createRunWithRecovery(
  coordinator: ReturnType<typeof createSyncLocalApplyCoordinator>,
) {
  return async <T>(stage: LocalStateMutationStage<T>): Promise<T> => {
    await coordinator.recover();
    const operation = await stage();
    try {
      return await coordinator.runMutation(operation);
    } catch (applyError) {
      try {
        await coordinator.recover();
      } catch (recoveryError) {
        throw new AggregateError(
          [applyError, recoveryError],
          'Local-state mutation failed and recovery remains pending',
        );
      }
      throw applyError;
    }
  };
}

interface DeletionState {
  targetPresent: boolean;
  failMutation: boolean;
  clearBlocked: boolean;
  currentJournal: unknown | null;
  port: SyncLocalStatePort;
  journal: SyncLocalApplyJournalPort;
}

function createDeletionState(): DeletionState {
  const state = {
    targetPresent: true,
    failMutation: true,
    clearBlocked: true,
    currentJournal: null as unknown | null,
  };
  const result: DeletionState = {
    ...state,
    port: {
      captureUndoPreimage: async () => createUndoPreimage(result.targetPresent),
      stage: () => unusedDependency(),
      applyStep: async () => unusedDependency(),
      restoreStep: async (step, before) => {
        if (step !== 'presets') return;
        const value = before.storage.presets.value as { targetPresent?: unknown };
        result.targetPresent = value.targetPresent === true;
      },
    },
    journal: {
      readCurrent: async () => result.currentJournal,
      writeCurrent: async (record) => {
        result.currentJournal = record;
      },
      clearCurrent: async () => {
        if (result.clearBlocked) throw new Error('journal clear blocked');
        result.currentJournal = null;
      },
    },
  };
  return result;
}

function createUndoPreimage(targetPresent: boolean): SyncUndoPreimageV1 {
  return {
    memoryRecords: [],
    storage: {
      skills: { present: false },
      skillSources: { present: false },
      presets: { present: true, value: { targetPresent } },
      activePreset: { present: false },
      savedItems: { present: false },
    },
  };
}

async function unusedMutationStage(): Promise<() => Promise<void>> {
  return async () => unusedDependency();
}

function unusedDependency(): never {
  throw new Error('Unexpected test dependency call');
}
