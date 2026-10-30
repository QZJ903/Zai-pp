import { describe, expect, it } from 'vitest';
import {
  applyZaiChatNewModelOverride,
  parseZaiChatNewBody,
  rewriteZaiChatNewUserMessages,
} from '../core/zai/request-codec';

/**
 * `/chats/new` body 的**读写对称性**。
 *
 * ⚠️⚠️ **这条守的是一次真实的静默失效**：解析容忍三种容器形状
 * （`chat.history.messages` → `chat.messages` → `body.messages`），而重写当初只认第一种
 * ⇒ 收到兜底形状时**解析拿得到文本、重写却写不进去**：建授权照常、模型覆写照常、
 * 工具目录照常回传，唯独提示词与记忆**没进 body**，全程没有任何报错。
 *
 * ⇒ 判据不是「解析能认出几种形状」，而是**「解析认出的那种形状，重写也写得进去」**。
 * 所以下面每条用例都成对断言：先解析拿到文本，再重写，最后**回读确认真的变了**。
 */
describe('parseZaiChatNewBody and rewriteZaiChatNewUserMessages agree on which container holds the text', () => {
  /** 三种形状各一份。第一份是真机形态，后两份是解析的兜底分支。 */
  const SHAPES: Array<{ name: string; body: (text: string) => Record<string, unknown> }> = [
    {
      name: 'chat.history.messages (the real shape)',
      body: (text) => ({
        chat: {
          type: 'general_agent',
          flags: ['general_agent'],
          history: { messages: { m1: { role: 'user', content: text } }, currentId: 'm1' },
        },
      }),
    },
    {
      name: 'chat.messages (first fallback)',
      body: (text) => ({
        chat: {
          type: 'general_agent',
          flags: ['general_agent'],
          messages: { m1: { role: 'user', content: text } },
        },
      }),
    },
    {
      name: 'body.messages (second fallback)',
      body: (text) => ({
        chat: { type: 'general_agent', flags: ['general_agent'] },
        messages: { m1: { role: 'user', content: text } },
      }),
    },
  ];

  it.each(SHAPES)('round-trips through $name', ({ body }) => {
    const original = body('用户原文');

    // ① 解析读得到（否则这条形状根本进不了增广分支，无需谈写）。
    const parsed = parseZaiChatNewBody(original);
    expect(parsed, '这一种形状应当能被解析').not.toBeNull();
    expect(parsed!.userMessageTexts).toEqual(['用户原文']);

    // ② 重写必须写到**同一个**容器里 —— 这是本条用例的核心。
    const next = rewriteZaiChatNewUserMessages(original, ['增广后的文本']);

    // ③ 回读确认真的变了（不能只断言返回值形状）。
    const reparsed = parseZaiChatNewBody(next);
    expect(reparsed!.userMessageTexts).toEqual(['增广后的文本']);

    // ④ 入参不被改（重写在克隆上做）。
    expect(parseZaiChatNewBody(original)!.userMessageTexts).toEqual(['用户原文']);
  });

  it('prefers chat.history.messages when several containers are present', () => {
    // ⚠️ 三种形状同时出现是不合法的输入，但取值顺序必须是确定的 —— 否则
    // 「解析读 A、重写写 B」这种错位会在这种输入上重新出现。
    const body = {
      chat: {
        history: { messages: { m1: { content: '来自 history' } } },
        messages: { m2: { content: '来自 chat.messages' } },
      },
      messages: { m3: { content: '来自 body.messages' } },
    };
    expect(parseZaiChatNewBody(body)!.userMessageTexts).toEqual(['来自 history']);
    const next = rewriteZaiChatNewUserMessages(body, ['改过']);
    expect(parseZaiChatNewBody(next)!.userMessageTexts).toEqual(['改过']);
    // 未被选中的容器原样保留（不能顺手清掉）。
    expect((body.chat as Record<string, unknown>).messages).toEqual({ m2: { content: '来自 chat.messages' } });
  });

  it('falls through an empty nested container to the fallback one', () => {
    // 「空壳容器挡路」是这条兜底链最容易写错的地方：`chat.history.messages` 存在但里面
    // 一条可识别文本都没有时，必须继续往下找，而不是就此返回 null。
    const body = {
      chat: {
        history: { messages: {} },
        messages: { m1: { content: '兜底里的文本' } },
      },
    };
    expect(parseZaiChatNewBody(body)!.userMessageTexts).toEqual(['兜底里的文本']);
    const next = rewriteZaiChatNewUserMessages(body, ['改过']);
    expect(parseZaiChatNewBody(next)!.userMessageTexts).toEqual(['改过']);
  });

  it('falls through an empty chat.messages to body.messages', () => {
    // ⚠️⚠️ **这一条守的是一个具体的写法错误**：把两条兜底写成 `chat.messages ?? body.messages`
    // 时，空壳 `{}` 是真值 ⇒ 永远看不到 `body.messages`，整条兜底链在那里断掉。
    // 失败方向静默（解析返回 null、首条消息不增广），只有把四种组合都跑一遍才发现得了。
    const body = {
      chat: { messages: {} },
      messages: { m9: { content: '来自 body.messages' } },
    };
    expect(parseZaiChatNewBody(body)!.userMessageTexts).toEqual(['来自 body.messages']);
    const next = rewriteZaiChatNewUserMessages(body, ['改过']);
    expect(parseZaiChatNewBody(next)!.userMessageTexts).toEqual(['改过']);
  });

  it('prefers chat.messages when both fallbacks carry text', () => {
    const body = {
      chat: { messages: { m1: { content: '来自 chat.messages' } } },
      messages: { m2: { content: '来自 body.messages' } },
    };
    expect(parseZaiChatNewBody(body)!.userMessageTexts).toEqual(['来自 chat.messages']);
  });

  it('returns null when no container carries a string content', () => {
    expect(parseZaiChatNewBody({ chat: { history: { messages: {} } } })).toBeNull();
    expect(parseZaiChatNewBody({ chat: {} })).toBeNull();
    expect(parseZaiChatNewBody({})).toBeNull();
    // content 不是字符串（比如是对象）时同样不算数 —— 与真机 user 消息的形态一致。
    expect(parseZaiChatNewBody({ chat: { messages: { m1: { content: { blocks: [] } } } } })).toBeNull();
  });

  it('leaves the body alone when rewriting finds no container', () => {
    const body: Record<string, unknown> = { chat: { type: 'general_agent' } };
    const next = rewriteZaiChatNewUserMessages(body, ['x']);
    expect(next).toEqual(body);
  });

  it('writes the model carriers to the same container the augmentation used', () => {
    // ⚠️⚠️ **模型覆写是「同一个容器」的第三个消费者** —— 它找首条消息的 `models` 时也必须
    // 走同一个入口。各判一遍的话，会出现「增广认得这种形状、模型覆写不认」的第二处分叉，
    // 而那次分叉比第一处更隐蔽：模型照样覆写了 `chat.models`（所以选型是生效的），
    // 只有首条消息那一份没跟着变。
    const shape = {
      chat: {
        models: ['x-preview-l'],
        messages: { m1: { content: 'hi', models: ['x-preview-l'] } },
      },
    };
    expect(parseZaiChatNewBody(shape)!.userMessageTexts).toEqual(['hi']);
    expect(applyZaiChatNewModelOverride(shape, 'glm-5.2')).toBe(true);
    expect((shape.chat as Record<string, unknown>).models).toEqual(['glm-5.2']);
    // 兜底容器里的 `models` 也要跟着改 —— 否则「会话模型是 5.2、那条消息记的却是旧的」。
    expect(shape.chat.messages.m1.models).toEqual(['glm-5.2']);
  });
});