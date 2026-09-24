import { describe, expect, it } from 'vitest';
import {
  ZAI_FALLBACK_MODEL_OPTIONS,
  ZAI_MODEL_LIST_TTL_MS,
  createZaiModelCatalog,
  decodeZaiModelListResponse,
  parseZaiUpstreamModels,
} from '../core/zai/models';

/** 真机 `/api/models` 抓包的精简版：id / name / capabilities 三个字段。 */
function upstream(entries: Array<[string, string, Record<string, unknown>]>) {
  return {
    data: entries.map(([id, name, capabilities]) => ({
      id,
      name,
      info: { id, name, meta: { capabilities } },
    })),
  };
}

/** 真机实测的完整清单（15 条，前三条才是网页模型菜单里的对话模型）。 */
const LIVE_RESPONSE = upstream([
  ['x-preview-l', 'GLM-5.3-Flash', { agent_mode: true, reasoning_effort: true, think: true, web_search: true }],
  ['glm-5.3', 'GLM-5.3', { agent_mode: true, mcp: true, reasoning_effort: true, think: true }],
  ['glm-5.2', 'GLM-5.2', { agent_mode: true, mcp: true, reasoning_effort: true, think: true }],
  ['GLM-5-Turbo', 'GLM-5-Turbo', { agent_mode: true, mcp: true, think: true }],
  ['GLM-5v-Turbo', 'GLM-5V-Turbo', { agent_mode: true, vision: true }],
  ['glm-4.7', 'GLM-4.7', { mcp: true, think: true }],
  ['glm-4.6v', 'GLM-4.6V', { mcp: true, vision: true }],
  ['0727-106B-API', 'GLM-4.5-Air', { file_qa: true, mcp: true }],
  ['0727-360B-API', 'GLM-4.5', { file_qa: true, mcp: true }],
  ['GLM-4.1V-Thinking-FlashX', 'GLM-4.1V-9B-Thinking', { vision: true }],
  ['deep-research', 'Z1-Rumination', { citations: true }],
  ['zero', 'Z1-32B', { citations: true }],
  ['glm-4-flash', '任务专用', { citations: true }],
  ['0808-360B-DR', '0808-360B-DR', { mcp: true }],
  ['glm-4-air-250414', 'GLM-4-32B', { file_qa: true }],
]);

describe('zai model list parsing', () => {
  it('keeps only the conversation models the web menu offers', () => {
    expect(parseZaiUpstreamModels(LIVE_RESPONSE)).toEqual([
      { id: 'x-preview-l', label: 'GLM-5.3-Flash' },
      { id: 'glm-5.3', label: 'GLM-5.3' },
      { id: 'glm-5.2', label: 'GLM-5.2' },
    ]);
  });

  it('selects on a capability bit rather than a hardcoded id list', () => {
    // 服务端上新：新 id 只要带同一个能力位就自动出现，不需要改代码。
    const next = upstream([
      ['glm-5.4', 'GLM-5.4', { reasoning_effort: true }],
      ['glm-5.3', 'GLM-5.3', { reasoning_effort: true }],
    ]);
    expect(parseZaiUpstreamModels(next).map((model) => model.id))
      .toEqual(['glm-5.4', 'glm-5.3']);
  });

  it('falls back to the id when no display name is present', () => {
    expect(parseZaiUpstreamModels(upstream([['glm-5.3', '', { reasoning_effort: true }]])))
      .toEqual([{ id: 'glm-5.3', label: 'glm-5.3' }]);
  });

  it('drops entries without a readable capability map', () => {
    const mixed = {
      data: [
        { id: 'glm-5.3', info: { meta: { capabilities: { reasoning_effort: true } } } },
        { id: 'no-caps' },
        { name: 'no id' },
      ],
    };
    expect(parseZaiUpstreamModels(mixed)).toEqual([{ id: 'glm-5.3', label: 'glm-5.3' }]);
  });

  it('returns an empty list when no entry exposes capabilities', () => {
    // 形状不认识时交给调用方走兜底清单，而不是把来路不明的 id 列给用户。
    expect(parseZaiUpstreamModels({ data: [{ id: 'glm-5.2' }] })).toEqual([]);
    expect(parseZaiUpstreamModels(['glm-5.2'])).toEqual([]);
    expect(parseZaiUpstreamModels(null)).toEqual([]);
    expect(parseZaiUpstreamModels({ data: 'nope' })).toEqual([]);
  });

  it('validates the runtime response shape', () => {
    expect(decodeZaiModelListResponse({
      models: [{ id: 'glm-5.2', label: 'GLM-5.2' }],
      source: 'live',
    })).toEqual({
      models: [{ id: 'glm-5.2', label: 'GLM-5.2' }],
      source: 'live',
    });
    expect(() => decodeZaiModelListResponse({ models: [], source: 'nope' })).toThrow();
    expect(() => decodeZaiModelListResponse({ models: [{ id: '', label: 'x' }], source: 'live' }))
      .toThrow();
    expect(decodeZaiModelListResponse({ models: [], source: 'stale' }).source).toBe('stale');
  });
});

describe('zai model catalog', () => {
  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }

  /** 记录每次请求的入参，供断言 URL / 鉴权头。 */
  function recordingFetch(handler: () => ReturnType<typeof jsonResponse>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    return {
      calls,
      fetchImpl: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return handler();
      },
    };
  }

  it('fetches with the cached bearer token and reports a live list', async () => {
    const recorder = recordingFetch(() => jsonResponse(LIVE_RESPONSE));
    const catalog = createZaiModelCatalog({
      loadToken: async () => 'token-1',
      fetchImpl: recorder.fetchImpl,
    });

    const result = await catalog.list();

    expect(result.source).toBe('live');
    expect(result.models.map((model) => model.id)).toEqual(['x-preview-l', 'glm-5.3', 'glm-5.2']);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.url).toBe('https://chat.z.ai/api/models');
    const headers = recorder.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer token-1');
  });

  it('serves from cache inside the TTL and refetches after it expires', async () => {
    let now = 1_000_000;
    const recorder = recordingFetch(() => jsonResponse(LIVE_RESPONSE));
    const catalog = createZaiModelCatalog({
      loadToken: async () => 'token-1',
      fetchImpl: recorder.fetchImpl,
      now: () => now,
    });

    await catalog.list();
    now += ZAI_MODEL_LIST_TTL_MS - 1;
    await catalog.list();
    expect(recorder.calls).toHaveLength(1);

    now += 1;
    await catalog.list();
    expect(recorder.calls).toHaveLength(2);
  });

  it('shares one in-flight request across concurrent callers', async () => {
    const recorder = recordingFetch(() => jsonResponse(LIVE_RESPONSE));
    const catalog = createZaiModelCatalog({
      loadToken: async () => 'token-1',
      fetchImpl: recorder.fetchImpl,
    });

    await Promise.all([catalog.list(), catalog.list(), catalog.list()]);
    expect(recorder.calls).toHaveLength(1);
  });

  it('uses the built-in list when no token is cached', async () => {
    const recorder = recordingFetch(() => jsonResponse(LIVE_RESPONSE));
    const catalog = createZaiModelCatalog({
      loadToken: async () => null,
      fetchImpl: recorder.fetchImpl,
    });

    const result = await catalog.list();

    expect(result.source).toBe('fallback');
    expect(result.models).toEqual([...ZAI_FALLBACK_MODEL_OPTIONS]);
    expect(recorder.calls).toHaveLength(0);
  });

  it('uses the built-in list when the request fails', async () => {
    const catalog = createZaiModelCatalog({
      loadToken: async () => 'token-1',
      fetchImpl: async () => jsonResponse({ detail: 'nope' }, 401),
    });

    const result = await catalog.list();

    expect(result.source).toBe('fallback');
    expect(result.models).toEqual([...ZAI_FALLBACK_MODEL_OPTIONS]);
  });

  it('treats a response with no selectable model as unusable', async () => {
    const catalog = createZaiModelCatalog({
      loadToken: async () => 'token-1',
      fetchImpl: async () => jsonResponse({ data: [{ id: 'glm-5.2' }] }),
    });

    const result = await catalog.list();

    expect(result.source).toBe('fallback');
    expect(result.models).toEqual([...ZAI_FALLBACK_MODEL_OPTIONS]);
  });

  it('prefers a stale cache over the built-in list after a refresh failure', async () => {
    let now = 1_000_000;
    let failing = false;
    const catalog = createZaiModelCatalog({
      loadToken: async () => 'token-1',
      fetchImpl: async () => (failing
        ? jsonResponse({}, 500)
        : jsonResponse(upstream([['glm-5.3', 'GLM-5.3', { reasoning_effort: true }]]))),
      now: () => now,
    });

    await catalog.list();
    failing = true;
    now += ZAI_MODEL_LIST_TTL_MS + 1;
    const result = await catalog.list();

    expect(result.source).toBe('stale');
    expect(result.models).toEqual([{ id: 'glm-5.3', label: 'GLM-5.3' }]);
  });
});
