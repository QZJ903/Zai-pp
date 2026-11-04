import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpCapabilityToolDescriptors,
  executeMcpCapabilityToolCall,
} from '../core/mcp/capability-tools';
import { TOOL_OUTPUT_MAX_CHARS } from '../core/tool/result-bytes';
import type { ToolCall, ToolDescriptor } from '../core/types';

/**
 * **`mcp_discover` 的输出必须自己裁到消费者能装下的长度。**
 *
 * ⚠️⚠️ 守的是一个跨单元缺陷：`output` 会被 `JSON.stringify` 后塞进续跑模板，
 * 而那里对它的上界是 `TOOL_OUTPUT_MAX_CHARS`（8 000）。产出侧不裁的后果**不是**
 * 「少几张卡」—— 是整段 JSON 被从中间切断、拼上 `...[truncated]`，
 * **模型拿到的根本解析不了**，它连前面那几张能用的 handle 都读不出来。
 *
 * 实测（修复前，20 张卡）：描述被截到 480 字符时 14 369 字符、三个字段都超长时 34 169。
 */

let sessionStorage: Record<string, unknown>;
let uuid = 0;

beforeEach(() => {
  sessionStorage = {};
  uuid = 0;
  const nativeCrypto = globalThis.crypto;
  vi.stubGlobal('crypto', {
    subtle: nativeCrypto.subtle,
    randomUUID: vi.fn(() => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`),
  });
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: vi.fn(async (key: string) => (
          Object.hasOwn(sessionStorage, key) ? { [key]: sessionStorage[key] } : {}
        )),
        set: vi.fn(async (values: Record<string, unknown>) => {
          sessionStorage = { ...sessionStorage, ...values };
        }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function remoteDescriptor(index: number, descriptionLength: number, namePadding: number): ToolDescriptor {
  return {
    id: `mcp:remote:tool_${index}`,
    provider: { kind: 'mcp', id: 'remote', displayName: 'Remote MCP Server', transport: 'streamable_http' },
    name: `tool_${index}_${'n'.repeat(namePadding)}`,
    invocationName: `mcp_remote_tool_${index}`,
    title: `Tool ${index} ${'t'.repeat(namePadding)}`,
    description: 'd'.repeat(descriptionLength),
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'medium' },
  } as ToolDescriptor;
}

const CONTROL = createMcpCapabilityToolDescriptors('en').find((item) => item.name === 'mcp_discover')!;

async function discover(options: {
  candidates: number;
  descriptionLength: number;
  namePadding?: number;
  limit?: number;
}): Promise<{ output: Record<string, unknown>; serializedChars: number }> {
  const available = Array.from({ length: options.candidates }, (_, index) => (
    remoteDescriptor(index, options.descriptionLength, options.namePadding ?? 0)
  ));
  const call = {
    name: 'mcp_discover',
    invocationName: 'mcp_discover',
    descriptorId: CONTROL.id,
    payload: { query: 'read a file from disk', ...(options.limit === undefined ? {} : { limit: options.limit }) },
    raw: '',
  } as ToolCall;
  const result = await executeMcpCapabilityToolCall(call, CONTROL, {
    locale: 'en',
    availableDescriptors: available,
    capabilityScope: { kind: 'trusted', scopeId: 'discover-budget', trigger: 'test', chatSessionId: null },
  });
  expect(result.ok, '前置：discover 本身应当成功').toBe(true);
  const output = result.output as Record<string, unknown>;
  return { output, serializedChars: JSON.stringify(output).length };
}

describe('mcp_discover output budget', () => {
  it('keeps a typical result under the consumer limit without dropping cards', async () => {
    const { output, serializedChars } = await discover({ candidates: 40, descriptionLength: 120, limit: 20 });
    expect(serializedChars).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS);
    expect(output.returned).toBe(20);
    expect(output.truncated).toBeUndefined();
    expect((output.candidates as unknown[]).length).toBe(20);
  });

  it('drops cards instead of emitting unparseable JSON when descriptions are long', async () => {
    // 描述 4 000 字符会被 compactCatalogCardText 截到 480 —— 20 张约 14 000 字符。
    const { output, serializedChars } = await discover({ candidates: 40, descriptionLength: 4_000, limit: 20 });
    expect(serializedChars, '整段 JSON 必须装得下 8 000').toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS);
    const candidates = output.candidates as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThan(20);
    expect(output.returned).toBe(candidates.length);
    expect(output.truncated).toBe(true);
    // 每一张留下的卡都必须带 handle —— 那正是丢卡时最不能丢的字段。
    for (const candidate of candidates) {
      expect(typeof candidate.capability).toBe('string');
    }
  });

  it('keeps the payload under the limit even when every field is oversized', async () => {
    const { output, serializedChars } = await discover({
      candidates: 40,
      descriptionLength: 4_000,
      namePadding: 600,
      limit: 20,
    });
    expect(serializedChars).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS);
    expect((output.candidates as unknown[]).length).toBeGreaterThan(0);
  });

  it('always returns at least one card, even if a single card cannot fit', async () => {
    // 一张卡就涨到上限之上时，静默返回 0 张比轻微超限糟得多：模型拿不到任何 handle。
    const { output } = await discover({ candidates: 5, descriptionLength: 4_000, namePadding: 600, limit: 1 });
    expect((output.candidates as unknown[]).length).toBe(1);
  });

  it('never issues leases for cards it does not return', async () => {
    // ⚠️ 池子 256 个名额 —— 「签了但不返回」的 handle 是纯泄漏。
    const { output } = await discover({ candidates: 40, descriptionLength: 4_000, limit: 20 });
    const returned = (output.candidates as unknown[]).length;
    expect(returned).toBeLessThan(20);
    // 被存下来的 lease 条数必须等于返回的卡数。
    const stored = Object.values(sessionStorage).flatMap((value) => (
      value && typeof value === 'object' && 'leases' in value
        ? Object.keys((value as { leases: Record<string, unknown> }).leases)
        : []
    ));
    expect(stored.length).toBe(returned);
  });
});
