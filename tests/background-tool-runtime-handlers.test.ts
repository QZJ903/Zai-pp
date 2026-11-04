import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserControlSettings,
  BrowserControlState,
  BrowserControlTarget,
} from '../core/browser-control/types';
import type { RuntimeMessageContext } from '../core/messaging/runtime-boundary';
import { RUNTIME_COMMAND_CONTRACTS } from '../core/messaging/runtime-command-contracts';
import {
  getRuntimeCommandOwner,
  type RuntimeCommandHandler,
} from '../core/messaging/runtime-command-registry';
import { TOOL_RUNTIME_PAYLOAD_DECODERS } from '../core/messaging/tool-runtime-request-codec';
import type { McpCapabilitySettings } from '../core/mcp/capability-types';
import type { McpServerConfig, McpToolCacheEntry } from '../core/mcp/types';
import { createCapabilityMap, type PlatformEnvironment } from '../core/platform/capabilities';
import { createMcpCapabilityToolDescriptors } from '../core/mcp/capability-tools';
import { ToolAuthorizationError } from '../core/tool/authorization';
import type {
  RuntimeToolAuthorizationContext,
  ToolAuthorizationGrantSummary,
  ToolCall,
  ToolCallHistoryRecord,
  ToolDescriptor,
  ToolResult,
} from '../core/tool/types';
import {
  createBrowserToolRuntimeHandlers,
  type BrowserToolRuntimeHandlerDependencies,
} from '../entrypoints/background/browser-tool-handlers';
import {
  createMcpRuntimeHandlers,
  type McpRuntimeHandlerDependencies,
} from '../entrypoints/background/mcp-handlers';
import {
  createToolAuthorizationSubject,
  createTrustedToolExecutionContext,
  createToolExecutionRuntimeHandlers,
  type ToolExecutionRuntimeHandlerDependencies,
} from '../entrypoints/background/tool-execution-handlers';
import { createToolRuntimeHandlers } from '../entrypoints/background/tool-runtime-handlers';

const extensionContext: RuntimeMessageContext = {
  runtimeId: 'extension-id',
  surface: 'extension_context',
  senderUrl: 'chrome-extension://extension-id/sidepanel.html',
  senderOrigin: 'chrome-extension://extension-id',
  tabId: 17,
  frameId: 0,
  documentId: 'extension-document-1',
  documentSessionId: 'extension-document-1',
};

const zaiContext: RuntimeMessageContext = {
  runtimeId: 'extension-id',
  surface: 'zai_content',
  senderUrl: 'https://chat.z.ai/a/chat/s/chat-1',
  senderOrigin: 'https://chat.z.ai',
  tabId: 7,
  frameId: 0,
  documentId: 'document-1',
  documentSessionId: 'document-1',
  chatSessionId: 'chat-1',
};

const descriptor: ToolDescriptor = {
  id: 'local:test:sample_tool',
  provider: { kind: 'local', id: 'test', displayName: 'Test', transport: 'in_process' },
  name: 'sample_tool',
  invocationName: 'sample_tool',
  title: 'Sample tool',
  description: 'Sample tool.',
  inputSchema: { type: 'object', properties: {} },
  execution: { mode: 'auto', enabled: true, risk: 'low' },
};

const call: ToolCall = {
  id: 'call-1',
  descriptorId: descriptor.id,
  provider: descriptor.provider,
  name: descriptor.name,
  invocationName: descriptor.invocationName,
  payload: { value: 'approved' },
  raw: '<sample_tool>{"value":"approved"}</sample_tool>',
  source: {
    trigger: 'manual_chat',
    requestId: 'request-1',
    chatSessionId: 'chat-1',
  },
};

describe('tool runtime handler ownership', () => {
  it('creates exactly the 30 inventory-assigned handlers without duplicate ownership', () => {
    const handlers = createToolRuntimeHandlers({
      mcp: createMcpDependencies(),
      browser: createBrowserDependencies(),
      execution: createExecutionDependencies(),
    });
    const types = handlers.map((handler) => handler.type);
    const expected = readInventoryCommands(
      'Group C — MCP, tool, browser control, and sandbox (30)',
    );

    expect(types).toHaveLength(30);
    expect(new Set(types).size).toBe(30);
    expect([...types].sort()).toEqual([...expected].sort());
    for (const type of types) expect(getRuntimeCommandOwner(type)).toBe('typed-handler');

    const decodedTypes = Object.entries(RUNTIME_COMMAND_CONTRACTS)
      .filter(([, contract]) => contract.request.access === 'payload-decoded')
      .map(([type]) => type)
      .filter((type) => expected.includes(type))
      .sort();
    expect(Object.keys(TOOL_RUNTIME_PAYLOAD_DECODERS).sort()).toEqual(decodedTypes);
    expect(decodedTypes).toHaveLength(18);
  });

  it('rejects malformed nested MCP input before persistence or external I/O', async () => {
    const dependencies = createMcpDependencies();
    const handlers = createMcpRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, {
      type: 'CREATE_MCP_SERVER',
      payload: {
        displayName: 'Invalid',
        transport: { kind: 'http', url: 'https://example.test/mcp' },
        secrets: [{ kind: 'bearer', value: 7 }],
      },
    })).rejects.toThrow('CREATE_MCP_SERVER.payload.secrets[0].value must be a string');
    expect(dependencies.createMcpServer).not.toHaveBeenCalled();
  });

  it('rejects missing and non-plain required payloads before dependency I/O', async () => {
    const dependencies = createMcpDependencies();
    const handlers = createMcpRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, { type: 'GET_MCP_SERVER' }))
      .rejects.toThrow('GET_MCP_SERVER.payload must be a plain object');
    await expect(dispatch(handlers, {
      type: 'GET_MCP_SERVER',
      payload: new Date(0),
    })).rejects.toThrow('GET_MCP_SERVER.payload must be a plain object');
    expect(dependencies.getMcpServerById).not.toHaveBeenCalled();
  });
});

describe('MCP runtime handlers', () => {
  it('preserves nullable reads, redacted server output, and raw cache output', async () => {
    const dependencies = createMcpDependencies();
    const redacted = createMcpServer({
      secrets: [{ kind: 'bearer', value: '********' }],
    });
    const cache = createMcpCache();
    vi.mocked(dependencies.getAllMcpServers).mockResolvedValue([redacted]);
    vi.mocked(dependencies.getMcpServerById)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(redacted);
    vi.mocked(dependencies.getMcpToolCache)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(cache);
    vi.mocked(dependencies.updateMcpServer).mockResolvedValueOnce(null);
    const handlers = createMcpRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, { type: 'GET_MCP_SERVERS' })).resolves.toEqual([redacted]);
    await expect(dispatch(handlers, {
      type: 'GET_MCP_SERVER',
      payload: { id: 'missing' },
    })).resolves.toBeNull();
    await expect(dispatch(handlers, {
      type: 'GET_MCP_SERVER',
      payload: { id: redacted.id },
    })).resolves.toEqual(redacted);
    await expect(dispatch(handlers, {
      type: 'GET_MCP_TOOL_CACHE',
      payload: { serverId: 'missing' },
    })).resolves.toBeNull();
    await expect(dispatch(handlers, {
      type: 'GET_MCP_TOOL_CACHE',
      payload: { serverId: redacted.id },
    })).resolves.toBe(cache);
    await expect(dispatch(handlers, {
      type: 'UPDATE_MCP_SERVER',
      payload: { id: redacted.id, patch: {} },
    })).resolves.toBeNull();
  });

  it('drops the server exposure entry when a server is deleted', async () => {
    // ⚠️ **成对动作的另一半** —— 服务的暴露设置（`mode` / `pinnedDescriptorIds`）
    // 存在 `zai_pp_mcp_capability_settings` 里，是一个**独立的键**。只删 `servers`
    // 与 `toolCaches` 会让那一格随删除次数单调增长：读不到、也不报错，永远发现不了。
    const dependencies = createMcpDependencies();
    const handlers = createMcpRuntimeHandlers(dependencies);

    await dispatch(handlers, { type: 'DELETE_MCP_SERVER', payload: { id: 'doomed' } });

    expect(dependencies.deleteMcpServer).toHaveBeenCalledWith('doomed');
    expect(dependencies.deleteMcpCapabilityServerSettings, '删除服务必须同时清掉它的暴露设置')
      .toHaveBeenCalledWith('doomed');
  });

  it('notifies MCP consumers before descriptor consumers after mutations and discovery', async () => {
    const events: string[] = [];
    const dependencies = createMcpDependencies();
    vi.mocked(dependencies.createMcpServer).mockImplementation(async () => {
      events.push('create');
      return createMcpServer();
    });
    vi.mocked(dependencies.refreshMcpServerDiscovery).mockImplementation(async () => {
      events.push('refresh');
      return createMcpCache();
    });
    vi.mocked(dependencies.broadcastMcpServersUpdate).mockImplementation(async (tabId) => {
      events.push(`mcp:${tabId}`);
    });
    vi.mocked(dependencies.broadcastToolDescriptorsUpdate).mockImplementation(async (tabId) => {
      events.push(`tools:${tabId}`);
    });
    const handlers = createMcpRuntimeHandlers(dependencies);

    await dispatch(handlers, {
      type: 'CREATE_MCP_SERVER',
      payload: {
        displayName: 'Example',
        transport: { kind: 'http', url: 'https://example.test/mcp' },
      },
    });
    expect(events).toEqual(['create', 'mcp:17', 'tools:17']);

    events.length = 0;
    await dispatch(handlers, {
      type: 'REFRESH_MCP_SERVER_TOOLS',
      payload: { serverId: 'server-1' },
    });
    expect(events).toEqual(['refresh', 'mcp:17', 'tools:17']);
  });

  it('preserves all released MCP permission response branches', async () => {
    const dependencies = createMcpDependencies();
    const handlers = createMcpRuntimeHandlers(dependencies);

    vi.mocked(dependencies.getMcpServerById).mockResolvedValueOnce(null);
    await expect(dispatch(handlers, {
      type: 'REQUEST_MCP_SERVER_PERMISSION',
      payload: { serverId: 'missing' },
    })).resolves.toEqual({ ok: false, error: 'mcp_server_not_found' });

    vi.mocked(dependencies.getMcpServerById).mockResolvedValueOnce(createMcpServer({
      transport: { kind: 'native_messaging', nativeHost: 'com.example.host' },
    }));
    await expect(dispatch(handlers, {
      type: 'REQUEST_MCP_SERVER_PERMISSION',
      payload: { serverId: 'server-1' },
    })).resolves.toEqual({ ok: true, origin: null });
    expect(dependencies.hasMcpServerOriginPermission).not.toHaveBeenCalled();

    vi.mocked(dependencies.getMcpServerById).mockResolvedValue(createMcpServer());
    vi.mocked(dependencies.hasMcpServerOriginPermission)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('permissions API unavailable'));
    await expect(dispatch(handlers, {
      type: 'REQUEST_MCP_SERVER_PERMISSION',
      payload: { serverId: 'server-1' },
    })).resolves.toEqual({
      ok: false,
      origin: 'https://example.test/*',
    });
    await expect(dispatch(handlers, {
      type: 'REQUEST_MCP_SERVER_PERMISSION',
      payload: { serverId: 'server-1' },
    })).resolves.toEqual({ ok: false, error: 'permissions API unavailable' });
  });

  it('wraps the connection test without changing the raw discovery cache contract', async () => {
    const dependencies = createMcpDependencies();
    const cache = createMcpCache();
    vi.mocked(dependencies.refreshMcpServerDiscovery).mockResolvedValue(cache);
    const handlers = createMcpRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, {
      type: 'TEST_MCP_SERVER_CONNECTION',
      payload: { serverId: cache.serverId },
    })).resolves.toEqual({ ok: true, cache, health: cache.health });
    expect(dependencies.broadcastMcpServersUpdate).toHaveBeenCalledWith(17);
    expect(dependencies.broadcastToolDescriptorsUpdate).toHaveBeenCalledWith(17);
  });
});

describe('browser and web runtime handlers', () => {
  it('keeps the released empty settings patch and descriptor-before-browser notification order', async () => {
    const events: string[] = [];
    const dependencies = createBrowserDependencies();
    vi.mocked(dependencies.saveBrowserControlSettings).mockImplementation(async (patch) => {
      events.push(`save:${JSON.stringify(patch)}`);
      return createBrowserSettings();
    });
    vi.mocked(dependencies.broadcastToolDescriptorsUpdate).mockImplementation(async () => {
      events.push('tools');
    });
    vi.mocked(dependencies.broadcastBrowserControlUpdate).mockImplementation(async () => {
      events.push('browser');
    });
    const handlers = createBrowserToolRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, {
      type: 'SAVE_BROWSER_CONTROL_SETTINGS',
    })).resolves.toEqual(createBrowserSettings());
    expect(events).toEqual(['save:{}', 'tools', 'browser']);
  });

  it('detaches before publishing a disabled browser-control state', async () => {
    const events: string[] = [];
    const dependencies = createBrowserDependencies();
    vi.mocked(dependencies.setBrowserControlEnabled).mockImplementation(async () => {
      events.push('disable');
      return createBrowserSettings({ enabled: false });
    });
    vi.mocked(dependencies.detachBrowserControl).mockImplementation(async () => {
      events.push('detach');
    });
    vi.mocked(dependencies.broadcastToolDescriptorsUpdate).mockImplementation(async () => {
      events.push('tools');
    });
    vi.mocked(dependencies.broadcastBrowserControlUpdate).mockImplementation(async () => {
      events.push('browser');
    });
    const handlers = createBrowserToolRuntimeHandlers(dependencies);

    await dispatch(handlers, {
      type: 'SET_BROWSER_CONTROL_ENABLED',
      payload: { enabled: false },
    });
    expect(events).toEqual(['disable', 'detach', 'tools', 'browser']);

    events.length = 0;
    await dispatch(handlers, {
      type: 'SET_BROWSER_CONTROL_ENABLED',
      payload: { enabled: true },
    });
    expect(events).toEqual(['disable', 'tools', 'browser']);
  });

  it('passes through unsupported PC browser state and publishes target changes after success', async () => {
    const state = createBrowserState({
      supported: false,
      error: 'browser_control_unsupported',
    });
    const target = createBrowserTarget();
    const dependencies = createBrowserDependencies();
    vi.mocked(dependencies.getBrowserControlState).mockResolvedValue(state);
    vi.mocked(dependencies.setBrowserControlTarget).mockResolvedValue(target);
    const handlers = createBrowserToolRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, { type: 'GET_BROWSER_CONTROL_STATE' }))
      .resolves.toBe(state);
    await expect(dispatch(handlers, {
      type: 'SET_BROWSER_CONTROL_TARGET',
      payload: { tabId: 9 },
    })).resolves.toEqual({ ok: true, target });
    expect(dependencies.broadcastBrowserControlUpdate).toHaveBeenCalledWith(17);
  });

});

describe('tool execution runtime handlers', () => {
  it('gates authorization by receiver surface and validates before descriptor I/O', async () => {
    const dependencies = createExecutionDependencies();
    const handlers = createToolExecutionRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, {
      type: 'CREATE_TOOL_AUTHORIZATION',
      payload: { requestId: 'request-1', trigger: 'manual_chat' },
    })).resolves.toEqual({
      ok: false,
      error: 'tool_authorization_requires_content_runtime',
    });
    expect(dependencies.getToolDescriptors).not.toHaveBeenCalled();

    await expect(dispatch(handlers, {
      type: 'CREATE_TOOL_AUTHORIZATION',
      payload: { requestId: 7, trigger: 'manual_chat' },
    }, zaiContext)).resolves.toEqual({
      ok: false,
      error: 'invalid_tool_authorization_request',
    });
    expect(dependencies.getToolDescriptors).not.toHaveBeenCalled();
  });

  it('distinguishes omitted descriptor selection from an explicit empty selection', async () => {
    const dependencies = createExecutionDependencies();
    vi.mocked(dependencies.getToolDescriptors).mockResolvedValue([descriptor]);
    const handlers = createToolExecutionRuntimeHandlers(dependencies);

    await dispatch(handlers, {
      type: 'CREATE_TOOL_AUTHORIZATION',
      payload: { requestId: 'request-all', trigger: 'manual_chat', chatSessionId: 'chat-1' },
    }, zaiContext);
    expect(dependencies.createToolAuthorization).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ descriptors: [descriptor] }),
    );

    await dispatch(handlers, {
      type: 'CREATE_TOOL_AUTHORIZATION',
      payload: {
        requestId: 'request-none',
        trigger: 'manual_chat',
        chatSessionId: 'chat-1',
        descriptorIds: [],
      },
    }, zaiContext);
    expect(dependencies.createToolAuthorization).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ descriptors: [] }),
    );
  });

  it('keeps catalog controls available to the content parser while authorizing them only through a prompt projection', async () => {
    const dependencies = createExecutionDependencies();
    const [discover] = createMcpCapabilityToolDescriptors('en');
    vi.mocked(dependencies.getToolDescriptors).mockResolvedValue([descriptor, discover]);
    vi.mocked(dependencies.getPromptToolDescriptors).mockResolvedValue([descriptor, discover]);
    const handlers = createToolExecutionRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, { type: 'GET_TOOL_DESCRIPTORS' }))
      .resolves.toEqual([descriptor, discover]);

    await dispatch(handlers, {
      type: 'CREATE_TOOL_AUTHORIZATION',
      payload: {
        requestId: 'request-projected',
        trigger: 'manual_chat',
        chatSessionId: 'chat-1',
        toolIntent: 'discover a workspace capability',
      },
    }, zaiContext);
    expect(dependencies.getPromptToolDescriptors).toHaveBeenCalledWith(
      'en',
      'discover a workspace capability',
    );
    expect(dependencies.createToolAuthorization).toHaveBeenLastCalledWith(
      expect.objectContaining({ descriptors: [descriptor, discover] }),
    );

    await dispatch(handlers, {
      type: 'CREATE_TOOL_AUTHORIZATION',
      payload: {
        requestId: 'request-catalog-continuation',
        trigger: 'agent_run',
        chatSessionId: 'chat-1',
        descriptorIds: [discover.id],
      },
    }, zaiContext);
    expect(dependencies.createToolAuthorization).toHaveBeenLastCalledWith(
      expect.objectContaining({ descriptors: [discover] }),
    );
  });

  it('keeps grant identity stable when MessageSender.documentId is unavailable', () => {
    const subject = createToolAuthorizationSubject({
      ...zaiContext,
      documentId: undefined,
      documentSessionId: 'zai_content:7:0:https://chat.z.ai/a/chat/s/chat-1',
    });

    expect(subject).toEqual({
      surface: 'zai_content',
      documentSessionId: 'zai_content:7:0',
      tabId: 7,
      frameId: 0,
      chatSessionId: 'chat-1',
    });
  });

  it('keeps trusted request correlation separate from a stable capability scope', () => {
    expect(createTrustedToolExecutionContext(
      call,
      'automation',
      () => 'generated-request-id',
      'automation:run-1:attempt-1',
    )).toMatchObject({
      kind: 'trusted',
      trigger: 'automation',
      requestId: 'request-1',
      capabilityScopeId: 'automation:run-1:attempt-1',
    });
  });

  it('uses content grants, fails closed without an id, and keeps extension calls trusted', async () => {
    const events: string[] = [];
    const dependencies = createExecutionDependencies();
    vi.mocked(dependencies.executeToolCall).mockImplementation(async (_call, authorization) => {
      events.push(`execute:${authorization.kind}`);
      return { ok: true, summary: 'done' };
    });
    vi.mocked(dependencies.broadcastToolCallHistoryUpdate).mockImplementation(async () => {
      events.push('history:broadcast');
    });
    const handlers = createToolExecutionRuntimeHandlers(dependencies);

    await dispatch(handlers, {
      type: 'EXECUTE_TOOL_CALL',
      payload: { ...call, authorizationId: 'grant-1' },
    }, zaiContext);
    expect(events).toEqual(['execute:grant', 'history:broadcast']);
    expect(dependencies.executeToolCall).toHaveBeenNthCalledWith(
      1,
      call,
      {
        kind: 'grant',
        grantId: 'grant-1',
        subject: createToolAuthorizationSubject(zaiContext),
      },
      'en',
    );

    events.length = 0;
    await dispatch(handlers, { type: 'EXECUTE_TOOL_CALL', payload: call }, zaiContext);
    expect(dependencies.executeToolCall).toHaveBeenNthCalledWith(
      2,
      call,
      expect.objectContaining({ kind: 'grant', grantId: '' }),
      'en',
    );

    events.length = 0;
    await dispatch(handlers, { type: 'EXECUTE_TOOL_CALL', payload: call });
    expect(dependencies.executeToolCall).toHaveBeenNthCalledWith(
      3,
      call,
      expect.objectContaining({
        kind: 'trusted',
        trigger: 'manual_chat',
        requestId: 'request-1',
        chatSessionId: 'chat-1',
      }),
      'en',
    );
  });

  it.each([
    ['missing payload', undefined],
    ['null payload', null],
    ['array payload', []],
    ['malformed identified call', {
      authorizationId: 'grant-1',
      id: 'call-invalid',
      name: descriptor.name,
    }],
  ])('rejects %s before cache, runtime, or broadcast side effects', async (_name, payload) => {
    const dependencies = createExecutionDependencies();
    const invalidResult: ToolResult = {
      ok: false,
      summary: 'Invalid tool call',
      detail: 'Runtime tool call does not match the released contract.',
      error: {
        code: 'tool_call_payload_invalid',
        message: 'Runtime tool call does not match the released contract.',
        retryable: false,
      },
    };
    vi.mocked(dependencies.createInvalidToolCallResult).mockReturnValue(invalidResult);
    const handlers = createToolExecutionRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, {
      type: 'EXECUTE_TOOL_CALL',
      payload,
    }, zaiContext)).resolves.toBe(invalidResult);
    expect(dependencies.executeToolCall).not.toHaveBeenCalled();
    expect(dependencies.broadcastToolCallHistoryUpdate).not.toHaveBeenCalled();
  });

  it('closes the persisted authorization without touching anything else', async () => {
    const close = vi.fn(async () => undefined);
    const dependencies = createExecutionDependencies();
    vi.mocked(dependencies.closeToolAuthorization).mockImplementation(close);
    const handlers = createToolExecutionRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, {
      type: 'CLOSE_TOOL_AUTHORIZATION',
      payload: { authorizationId: 'grant-1' },
    }, zaiContext)).resolves.toEqual({ ok: true });
    expect(close).toHaveBeenCalledWith('grant-1', expect.anything());
  });

  it('preserves history limits, notification order, and platform capabilities', async () => {
    const dependencies = createExecutionDependencies();
    const history = createHistoryRecord();
    const platform = createPlatformEnvironment();
    vi.mocked(dependencies.getToolCallHistory).mockResolvedValue({ records: [history], dropped: 0 });
    vi.mocked(dependencies.getPlatformEnvironment).mockReturnValue(platform);
    const handlers = createToolExecutionRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, {
      type: 'GET_TOOL_CALL_HISTORY',
      payload: { limit: 5 },
    })).resolves.toEqual({ records: [history], dropped: 0 });
    expect(dependencies.getToolCallHistory).toHaveBeenCalledWith(5);

    vi.mocked(dependencies.getToolCallHistory).mockClear();
    await expect(dispatch(handlers, { type: 'GET_TOOL_CALL_HISTORY' }))
      .resolves.toEqual({ records: [history], dropped: 0 });
    expect(dependencies.getToolCallHistory).toHaveBeenCalledWith(undefined);

    await expect(dispatch(handlers, { type: 'CLEAR_TOOL_CALL_HISTORY' }))
      .resolves.toEqual({ ok: true });
    expect(dependencies.clearToolCallHistory).toHaveBeenCalledOnce();
    expect(dependencies.broadcastToolCallHistoryUpdate).toHaveBeenCalledWith(17);

    await expect(dispatch(handlers, { type: 'GET_PLATFORM_CAPABILITIES' }))
      .resolves.toBe(platform);
  });

  it('publishes descriptor refreshes in descriptor-before-MCP order', async () => {
    const events: string[] = [];
    const dependencies = createExecutionDependencies();
    vi.mocked(dependencies.refreshToolDescriptors).mockImplementation(async () => {
      events.push('refresh');
      return [descriptor];
    });
    vi.mocked(dependencies.broadcastToolDescriptorsUpdate).mockImplementation(async () => {
      events.push('tools');
    });
    vi.mocked(dependencies.broadcastMcpServersUpdate).mockImplementation(async () => {
      events.push('mcp');
    });
    const handlers = createToolExecutionRuntimeHandlers(dependencies);

    await expect(dispatch(handlers, { type: 'REFRESH_TOOL_DESCRIPTORS' }))
      .resolves.toEqual([descriptor]);
    expect(events).toEqual(['refresh', 'tools', 'mcp']);
  });
});

function createMcpDependencies(): McpRuntimeHandlerDependencies {
  return {
    getAllMcpServers: vi.fn(async () => []),
    getMcpCapabilitySettings: vi.fn(async () => createMcpCapabilitySettings()),
    updateMcpCapabilitySettings: vi.fn(async () => createMcpCapabilitySettings()),
    setMcpCapabilityServerExposure: vi.fn(async () => createMcpCapabilitySettings()),
    getMcpServerById: vi.fn(async () => createMcpServer()),
    createMcpServer: vi.fn(async () => createMcpServer()),
    updateMcpServer: vi.fn(async () => createMcpServer()),
    deleteMcpServer: vi.fn(async () => undefined),
    deleteMcpCapabilityServerSettings: vi.fn(async () => createMcpCapabilitySettings()),
    getMcpToolCache: vi.fn(async () => createMcpCache()),
    refreshMcpServerDiscovery: vi.fn(async () => createMcpCache()),
    getMcpOriginPattern: vi.fn(() => 'https://example.test/*'),
    hasMcpServerOriginPermission: vi.fn(async () => true),
    broadcastMcpServersUpdate: vi.fn(async () => undefined),
    broadcastToolDescriptorsUpdate: vi.fn(async () => undefined),
  };
}

function createBrowserDependencies(): BrowserToolRuntimeHandlerDependencies {
  return {
    getBrowserControlSettings: vi.fn(async () => createBrowserSettings()),
    saveBrowserControlSettings: vi.fn(async () => createBrowserSettings()),
    setBrowserControlEnabled: vi.fn(async (enabled) => createBrowserSettings({ enabled })),
    getBrowserControlState: vi.fn(async () => createBrowserState()),
    setBrowserControlTarget: vi.fn(async () => createBrowserTarget()),
    detachBrowserControl: vi.fn(async () => undefined),
    startTabKeepAlive: vi.fn(async () => undefined),
    stopTabKeepAlive: vi.fn(async () => undefined),
    getTabKeepaliveSettings: vi.fn(async () => ({ enabled: true })),
    setTabKeepaliveEnabled: vi.fn(async (enabled: boolean) => ({ enabled })),
    broadcastToolDescriptorsUpdate: vi.fn(async () => undefined),
    broadcastBrowserControlUpdate: vi.fn(async () => undefined),
  };
}

function createExecutionDependencies(): ToolExecutionRuntimeHandlerDependencies {
  const grant: ToolAuthorizationGrantSummary = {
    id: 'grant-1',
    requestId: 'request-1',
    trigger: 'manual_chat',
    chatSessionId: 'chat-1',
    descriptors: [descriptor],
    expiresAt: 2_000,
  };
  return {
    getLocale: vi.fn(() => 'en' as const),
    getToolDescriptors: vi.fn(async () => [descriptor]),
    getPromptToolDescriptors: vi.fn(async () => [descriptor]),
    getAuthorizationDescriptors: vi.fn(async () => [descriptor]),
    refreshToolDescriptors: vi.fn(async () => [descriptor]),
    createToolAuthorization: vi.fn(async () => grant),
    closeToolAuthorization: vi.fn(async () => undefined),
    createInvalidToolCallResult: vi.fn(() => ({
      ok: false,
      summary: 'Invalid tool call',
      detail: 'Runtime tool call does not match the released contract.',
      error: {
        code: 'tool_call_payload_invalid',
        message: 'Runtime tool call does not match the released contract.',
        retryable: false,
      },
    })),
    executeToolCall: vi.fn(async (_call, _authorization: RuntimeToolAuthorizationContext) => ({
      ok: true,
      summary: 'done',
    })),
    getToolCallHistory: vi.fn(async () => ({ records: [], dropped: 0 })),
    clearToolCallHistory: vi.fn(async () => undefined),
    getPlatformEnvironment: vi.fn(() => createPlatformEnvironment()),
    createRequestId: vi.fn(() => 'generated-request-id'),
    now: vi.fn(() => 1_000),
    broadcastToolDescriptorsUpdate: vi.fn(async () => undefined),
    broadcastMcpServersUpdate: vi.fn(async () => undefined),
    broadcastToolCallHistoryUpdate: vi.fn(async () => undefined),
    // mock 的本地目录校验默认信任（本用例不针对该校验逻辑）。
    validateLocalSkillDirectory: vi.fn(async () => true),
  };
}

function createMcpCapabilitySettings(
  overrides: Partial<McpCapabilitySettings> = {},
): McpCapabilitySettings {
  return {
    version: 1,
    adaptiveMaxDirectTools: 8,
    adaptiveMaxPromptBytes: 24_000,
    servers: {},
    ...overrides,
  };
}

function createMcpServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    version: 1,
    id: 'server-1',
    displayName: 'Example MCP',
    enabled: true,
    transport: { kind: 'http', url: 'https://example.test/mcp' },
    headers: [],
    secrets: [],
    timeouts: { connectMs: 10_000, requestMs: 60_000, discoveryMs: 20_000 },
    limits: { maxResultBytes: 64_000, maxToolCount: 128 },
    allowlist: { mode: 'all', toolNames: [] },
    execution: { mode: 'auto', enabled: true },
    status: 'ready',
    lastConnectedAt: 1_000,
    lastError: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function createMcpCache(): McpToolCacheEntry {
  return {
    serverId: 'server-1',
    descriptors: [descriptor],
    refreshedAt: 1_000,
    expiresAt: 2_000,
    health: {
      serverId: 'server-1',
      status: 'ready',
      checkedAt: 1_000,
      latencyMs: 10,
      toolCount: 1,
      error: null,
    },
  };
}

function createBrowserSettings(
  overrides: Partial<BrowserControlSettings> = {},
): BrowserControlSettings {
  return {
    enabled: true,
    targetTabId: 9,
    includeSnapshotAfterActions: true,
    maxSnapshotNodes: 500,
    maxSnapshotTextBytes: 32_000,
    ...overrides,
  };
}

function createBrowserTarget(): BrowserControlTarget {
  return {
    id: 9,
    windowId: 3,
    groupId: -1,
    active: true,
    currentWindow: true,
    title: 'Example',
    url: 'https://example.test/',
    controllable: true,
  };
}

function createBrowserState(overrides: Partial<BrowserControlState> = {}): BrowserControlState {
  return {
    supported: true,
    enabled: true,
    attached: false,
    targetTabId: 9,
    target: createBrowserTarget(),
    targets: [createBrowserTarget()],
    error: null,
    ...overrides,
  };
}

function createPlatformEnvironment(): PlatformEnvironment {
  return {
    kind: 'browser_extension',
    name: 'WebExtension',
    capabilities: createCapabilityMap({
      storage: true,
      runtimeMessaging: true,
      tabs: true,
    }),
  };
}

function createHistoryRecord(): ToolCallHistoryRecord {
  const result: ToolResult = { ok: true, summary: 'done' };
  return {
    id: 'history-1',
    call,
    result,
    source: 'manual_chat',
    createdAt: 1_000,
  };
}


function dispatch(
  handlers: readonly RuntimeCommandHandler[],
  message: { type: string; payload?: unknown },
  context: RuntimeMessageContext = extensionContext,
): Promise<unknown> {
  const handler = handlers.find((candidate) => candidate.type === message.type);
  if (!handler) throw new Error(`Handler not found: ${message.type}`);
  return handler.handle(message, context);
}

function readInventoryCommands(heading: string): string[] {
  const source = readFileSync('docs/compatibility/runtime-command-inventory.md', 'utf8');
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = source.match(
    new RegExp(`### ${escaped}[^\\n]*\\n\\n` + '```text\\n([\\s\\S]*?)\\n```'),
  )?.[1];
  if (!block) throw new Error(`Inventory block not found: ${heading}`);
  return block.split('\n').filter(Boolean);
}
