import { describe, expect, it } from 'vitest';
import {
  applyZaiChatNewModelOverride,
  applyZaiModelOverride,
  disableZaiNativeWebSearch,
  mergeZaiNativeSearchDisabled,
  rewriteZaiChatNewUserMessages,
  rewriteZaiLastUserMessage,
} from '../core/zai/request-codec';

/**
 * **改写请求体时，兄弟字段必须原样保留。**
 *
 * 这条守的是 z.ai 对 body 形状的敏感度：历史上凭空多一个字段（`chat.features` 被覆盖成对象）
 * 就是 400 卡首页。所以「只改该改的那个字段、别的一律不动」是**契约**，不是风格偏好。
 *
 * ⚠️⚠️ **为什么需要这个文件**：这条契约原先**一条断言都没有** ——
 * 现有的 `never invents a field` 只守「不**新增**字段」，守不住「已有的兄弟字段被改掉 / 丢掉」。
 * 把 `rewriteZaiLastUserMessage` 改成「只返回 `signature_prompt` + messages」
 * （丢掉 `features` / `model` / 一切未知字段）时，全量测试**依然全绿**。
 *
 * ⚠️ **判据用「路径级 diff」而不是「逐个字段抽查」** —— 抽查只能覆盖写下来的那几个字段，
 * 而这条契约说的是「**除落点外全部不变**」，包括将来页面新加的、我们不认识的字段。
 * 所以这里喂一份带未知字段的 body，跑完对比**变更路径集合**：
 * 多出任何一条路径（改的、丢的、新增的）都会红。
 *
 * ⚠️ **断言的是「路径集合恰好等于落点」**，不是「包含落点」—— 后者对「顺手多改了一个字段」是绿的。
 */

/** 把一份 body 摊平成 `路径 → 类型/值` 的快照；用于逐路径比对。 */
function snapshot(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (current: unknown, path: string): void => {
    if (current === null || typeof current !== 'object') {
      out.set(path, `${typeof current}:${JSON.stringify(current)}`);
      return;
    }
    out.set(path, Array.isArray(current) ? 'array' : 'object');
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      visit(child, path ? `${path}.${key}` : key);
    }
  };
  visit(value, '');
  return out;
}

/** 两次快照之间发生变化的全部路径（改的 / 丢的 / 新增的都算）。 */
function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

/** 一份「页面可能发出来的」completion body：含真实字段 + 几个我们不认识的未来字段。 */
function completionBody(): Record<string, unknown> {
  return {
    model: 'x-preview-l',
    messages: [
      { role: 'assistant', content: '上一条回答', models: ['x-preview-l'] },
      { role: 'user', content: '原始提问', brand_new_message_field: { deep: [1, 2] } },
    ],
    signature_prompt: '原始提问',
    features: {
      auto_web_search: true,
      web_search: true,
      mcp_servers: ['advanced-search'],
      brand_new_feature_flag: 7,
    },
    current_user_message_parent_id: 'parent-1',
    background_tasks: { title_generation: true, tags_generation: true },
    brand_new_top_level_field: 'keep me',
  };
}

/** 一份「页面可能发出来的」chats/new body，同样是多层的未知字段。 */
function chatNewBody(): Record<string, unknown> {
  return {
    chat: {
      id: '',
      type: 'general_agent',
      flags: ['general_agent'],
      models: ['x-preview-l'],
      history: {
        messages: {
          m1: { role: 'user', content: '第一条', models: ['x-preview-l'], brand_new: { a: 1 } },
          m2: { role: 'user', content: '第二条', brand_new_array: [1, 2, 3] },
        },
        brand_new_history_field: true,
      },
      brand_new_chat_field: { keep: [1, 2, 3] },
    },
    brand_new_top_level_field: { keep: true },
  };
}

describe('rewriting a completion body preserves every sibling field', () => {
  it('changes exactly the last user message and signature_prompt, nothing else', () => {
    const body = completionBody();
    const before = snapshot(body);

    const next = rewriteZaiLastUserMessage(body, '增强后的提问');

    expect(changedPaths(before, snapshot(next))).toEqual([
      'messages[1].content',
      'signature_prompt',
    ]);
    // 被改的字段确实改对了（否则「路径集合对」也可能只是改成了别的值）。
    expect(next.signature_prompt).toBe('增强后的提问');
    expect((next.messages as Array<Record<string, unknown>>)[1]!.content).toBe('增强后的提问');
    // 未知的兄弟字段仍然逐字相同 —— 包括 message 自己那份。
    expect((next.messages as Array<Record<string, unknown>>)[1]!.brand_new_message_field)
      .toEqual({ deep: [1, 2] });
    expect(next.brand_new_top_level_field).toBe('keep me');
    expect(next.features).toEqual(body.features);
  });

  it('does not mutate the input body', () => {
    // ⚠️ 返回的是浅拷贝，嵌套对象与入参**共享引用** —— 所以「只改顶层」这件事
    // 挡不住「顺手把 next.features.xxx 也改了」那种写法，必须单独断言入参没被动过。
    const body = completionBody();
    const before = snapshot(body);

    rewriteZaiLastUserMessage(body, '增强后的提问');

    expect(changedPaths(before, snapshot(body))).toEqual([]);
  });

  it('leaves the body untouched when there is no user message to rewrite', () => {
    const body: Record<string, unknown> = {
      model: 'x-preview-l',
      messages: [{ role: 'assistant', content: '只有助手消息' }],
      signature_prompt: '旧值',
      brand_new_top_level_field: 1,
    };
    const next = rewriteZaiLastUserMessage(body, '新值');

    // 没有可改的 user 消息 ⇒ 只同步 signature_prompt（这是既有语义）。
    expect(changedPaths(snapshot(body), snapshot(next))).toEqual(['signature_prompt']);
    expect(next.messages).toEqual([{ role: 'assistant', content: '只有助手消息' }]);
  });
});

describe('rewriting a chats/new body preserves every sibling field', () => {
  it('changes exactly the message contents, nothing else', () => {
    const body = chatNewBody();
    const before = snapshot(body);

    const next = rewriteZaiChatNewUserMessages(body, ['增强一', '增强二']);

    expect(changedPaths(before, snapshot(next))).toEqual([
      'chat.history.messages.m1.content',
      'chat.history.messages.m2.content',
    ]);
    expect(next.brand_new_top_level_field).toEqual({ keep: true });
    expect((next.chat as Record<string, unknown>).brand_new_chat_field).toEqual({ keep: [1, 2, 3] });
  });

  it('does not mutate the input body', () => {
    const body = chatNewBody();
    const before = snapshot(body);

    rewriteZaiChatNewUserMessages(body, ['增强一', '增强二']);

    expect(changedPaths(before, snapshot(body))).toEqual([]);
  });
});

describe('disabling the native search channel preserves every sibling feature', () => {
  it('writes only the two search flags and keeps unknown feature siblings', () => {
    const body = completionBody();
    const before = snapshot(body);

    expect(disableZaiNativeWebSearch(body)).toBe(true);

    expect(changedPaths(before, snapshot(body))).toEqual([
      'features.auto_web_search',
      'features.web_search',
    ]);
    // 真实约束：`mcp_servers` 扩展只读不写（写了会与服务端 advanced-search 抢通道）。
    expect((body.features as Record<string, unknown>).mcp_servers).toEqual(['advanced-search']);
    expect((body.features as Record<string, unknown>).brand_new_feature_flag).toBe(7);
  });

  it('merges into the existing features object instead of replacing it', () => {
    const merged = mergeZaiNativeSearchDisabled({
      auto_web_search: true,
      web_search: true,
      mcp_servers: ['advanced-search'],
      brand_new_feature_flag: 7,
    });
    expect(merged).toEqual({
      auto_web_search: false,
      web_search: false,
      mcp_servers: ['advanced-search'],
      brand_new_feature_flag: 7,
    });
  });

  it('never spreads a non-record features value into the request body', () => {
    // ⚠️ `features` 是数组 / 字符串时**不能**展开它 —— 那会把数组下标或字符
    // 变成 body 的键。这里必须退化成「只写两个 flag 的新对象」。
    expect(mergeZaiNativeSearchDisabled(['advanced-search'])).toEqual({
      auto_web_search: false,
      web_search: false,
    });
    expect(mergeZaiNativeSearchDisabled('advanced-search')).toEqual({
      auto_web_search: false,
      web_search: false,
    });
    expect(mergeZaiNativeSearchDisabled(undefined)).toEqual({
      auto_web_search: false,
      web_search: false,
    });
  });
});

describe('overriding the model preserves every sibling field', () => {
  it('writes only the completion model field', () => {
    const body = completionBody();
    const before = snapshot(body);

    expect(applyZaiModelOverride(body, 'glm-5.3')).toBe(true);

    expect(changedPaths(before, snapshot(body))).toEqual(['model']);
  });

  it('leaves the body untouched when it does not write', () => {
    const noModelField: Record<string, unknown> = { messages: [], brand_new: 1 };
    const noModelBefore = snapshot(noModelField);
    expect(applyZaiModelOverride(noModelField, 'glm-5.3')).toBe(false);
    expect(changedPaths(noModelBefore, snapshot(noModelField))).toEqual([]);

    const sameModel: Record<string, unknown> = { model: 'glm-5.3', brand_new: 1 };
    const sameModelBefore = snapshot(sameModel);
    expect(applyZaiModelOverride(sameModel, 'glm-5.3')).toBe(false);
    expect(changedPaths(sameModelBefore, snapshot(sameModel))).toEqual([]);
  });

  it('writes only the chats/new model landing points', () => {
    const body = chatNewBody();
    const before = snapshot(body);

    expect(applyZaiChatNewModelOverride(body, 'glm-5.3')).toBe(true);

    // 两个落点：`chat.models` 与首条 user 消息自己的 `models`（真机抓包两者始终同值）。
    // ⚠️ m2 没有 `models` ⇒ **不得凭空补一个**（那是「凭空加字段」，与本次契约是两件事）。
    expect(changedPaths(before, snapshot(body))).toEqual([
      'chat.history.messages.m1.models[0]',
      'chat.models[0]',
    ]);
  });

  it('does not mutate the body when the chats/new override cannot apply', () => {
    const body: Record<string, unknown> = {
      chat: { history: { messages: { m1: { content: 'x' } } }, brand_new: 1 },
      brand_new_top_level: 2,
    };
    const before = snapshot(body);

    expect(applyZaiChatNewModelOverride(body, 'glm-5.3')).toBe(false);

    expect(changedPaths(before, snapshot(body))).toEqual([]);
  });
});
