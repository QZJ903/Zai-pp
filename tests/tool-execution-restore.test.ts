import { describe, expect, it } from 'vitest';
import {
  normalizeRestoredToolExecution,
  sanitizeToolExecutionForRestoreStorage,
} from '../core/tool/execution-restore';
import type { ToolExecutionRecord } from '../core/types';

describe('tool execution restore storage', () => {
  it('keeps structured skill draft output as an object when persisting restore data', () => {
    const execution: ToolExecutionRecord = {
      name: 'skill_draft_create',
      result: {
        ok: true,
        summary: 'Skill draft ready',
        detail: 'audit',
        output: {
          kind: 'skill_draft',
          draft: {
            name: 'audit',
            description: 'Review contrast-sensitive output.',
            instructions: 'Check dark theme text.',
            memoryEnabled: true,
          },
          warnings: [],
        },
      },
    };

    const stored = sanitizeToolExecutionForRestoreStorage(execution);

    expect(stored.result.output).toMatchObject({
      kind: 'skill_draft',
      draft: { name: 'audit' },
    });
    expect(typeof stored.result.output).toBe('object');
  });

  it('rehydrates legacy JSON-stringified structured outputs for rich renderers', () => {
    const execution: ToolExecutionRecord = {
      name: 'memory_import_preview',
      result: {
        ok: true,
        summary: 'Memory import preview ready (2)',
        detail: '0 duplicates skipped, 0 rejected',
        output: JSON.stringify({
          kind: 'memory_import_preview',
          memories: [{ name: 'alpha' }, { name: 'beta' }],
          duplicates: 0,
          rejected: 0,
        }),
      },
    };

    const restored = normalizeRestoredToolExecution(execution);

    expect(restored.result.output).toMatchObject({
      kind: 'memory_import_preview',
      duplicates: 0,
      rejected: 0,
    });
  });

  it('does not parse ordinary JSON-looking string outputs into fake rich results', () => {
    const execution: ToolExecutionRecord = {
      name: 'web_fetch',
      result: {
        ok: true,
        summary: 'Fetched',
        output: '{"title":"plain text output"}',
      },
    };

    const restored = normalizeRestoredToolExecution(execution);

    expect(restored.result.output).toBe('{"title":"plain text output"}');
  });
});
