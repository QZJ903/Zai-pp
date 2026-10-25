import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendToolCallHistory, clearToolCallHistory, getToolCallHistory } from '../core/tool/history';
import type { ToolCall, ToolResult } from '../core/tool/types';

// Regression tests: a growing tool history must not make every
// tool call log a QUOTA_BYTES warning. The history writer proactively trims
// the oldest records until the serialized payload fits the budget derived
// from chrome.storage.local.QUOTA_BYTES.

let storage: Record<string, unknown>;
let setCalls: Array<unknown[]>;

beforeEach(() => {
  storage = {};
  setCalls = [];
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        // Tiny quota so trimToFit must kick in after a few records.
        QUOTA_BYTES: 600,
        get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          setCalls.push(Object.values(values)[0] as unknown[]);
          Object.assign(storage, values);
        }),
        remove: vi.fn(async (key: string) => { delete storage[key]; }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('tool history budget trimming', () => {
  it('drops oldest records so the serialized history stays under budget', async () => {
    // Each record serializes to ~120 bytes; budget = 0.75 * 600 = 450 bytes.
    // After 8 appends only the most recent ~3 records should remain.
    for (let i = 0; i < 8; i += 1) {
      await appendToolCallHistory(sampleCall(i), sampleResult(i), 'manual_chat');
    }

    const stored = (await getToolCallHistory()) as ToolCallHistoryRecordLike[];
    expect(stored.length).toBeLessThan(8);
    expect(stored.length).toBeGreaterThanOrEqual(1);
    // No write attempt should have exceeded the per-key budget.
    for (const value of setCalls) {
      expect(new Blob([JSON.stringify(value)]).size).toBeLessThanOrEqual(450);
    }
  });

  it('always retains at least the newest record even when one record exceeds budget', async () => {
    await appendToolCallHistory(hugeCall(), sampleResult(0), 'manual_chat');
    const stored = (await getToolCallHistory()) as ToolCallHistoryRecordLike[];
    expect(stored).toHaveLength(1);
  });

  it('clearToolCallHistory removes the storage key', async () => {
    await appendToolCallHistory(sampleCall(0), sampleResult(0), 'manual_chat');
    await clearToolCallHistory();
    expect(storage['zai_pp_tool_history']).toBeUndefined();
  });
});

interface ToolCallHistoryRecordLike {
  call: { name: string };
  createdAt: number;
}

function sampleCall(index: number): ToolCall {
  return {
    name: `tool_${index}`,
    payload: { arg: 'x'.repeat(20) },
    raw: `<tool_${index}>${'y'.repeat(20)}</tool_${index}>`,
  };
}

function hugeCall(): ToolCall {
  return {
    name: 'huge_tool',
    payload: { arg: 'z'.repeat(2_000) },
    raw: 'z'.repeat(2_000),
  };
}

function sampleResult(index: number): ToolResult {
  return {
    ok: true,
    summary: `result ${index}`,
    detail: 'd'.repeat(20),
  };
}

describe('tool history output round-trip', () => {
  it('restores a structured output snapshot back into an object', async () => {
    // ⚠️⚠️ 落库时 `output` 被 `JSON.stringify` 成字符串（为了受同一套字符上限约束），
    // 而结构化结果的消费者全部按**对象形状**判 ⇒ 不还原就读不出卡片
    // （表现：刷新后「保存 Skill」按钮没了，且不报错）。
    await appendToolCallHistory(sampleCall(0), {
      ok: true,
      summary: 'Skill draft ready',
      output: { kind: 'skill_draft', draft: { name: 'greeting' } },
    }, 'manual_chat');

    const [record] = await getToolCallHistory();
    expect(record.result.output).toEqual({ kind: 'skill_draft', draft: { name: 'greeting' } });
  });

  it('leaves a truncated output as the original string', async () => {
    // 截断过的 JSON 不完整、还原不了 ⇒ 原样留着，消费方按「形状不对」退回纯文本。
    await appendToolCallHistory(sampleCall(0), {
      ok: true,
      summary: 'huge',
      output: { kind: 'skill_draft', blob: 'x'.repeat(20_000) },
    }, 'manual_chat');

    const [record] = await getToolCallHistory();
    expect(typeof record.result.output).toBe('string');
    expect(String(record.result.output)).toContain('...[truncated]');
  });

  it('keeps the persisted form a string so the storage shape does not change', async () => {
    // ⚠️ **只在读取侧还原** —— 写入侧改回对象会让已落库的旧记录仍然坏着，
    // 而且会动到字符上限那套约束。
    await appendToolCallHistory(sampleCall(0), {
      ok: true,
      summary: 'Skill draft ready',
      output: { kind: 'skill_draft' },
    }, 'manual_chat');

    const persisted = storage['zai_pp_tool_history'] as Array<{ result: { output: unknown } }>;
    expect(typeof persisted[0].result.output).toBe('string');
  });
});
