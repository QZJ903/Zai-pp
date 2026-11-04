import { describe, expect, it } from 'vitest';
import {
  decodeToolCallHistoryEnvelope,
  ToolHistoryStorageContractError,
} from '../core/tool/history-codec';

function record(id: string) {
  return {
    id,
    call: { name: 'shell_exec', payload: {}, raw: '<shell_exec>{}</shell_exec>' },
    result: { ok: true, summary: 'done' },
    source: 'manual_chat',
    createdAt: 1,
  };
}

describe('GET_TOOL_CALL_HISTORY envelope', () => {
  it('unwraps records and keeps the dropped count', () => {
    const out = decodeToolCallHistoryEnvelope({ records: [record('a')], dropped: 3 });
    expect(out.records.map((r) => r.id)).toEqual(['a']);
    expect(out.dropped).toBe(3);
  });

  it('treats a missing or non-finite dropped as zero', () => {
    expect(decodeToolCallHistoryEnvelope({ records: [] }).dropped).toBe(0);
    expect(decodeToolCallHistoryEnvelope({ records: [], dropped: Number.NaN }).dropped).toBe(0);
  });

  it('rejects a bare array — the envelope shape is part of the contract', () => {
    expect(() => decodeToolCallHistoryEnvelope([record('a')]))
      .toThrow(ToolHistoryStorageContractError);
  });

  it('rejects a corrupt record inside the envelope instead of silently dropping it', () => {
    // ⚠️ 响应那半边走**严格**解码：这批数据刚由写侧校验过，坏一条就是真异常。
    expect(() => decodeToolCallHistoryEnvelope({ records: [{ id: 'broken' }], dropped: 0 }))
      .toThrow(ToolHistoryStorageContractError);
  });
});
