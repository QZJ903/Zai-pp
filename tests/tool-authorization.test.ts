import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOOL_AUTHORIZATION_TTL_MS,
  TOOL_AUTHORIZATION_STORAGE_KEY,
  authorizeToolExecution,
  closeToolAuthorization,
  completeToolExecutionAuthorization,
  createToolAuthorization,
  haveEquivalentToolDescriptorSecurity,
} from '../core/tool/authorization';
import type {
  ToolAuthorizationSubject,
  ToolCall,
  ToolDescriptor,
} from '../core/tool/types';
import { createRuntimeToolRuntime } from '../core/tool/runtime';
import { ToolProviderRegistry, type RuntimeToolProvider } from '../core/tool/provider-registry';

/**
 * `core/tool/authorization.ts` 的边界契约。
 *
 * 这一组用例钉的是同一条线：**授权状态由后台单方面拥有**。会话身份只能由扩展
 * 自己从浏览器上下文里取（页面自报的 chat_session_id 一律不可信）；存储里的畸形
 * 或超限状态必须**可见地失败、且不被就地重写**（否则一次读取失败会静默抹掉用户
 * 在途的授权）；描述符一旦签发就按安全摘要比对 —— 本地化文案变化不该让授权失效，
 * 结构变化必须失效。
 */

let sessionStorage: Record<string, unknown>;

beforeEach(() => {
  sessionStorage = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionStorage[key] })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          sessionStorage = structuredClone({ ...sessionStorage, ...value });
        }),
      },
    },
    permissions: {
      contains: vi.fn(async () => true),
    },
  });
});

describe('tool authorization context', () => {
  it('keeps the registered session storage identity stable', () => {
    // 存储 key 本身是对外契约：改名会让升级后所有在途授权凭空消失，
    // 表现为「用户刚点的工具突然要重新授权」。这条守卫把改名变成显式的失败。
    expect(TOOL_AUTHORIZATION_STORAGE_KEY).toBe('zai_pp_tool_authorizations');
  });

  it('executes high-risk auto tools on both the grant (page) and trusted surfaces', async () => {
    // 'manual' 执行模式已删除：风险等级本身不再构成执行门槛，
    // 「已启用」就意味着模型可以在任何 surface 上自动执行，两侧都必须放行。
    const descriptor = makeDescriptor({
      execution: { mode: 'auto', enabled: true, risk: 'high' },
    });
    const grant = await createGrant([descriptor]);

    await expect(authorizeToolExecution(
      makeCall(),
      { kind: 'grant', grantId: grant.id, subject: SUBJECT },
      [descriptor],
    )).resolves.toMatchObject({ descriptor });

    await expect(authorizeToolExecution(
      makeCall(),
      { kind: 'trusted', trigger: 'sidepanel_chat', requestId: 'trusted-1' },
      [descriptor],
    )).resolves.toMatchObject({ descriptor });
  });

  it('fails visibly without rewriting malformed or future session state', async () => {
    sessionStorage.zai_pp_tool_authorizations = { version: 99, grants: {} };

    await expect(createGrant([makeDescriptor()]))
      .rejects.toThrow('Stored tool authorization state is invalid.');
    expect(sessionStorage.zai_pp_tool_authorizations).toEqual({ version: 99, grants: {} });
  });

  it('rejects nested corrupt v1 state without rewriting it', async () => {
    const corrupt = {
      version: 1,
      grants: {
        broken: {
          id: 'broken',
          requestId: 'request-1',
          trigger: 'manual_chat',
          descriptors: [],
          calls: { 'call-1': { descriptorId: 'tool', state: 'unknown' } },
        },
      },
    };
    sessionStorage.zai_pp_tool_authorizations = corrupt;

    await expect(createGrant([makeDescriptor()]))
      .rejects.toThrow('Stored tool authorization state is invalid.');
    expect(sessionStorage.zai_pp_tool_authorizations).toEqual(corrupt);
  });

  it('rejects oversized stored authorization state before rewriting it', async () => {
    const oversized = {
      version: 1,
      grants: {},
      padding: 'x'.repeat(4 * 1024 * 1024),
    };
    sessionStorage.zai_pp_tool_authorizations = oversized;

    await expect(createGrant([makeDescriptor()]))
      .rejects.toThrow('Stored tool authorization state is invalid.');
    expect(sessionStorage.zai_pp_tool_authorizations).toBe(oversized);
  });

  it('rejects stored state that exceeds the grant or per-grant call caps', async () => {
    const grant = await createGrant([makeDescriptor()]);
    const original = structuredClone(sessionStorage.zai_pp_tool_authorizations) as {
      version: 1;
      grants: Record<string, Record<string, unknown>>;
    };
    const template = original.grants[grant.id];
    original.grants = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => {
        const id = `grant-${index}`;
        return [id, { ...structuredClone(template), id }];
      }),
    );
    sessionStorage.zai_pp_tool_authorizations = original;

    await expect(createGrant([makeDescriptor()]))
      .rejects.toThrow('Stored tool authorization state is invalid.');

    const callOverflow = structuredClone(template) as Record<string, unknown> & {
      calls: Record<string, unknown>;
    };
    callOverflow.calls = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [
        `call-${index}`,
        { descriptorId: makeDescriptor().id, state: 'collecting', retryUsed: false },
      ]),
    );
    sessionStorage.zai_pp_tool_authorizations = {
      version: 1,
      grants: { [grant.id]: callOverflow },
    };

    await expect(createGrant([makeDescriptor()]))
      .rejects.toThrow('Stored tool authorization state is invalid.');
  });

  it('rejects stored call-state and grant-binding invariant violations', async () => {
    const descriptor = makeDescriptor();
    const grant = await createGrant([descriptor]);
    await authorizeToolExecution(
      makeCall(),
      { kind: 'grant', grantId: grant.id, subject: SUBJECT },
      [descriptor],
    );
    const valid = structuredClone(sessionStorage.zai_pp_tool_authorizations) as StoredAuthorizationTestState;
    const corruptions: Array<(state: StoredAuthorizationTestState) => void> = [
      (state) => {
        const call = state.grants[grant.id].calls['call-1'];
        call.state = 'retryable';
        call.fingerprint = undefined;
        call.retryUsed = false;
      },
      (state) => {
        const call = state.grants[grant.id].calls['call-1'];
        call.state = 'retryable';
        call.retryUsed = true;
      },
      (state) => {
        const call = state.grants[grant.id].calls['call-1'];
        call.state = 'collecting';
        call.retryUsed = false;
      },
      (state) => {
        state.grants[grant.id].calls['call-1'].descriptorId = 'local:test:unknown';
      },
      (state) => {
        state.grants[grant.id].chatSessionId = 'chat-other';
      },
    ];

    for (const corrupt of corruptions) {
      const state = structuredClone(valid);
      corrupt(state);
      sessionStorage.zai_pp_tool_authorizations = state;
      await expect(createGrant([descriptor]))
        .rejects.toThrow('Stored tool authorization state is invalid.');
    }
  });

  it.each([
    {
      name: 'unknown descriptor',
      call: makeCall({ descriptorId: 'local:test:missing' }),
      code: 'tool_not_authorized',
    },
    {
      name: 'descriptor and name mismatch',
      call: makeCall({ name: 'other_tool' }),
      code: 'tool_descriptor_mismatch',
    },
    {
      name: 'provider mismatch',
      call: makeCall({
        provider: { kind: 'local', id: 'other', displayName: 'Other', transport: 'in_process' },
      }),
      code: 'tool_descriptor_mismatch',
    },
    {
      name: 'forged trigger',
      call: makeCall({ source: { trigger: 'automation', requestId: 'request-1', chatSessionId: 'chat-1' } }),
      code: 'tool_session_mismatch',
    },
    {
      name: 'forged request identity',
      call: makeCall({ source: { trigger: 'manual_chat', requestId: 'other', chatSessionId: 'chat-1' } }),
      code: 'tool_session_mismatch',
    },
  ])('rejects $name before execution', async ({ call, code }) => {
    const descriptor = makeDescriptor();
    const grant = await createGrant([descriptor]);

    await expect(authorizeToolExecution(
      call,
      { kind: 'grant', grantId: grant.id, subject: SUBJECT },
      [descriptor],
    )).rejects.toMatchObject({ code });
  });

  it.each([
    {
      name: 'disabled descriptor',
      current: makeDescriptor({ execution: { mode: 'auto', enabled: false, risk: 'low' } }),
    },
    {
      name: 'changed mode',
      current: makeDescriptor({ execution: { mode: 'disabled', enabled: true, risk: 'low' } }),
    },
    {
      name: 'changed risk',
      current: makeDescriptor({ execution: { mode: 'auto', enabled: true, risk: 'high' } }),
    },
    {
      name: 'changed provider transport',
      current: makeDescriptor({
        provider: { kind: 'local', id: 'test', displayName: 'Test', transport: 'native_messaging' },
      }),
    },
    {
      name: 'changed input schema',
      current: makeDescriptor({
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      }),
    },
    {
      name: 'changed input field named description',
      current: makeDescriptor({
        inputSchema: { type: 'object', properties: { description: { type: 'integer' } } },
      }),
    },
  ])('rejects stale authorization after $name', async ({ current }) => {
    const descriptor = makeDescriptor();
    const grant = await createGrant([descriptor]);

    await expect(authorizeToolExecution(
      makeCall(),
      { kind: 'grant', grantId: grant.id, subject: SUBJECT },
      [current],
    )).rejects.toMatchObject({ code: 'tool_authorization_stale' });
  });

  it('does not stale a grant for localized schema description text alone', async () => {
    const descriptor = makeDescriptor({
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string', description: 'Original description' } },
      },
    });
    const grant = await createGrant([descriptor]);
    const localized = makeDescriptor({
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string', description: '本地化描述' } },
      },
    });

    await expect(authorizeToolExecution(
      makeCall(),
      { kind: 'grant', grantId: grant.id, subject: SUBJECT },
      [localized],
    )).resolves.toMatchObject({ descriptor: localized });
  });

  it('normalizes annotations inside draft-07 dependency and tuple schemas', async () => {
    const original = makeDescriptor({
      inputSchema: {
        type: 'object',
        dependencies: {
          mode: {
            type: 'object',
            description: 'Original dependency description',
            properties: { value: { type: 'string', description: 'Original value description' } },
          },
          enabled: ['mode'],
        },
        additionalItems: {
          type: 'string',
          description: 'Original tuple description',
        },
      } as ToolDescriptor['inputSchema'],
    });
    const localized = makeDescriptor({
      inputSchema: {
        type: 'object',
        dependencies: {
          mode: {
            type: 'object',
            description: '本地化依赖说明',
            properties: { value: { type: 'string', description: '本地化字段说明' } },
          },
          enabled: ['mode'],
        },
        additionalItems: {
          type: 'string',
          description: '本地化元组说明',
        },
      } as ToolDescriptor['inputSchema'],
    });
    const changedDependency = makeDescriptor({
      inputSchema: {
        ...localized.inputSchema,
        dependencies: {
          ...((localized.inputSchema as unknown as Record<string, unknown>).dependencies as Record<string, unknown>),
          enabled: ['other'],
        },
      } as ToolDescriptor['inputSchema'],
    });

    await expect(haveEquivalentToolDescriptorSecurity(original, localized)).resolves.toBe(true);
    await expect(haveEquivalentToolDescriptorSecurity(original, changedDependency)).resolves.toBe(false);
  });

  it('rejects expired and cross-session grants', async () => {
    const descriptor = makeDescriptor();
    const grant = await createGrant([descriptor], 100);

    await expect(authorizeToolExecution(
      makeCall(),
      { kind: 'grant', grantId: grant.id, subject: SUBJECT },
      [descriptor],
      100 + TOOL_AUTHORIZATION_TTL_MS + 1,
    )).rejects.toMatchObject({ code: 'tool_authorization_stale' });

    const liveGrant = await createGrant([descriptor]);
    await expect(authorizeToolExecution(
      makeCall(),
      {
        kind: 'grant',
        grantId: liveGrant.id,
        subject: { ...SUBJECT, documentSessionId: 'document-2' },
      },
      [descriptor],
    )).rejects.toMatchObject({ code: 'tool_session_mismatch' });
    await expect(authorizeToolExecution(
      makeCall(),
      {
        kind: 'grant',
        grantId: liveGrant.id,
        subject: { ...SUBJECT, chatSessionId: 'chat-2' },
      },
      [descriptor],
    )).rejects.toMatchObject({ code: 'tool_session_mismatch' });
  });

  it('allows the same document to transition from a new-chat route to its assigned session', async () => {
    const descriptor = makeDescriptor();
    const newChatSubject = { ...SUBJECT, chatSessionId: null };
    const grant = await createToolAuthorization({
      requestId: 'request-1',
      trigger: 'manual_chat',
      chatSessionId: null,
      subject: newChatSubject,
      descriptors: [descriptor],
    });

    await expect(authorizeToolExecution(
      makeCall({
        source: { trigger: 'manual_chat', requestId: 'request-1', chatSessionId: 'chat-1' },
      }),
      { kind: 'grant', grantId: grant.id, subject: SUBJECT },
      [descriptor],
    )).resolves.toMatchObject({
      descriptor,
      call: { source: { chatSessionId: 'chat-1' } },
    });

    await expect(authorizeToolExecution(
      makeCall({
        id: 'call-2',
        source: { trigger: 'manual_chat', requestId: 'request-1', chatSessionId: null },
      }),
      {
        kind: 'grant',
        grantId: grant.id,
        subject: { ...SUBJECT, chatSessionId: null },
      },
      [descriptor],
    )).rejects.toMatchObject({ code: 'tool_session_mismatch' });

    await expect(authorizeToolExecution(
      makeCall({
        id: 'call-3',
        source: { trigger: 'manual_chat', requestId: 'request-1', chatSessionId: null },
      }),
      {
        kind: 'grant',
        grantId: grant.id,
        subject: { ...SUBJECT, chatSessionId: 'chat-2' },
      },
      [descriptor],
    )).rejects.toMatchObject({ code: 'tool_session_mismatch' });

    await expect(closeToolAuthorization(
      grant.id,
      { ...SUBJECT, chatSessionId: 'chat-2' },
    )).resolves.toBeUndefined();
  });

  it('derives the grant session from the browser-owned receiver rather than a page claim', async () => {
    const descriptor = makeDescriptor();
    const grant = await createToolAuthorization({
      requestId: 'request-1',
      trigger: 'manual_chat',
      chatSessionId: 'chat-forged',
      subject: SUBJECT,
      descriptors: [descriptor],
    });
    expect(grant.chatSessionId).toBe('chat-1');

    await expect(authorizeToolExecution(
      makeCall({
        source: { trigger: 'manual_chat', requestId: 'request-1', chatSessionId: 'chat-forged' },
      }),
      { kind: 'grant', grantId: grant.id, subject: SUBJECT },
      [descriptor],
    )).rejects.toMatchObject({ code: 'tool_session_mismatch' });

    await expect(authorizeToolExecution(
      makeCall({
        source: { trigger: 'manual_chat', requestId: 'request-1', chatSessionId: 'chat-1' },
      }),
      { kind: 'grant', grantId: grant.id, subject: SUBJECT },
      [descriptor],
    )).resolves.toMatchObject({ descriptor });
  });

  it('binds a new-chat grant to the first browser-owned route before execution', async () => {
    const descriptor = makeDescriptor();
    const newChatSubject = { ...SUBJECT, chatSessionId: null };
    const grant = await createToolAuthorization({
      requestId: 'request-1',
      trigger: 'manual_chat',
      chatSessionId: 'chat-forged',
      subject: newChatSubject,
      descriptors: [descriptor],
    });
    expect(grant.chatSessionId).toBeNull();

    await expect(authorizeToolExecution(
      makeCall({
        source: { trigger: 'manual_chat', requestId: 'request-1', chatSessionId: 'chat-forged' },
      }),
      { kind: 'grant', grantId: grant.id, subject: newChatSubject },
      [descriptor],
    )).rejects.toMatchObject({ code: 'tool_session_mismatch' });

    await expect(authorizeToolExecution(
      makeCall({
        source: { trigger: 'manual_chat', requestId: 'request-1', chatSessionId: 'chat-other' },
      }),
      { kind: 'grant', grantId: grant.id, subject: { ...SUBJECT, chatSessionId: 'chat-other' } },
      [descriptor],
    )).resolves.toMatchObject({ descriptor });
  });

  it('allows only the owning document to close a grant', async () => {
    const grant = await createGrant([makeDescriptor()]);
    await expect(closeToolAuthorization(grant.id, {
      ...SUBJECT,
      documentSessionId: 'document-2',
    })).rejects.toMatchObject({ code: 'tool_session_mismatch' });
    await expect(closeToolAuthorization(grant.id, SUBJECT)).resolves.toBeUndefined();
  });

  it('rejects a mismatched provider before the runtime provider performs I/O', async () => {
    const descriptor = makeDescriptor();
    const execute = vi.fn(async () => ({ ok: true as const, summary: 'provider completed' }));
    const runtime = createTestRuntime(execute);
    const grant = await createGrant([descriptor]);

    const result = await runtime.executeToolCall({
      id: 'call-1',
      descriptorId: descriptor.id,
      provider: { ...descriptor.provider, id: 'forged-provider' },
      name: descriptor.name,
      invocationName: descriptor.invocationName,
      payload: {},
      raw: '<sample_tool>{}</sample_tool>',
      source: { trigger: 'manual_chat', requestId: 'request-1', chatSessionId: 'chat-1' },
    }, {
      kind: 'grant',
      grantId: grant.id,
      subject: SUBJECT,
    }, 'en');

    expect(result.error?.code).toBe('tool_descriptor_mismatch');
    expect(execute).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
      zai_pp_tool_history: expect.any(Array),
    }));
  });

  it('fails closed before provider I/O when reservation persistence fails', async () => {
    const descriptor = makeDescriptor();
    const execute = vi.fn(async () => ({ ok: true as const, summary: 'provider completed' }));
    const runtime = createTestRuntime(execute);
    const grant = await createGrant([descriptor]);
    vi.mocked(chrome.storage.session.set).mockRejectedValueOnce(new Error('session write failed'));

    await expect(runtime.executeToolCall(
      makeCall(),
      { kind: 'grant', grantId: grant.id, subject: SUBJECT },
      'en',
    )).rejects.toThrow('session write failed');
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves the provider result when completion persistence fails', async () => {
    const descriptor = makeDescriptor();
    const execute = vi.fn(async () => ({
      ok: true as const,
      summary: 'provider completed',
      output: { content: 'provider-result' },
    }));
    const runtime = createTestRuntime(execute);
    const grant = await createGrant([descriptor]);
    let subsequentWrites = 0;
    vi.mocked(chrome.storage.session.set).mockImplementation(async (value: Record<string, unknown>) => {
      subsequentWrites++;
      if (subsequentWrites === 2) throw new Error('completion write failed');
      sessionStorage = structuredClone({ ...sessionStorage, ...value });
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await runtime.executeToolCall(
      makeCall(),
      { kind: 'grant', grantId: grant.id, subject: SUBJECT },
      'en',
    );

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ content: 'provider-result' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[Zai++] tool authorization completion persistence failed',
      expect.any(Error),
    );
  });

  it('atomically rejects sequential and concurrent replay', async () => {
    const descriptor = makeDescriptor();
    const grant = await createGrant([descriptor]);
    const context = { kind: 'grant' as const, grantId: grant.id, subject: SUBJECT };
    const first = await authorizeToolExecution(makeCall(), context, [descriptor]);
    await completeToolExecutionAuthorization(first.reservation, { ok: true, summary: 'done' });

    await expect(authorizeToolExecution(makeCall(), context, [descriptor]))
      .rejects.toMatchObject({ code: 'tool_call_replayed' });

    const secondGrant = await createGrant([descriptor]);
    const secondContext = { kind: 'grant' as const, grantId: secondGrant.id, subject: SUBJECT };
    const attempts = await Promise.allSettled([
      authorizeToolExecution(makeCall(), secondContext, [descriptor]),
      authorizeToolExecution(makeCall(), secondContext, [descriptor]),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'tool_call_replayed' });
  });
});

const SUBJECT: ToolAuthorizationSubject = {
  surface: 'zai_content',
  documentSessionId: 'document-1',
  tabId: 7,
  frameId: 0,
  chatSessionId: 'chat-1',
};

function makeDescriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id: 'local:test:sample_tool',
    provider: { kind: 'local', id: 'test', displayName: 'Test', transport: 'in_process' },
    name: 'sample_tool',
    invocationName: 'sample_tool',
    title: 'Sample tool',
    description: 'Sample tool.',
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
    ...overrides,
  };
}

function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'call-1',
    descriptorId: 'local:test:sample_tool',
    provider: { kind: 'local', id: 'test', displayName: 'Caller label', transport: 'in_process' },
    name: 'sample_tool',
    invocationName: 'sample_tool',
    payload: {},
    raw: '<sample_tool>{}</sample_tool>',
    source: { trigger: 'manual_chat', requestId: 'request-1', chatSessionId: 'chat-1' },
    ...overrides,
  };
}

async function createGrant(descriptors: ToolDescriptor[], now?: number) {
  return createToolAuthorization({
    requestId: 'request-1',
    trigger: 'manual_chat',
    chatSessionId: 'chat-1',
    subject: SUBJECT,
    descriptors,
    now,
  });
}

function createTestRuntime(execute: RuntimeToolProvider['execute']) {
  const provider: RuntimeToolProvider = {
    registration: { kind: 'local', id: 'test' },
    listTools: async () => [makeDescriptor()],
    execute,
  };
  return createRuntimeToolRuntime(new ToolProviderRegistry([provider]));
}

interface StoredAuthorizationTestState {
  version: 1;
  grants: Record<string, {
    chatSessionId: string | null;
    subject: ToolAuthorizationSubject;
    descriptors: Array<{ id: string }>;
    calls: Record<string, {
      descriptorId: string;
      state: 'collecting' | 'executing' | 'consumed' | 'retryable';
      fingerprint?: string;
      retryUsed: boolean;
    }>;
  }>;
}
