import { describe, expect, it } from 'vitest';
import {
  buildZaiSortedPayload,
  createZaiSignature,
  resignZaiCompletionRequest,
} from '../core/zai/sign';
import {
  applyZaiChatNewModelOverride,
  applyZaiModelOverride,
  applyZaiModelOverrideForRoute,
  matchZaiChatNewRoute,
  matchZaiCompletionRoute,
  parseZaiBody,
  parseZaiChatNewBody,
  readZaiChatNewModel,
  readZaiLastUserMessageText,
  readZaiModelForRoute,
  rewriteZaiChatNewUserMessages,
  rewriteZaiLastUserMessage,
} from '../core/zai/request-codec';
import {
  createZaiStreamAccumulator,
  extractZaiErrorDetail,
  extractZaiToolCalls,
  parseZaiSseData,
  stripZaiThinkingBlocks,
} from '../core/zai/stream-codec';
import { filterZaiModelFacingToolDescriptors } from '../core/zai/model-facing';
import type { ToolDescriptor } from '../core/tool/types';

// 签名测试向量：与 zhipu-ai-proxy/intl-sign.js、GLM-Free-API zai.go 交叉验证。
describe('zai signature', () => {
  const SECRET = 'key-@@@@)))()((9))-xxxx&&&%%%%%';

  it('builds sorted payload in key order', () => {
    const sorted = buildZaiSortedPayload({
      timestamp: '1700000000000',
      requestId: 'req-1',
      userId: 'user-1',
    });
    // requestId < timestamp < user_id 按字典序
    expect(sorted).toBe('requestId,req-1,timestamp,1700000000000,user_id,user-1');
  });

  it('produces the double-HMAC signature with wKey-hex-as-key', () => {
    // 时间戳固定为 5 分钟窗口内一个值，timeSlot = floor(1700000000000/300000)
    const timestamp = '1700000000000';
    const timeSlot = Math.floor(Number(timestamp) / 300000);
    const sortPayload = buildZaiSortedPayload({
      timestamp,
      requestId: 'req-1',
      userId: 'user-1',
    });
    const signature = createZaiSignature(sortPayload, 'hello world', timestamp);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    // 时间窗位正确
    expect(timeSlot).toBe(Math.floor(1700000000000 / 300000));
    // 同一输入签名稳定
    expect(createZaiSignature(sortPayload, 'hello world', timestamp)).toBe(signature);
  });

  it('locks the golden signature vector (cross-checked with intl-sign.js / zai.go)', () => {
    // SECRET=key-@@@@)))()((9))-xxxx&&&%%%%%, timestamp=1700000000000,
    // requestId=req-1, user_id=user-1, prompt="hello world"
    const sortPayload = buildZaiSortedPayload({
      timestamp: '1700000000000',
      requestId: 'req-1',
      userId: 'user-1',
    });
    const signature = createZaiSignature(sortPayload, 'hello world', '1700000000000');
    // Node crypto 寄存器交叉验证：wKey= e37c98fb... ; signature 固定为此值。
    expect(signature).toBe('7f96ee353471ad96660bc94bd7dddd65e061a024f5302ee56232bc82559c9b5a');
  });

  it('is deterministic and prompt-sensitive', () => {
    const sortPayload = 'requestId,r1,timestamp,1700000000000,user_id,u1';
    const a = createZaiSignature(sortPayload, 'prompt-a', '1700000000000');
    const b = createZaiSignature(sortPayload, 'prompt-b', '1700000000000');
    expect(a).not.toBe(b);
  });

  it('resigns a completion request and refreshes signature_timestamp', () => {
    const url =
      'https://chat.z.ai/api/v2/chat/completions?timestamp=1700000000000&requestId=r1&user_id=u1&version=0.0.1&platform=web&signature_timestamp=1699999999999';
    const body = {
      model: 'x-preview-l',
      messages: [{ role: 'user', content: 'hi' }],
      signature_prompt: 'hi',
    };
    const result = resignZaiCompletionRequest(url, body);
    expect(result).not.toBeNull();
    expect(result!.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(result!.url).toContain('signature_timestamp=1700000000000');
  });

  it('returns null when signature_prompt is missing', () => {
    const result = resignZaiCompletionRequest(
      'https://chat.z.ai/api/v2/chat/completions?timestamp=1&requestId=r&user_id=u',
      { model: 'x-preview-l' },
    );
    expect(result).toBeNull();
  });
});

describe('zai request codec', () => {
  it('matches completion and chatNew routes', () => {
    expect(
      matchZaiCompletionRoute({
        url: 'https://chat.z.ai/api/v2/chat/completions',
        method: 'POST',
      }),
    ).toBe(true);
    expect(
      matchZaiChatNewRoute({
        url: 'https://chat.z.ai/api/v1/chats/new',
        method: 'POST',
      }),
    ).toBe(true);
    expect(
      matchZaiCompletionRoute({
        url: 'https://chat.z.ai/api/v2/chat/completions',
        method: 'GET',
      }),
    ).toBe(false);
  });

  it('reads the last user message from completion body', () => {
    const body = {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
      ],
    };
    expect(readZaiLastUserMessageText(body)).toBe('second');
  });

  it('rewrites last user message and signature_prompt together', () => {
    const body = {
      messages: [{ role: 'user', content: 'old' }],
      signature_prompt: 'old',
    };
    const next = rewriteZaiLastUserMessage(body, 'new');
    expect(readZaiLastUserMessageText(next)).toBe('new');
    expect(next.signature_prompt).toBe('new');
  });

  it('parses chatNew body with agent flag', () => {
    const body = {
      chat: {
        type: 'general_agent',
        flags: ['general_agent'],
        history: {
          messages: {
            m1: { content: 'hello from first message' },
          },
        },
      },
    };
    const parsed = parseZaiChatNewBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.isAgent).toBe(true);
    expect(parsed!.userMessageTexts).toEqual(['hello from first message']);
  });

  it('rewrites chatNew user messages', () => {
    const body = {
      chat: {
        type: 'general_agent',
        flags: ['general_agent'],
        history: { messages: { m1: { content: 'old' } } },
      },
    };
    const next = rewriteZaiChatNewUserMessages(body, ['augmented']);
    expect(parseZaiChatNewBody(next)!.userMessageTexts).toEqual(['augmented']);
  });
});

describe('zai model override', () => {
  it('overwrites an existing model field', () => {
    const body = { model: 'x-preview-l', messages: [] };
    expect(applyZaiModelOverride(body, 'glm-5.3-flash')).toBe(true);
    expect(body.model).toBe('glm-5.3-flash');
  });

  it('trims the requested id and skips no-op writes', () => {
    const body = { model: 'glm-5.3' };
    expect(applyZaiModelOverride(body, '  glm-5.3  ')).toBe(false);
    expect(body.model).toBe('glm-5.3');
  });

  it('never invents a model field the page did not send', () => {
    const body: Record<string, unknown> = { chat: { type: 'general_agent' } };
    expect(applyZaiModelOverride(body, 'glm-5.3')).toBe(false);
    expect(Object.hasOwn(body, 'model')).toBe(false);
  });

  it('ignores empty and non-string requests', () => {
    const body = { model: 'x-preview-l' };
    expect(applyZaiModelOverride(body, null)).toBe(false);
    expect(applyZaiModelOverride(body, '   ')).toBe(false);
    expect(body.model).toBe('x-preview-l');
  });
});

describe('zai chatNew model override', () => {
  /** 真机抓包的精简版建会话 body：模型在 chat.models，首条 user 消息自己也带一份。 */
  function chatNewBody(models: string[] = ['x-preview-l']): Record<string, unknown> {
    return {
      chat: {
        id: '',
        title: '新聊天',
        models: [...models],
        params: {},
        history: {
          messages: {
            'msg-1': {
              id: 'msg-1',
              parentId: null,
              childrenIds: [],
              role: 'user',
              content: 'hi',
              timestamp: 1790149542,
              models: [...models],
            },
          },
          currentId: 'msg-1',
        },
        flags: [],
        auto_web_search: false,
        message_version: 1,
        type: 'default',
      },
    };
  }

  it('rewrites both the session models and the first message models', () => {
    const body = chatNewBody();
    expect(applyZaiChatNewModelOverride(body, 'glm-5.2')).toBe(true);
    const chat = body.chat as Record<string, unknown>;
    expect(chat.models).toEqual(['glm-5.2']);
    const messages = (chat.history as { messages: Record<string, { models: string[] }> }).messages;
    expect(messages['msg-1']!.models).toEqual(['glm-5.2']);
    expect(readZaiChatNewModel(body)).toEqual(['glm-5.2']);
  });

  it('trims the requested id and skips no-op writes', () => {
    const body = chatNewBody(['glm-5.3']);
    expect(applyZaiChatNewModelOverride(body, '  glm-5.3  ')).toBe(false);
    expect(readZaiChatNewModel(body)).toEqual(['glm-5.3']);
  });

  it('never invents fields the page did not send', () => {
    const body: Record<string, unknown> = { chat: { id: '', history: { messages: {} } } };
    expect(applyZaiChatNewModelOverride(body, 'glm-5.2')).toBe(false);
    expect(Object.hasOwn(body.chat as object, 'models')).toBe(false);
  });

  it('leaves a message without its own models untouched', () => {
    const body = chatNewBody();
    const messages = ((body.chat as Record<string, unknown>).history as {
      messages: Record<string, Record<string, unknown>>;
    }).messages;
    delete messages['msg-1']!.models;
    expect(applyZaiChatNewModelOverride(body, 'glm-5.2')).toBe(true);
    expect(Object.hasOwn(messages['msg-1']!, 'models')).toBe(false);
    expect(readZaiChatNewModel(body)).toEqual(['glm-5.2']);
  });

  it('ignores empty requests and bodies without a chat object', () => {
    const body = chatNewBody();
    expect(applyZaiChatNewModelOverride(body, null)).toBe(false);
    expect(applyZaiChatNewModelOverride(body, '   ')).toBe(false);
    expect(readZaiChatNewModel(body)).toEqual(['x-preview-l']);
    expect(applyZaiChatNewModelOverride({}, 'glm-5.2')).toBe(false);
    expect(readZaiChatNewModel({})).toBeNull();
  });

  it('routes to the right target through the single entry point', () => {
    const chatNew = chatNewBody();
    const completion = { model: 'x-preview-l', messages: [] };
    expect(applyZaiModelOverrideForRoute(chatNew, 'chatNew', 'glm-5.2')).toBe(true);
    expect(applyZaiModelOverrideForRoute(completion, 'completion', 'glm-5.2')).toBe(true);
    // 各自写在自己的落点上，不串门。
    expect(readZaiModelForRoute(chatNew, 'chatNew')).toEqual(['glm-5.2']);
    expect(Object.hasOwn(chatNew, 'model')).toBe(false);
    expect(readZaiModelForRoute(completion, 'completion')).toBe('glm-5.2');
    expect(Object.hasOwn(completion, 'chat')).toBe(false);
  });

  it('reads the model target per route without inventing one', () => {
    expect(readZaiModelForRoute({ model: 'glm-5.3' }, 'completion')).toBe('glm-5.3');
    expect(readZaiModelForRoute({}, 'completion')).toBeNull();
    expect(readZaiModelForRoute(chatNewBody(), 'chatNew')).toEqual(['x-preview-l']);
    expect(readZaiModelForRoute({}, 'chatNew')).toBeNull();
  });
});

describe('zai stream codec', () => {
  it('parses delta/content/edit events and accumulates text', () => {
    const acc = createZaiStreamAccumulator();
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"Hel"}}\n');
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"lo"}}\n');
    expect(acc.assistantText).toBe('Hello');
  });

  it('handles content replace semantics', () => {
    const acc = createZaiStreamAccumulator();
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"Hel"}}\n');
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","content":"World"}}\n');
    expect(acc.assistantText).toBe('World');
  });

  it('applies edit_content as a substring replace (prefix kept, tail cut)', () => {
    // 三语义之一：text = text.substring(0, edit_index) + edit_content。
    // 与 GLM-Free-API zai.go / zai-openai-proxy 的参照实现一致。
    const acc = createZaiStreamAccumulator();
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"abc"}}\n');
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","edit_content":"d","edit_index":3}}\n');
    expect(acc.assistantText).toBe('abcd');
  });

  it('replaces the tail after edit_index when it is inside the text', () => {
    const acc = createZaiStreamAccumulator();
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"hello world"}}\n');
    // edit_index 落在 "hello " 之后：丢掉 "world"，接上 "there"。
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","edit_content":"there","edit_index":6}}\n');
    expect(acc.assistantText).toBe('hello there');
  });

  it('supports per-character edit_content appends (reasoning body pattern)', () => {
    // GLM-Free-API 回归用例形态：正文逐字符用 edit_content 追加，
    // edit_index 每次指向当前文本末尾。原实现（切到 start）会只剩最后一个字符。
    const acc = createZaiStreamAccumulator();
    let len = 0;
    for (const ch of ['a', 'b', 'c']) {
      acc.push(`data: {"type":"chat:completion","data":{"phase":"answer","edit_content":${JSON.stringify(ch)},"edit_index":${len}}}\n`);
      len += ch.length;
    }
    expect(acc.assistantText).toBe('abc');
  });

  it('flushes a trailing data line that arrives without a newline', () => {
    const acc = createZaiStreamAccumulator();
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"Hel"}}\n');
    // 末行没有换行符（TextDecoder 结尾常见）：push 不掉，必须 finish() flush。
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"lo"}}');
    expect(acc.assistantText).toBe('Hel');
    acc.finish();
    expect(acc.assistantText).toBe('Hello');
  });

  it('reassembles a data line split across two pushes', () => {
    const acc = createZaiStreamAccumulator();
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"Hel');
    acc.push('lo"}}\n');
    expect(acc.assistantText).toBe('Hello');
  });

  it('extracts tool calls from accumulated text', () => {
    const text = 'before <shell_exec>{"command":"ls"}</shell_exec> after';
    const found = extractZaiToolCalls(text, new Set(['shell_exec']));
    expect(found.length).toBe(1);
    expect(found[0].name).toBe('shell_exec');
  });

  it('extracts embedded error detail', () => {
    const payload = {
      data: { error: { detail: '人机验证失败' } },
    };
    expect(extractZaiErrorDetail(payload)).toBe('人机验证失败');
  });

  it('parses a full envelope event', () => {
    const event = parseZaiSseData(
      '{"type":"chat:completion","data":{"phase":"answer","delta_content":"x"}}',
    );
    expect(event?.phase).toBe('answer');
  });

  it('strips the leading thinking block from accumulated text', () => {
    // 真机抓样：思考内联在 answer 流里、包在 <details> 中，恒在最前。
    const raw = '<details>用户只是打了个招呼"hi"，我应该友好地回应。</details>你好！👋 我是你的私人 AI 助手。';
    expect(stripZaiThinkingBlocks(raw)).toBe('你好！👋 我是你的私人 AI 助手。');
  });

  it('leaves text without a details block untouched', () => {
    const raw = '这是一段普通回答，没有任何思考块。';
    expect(stripZaiThinkingBlocks(raw)).toBe(raw);
  });

  it('does not strip a details block that appears mid-answer', () => {
    // 模型在答案中段讨论 HTML：开头不是 <details> ⇒ 不误剥。
    const raw = '关于 HTML：<details> 元素用于可折叠内容。</details>以上就是说明。';
    expect(stripZaiThinkingBlocks(raw)).toBe(raw);
  });

  it('does not strip when the whole answer is a bare details element', () => {
    // 回答本身就是个 details 元素（无后续正文）⇒ 不误剥。
    const raw = '<details>只有这一段。</details>';
    expect(stripZaiThinkingBlocks(raw)).toBe(raw);
  });

  it('strips a leading details opener that never closes (truncated stream)', () => {
    // 流被截断：开标签闭合、内容未闭合 ⇒ 砍到结尾。
    const raw = '<details>思考到一半就断了，没有闭合标签';
    expect(stripZaiThinkingBlocks(raw)).toBe('');
  });

  it('keeps answer text before a truncated trailing details opener', () => {
    const raw = '正文开始。<details>思考被截断';
    // 开标签不在开头（前面有正文）⇒ 不剥。
    expect(stripZaiThinkingBlocks(raw)).toBe(raw);
  });

  it('does not misfire on a same-prefix tag such as <detailsx>', () => {
    const raw = '<detailsx>这不是 details 标签</detailsx>正文。';
    expect(stripZaiThinkingBlocks(raw)).toBe(raw);
  });

  it('tolerates attributes on the opening tag', () => {
    const raw = '<details open class="think">思考内容</details>正文。';
    expect(stripZaiThinkingBlocks(raw)).toBe('正文。');
  });

  it('strips an uppercase DETAILS block too (guard must not be case-sensitive)', () => {
    // ⚠️ 快速路径守卫若写成大小写敏感（`includes('<details')`），`<DETAILS>` 会在守卫处
    // 直接返回、绕过剥离，而两个正则都带 /i —— 两处判据不一致。
    const raw = '<DETAILS>思考</DETAILS>正文。';
    expect(stripZaiThinkingBlocks(raw)).toBe('正文。');
  });

  it('keeps an earlier stripped block stripped when a later block is the whole answer', () => {
    // ⚠️ 连续两个开头 details、且最后一个即正文时，「剥完无正文」那条守卫**必须返回 `out`
    // 而不是原始 `text`** —— 否则第一个（已剥掉的）思考块会被吐回来。
    const raw = '<details>思考</details><details>答案</details>';
    expect(stripZaiThinkingBlocks(raw)).toBe('<details>答案</details>');
  });

  it('does not mutate the accumulator when reading assistantText', () => {
    // 剥离只在读取出口发生（getter 是纯函数），内部累积保持原始 ——
    // 否则 edit_content 的 edit_index（相对原始文本的 UTF-16 偏移）会错位。
    const acc = createZaiStreamAccumulator();
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"<details>思考"}}\n');
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"中</details>答"}}\n');
    expect(acc.assistantText).toBe('答');
    // 再读一次仍是同样结果：读取不改变内部状态。
    expect(acc.assistantText).toBe('答');
    // 继续追加仍按原始文本延续（若读取时改写了内部 text，这里会错）。
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"案"}}\n');
    expect(acc.assistantText).toBe('答案');
  });
});

describe('zai model-facing filter', () => {
  const mk = (name: string, invocationName: string): ToolDescriptor =>
    ({
      name,
      invocationName,
      id: `id-${name}`,
      inputSchema: {},
    }) as unknown as ToolDescriptor;

  it('keeps web_search and web_fetch when the web tools switch is on', () => {
    const descriptors = [
      mk('memory_save', 'memory_save'),
      mk('web_search', 'web_search'),
      mk('web_fetch', 'web_fetch'),
    ];
    const filtered = filterZaiModelFacingToolDescriptors(descriptors, {
      isAgent: false,
      webToolsEnabled: true,
    });
    expect(filtered.map((d) => d.name)).toEqual(['memory_save', 'web_search', 'web_fetch']);
  });

  it('keeps web tools when page-native search is on even if the switch is off', () => {
    const descriptors = [
      mk('memory_save', 'memory_save'),
      mk('web_search', 'web_search'),
      mk('web_fetch', 'web_fetch'),
    ];
    const filtered = filterZaiModelFacingToolDescriptors(descriptors, {
      isAgent: false,
      webToolsEnabled: false,
      nativeSearchOn: true,
    });
    expect(filtered.map((d) => d.name)).toEqual(['memory_save', 'web_search', 'web_fetch']);
  });

  it('filters web tools when the switch is off and native search is off', () => {
    const descriptors = [
      mk('memory_save', 'memory_save'),
      mk('web_search', 'web_search'),
      mk('web_fetch', 'web_fetch'),
    ];
    const filtered = filterZaiModelFacingToolDescriptors(descriptors, {
      isAgent: false,
      webToolsEnabled: false,
      nativeSearchOn: false,
    });
    expect(filtered.map((d) => d.name)).toEqual(['memory_save']);
  });

  it('filters web_search and web_fetch out of the model catalog for agent turns', () => {
    const descriptors = [
      mk('memory_save', 'memory_save'),
      mk('web_search', 'web_search'),
      mk('web_fetch', 'web_fetch'),
    ];
    const filtered = filterZaiModelFacingToolDescriptors(descriptors, {
      isAgent: true,
      webToolsEnabled: true,
      nativeSearchOn: true,
    });
    expect(filtered.map((d) => d.name)).toEqual(['memory_save']);
  });

  it('keeps skill_draft/memory_import in the model catalog and filters local_skill_preview out', () => {
    const descriptors = [
      mk('shell_exec', 'shell_exec'),
      mk('skill_draft_create', 'skill_draft_create'),
      mk('memory_import_preview', 'memory_import_preview'),
      mk('local_skill_preview', 'local_skill_preview'),
    ];
    const filtered = filterZaiModelFacingToolDescriptors(descriptors);
    // Skill 起草与记忆导入预览必须对模型可见 —— 它们的结果要渲染成带
    // 「保存 / 导入」按钮的卡片，模型不调就永远不会出现。
    // local_skill_preview 相反：它是本地 Skill 导入的传输层，只由扩展自己调用。
    expect(filtered.map((d) => d.name)).toEqual([
      'shell_exec',
      'skill_draft_create',
      'memory_import_preview',
    ]);
  });
});
