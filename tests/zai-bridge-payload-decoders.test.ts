import { describe, expect, it } from 'vitest';
import {
  decodeZaiHistoryToolRecordsMessage,
  decodeZaiHtmlChallengeMessage,
  decodeZaiRequestTerminalMessage,
  decodeZaiResponseCompleteMessage,
  decodeZaiSyncHookStateMessage,
  decodeZaiToolCallMessage,
} from '../core/zai/messages';

/**
 * 桥的载荷 decoder。
 *
 * ⚠️⚠️ **这些测试守的是「形状非法不再被当成合法指令执行」，不是「桥安全了」。**
 * 页面与主世界共享 `window`，能构造出**形状完全合法**的伪造消息 —— 真伪不可区分
 * 这条不变（上游的定性：*MAIN-world identity is routing, not authentication*）。
 *
 * ⚠️ **每个 decoder 都要覆盖两侧**：合法形状原样通过、非法形状返回 null。
 * 只测合法形状等于没测 —— 一个恒返回入参的 decoder 也能过。
 */

const VALID_TOOL_CALL = { name: 'memory_save', raw: '<memory_save>{}</memory_save>', requestId: 'r-1' };

describe('decodeZaiToolCallMessage', () => {
  it('passes a legal tool call through, keeping every field', () => {
    expect(decodeZaiToolCallMessage(VALID_TOOL_CALL)).toEqual(VALID_TOOL_CALL);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['array', []],
    ['string', 'memory_save'],
    ['missing name', { raw: 'x', requestId: 'r' }],
    ['empty name', { name: '', raw: 'x', requestId: 'r' }],
    ['non-string name', { name: 7, raw: 'x', requestId: 'r' }],
    ['missing raw', { name: 'memory_save', requestId: 'r' }],
    ['non-string raw', { name: 'memory_save', raw: { xml: 'x' }, requestId: 'r' }],
    ['missing requestId', { name: 'memory_save', raw: 'x' }],
    ['non-string requestId', { name: 'memory_save', raw: 'x', requestId: 1 }],
  ])('rejects malformed tool call: %s', (_label, value) => {
    expect(decodeZaiToolCallMessage(value)).toBeNull();
  });

  it('rejects a class instance, whose prototype is not Object.prototype', () => {
    class Fake {
      name = 'memory_save';
      raw = 'x';
      requestId = 'r';
    }
    expect(decodeZaiToolCallMessage(new Fake())).toBeNull();
  });
});

describe('decodeZaiResponseCompleteMessage', () => {
  const legal = {
    requestId: 'r-1',
    originalPrompt: 'hi',
    agentTaskPrompt: 'hi',
    assistantText: 'done',
  };

  it('passes a legal payload through', () => {
    expect(decodeZaiResponseCompleteMessage(legal)).toEqual(legal);
  });

  it('ignores unknown extra fields rather than rejecting', () => {
    // 载荷里多出来的字段一律忽略 —— 主世界与隔离世界版本可能不同步。
    expect(decodeZaiResponseCompleteMessage({ ...legal, toolCalls: [] })).toEqual(legal);
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing requestId', { ...legal, requestId: undefined }],
    ['empty requestId', { ...legal, requestId: '' }],
    ['non-string requestId', { ...legal, requestId: 3 }],
    ['missing assistantText', { ...legal, assistantText: undefined }],
    ['non-string assistantText', { ...legal, assistantText: { text: 'x' } }],
    ['missing originalPrompt', { ...legal, originalPrompt: undefined }],
    ['non-string agentTaskPrompt', { ...legal, agentTaskPrompt: null }],
  ])('rejects malformed payload: %s', (_label, value) => {
    expect(decodeZaiResponseCompleteMessage(value)).toBeNull();
  });
});

describe('decodeZaiRequestTerminalMessage / decodeZaiHtmlChallengeMessage', () => {
  it('passes a legal payload through', () => {
    expect(decodeZaiRequestTerminalMessage({ requestId: 'r-1' })).toEqual({ requestId: 'r-1' });
    expect(decodeZaiHtmlChallengeMessage({ requestId: 'r-1' })).toEqual({ requestId: 'r-1' });
  });

  it('ignores extra fields instead of rejecting them', () => {
    expect(decodeZaiRequestTerminalMessage({ requestId: 'r-1', extra: 'x' }))
      .toEqual({ requestId: 'r-1' });
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing requestId', {}],
    ['empty requestId', { requestId: '' }],
    ['non-string requestId', { requestId: 9 }],
  ])('rejects malformed payload: %s', (_label, value) => {
    expect(decodeZaiRequestTerminalMessage(value)).toBeNull();
    expect(decodeZaiHtmlChallengeMessage(value)).toBeNull();
  });
});

describe('decodeZaiSyncHookStateMessage', () => {
  it('passes a legal name list through', () => {
    expect(decodeZaiSyncHookStateMessage({ toolDescriptorNames: ['memory_save', 'shell_exec'] }))
      .toEqual({ toolDescriptorNames: ['memory_save', 'shell_exec'] });
  });

  it('accepts an empty list', () => {
    expect(decodeZaiSyncHookStateMessage({ toolDescriptorNames: [] }))
      .toEqual({ toolDescriptorNames: [] });
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing field', {}],
    ['non-array', { toolDescriptorNames: 'memory_save' }],
    ['object instead of array', { toolDescriptorNames: { 0: 'memory_save' } }],
  ])('rejects malformed payload: %s', (_label, value) => {
    expect(decodeZaiSyncHookStateMessage(value)).toBeNull();
  });

  it.each([
    ['number element', [123]],
    ['null element', [null]],
    ['object element', [{ name: 'memory_save' }]],
    ['nested array element', [['memory_save']]],
    ['mixed, one bad', ['memory_save', 123]],
  ])('rejects non-string element: %s', (_label, names) => {
    // ⚠️⚠️ **这条是本组最要紧的** —— 元素会被逐个喂给 `escapeRegExp`（`value.replace`），
    // 非字符串抛 TypeError → `controller.error` → **打断回给页面的响应流**。
    // `new Set()` 不做类型收敛（`[...new Set(['a', 123])]` 仍是 `['a', 123]`），别指望它兜。
    expect(decodeZaiSyncHookStateMessage({ toolDescriptorNames: names })).toBeNull();
  });
});

describe('decodeZaiHistoryToolRecordsMessage', () => {
  const RECORD = {
    messageId: 'aaaaaaaa-1111-2222-3333-444444444444',
    parentMessageId: 'bbbbbbbb-1111-2222-3333-444444444444',
    content: '正文',
    calls: [{ name: 'shell_exec', raw: '<shell_exec>{}</shell_exec>' }],
  };

  it('accepts the envelope shape the main world actually posts', () => {
    // ⚠️⚠️ **主世界把数组平铺挂在信封上**（`postToContent({ type, records })`）
    // ⇒ decoder 必须按 `value.records` 读。这一条钉住「接收侧要传整条信封」——
    // 传 `data.records` 进去会让 `isPlainRecord` 判否、**整批记录被静默丢弃**。
    expect(decodeZaiHistoryToolRecordsMessage({ type: 'HISTORY_TOOL_RECORDS', records: [RECORD] }))
      .toEqual({ records: [RECORD], chatSessionId: null });
  });

  it('carries the conversation id the records belong to', () => {
    // ⚠️⚠️ **会话归属是「切过会话后旧记录不许挂到新会话」的判据来源**
    // （真机实测过：旧会话的 web_fetch / web_search / shell_status 出现在新会话里）。
    // 主世界从请求 URL `/api/v1/chats/<id>/…` 读出它，与 `records` **同层**平铺。
    expect(decodeZaiHistoryToolRecordsMessage({
      records: [RECORD],
      chatSessionId: 'chat-9',
    })).toEqual({ records: [RECORD], chatSessionId: 'chat-9' });
  });

  it('accepts a null parent id and an empty call list', () => {
    expect(decodeZaiHistoryToolRecordsMessage({
      records: [{ ...RECORD, parentMessageId: null, calls: [] }],
    })).toEqual({ records: [{ ...RECORD, parentMessageId: null, calls: [] }], chatSessionId: null });
  });

  it.each([
    ['null', null],
    ['an array (the receiver passing `data.records` by mistake)', [RECORD]],
    ['missing records', {}],
    ['records not an array', { records: 'x' }],
  ])('rejects a malformed envelope: %s', (_label, value) => {
    expect(decodeZaiHistoryToolRecordsMessage(value)).toBeNull();
  });

  it.each([
    ['a number', 7],
    ['an object', {}],
  ])('rejects a non-string conversation id: %s', (_label, chatSessionId) => {
    // ⚠️ 类型不对判否；**缺省与 null 是合法的**（读不到就是「不知道」）。
    expect(decodeZaiHistoryToolRecordsMessage({ records: [RECORD], chatSessionId })).toBeNull();
  });

  it.each([
    ['missing messageId', { ...RECORD, messageId: undefined }],
    ['empty messageId', { ...RECORD, messageId: '' }],
    ['non-string messageId', { ...RECORD, messageId: 7 }],
    ['content not a string', { ...RECORD, content: null }],
    ['calls not an array', { ...RECORD, calls: 'x' }],
    ['call missing name', { ...RECORD, calls: [{ raw: 'r' }] }],
    ['call raw not a string', { ...RECORD, calls: [{ name: 'shell_exec', raw: 1 }] }],
  ])('rejects a malformed record: %s', (_label, record) => {
    expect(decodeZaiHistoryToolRecordsMessage({ records: [record] })).toBeNull();
  });
});
