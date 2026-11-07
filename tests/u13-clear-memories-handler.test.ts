import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryRuntimeHandlers,
  type MemoryRuntimeHandlerDependencies,
} from '../entrypoints/background/memory-handlers';
import {
  decodeAutomationRunsRequest,
  decodeRecentAutomationRunsRequest,
} from '../core/automation/runtime-request-codec';

/**
 * The two batched commands added for the side panel.
 *
 * Both replace a per-record round trip: `CLEAR_MEMORIES` for "clear everything"
 * and `GET_AUTOMATION_RUNS_BATCH` for "recent runs of every automation". Their
 * decoders are pinned here because a silently lax decoder would accept a payload
 * the handler cannot act on.
 */

function memoryDependencies(): MemoryRuntimeHandlerDependencies & {
  clearMemories: ReturnType<typeof vi.fn>;
} {
  return {
    getAllMemories: vi.fn(async () => []),
    getMemoryById: vi.fn(async () => undefined),
    saveMemory: vi.fn(async () => 1),
    importMemoriesAtomically: vi.fn(async () => []),
    updateMemory: vi.fn(async () => undefined),
    deleteMemory: vi.fn(async () => undefined),
    clearMemories: vi.fn(async () => undefined),
    touchMemories: vi.fn(async () => undefined),
    notifyCommittedStateUpdate: vi.fn(async () => undefined),
  };
}

describe('CLEAR_MEMORIES', () => {
  it('clears once and broadcasts once', async () => {
    const dependencies = memoryDependencies();
    const handler = createMemoryRuntimeHandlers(dependencies)
      .find((candidate) => candidate.type === 'CLEAR_MEMORIES')!;

    await expect(handler.handle({ type: 'CLEAR_MEMORIES' }, { tabId: 3 } as never))
      .resolves.toEqual({ ok: true });

    expect(dependencies.clearMemories).toHaveBeenCalledTimes(1);
    expect(dependencies.deleteMemory).not.toHaveBeenCalled();
    expect(dependencies.notifyCommittedStateUpdate).toHaveBeenCalledWith(3);
  });
});

describe('automation run payload decoders', () => {
  it('accepts a batch payload with and without an id list', () => {
    expect(decodeRecentAutomationRunsRequest({ limit: 3 })).toEqual({ limit: 3 });
    expect(decodeRecentAutomationRunsRequest({ limit: 3, automationIds: ['a', 'b'] }))
      .toEqual({ limit: 3, automationIds: ['a', 'b'] });
    expect(decodeRecentAutomationRunsRequest({})).toEqual({});
  });

  it('rejects a batch payload with an unusable limit or id list', () => {
    expect(() => decodeRecentAutomationRunsRequest({ limit: 0 })).toThrow();
    expect(() => decodeRecentAutomationRunsRequest({ limit: 1.5 })).toThrow();
    expect(() => decodeRecentAutomationRunsRequest({ automationIds: ['ok', ''] })).toThrow();
    expect(() => decodeRecentAutomationRunsRequest({ automationIds: 'a' })).toThrow();
    expect(() => decodeRecentAutomationRunsRequest({ unexpected: true })).toThrow();
  });

  it('keeps the single-automation payload contract unchanged', () => {
    expect(decodeAutomationRunsRequest({ automationId: 'a', limit: 3 }))
      .toEqual({ automationId: 'a', limit: 3 });
    expect(() => decodeAutomationRunsRequest({})).toThrow();
  });
});
