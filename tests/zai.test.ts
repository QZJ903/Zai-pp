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
  isZaiAugmentableRoute,
  isZaiHistoryRoute,
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
  ZAI_AUGMENTABLE_WEB_ROUTES,
  ZAI_HISTORY_WEB_ROUTES,
  ZAI_SITES,
  ZAI_WEB_ORIGINS,
  ZAI_WEB_ROUTES,
  isZaiSiteOrigin,
  resolveZaiSite,
  resolveZaiSiteOrigin,
  type ZaiWebRouteName,
} from '../core/zai/contracts';
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
  //
  // ⚠️ **`{id}` 是变量段模板，钉的是模板本身**（不是某个具体 id）——
  // 模板写错（例如漏了 `/messages/batch` 后缀）会让历史侧**静默不剥**。
  it('pins the released route paths to their literal values', () => {
    expect(ZAI_WEB_ROUTES).toEqual({
      completion: '/api/v2/chat/completions',
      chatNew: '/api/v1/chats/new',
      chatDetail: '/api/v1/chats/{id}',
      chatMessages: '/api/v1/chats/{id}/messages/batch',
    });
  });

  // ⚠️⚠️ **「路由匹配」与「该不该增强」是两份独立的名单。** 历史路由会被
  // `matchZaiWebRoute` 匹配到，但它们的请求体里没有提示词 —— 让它们进增广分支
  // 会把 `signature_prompt` 写进 `{"ids":[…]}` 这种 body。
  // ⚠️ **这条断言与「桥的豁免表」是配套的**：`AUGMENT_REQUEST_BODY` 的 route
  // 是逐字段取值 + 默认值，未知值静默落到 `'completion'` ⇒ 这份名单是唯一那道门。
  it('keeps the augmentable and history route sets disjoint and explicit', () => {
    expect([...ZAI_AUGMENTABLE_WEB_ROUTES].sort()).toEqual(['chatNew', 'completion']);
    expect([...ZAI_HISTORY_WEB_ROUTES].sort()).toEqual(['chatDetail', 'chatMessages']);
    // 两份名单合起来必须覆盖全部路由 —— 新增路由时漏归类的表现是「它既不被增强
    // 也不被剥」，而那是静默的。
    expect([...ZAI_AUGMENTABLE_WEB_ROUTES, ...ZAI_HISTORY_WEB_ROUTES].sort())
      .toEqual(Object.keys(ZAI_WEB_ROUTES).sort());
    for (const route of ZAI_AUGMENTABLE_WEB_ROUTES) {
      expect(isZaiAugmentableRoute(route), `${route} 应可增强`).toBe(true);
      expect(isZaiHistoryRoute(route), `${route} 不该被当历史路由`).toBe(false);
    }
    for (const route of ZAI_HISTORY_WEB_ROUTES) {
      expect(isZaiHistoryRoute(route), `${route} 应是历史路由`).toBe(true);
      expect(isZaiAugmentableRoute(route), `${route} 不该可增强`).toBe(false);
    }
    // 未匹配（null）两边都是 false。
    expect(isZaiAugmentableRoute(null)).toBe(false);
    expect(isZaiHistoryRoute(null)).toBe(false);
  });

  // 路由匹配是「哪些请求会被我们改写并注入提示词」的判据 —— 它是一道边界，
  // 所以**拒绝面必须逐条钉住**：异源 / 加后缀 / 藏在 query 里 / 方法不符
  // 这几类正是「本该拒绝却被接受」的形态。
  // ⚠️ 判据是 origin 与 pathname **整串相等** —— 换成 includes / startsWith 这类
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
  // 每条路由的**真实方法**（历史详情是 GET、批量取消息是 POST）—— 表里写死
  // `'POST'` 会让 chatDetail 的「方法正确」用例反而红。
  const ROUTE_METHOD: Record<ZaiWebRouteName, string> = {
    completion: 'POST',
    chatNew: 'POST',
    chatDetail: 'GET',
    chatMessages: 'POST',
  };
  // 把模板里的 `{id}` 换成一个**具体的**会话 id（真机形态：UUID）。
  const SAMPLE_CHAT_ID = '4636417d-6084-4203-9a7a-f9246d5ed027';
  const pathOf = (route: ZaiWebRouteName) => ZAI_WEB_ROUTES[route].replace('{id}', SAMPLE_CHAT_ID);
  const otherMethodOf = (route: ZaiWebRouteName) => (ROUTE_METHOD[route] === 'POST' ? 'GET' : 'POST');
  // ⚠️ **从站点表派生**（而不是手抄两串域名）—— 但下表另有一条**字面量钉真值**的断言，
  // 否则「表本身写错」时派生的用例会跟着一起错（守则 B9/B16：全派生 = 同义反复）。
  const SITE_ORIGINS = ZAI_WEB_ORIGINS;
  const encodedPath = (path: string) => `https://chat.z.ai/${path.split('/').slice(1).join('%2F')}`;

  const acceptedRouteCases: RouteCase[] = routeNames.flatMap((route) => {
    const path = pathOf(route);
    const method = ROUTE_METHOD[route];
    // ⚠️ **两个站点都要覆盖** —— 只测一个站会让「另一个站的路由整块不匹配」这种
    // 静默失效（表现：增广 / 工具剥离 / 用量统计全都不生效）完全漏网。
    return SITE_ORIGINS.flatMap((origin) => [
      { name: `${route} @ ${origin}: absolute URL`, route, url: `${origin}${path}`, method, matched: true },
      // 相对路径必须按站点 origin 兜底解析 —— fetch hook 里拿到的就是相对路径。
      { name: `${route} @ ${origin}: relative path resolves against the site origin`, route, url: path, method, matched: true, baseUrl: `${origin}/c/x` },
      { name: `${route} @ ${origin}: host is case-insensitive`, route, url: `${origin.toUpperCase()}${path}`, method, matched: true },
      { name: `${route} @ ${origin}: explicit default port`, route, url: `${origin}:443${path}`, method, matched: true },
      { name: `${route} @ ${origin}: query string is ignored`, route, url: `${origin}${path}?timestamp=1&requestId=abc`, method, matched: true },
      { name: `${route} @ ${origin}: fragment is ignored`, route, url: `${origin}${path}#anchor`, method, matched: true },
      { name: `${route} @ ${origin}: method is case-insensitive`, route, url: `${origin}${path}`, method: method.toLowerCase(), matched: true },
    ]);
  });

  const rejectedRouteCases: RouteCase[] = routeNames.flatMap((route) => {
    const path = pathOf(route);
    const method = ROUTE_METHOD[route];
    return [
      { name: `${route}: different origin`, route, url: `https://evil.test${path}`, method, matched: false },
      // ⚠️⚠️ **「站点集合」不是「z.ai 域」** —— 站点自己有 zcode.z.ai 之类的同域子站，
      // 放宽到后缀匹配等于把信任范围从一个站放大到一个域。
      { name: `${route}: subdomain of a site`, route, url: `https://sub.chat.z.ai${path}`, method, matched: false },
      { name: `${route}: site host as a prefix of another host`, route, url: `https://chat.z.ai.evil.test${path}`, method, matched: false },
      { name: `${route}: sibling z.ai subdomain`, route, url: `https://zcode.z.ai${path}`, method, matched: false },
      { name: `${route}: bare apex domain`, route, url: `https://z.ai${path}`, method, matched: false },
      { name: `${route}: insecure scheme`, route, url: `http://chat.z.ai${path}`, method, matched: false },
      { name: `${route}: insecure scheme on the CN site`, route, url: `http://zchat.z.ai${path}`, method, matched: false },
      { name: `${route}: path embedded in a query parameter`, route, url: `https://evil.test/?next=${path}`, method, matched: false },
      { name: `${route}: path with a suffix`, route, url: `https://chat.z.ai${path}/suffix`, method, matched: false },
      { name: `${route}: trailing slash`, route, url: `https://chat.z.ai${path}/`, method, matched: false },
      { name: `${route}: percent-encoded slashes`, route, url: encodedPath(path), method, matched: false },
      { name: `${route}: userinfo looks like the site host`, route, url: `https://chat.z.ai@evil.test${path}`, method, matched: false },
      { name: `${route}: userinfo looks like the CN site host`, route, url: `https://zchat.z.ai@evil.test${path}`, method, matched: false },
      { name: `${route}: wrong method`, route, url: `https://chat.z.ai${path}`, method: otherMethodOf(route), matched: false },
      { name: `${route}: empty method`, route, url: `https://chat.z.ai${path}`, method: '', matched: false },
      { name: `${route}: relative path with a foreign base`, route, url: path, method, baseUrl: 'https://evil.test/page', matched: false },
    ];
  });

  it.each([...acceptedRouteCases, ...rejectedRouteCases])(
    '$name',
    ({ route, url, method, baseUrl, matched }: RouteCase) => {
      const input = baseUrl === undefined ? { url, method } : { url, method, baseUrl };
      expect(matchZaiWebRoute(input)).toBe(matched ? route : null);
    },
  );

  // ⚠️⚠️ **`{id}` 段必须排除已知字面量段** —— `/api/v1/chats/all`、`/chats/subagents`、
  // `/chats/remix` 都落在「单个路径段」的形状里。不排除的话它们会被当成某条会话详情，
  // 于是**响应被当历史剥一次**（当前无害，因为剥函数对不认识的形状是 no-op），
  // 但更糟的是 `/chats/all` 与 `chatNew` 的路径**在字面量上互不干扰、语义却相邻**，
  // 将来若给它加增强就会出事。这条把「排除清单生效」钉死。
  it('does not treat known literal chat sub-paths as a chat id', () => {
    const literalPaths = [
      '/api/v1/chats/all',
      '/api/v1/chats/all/archived',
      '/api/v1/chats/subagents',
      '/api/v1/chats/remix',
    ];
    for (const path of literalPaths) {
      expect(matchZaiWebRoute({ url: `https://chat.z.ai${path}`, method: 'GET' }), `${path} 不该匹配`).toBeNull();
      expect(matchZaiWebRoute({ url: `https://chat.z.ai${path}`, method: 'POST' }), `${path} 不该匹配`).toBeNull();
    }
    // 反面对照：`subagents` 带上真正属于它的 query 也仍不匹配（query 本来就被忽略）。
    expect(
      matchZaiWebRoute({ url: 'https://chat.z.ai/api/v1/chats/subagents?chat_id=x', method: 'GET' }),
    ).toBeNull();
    // `/chats/new` 是**真路由**（chatNew）—— 它既不能被 chatDetail 抢走，也不能在
    // 方法不符时落到 chatDetail 上。这条把「排除清单」与「真路由」的边界钉死。
    expect(matchZaiWebRoute({ url: 'https://chat.z.ai/api/v1/chats/new', method: 'POST' })).toBe('chatNew');
    expect(matchZaiWebRoute({ url: 'https://chat.z.ai/api/v1/chats/new', method: 'GET' })).toBeNull();
    // 而一条真会话 id 要匹配得上 —— 否则上面那些「不匹配」可能是路径整体坏掉造成的。
    expect(
      matchZaiWebRoute({
        url: `https://chat.z.ai/api/v1/chats/${SAMPLE_CHAT_ID}`,
        method: 'GET',
      }),
    ).toBe('chatDetail');
  });

  // ⚠️ **两个历史端点的后缀不能互相认领** —— `/chats/{id}` 与 `/chats/{id}/messages/batch`
  // 只差一个后缀，模板写错（漏后缀 / 多后缀）的表现是**其中一条静默不剥**。
  it('keeps the two history endpoints apart', () => {
    const detail = `https://chat.z.ai/api/v1/chats/${SAMPLE_CHAT_ID}`;
    const batch = `${detail}/messages/batch`;
    expect(matchZaiWebRoute({ url: detail, method: 'GET' })).toBe('chatDetail');
    expect(matchZaiWebRoute({ url: batch, method: 'POST' })).toBe('chatMessages');
    // 交错的方法必须被拒（详情是 GET、批量是 POST）。
    expect(matchZaiWebRoute({ url: detail, method: 'POST' })).toBeNull();
    expect(matchZaiWebRoute({ url: batch, method: 'GET' })).toBeNull();
    // 未知后缀不是任何路由（防止「只要前缀对上就认」的近似匹配）。
    expect(matchZaiWebRoute({ url: `${detail}/tags`, method: 'GET' })).toBeNull();
    expect(matchZaiWebRoute({ url: `${batch}/extra`, method: 'POST' })).toBeNull();
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

describe('zai site table', () => {
  it('pins the two sites to literal values', () => {
    // ⚠️⚠️ **这是那张「按站点派生」的用例表的**外部真值**（守则 B16）。
    // 少了它，`SITE_ORIGINS` 从 `ZAI_WEB_ORIGINS` 派生 ⇒ 表本身写错时
    // 路由用例会跟着一起错、全绿（同义反复）。
    expect(ZAI_SITES.cn.origin).toBe('https://zchat.z.ai');
    expect(ZAI_SITES.cn.homeUrl).toBe('https://zchat.z.ai/');
    expect(ZAI_SITES.cn.tabUrlPattern).toBe('*://zchat.z.ai/*');
    expect(ZAI_SITES.global.origin).toBe('https://chat.z.ai');
    expect(ZAI_SITES.global.homeUrl).toBe('https://chat.z.ai/');
    expect(ZAI_SITES.global.tabUrlPattern).toBe('*://chat.z.ai/*');
  });

  it('exposes exactly the two site origins', () => {
    expect([...ZAI_WEB_ORIGINS].sort()).toEqual(['https://chat.z.ai', 'https://zchat.z.ai']);
  });

  it('resolves an origin back to its site, exactly (never by suffix)', () => {
    expect(resolveZaiSite('https://zchat.z.ai')?.id).toBe('cn');
    expect(resolveZaiSite('https://chat.z.ai')?.id).toBe('global');
    // 带上路径 / query 也能反查（解析成 origin 再比）。
    expect(resolveZaiSiteOrigin('https://zchat.z.ai/c/abc?x=1')).toBe('https://zchat.z.ai');
    // ⚠️ 站点自己有同域子站（`zcode.z.ai` 就是真的存在的一个）—— 一律不认。
    for (const stranger of [
      'https://zcode.z.ai',
      'https://z.ai',
      'https://sub.chat.z.ai',
      'https://chat.z.ai.evil.test',
      'http://chat.z.ai',
      'https://space-z.ai',
    ]) {
      expect(isZaiSiteOrigin(stranger), `${stranger} 不该被当成站点`).toBe(false);
      expect(resolveZaiSiteOrigin(stranger), `${stranger} 不该被反查出站点`).toBeNull();
    }
    expect(isZaiSiteOrigin(undefined)).toBe(false);
    expect(isZaiSiteOrigin('')).toBe(false);
    expect(isZaiSiteOrigin('not a url')).toBe(false);
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
  /**
   * 真机抓包的精简版建会话 body：模型在**三个落点**同值 ——
   * `chat.models`、首条 user 消息的 `models`、`features.models`。
   * ⚠️ 三处必须一起改：页面自己始终让它们同值，少改一处就是**亲手制造不一致**。
   */
  function chatNewBody(models: string[] = ['x-preview-l']): Record<string, unknown> {
    return {
      features: {
        auto_web_search: false,
        flags: ['general_agent'],
        mcp_servers: [],
        models: [...models],
      },
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

  it('rewrites all three model carriers: chat.models, the first message, and features.models', () => {
    const body = chatNewBody();
    expect(applyZaiChatNewModelOverride(body, 'glm-5.2')).toBe(true);
    const chat = body.chat as Record<string, unknown>;
    expect(chat.models).toEqual(['glm-5.2']);
    const messages = (chat.history as { messages: Record<string, { models: string[] }> }).messages;
    expect(messages['msg-1']!.models).toEqual(['glm-5.2']);
    // ⚠️ 第三个落点：漏掉它就会留下「前两处是用户选的、features 还是页面默认」的不一致。
    expect((body.features as Record<string, unknown>).models).toEqual(['glm-5.2']);
    expect(readZaiChatNewModel(body)).toEqual(['glm-5.2']);
  });

  it('leaves features untouched when it carries no models array', () => {
    const body = chatNewBody();
    delete (body.features as Record<string, unknown>).models;
    expect(applyZaiChatNewModelOverride(body, 'glm-5.2')).toBe(true);
    expect(Object.hasOwn(body.features as object, 'models')).toBe(false);
  });

  it('leaves the body without a features object alone', () => {
    const body = chatNewBody();
    delete body.features;
    expect(applyZaiChatNewModelOverride(body, 'glm-5.2')).toBe(true);
    expect(Object.hasOwn(body, 'features')).toBe(false);
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
    expect(Object.hasOwn(body, 'features')).toBe(false);
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

/**
 * **思考按 `phase` 分流，不靠 `<details>` 标签。**
 *
 * ⚠️⚠️ **为什么需要这一组**：真机实测（2026-10）`phase:"thinking"` 是**独立相位**、
 * 内容是**裸文本**（整段累积里 `<details` 出现 0 次）。而 `stripZaiThinkingBlocks`
 * 的第一行是「不含 `<details` 就原样返回」⇒ 它在生产路径上等价于 no-op。
 *
 * 漏掉的后果不是「多显示一段思考」：`assistantText` 同时是
 * `extractAndNotifyToolCalls` 与兜底 `parseToolXml` 的输入 ⇒
 * **模型写在思考里的完整工具 XML 会被真的执行**。
 *
 * ⚠️ **这一组必须走真入口**（push 真实 `data:` 行），不能只喂字符串给
 * `stripZaiThinkingBlocks` —— 下面那些 `<details>` 用例测的是**函数本身**，
 * 而函数本身从来没错，错的是生产里喂给它的东西不再有 `<details>`。
 */
describe('zai stream codec: thinking phase split', () => {
  const line = (phase: string, key: string, value: unknown): string =>
    `data: ${JSON.stringify({ type: 'chat:completion', data: { phase, [key]: value } })}\n`;

  it('drops thinking-phase text from assistantText', () => {
    const acc = createZaiStreamAccumulator();
    acc.push(line('thinking', 'delta_content', '用户只是打了个招呼。'));
    acc.push(line('thinking', 'delta_content', '不需要调用任何工具。'));
    acc.push(line('answer', 'delta_content', '你好！有什么可以帮你？'));
    expect(acc.assistantText).toBe('你好！有什么可以帮你？');
  });

  it('keeps thinking text out of the accumulated answer even when it mentions a tool', () => {
    // 这条是本修复的目的：思考里写出的完整工具 XML 不能进识别器。
    const acc = createZaiStreamAccumulator();
    acc.push(line('thinking', 'delta_content', '我需要用 <shell_exec>{"command":"ls"}</shell_exec> 列目录。'));
    acc.push(line('answer', 'delta_content', '好的，我看看。'));
    const text = acc.assistantText;
    expect(text).toBe('好的，我看看。');
    expect(text).not.toContain('shell_exec');
  });

  it('yields an empty answer when the stream never leaves the thinking phase', () => {
    // 思考到一半就被打断（abort / 网络断）⇒ 没有答案，绝不能把思考当答案交出去。
    const acc = createZaiStreamAccumulator();
    acc.push(line('thinking', 'delta_content', '正在想……'));
    acc.finish();
    expect(acc.assistantText).toBe('');
  });

  it('treats an unknown phase as answer text (failure direction is safe)', () => {
    // 服务端新增相位名时不能把正文一起丢掉 —— 未知一律按答案算。
    const acc = createZaiStreamAccumulator();
    acc.push(line('thinking', 'delta_content', '思考。'));
    acc.push(line('future_phase', 'delta_content', '正文。'));
    expect(acc.assistantText).toBe('正文。');
  });

  it('does not treat "other"-phase text as thinking', () => {
    // `other` 是 usage 的承载相位，但**不排除**它带文本 —— 按 phase 分流时
    // 只把 `thinking` 当非答案，其余都算答案。
    const acc = createZaiStreamAccumulator();
    acc.push(line('thinking', 'delta_content', '思考。'));
    acc.push(line('other', 'delta_content', '正文。'));
    expect(acc.assistantText).toBe('正文。');
  });

  it('re-bases the answer start when a content frame replaces the whole text', () => {
    // `content` 是整体替换：这段文本的归属由**本帧自己的相位**决定，不继承上一帧。
    const acc = createZaiStreamAccumulator();
    acc.push(line('thinking', 'delta_content', '思考。'));
    acc.push(line('answer', 'content', '整段替换后的答案。'));
    expect(acc.assistantText).toBe('整段替换后的答案。');
  });

  it('re-bases the answer start when a content frame itself carries thinking', () => {
    const acc = createZaiStreamAccumulator();
    acc.push(line('answer', 'delta_content', '先前的答案。'));
    acc.push(line('thinking', 'content', '整段替换成了思考。'));
    expect(acc.assistantText).toBe('');
  });

  it('keeps the answer start when an edit lands inside the answer', () => {
    const acc = createZaiStreamAccumulator();
    acc.push(line('thinking', 'delta_content', '思考。'));
    acc.push(line('answer', 'delta_content', 'abcde'));
    // 答案起点是 3（思考 3 字）；edit_index=7 落在答案之内 ⇒ 起点之前那段没被碰，起点不动。
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","edit_content":"D","edit_index":7}}\n');
    expect(acc.assistantText).toBe('abcdD');
  });

  it('re-bases the answer start when an edit rewrites the thinking region', () => {
    // ⚠️ 这条是那四条同步规则里**唯一实测不可达**的一条（真机零 edit），
    // 但代码写了就必须有用例喂它 —— 否则又是「写了但没人走」。
    const acc = createZaiStreamAccumulator();
    acc.push(line('thinking', 'delta_content', '思考到一半'));
    // edit_index=0 落在答案起点之前（此时还没有答案）⇒ 起点重定到 edit 之后。
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","edit_content":"思考完毕。答案。","edit_index":0}}\n');
    expect(acc.assistantText).toBe('思考完毕。答案。');
  });

  it('still applies the legacy details strip on top of the phase split', () => {
    // 旧版站点形态：思考内联在 answer 相位里、包在 <details> 中。
    // 两条路要能叠加（phase 分流先切、details 剥离后切）。
    const acc = createZaiStreamAccumulator();
    acc.push(line('answer', 'delta_content', '<details>内联思考</details>答案。'));
    expect(acc.assistantText).toBe('答案。');
  });

  it('does not mutate the accumulator across repeated reads (phase split)', () => {
    const acc = createZaiStreamAccumulator();
    acc.push(line('thinking', 'delta_content', '思考。'));
    acc.push(line('answer', 'delta_content', '答'));
    expect(acc.assistantText).toBe('答');
    expect(acc.assistantText).toBe('答');
    // 继续追加仍按**完整**文本延续：内部 text 从未被切过。
    acc.push(line('answer', 'delta_content', '案'));
    expect(acc.assistantText).toBe('答案');
  });
});

/**
 * **服务端工具相位（`tool_response`）带正文，且可能夹在两段答案中间。**
 *
 * 真机实测（2026-10，agent 模式一轮带服务端搜索的回答）：`tool_response` 相位
 * 5 帧带 `delta_content`，内容是 `# Web Search Skill…` 这类**技能说明文本**。
 *
 * ⚠️ 旧实现用单个 `answerStart` 指针（「起点之前不要、之后全要」），只能表达
 * 「前面有一段非答案」；agent 多步执行时形态是
 * `answer → tool_call → tool_response → answer`，那一段会被拼进两段答案**中间**。
 * ⇒ 改成按区间挖洞，这一组就是那个模型的守卫。
 *
 * `assistantText` 的三个消费者都受影响：自动化回传正文、工具面板的
 * `session.content`、用量估算。
 */
describe('zai stream codec: server tool phases are not answer text', () => {
  const line = (phase: string, key: string, value: unknown): string =>
    `data: ${JSON.stringify({ type: 'chat:completion', data: { phase, [key]: value } })}\n`;

  it('drops tool_response text that arrives before the answer', () => {
    // 真机那条样本的顺序：thinking → tool_call（无正文）→ tool_response（带正文）→ answer
    const acc = createZaiStreamAccumulator();
    acc.push(line('thinking', 'delta_content', '用户想搜新闻。'));
    acc.push('data: {"type":"chat:completion","data":{"phase":"tool_call","delta_name":"web_search"}}\n');
    acc.push(line('tool_response', 'delta_content', '# Web Search Skill\n技能说明'));
    acc.push(line('answer', 'delta_content', '今天的新闻是……'));
    expect(acc.assistantText).toBe('今天的新闻是……');
  });

  it('drops tool_response text wedged between two answer segments', () => {
    // ⚠️ 这条是单指针模型**修不了**的那一格：答案已经开始了，后面又插进一段工具正文。
    const acc = createZaiStreamAccumulator();
    acc.push(line('answer', 'delta_content', '我查一下。'));
    acc.push(line('tool_response', 'delta_content', '【技能说明】'));
    acc.push(line('answer', 'delta_content', '查到了：今天晴天。'));
    expect(acc.assistantText).toBe('我查一下。查到了：今天晴天。');
  });

  it('drops the whole reply when it is only tool_response', () => {
    const acc = createZaiStreamAccumulator();
    acc.push(line('thinking', 'delta_content', '思考。'));
    acc.push(line('tool_response', 'delta_content', '技能说明正文'));
    acc.finish();
    expect(acc.assistantText).toBe('');
  });

  it('treats a tool_response content frame as a replacement owned by that phase', () => {
    // `content` 是整体替换：旧文本被换掉，这段的归属由本帧自己的相位决定。
    const acc = createZaiStreamAccumulator();
    acc.push(line('answer', 'delta_content', '已经写好的答案。'));
    acc.push(line('tool_response', 'content', '工具返回的整段内容'));
    acc.push(line('answer', 'delta_content', '继续。'));
    expect(acc.assistantText).toBe('继续。');
  });

  it('keeps the prefix before edit_index when a tool_response edits the text', () => {
    // `edit_content` 覆盖 edit_index 之后的内容 ⇒ 那里的排除区间要一起截断。
    const acc = createZaiStreamAccumulator();
    acc.push(line('answer', 'delta_content', '答案。'));
    acc.push('data: {"type":"chat:completion","data":{"phase":"tool_response","edit_content":"X","edit_index":0}}\n');
    acc.push(line('answer', 'delta_content', '尾。'));
    expect(acc.assistantText).toBe('尾。');
  });

  it('drops every excluded range at or after edit_index (no straddling involved)', () => {
    // 这里的区间 `[2,6)` **整段落在落点之后**（`start=2 >= editIndex=1`）⇒ 走 pop 分支，
    // 不发生「跨落点」：
    //   text 先由 'AB' + 'TOOL' 变成 'ABTOOL'，区间 [2,6)；
    //   edit_index=1 用 tool_response 写 'ZZZ' ⇒ text = 'A' + 'ZZZ' = 'AZZZ'，
    //   区间 [2,6) 被弹掉（start>=1），本帧是 tool_response ⇒ 再压 [1,4)；
    //   最后 answer 追加 '!' ⇒ 答案 = 'A'（[1,4) 被排除）+ '!' = 'A!'。
    // ⚠️ **真正的跨落点形态见下一条用例** —— 这一条的标题早前误写成了
    // 「straddles the edit point」，与实际走的 pop 分支不符。
    const acc = createZaiStreamAccumulator();
    acc.push(line('answer', 'delta_content', 'AB'));
    acc.push(line('tool_response', 'delta_content', 'TOOL'));   // 区间 [2, 6)
    acc.push('data: {"type":"chat:completion","data":{"phase":"tool_response","edit_content":"ZZZ","edit_index":1}}\n');
    acc.push(line('answer', 'delta_content', '!'));
    expect(acc.assistantText).toBe('A!');
  });

  it('truncates a truly straddling excluded range at the edit point', () => {
    // ⚠️ **真正的跨落点**：区间 `[2,6)`，落点 `editIndex=3` 落在**区间内部**（2 < 3 < 6）。
    //   text 'AB' + 'TOOL' = 'ABTOOL'，区间 [2,6)；
    //   index=3 用 **answer** 相位写 'XYZ' ⇒ text = 'ABT' + 'XYZ' = 'ABTXYZ'；
    //   区间要**截到落点为止** ⇒ [2,3)，只排除 'T'；
    //   answer 相位不压新区间 ⇒ 答案 = 'AB' + 'XYZ' = 'ABXYZ'。
    // ⚠️ 如果整段作废（只 pop 不截断），'TXYZ' 会一起漏进答案 ⇒ 'ABTXYZ'；
    //    如果把 `start` 往后推到落点，'T' 会漏进答案 ⇒ 'ABTXYZ'。两个方向都被这条钉住。
    const acc = createZaiStreamAccumulator();
    acc.push(line('answer', 'delta_content', 'AB'));
    acc.push(line('tool_response', 'delta_content', 'TOOL'));   // 区间 [2, 6)
    acc.push('data: {"type":"chat:completion","data":{"phase":"answer","edit_content":"XYZ","edit_index":3}}\n');
    expect(acc.assistantText).toBe('ABXYZ');
  });

  it('still treats search and unknown phases as answer text', () => {
    // ⚠️ `search` 没有真机样本证明它带正文 ⇒ 不排除；未知相位同理（失败方向安全）。
    const acc = createZaiStreamAccumulator();
    acc.push(line('answer', 'delta_content', '答案。'));
    acc.push(line('search', 'delta_content', '搜索结果摘要'));
    acc.push(line('future_phase', 'delta_content', '未来相位'));
    expect(acc.assistantText).toBe('答案。搜索结果摘要未来相位');
  });
});

describe('zai model-facing filter', () => {
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

  // ⚠️ **判据只按「名字在不在那份封闭名单里」，不看 provider** ——
  // 唯一被裁的是扩展自己的 `local_skill_preview`。第三方 MCP 服务用任何名字
  // （包括历史上的 web 工具名）都必须原样放行，误裁的表现是「用户的工具凭空消失」。
  it('never filters a tool that merely shares a name with a retired built-in', () => {
    const descriptors = [
      mk('web_search', 'browser_tools_web_search', {
        kind: 'mcp',
        id: 'browser-tools',
        displayName: 'Browser Tools',
        transport: 'streamable_http',
      }),
      mk('web_fetch', 'web_fetch', {
        kind: 'mcp',
        id: 'browser-tools',
        displayName: 'Browser Tools',
        transport: 'streamable_http',
      }),
    ];

    expect(filterZaiModelFacingToolDescriptors(descriptors).map((d) => d.id))
      .toEqual(['id-web_search', 'id-web_fetch']);
  });
});
