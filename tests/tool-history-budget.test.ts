import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendToolCallHistory,
  clearToolCallHistory,
  getToolCallHistory,
  getToolCallHistoryReport,
  TOOL_HISTORY_STORAGE_KEY,
} from '../core/tool/history';
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

describe('tool history scoping by provider', () => {
  // ⚠️⚠️ 这一组守「**先筛后截**」。反过来的写法（先 `slice` 再 `filter`）在单服务夹具下
  // 完全看不出来 —— 只有另一个 provider 把名额占满时，本服务才会静默变成 0 条，
  // 而界面照旧显示「暂无调用」。所以夹具里必须有**两个** provider。
  //
  // ⚠️ 本组要多写几条，而外层 `beforeEach` 把配额压到 600 字节（专为裁剪用例设的）
  // ⇒ 必须先放开配额，否则记录在**写入侧**就被 `trimToFit` 砍掉了，测不到读取侧过滤。
  const widenQuota = () => {
    (chrome.storage.local as unknown as { QUOTA_BYTES: number }).QUOTA_BYTES = 10_485_760;
  };

  const scopedCall = (index: number, providerId: string): ToolCall => ({
    ...sampleCall(index),
    provider: { kind: 'mcp', id: providerId, displayName: providerId, transport: 'http' },
  });

  it('counts the limit per provider instead of taking a global window first', async () => {
    widenQuota();
    // 先写 6 条 A（更早），再写 2 条 B（更晚）—— 全局最近 3 条全是 B。
    for (let i = 0; i < 6; i += 1) {
      await appendToolCallHistory(scopedCall(i, 'server-a'), sampleResult(i), 'manual_chat');
    }
    for (let i = 0; i < 2; i += 1) {
      await appendToolCallHistory(scopedCall(100 + i, 'server-b'), sampleResult(i), 'manual_chat');
    }

    // 先截后筛时这里拿到 0 条（3 个名额被 B 占满）—— 那就是「暂无调用」那个缺陷。
    const scoped = await getToolCallHistory({ serverId: 'server-a', limit: 3 });
    expect(scoped).toHaveLength(3);
    expect(scoped.every((record) => record.call.provider?.id === 'server-a')).toBe(true);
  });

  it('returns every provider when no serverId is given', async () => {
    widenQuota();
    await appendToolCallHistory(scopedCall(0, 'server-a'), sampleResult(0), 'manual_chat');
    await appendToolCallHistory(scopedCall(1, 'server-b'), sampleResult(1), 'manual_chat');

    const all = await getToolCallHistory({ limit: 10 });
    expect(new Set(all.map((record) => record.call.provider?.id)))
      .toEqual(new Set(['server-a', 'server-b']));
  });

  it('keeps dropped in the global reading even when scoping', async () => {
    await appendToolCallHistory(scopedCall(0, 'server-a'), sampleResult(0), 'manual_chat');
    const stored = storage[TOOL_HISTORY_STORAGE_KEY] as unknown[];
    storage[TOOL_HISTORY_STORAGE_KEY] = [...stored, { totally: 'broken' }];

    const report = await getToolCallHistoryReport({ serverId: 'server-a', limit: 5 });
    expect(report.records).toHaveLength(1);
    expect(report.dropped).toBe(1);
  });
});

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
      // ⚠️ 用**非结构化**载荷：`skill_draft` / `memory_import_preview` 走更宽的
      // `STRUCTURED_OUTPUT_LIMITS`（64 KB / 32 KB），这个体积不再触发截断。
      output: { blob: 'x'.repeat(20_000) },
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

describe('structured output budgets', () => {
  // ⚠️⚠️ **这两类结果不是「偶尔超」，是「写长就必超」** —— 而超了不是少看一点，
  // 是卡片整个退化成纯文本、「保存 / 导入」按钮静默消失。
  // 实测：16 000 字符指令的草稿 JSON 16 755（全角）~ 64 755（全反斜杠）字符，
  // 5 条满长记忆的预览 JSON 10 328 字符，都超过通用的 8 000。
  it('keeps a long skill draft intact instead of degrading the save button', async () => {
    const draft = {
      kind: 'skill_draft',
      draft: {
        name: 'x'.repeat(64),
        description: 'y'.repeat(500),
        instructions: '中'.repeat(16_000),
        source: 'custom',
        memoryEnabled: true,
        enabled: true,
        metadata: { createdBy: 'skill_draft_create' },
      },
      warnings: [],
    };
    await appendToolCallHistory(sampleCall(0), {
      ok: true,
      summary: 'Skill draft ready',
      output: draft,
    }, 'manual_chat');

    const [record] = await getToolCallHistory();
    expect(record.result.output).toEqual(draft);
  });

  it('keeps a long memory import preview intact instead of degrading the import button', async () => {
    const preview = {
      kind: 'memory_import_preview',
      duplicates: 0,
      rejected: 0,
      omitted: 0,
      memories: Array.from({ length: 5 }, (_, index) => ({
        type: 'user',
        name: `m${index}`,
        content: '中'.repeat(2_000),
        tags: [],
      })),
    };
    await appendToolCallHistory(sampleCall(0), {
      ok: true,
      summary: 'Memory import preview ready',
      output: preview,
    }, 'manual_chat');

    const [record] = await getToolCallHistory();
    expect(record.result.output).toEqual(preview);
  });

  it('still clamps a structured payload that exceeds its own wider budget', async () => {
    // ⚠️ **上限仍有，只是更宽** —— 不设上限的版本会让单条预览到 816 KB、
    // 100 条 230 MB（预算只有 7.5 MB），`trimToFit` 会把别的工具记录一起挤掉。
    await appendToolCallHistory(sampleCall(0), {
      ok: true,
      summary: 'huge preview',
      output: { kind: 'memory_import_preview', blob: 'x'.repeat(40_000) },
    }, 'manual_chat');

    const [record] = await getToolCallHistory();
    expect(typeof record.result.output).toBe('string');
    expect(String(record.result.output)).toContain('...[truncated]');
  });
});
