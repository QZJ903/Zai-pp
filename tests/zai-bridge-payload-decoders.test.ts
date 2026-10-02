import { describe, expect, it } from 'vitest';
import {
  decodeZaiHtmlChallengeMessage,
  decodeZaiRequestTerminalMessage,
  decodeZaiResponseCompleteMessage,
  decodeZaiSyncHookStateMessage,
  decodeZaiTitleLookupMessage,
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
    toolCalls: [VALID_TOOL_CALL],
  };

  it('passes a legal payload through', () => {
    expect(decodeZaiResponseCompleteMessage(legal)).toEqual(legal);
  });

  it('accepts an empty toolCalls array', () => {
    expect(decodeZaiResponseCompleteMessage({ ...legal, toolCalls: [] }))
      .toEqual({ ...legal, toolCalls: [] });
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
    ['missing toolCalls', { ...legal, toolCalls: undefined }],
    ['non-array toolCalls', { ...legal, toolCalls: 'none' }],
  ])('rejects malformed payload: %s', (_label, value) => {
    expect(decodeZaiResponseCompleteMessage(value)).toBeNull();
  });

  it('rejects the whole payload when one tool call inside is malformed', () => {
    // 不能「跳过坏元素、保留好元素」—— 那会让「本轮执行过什么」与 fetch hook
    // 的认知不一致，宁可整条不认。
    expect(decodeZaiResponseCompleteMessage({
      ...legal,
      toolCalls: [VALID_TOOL_CALL, { name: 'shell_exec', raw: 7, requestId: 'r-2' }],
    })).toBeNull();
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

describe('decodeZaiTitleLookupMessage', () => {
  it('passes a legal entry through by reference', () => {
    const entry = { conversationId: 'c-1', source: 'prewarm', outcome: 'resolved', at: 1 };
    expect(decodeZaiTitleLookupMessage(entry)).toBe(entry);
  });

  it('accepts an entry carrying only the required `at`', () => {
    // 这条只进诊断数组，没有执行语义 —— 校验强度按「挡掉形状垃圾」定，
    // 不复刻 ZaiConversationTitleDiagnostic 的联合类型。
    const entry = { at: 1 };
    expect(decodeZaiTitleLookupMessage(entry)).toBe(entry);
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing at', { conversationId: 'c-1' }],
    ['non-number at', { at: 'now' }],
    ['NaN at', { at: Number.NaN }],
    ['Infinity at', { at: Number.POSITIVE_INFINITY }],
  ])('rejects malformed entry: %s', (_label, value) => {
    expect(decodeZaiTitleLookupMessage(value)).toBeNull();
  });
});
