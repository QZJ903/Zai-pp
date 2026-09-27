import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../core/tool/types';

let storage: Record<string, unknown>;
let externalizedPayload: typeof import('../core/tool/externalized-payload');
let executeRuntimeToolCall: typeof import('./helpers/production-tool-runtime')['executeRuntimeToolCall'];

beforeEach(async () => {
  vi.resetModules();
  storage = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (
          Object.prototype.hasOwnProperty.call(storage, key)
            ? { [key]: storage[key] }
            : {}
        )),
        set: vi.fn(async (values: Record<string, unknown>) => {
          storage = { ...storage, ...values };
        }),
        remove: vi.fn(async (key: string) => {
          delete storage[key];
        }),
      },
    },
  });
  externalizedPayload = await import('../core/tool/externalized-payload');
  ({ executeRuntimeToolCall } = await import('./helpers/production-tool-runtime'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runtime externalized tool payloads', () => {
  it('keeps an intermediate chunk failure sticky and skips later writes', async () => {
    const failure = Promise.reject(new Error('middle chunk failed'));
    const laterWrite = vi.fn(async () => undefined);

    await expect(externalizedPayload.chainExternalizedPayloadWrite(failure, laterWrite))
      .rejects.toThrow('middle chunk failed');
    expect(laterWrite).not.toHaveBeenCalled();
  });

  it('rehydrates and executes a large payload from chunk storage', async () => {
    const callId = 'call-external-1';
    const payloadText = JSON.stringify({
      name: 'release-notes',
      description: 'Draft release notes for the user to review.',
      instructions: 'Write concise release notes.\n' + '细节段落\n'.repeat(20000),
    });

    externalizedPayload.appendExternalizedToolPayloadChunk(callId, 'skill_draft_create', payloadText.slice(0, 50000));
    externalizedPayload.appendExternalizedToolPayloadChunk(callId, 'skill_draft_create', payloadText.slice(50000));

    const result = await executeRuntimeToolCall({
      id: callId,
      name: 'skill_draft_create',
      invocationName: 'skill_draft_create',
      payload: externalizedPayload.createExternalizedToolPayload(callId, 'skill_draft_create'),
      raw: '<skill_draft_create>\n...[payload externalized]\n</skill_draft_create>',
    } satisfies ToolCall, 'manual_chat', 'en');

    expect(result.ok).toBe(true);
    const output = result.output as { kind: string; draft: { name: string; instructions: string } };
    expect(output.kind).toBe('skill_draft');
    expect(output.draft.name).toBe('release-notes');
    expect(output.draft.instructions.startsWith('Write concise release notes.')).toBe(true);
  });

  it('returns a retryable parse result without provider I/O when the payload chunk is missing', async () => {
    const callId = 'call-external-missing';

    const result = await executeRuntimeToolCall({
      id: callId,
      name: 'skill_draft_create',
      invocationName: 'skill_draft_create',
      payload: externalizedPayload.createExternalizedToolPayload(callId, 'skill_draft_create'),
      raw: '<skill_draft_create>...[payload externalized]</skill_draft_create>',
    } satisfies ToolCall, 'manual_chat', 'en');

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'tool_call_external_payload_missing', retryable: true },
    });
    // 没拿到 payload 就不该产出结构化结果（渲染层靠这个形状决定要不要画卡片）。
    expect(result.output).toBeUndefined();
  });

  it('returns the released external-payload parse code without provider I/O for malformed chunks', async () => {
    const callId = 'call-external-malformed';
    externalizedPayload.appendExternalizedToolPayloadChunk(callId, 'skill_draft_create', '{"name":');

    const result = await executeRuntimeToolCall({
      id: callId,
      name: 'skill_draft_create',
      invocationName: 'skill_draft_create',
      payload: externalizedPayload.createExternalizedToolPayload(callId, 'skill_draft_create'),
      raw: '<skill_draft_create>...[payload externalized]</skill_draft_create>',
    } satisfies ToolCall, 'manual_chat', 'en');

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'tool_call_external_payload_invalid', retryable: false },
    });
    expect(result.output).toBeUndefined();
  });
});
