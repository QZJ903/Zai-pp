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
  matchZaiWebRoute,
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
  parseZaiSseData,
  stripZaiThinkingBlocks,
} from '../core/zai/stream-codec';
import {
  ZAI_WEB_ROUTES,
  type ZaiWebRouteName,
} from '../core/zai/contracts';
import { filterZaiModelFacingToolDescriptors } from '../core/zai/model-facing';
import { createWebSearchToolProviderIdentity } from '../core/tool/web-search';
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
  /**
   * ⚠️⚠️ **`parseZaiBody` 的失败语义必须按契约返回 `null`。**
   *
   * 它是「这次请求要不要被我们改写」的判据（`fetch-hook.ts` 的 `prepareRequest` 与
   * `zai.content.ts` 的 `handleAugmentRequestBody` 都在它返回 null 时**原样放行**），
   * 所以失败时**不能**退化成 `{}` —— 那会让一个解析不了的请求被当成空 body 继续往下走。
   *
   * ⚠️ **为什么单独写这一组**：整条「解析失败就放行」的设计原先由
   * `zai-content-augment-order-contract.test.ts` 的三条断言守着，而那三条**全是源码扫描**
   * （`indexOf('parseZaiBody(bodyStr)')` 拿位置再比先后）—— **没有一条真的调用过这个函数**。
   * 把 `catch` 里的 `return null` 改成 `return {}` 时，全量测试依然全绿。
   * **位置类断言守接线，行为断言守语义，两者缺一不可。**
   */
  it('returns null for anything that is not a JSON object', () => {
    // 解析不了 ⇒ null（调用方据此原样放行）。
    expect(parseZaiBody('{bad json}')).toBeNull();
    expect(parseZaiBody('')).toBeNull();
    expect(parseZaiBody('   ')).toBeNull();
    expect(parseZaiBody('not json at all')).toBeNull();
    // 能解析、但形状不是「一个对象」⇒ 同样 null（数组 / 标量都不是请求体）。
    expect(parseZaiBody('null')).toBeNull();
    expect(parseZaiBody('[]')).toBeNull();
    expect(parseZaiBody('[{"model":"x-preview-l"}]')).toBeNull();
    expect(parseZaiBody('"a string"')).toBeNull();
    expect(parseZaiBody('42')).toBeNull();
    expect(parseZaiBody('true')).toBeNull();
  });

  it('returns the parsed object itself for a JSON object', () => {
    const body = parseZaiBody('{"model":"x-preview-l","features":{"web_search":true}}');
    expect(body).toEqual({ model: 'x-preview-l', features: { web_search: true } });
    // 空对象是**合法**请求体（不是失败）—— 别把它与 null 混为一谈。
    expect(parseZaiBody('{}')).toEqual({});
  });

  it('resolves a request to its route name, or null when it belongs to none', () => {
    expect(
      matchZaiWebRoute({
        url: 'https://chat.z.ai/api/v2/chat/completions',
        method: 'POST',
      }),
    ).toBe('completion');
    expect(
      matchZaiWebRoute({
        url: 'https://chat.z.ai/api/v1/chats/new',
        method: 'POST',
      }),
    ).toBe('chatNew');
    expect(
      matchZaiWebRoute({
        url: 'https://chat.z.ai/api/v2/chat/completions',
        method: 'GET',
      }),
    ).toBeNull();
    expect(
      matchZaiWebRoute({
        url: 'https://chat.z.ai/api/v1/chats',
        method: 'POST',
      }),
    ).toBeNull();
  });

  // ⚠️⚠️ **这一条是上面那张用例表的解药。** 用例表从 `ZAI_WEB_ROUTES` 派生，
  // 所以**常量值本身写错时两边会同步改错** —— 矩阵照样全绿（实测过：把
  // `completions` 改成 `completion` 后 38 条用例仍全过）。这里把**线上真实路径**
  // 独立钉成字面量：真机抓包 + 第三方 HAR（`zhipu-ai-proxy-master/har/intl/`）确认过。
  it('pins the released route paths to their literal values', () => {
    expect(ZAI_WEB_ROUTES).toEqual({
      completion: '/api/v2/chat/completions',
      chatNew: '/api/v1/chats/new',
    });
  });

  // 路由匹配是「哪些请求会被我们改写并注入提示词」的判据 —— 它是一道边界，
  // 所以**拒绝面必须逐条钉住**：异源 / 加后缀 / 藏在 query 里 / 方法不符
  // 这几类正是「本该拒绝却被接受」的形态。
  // ⚠️ 判据是 origin 与 pathname **精确相等** —— 换成 includes / startsWith 这类
  // 近似匹配会让上面几类全部漏过，而漏过的表现是「把提示词注进了不该注的请求」。
  //
  // ⚠️⚠️ **断言比的是「解析出来的路由名」，不是布尔值** —— 这一点是承重的：
  // 策略表里 `route` 与路径错配（把 `chatNew` 那行的 route 写成 `'completion'`、
  // 或两行整体对调）时，**布尔口径的断言抓不到**（两条都「匹配上了」），
  // 而按路由名比会立刻红。
  interface RouteCase {
    name: string;
    route: ZaiWebRouteName;
    url: string;
    method: string;
    baseUrl?: string;
    matched: boolean;
  }

  const routeNames = Object.keys(ZAI_WEB_ROUTES) as ZaiWebRouteName[];
  const pathOf = (route: ZaiWebRouteName) => ZAI_WEB_ROUTES[route];
  const encodedPath = (path: string) => `https://chat.z.ai/${path.split('/').slice(1).join('%2F')}`;

  const acceptedRouteCases: RouteCase[] = routeNames.flatMap((route) => {
    const path = pathOf(route);
    return [
      { name: `${route}: absolute URL`, route, url: `https://chat.z.ai${path}`, method: 'POST', matched: true },
      // 相对路径必须按站点 origin 兜底解析 —— fetch hook 里拿到的就是相对路径。
      { name: `${route}: relative path resolves against the site origin`, route, url: path, method: 'POST', matched: true },
      { name: `${route}: host is case-insensitive`, route, url: `https://CHAT.Z.AI${path}`, method: 'POST', matched: true },
      { name: `${route}: explicit default port`, route, url: `https://chat.z.ai:443${path}`, method: 'POST', matched: true },
      { name: `${route}: query string is ignored`, route, url: `https://chat.z.ai${path}?timestamp=1&requestId=abc`, method: 'POST', matched: true },
      { name: `${route}: fragment is ignored`, route, url: `https://chat.z.ai${path}#anchor`, method: 'POST', matched: true },
      { name: `${route}: method is case-insensitive`, route, url: `https://chat.z.ai${path}`, method: 'post', matched: true },
    ];
  });

  const rejectedRouteCases: RouteCase[] = routeNames.flatMap((route) => {
    const path = pathOf(route);
    return [
      { name: `${route}: different origin`, route, url: `https://evil.test${path}`, method: 'POST', matched: false },
      { name: `${route}: subdomain of the site`, route, url: `https://sub.chat.z.ai${path}`, method: 'POST', matched: false },
      { name: `${route}: insecure scheme`, route, url: `http://chat.z.ai${path}`, method: 'POST', matched: false },
      { name: `${route}: path embedded in a query parameter`, route, url: `https://evil.test/?next=${path}`, method: 'POST', matched: false },
      { name: `${route}: path with a suffix`, route, url: `https://chat.z.ai${path}/suffix`, method: 'POST', matched: false },
      { name: `${route}: trailing slash`, route, url: `https://chat.z.ai${path}/`, method: 'POST', matched: false },
      { name: `${route}: percent-encoded slashes`, route, url: encodedPath(path), method: 'POST', matched: false },
      { name: `${route}: userinfo looks like the site host`, route, url: `https://chat.z.ai@evil.test${path}`, method: 'POST', matched: false },
      { name: `${route}: wrong method`, route, url: `https://chat.z.ai${path}`, method: 'GET', matched: false },
      { name: `${route}: empty method`, route, url: `https://chat.z.ai${path}`, method: '', matched: false },
      { name: `${route}: relative path with a foreign base`, route, url: path, method: 'POST', baseUrl: 'https://evil.test/page', matched: false },
    ];
  });

  it.each([...acceptedRouteCases, ...rejectedRouteCases])(
    '$name',
    ({ route, url, method, baseUrl, matched }: RouteCase) => {
      const input = baseUrl === undefined ? { url, method } : { url, method, baseUrl };
      expect(matchZaiWebRoute(input)).toBe(matched ? route : null);
    },
  );

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

  it('strips a nested details block up to its matching close tag', () => {
    // ⚠️⚠️ **非贪婪正则会停在内层的 `</details>` 上** ⇒ 外层剩下的半截思考被当成正文留下，
    // 而 `assistantText` 是工具识别的输入 ⇒ 思考里的工具 XML 会漏出去并真的被执行。
    // 单层时那种 XML 随整块一起被剥掉，嵌套时这个保护就没了。必须按配平深度剥。
    const raw = '<details>思考<details>内层</details>更多</details>正文。';
    expect(stripZaiThinkingBlocks(raw)).toBe('正文。');
  });

  it('strips deeply nested details blocks', () => {
    const raw = '<details>一<details>二<details>三</details>二</details>一</details>正文。';
    expect(stripZaiThinkingBlocks(raw)).toBe('正文。');
  });

  it('strips a nested block whose inner tag carries attributes', () => {
    const raw = '<details>思考<details open class="x">内层</details>更多</details>正文。';
    expect(stripZaiThinkingBlocks(raw)).toBe('正文。');
  });

  it('strips an uppercase nested details block too', () => {
    // ⚠️ **配平扫描用的标签正则必须带 `/i`** —— 它与快速路径守卫
    // （`text.toLowerCase().includes('<details')`）以及非贪婪正则同口径。
    // 少了 `/i` 时大写嵌套块扫不出配平、静默退回非贪婪 ⇒ 又变成剥成半截思考。
    const raw = '<DETAILS>思考<DETAILS>内层</DETAILS>更多</DETAILS>正文。';
    expect(stripZaiThinkingBlocks(raw)).toBe('正文。');
  });

  it('does not leak tool XML written inside a nested thinking block', () => {
    // 这条是本修复的**目的**：思考里提过一句工具，不能因为嵌套就把它当成模型意图执行。
    const raw = '<details>我想<details>细节</details>我打算调用 <shell_exec>{"command":"ls"}</shell_exec> 清理</details>好的。';
    const stripped = stripZaiThinkingBlocks(raw);
    expect(stripped).toBe('好的。');
    expect(stripped).not.toContain('shell_exec');
  });

  it('falls back to the non-greedy behaviour when a nested block is the entire reply', () => {
    // ⚠️ **歧义档：整个回复就是「一个配平的嵌套块」，没有后续正文** ——
    // 分不清「思考被截断」与「答案本身就是个 details 元素」。
    // 这一档**刻意退回非贪婪行为**：配平版会把它整块剥掉、再被「剥完无正文」守卫退回，
    // 而退回的是**完整原文** ⇒ 思考里的工具 XML 会一起交出去（比旧行为更糟）。
    // 所以这里钉的是「宁可留着，也不要把思考整段吐给识别器」。
    const raw = '<details>我要调用 <shell_exec>{"command":"ls"}</shell_exec><details>内层</details>更多</details>';
    expect(stripZaiThinkingBlocks(raw)).toBe('更多</details>');
  });

  it('treats an unbalanced nested block as truncated, same as before', () => {
    // 内层未闭合 ⇒ 配平路径拿不到配平块，退回非贪婪 + 截断语义（与改动前一致）。
    const raw = '<details>思考<details>内层没闭合</details>正文';
    expect(stripZaiThinkingBlocks(raw)).toBe('正文');
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
  // ⚠️ **web 工具的 fixture 必须带真实 provider** —— 判据是「provider 契约 + 名字」，
  // 不带 provider 的 fixture 会让 `web_search` 被判成**非扩展自带**（MCP 同名那种），
  // 于是那几条用例会红，而红的原因不是代码错、是 fixture 缺字段。
  // provider 由**生产同一个工厂**派生，不手抄。
  const webProvider = createWebSearchToolProviderIdentity('en');

  const mk = (
    name: string,
    invocationName: string,
    provider?: ToolDescriptor['provider'],
  ): ToolDescriptor =>
    ({
      name,
      invocationName,
      id: `id-${name}`,
      inputSchema: {},
      ...(provider ? { provider } : {}),
    }) as unknown as ToolDescriptor;

  /** 扩展自带的 web 工具（生产形状：`name === invocationName` 且 provider 是 `local/web`）。 */
  const mkOwnWebTool = (name: 'web_search' | 'web_fetch'): ToolDescriptor =>
    mk(name, name, webProvider);

  /** 第三方 MCP 服务暴露的、**恰好同名**的工具（长 invocationName + mcp provider）。 */
  const mkMcpLookalike = (name: 'web_search' | 'web_fetch'): ToolDescriptor =>
    mk(name, `browser_tools_${name}`, {
      kind: 'mcp',
      id: 'browser-tools',
      displayName: 'Browser Tools',
      transport: 'streamable_http',
    });

  it('keeps web_search and web_fetch when the web tools switch is on', () => {
    const descriptors = [
      mk('memory_save', 'memory_save'),
      mkOwnWebTool('web_search'),
      mkOwnWebTool('web_fetch'),
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
      mkOwnWebTool('web_search'),
      mkOwnWebTool('web_fetch'),
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
      mkOwnWebTool('web_search'),
      mkOwnWebTool('web_fetch'),
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
      mkOwnWebTool('web_search'),
      mkOwnWebTool('web_fetch'),
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

  // ⚠️⚠️ **这一条守的是「判身份要按 provider 契约，不能只按名字」。**
  // web 工具的裁剪理由是「agent 模式联网由服务端沙箱承担」「用户没想搜」——
  // 那两条**只对扩展自带的联网成立**。第三方 MCP 服务完全可以把工具命名为
  // `web_search`，那与我们的联网策略无关，误裁的表现是「用户的工具凭空消失」。
  // ⚠️ 反面对照同样必要：扩展自带的那一个**必须仍被裁**，否则这条用例会退化成
  // 「什么都不裁」也通过。
  it('never filters an MCP tool that merely shares the web tool names', () => {
    const descriptors = [
      mkOwnWebTool('web_search'),
      mkMcpLookalike('web_search'),
      mkOwnWebTool('web_fetch'),
      mkMcpLookalike('web_fetch'),
    ];

    // agent 模式：扩展自带的恒裁，MCP 同名的一个都不裁。
    expect(filterZaiModelFacingToolDescriptors(descriptors, { isAgent: true })
      .map((d) => d.id)).toEqual([
      'id-web_search',
      'id-web_fetch',
    ]);

    // chat 模式 + 开关关 + 原生关：同样只裁扩展自带的。
    expect(filterZaiModelFacingToolDescriptors(descriptors, {
      isAgent: false,
      webToolsEnabled: false,
      nativeSearchOn: false,
    }).map((d) => d.id)).toEqual([
      'id-web_search',
      'id-web_fetch',
    ]);

    // 反向：开关开着时扩展自带的也放行，四个都在。
    expect(filterZaiModelFacingToolDescriptors(descriptors, {
      isAgent: false,
      webToolsEnabled: true,
    })).toHaveLength(4);
  });
});
