import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_DISCOVERY_PAGES,
  MAX_DISCOVERY_RESPONSE_BYTES,
  MCP_NATIVE_ENVELOPE_PROTOCOL,
  MCP_NATIVE_ENVELOPE_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  McpTransportError,
  buildMcpRequestHeaders,
  callMcpTool,
  createMcpNativeMessagingTransport,
  createMcpRequest,
  createMcpTransport,
  fetchWithTimeout,
  initializeMcpServer,
  listMcpTools,
  normalizeJsonRpcResponse,
} from '../core/mcp';
import { parseJsonRpcSseMessage } from '../core/mcp/transports/common';
import type {
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpProtocolTransport,
  McpServerConfig,
} from '../core/mcp';
import type { ToolCall } from '../core/types';
import {
  MCP_CURRENT_GAPS,
  MCP_UNKNOWN_TRANSPORT_CONTRACT,
  MCP_NATIVE_ENVELOPE_FIXTURE,
  MCP_PROTOCOL_CONTRACT,
  MCP_PROTOCOL_NEGOTIATION_FIXTURES,
  MCP_STRICT_RESPONSE_REJECTIONS,
} from './fixtures/external-runtime/mcp';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MCP and Native external contract', () => {
  it('freezes the request protocol, five transports, and Native envelope identity', () => {
    expect(MCP_PROTOCOL_VERSION).toBe(MCP_PROTOCOL_CONTRACT.requestVersion);
    expect([...MCP_SUPPORTED_PROTOCOL_VERSIONS]).toEqual(MCP_PROTOCOL_CONTRACT.supportedVersions);
    expect(MCP_NATIVE_ENVELOPE_PROTOCOL).toBe(MCP_PROTOCOL_CONTRACT.nativeEnvelopeProtocol);
    expect(MCP_NATIVE_ENVELOPE_VERSION).toBe(MCP_PROTOCOL_CONTRACT.nativeEnvelopeVersion);
    expect(MCP_PROTOCOL_CONTRACT.transportKinds).toEqual([
      'http',
      'sse',
      'streamable_http',
      'stdio_bridge',
      'native_messaging',
    ]);
  });

  it('advertises only implemented client capabilities during initialize', async () => {
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ version: '1.11.9' }) },
    });

    const initializeRequests: Array<McpJsonRpcRequest<Record<string, unknown>>> = [];
    const transport: McpProtocolTransport = {
      async request(request) {
        initializeRequests.push(
          request as McpJsonRpcRequest<Record<string, unknown>>,
        );
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'strict-server', version: '1.0.0' },
          },
        } as McpJsonRpcResponse<any>;
      },
      async notify() {},
    };

    await initializeMcpServer(mcpServer(), transport);

    expect(initializeRequests[0]).toMatchObject({
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: MCP_PROTOCOL_CONTRACT.clientCapabilities,
        clientInfo: { name: 'Zai++', version: '1.11.9' },
      },
    });
    expect(
      (initializeRequests[0]?.params as { capabilities?: Record<string, unknown> } | undefined)
        ?.capabilities,
    ).not.toHaveProperty('tools');
  });

  it('preserves known/missing negotiation and rejects unsupported versions before notification', async () => {
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ version: '1.10.0' }) },
    });

    for (const fixture of MCP_PROTOCOL_NEGOTIATION_FIXTURES) {
      const methods: string[] = [];
      const transport: McpProtocolTransport = {
        async request(request) {
          methods.push(request.method);
          return {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              ...(fixture.classification === 'legacy-fallback'
                ? {}
                : { protocolVersion: fixture.serverVersion }),
              capabilities: { tools: {} },
              serverInfo: { name: 'contract-server', version: '1.0.0' },
            },
          } as McpJsonRpcResponse<any>;
        },
        async notify(notification) {
          methods.push(notification.method);
        },
      };

      const initialization = initializeMcpServer(mcpServer(), transport);
      if (fixture.classification === 'unsupported') {
        await expect(initialization).rejects.toMatchObject({ code: fixture.errorCode });
        expect(methods).toEqual(['initialize']);
      } else {
        await expect(initialization)
          .resolves.toMatchObject({ protocolVersion: fixture.currentOutput });
        expect(methods).toEqual(MCP_PROTOCOL_CONTRACT.handshakeMethods.slice(0, 2));
      }
    }
  });

  it('propagates a caller cancellation signal through MCP initialization and tool calls', async () => {
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ version: '1.10.0' }) },
    });
    const controller = new AbortController();
    const receivedSignals: Array<AbortSignal | undefined> = [];
    const transport: McpProtocolTransport = {
      async request(request, options) {
        receivedSignals.push(options?.signal);
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: request.method === 'initialize'
            ? { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} }
            : { content: [{ type: 'text', text: 'done' }] },
        } as McpJsonRpcResponse<any>;
      },
      async notify(_notification, options) {
        receivedSignals.push(options?.signal);
      },
    };

    await initializeMcpServer(mcpServer(), transport, { signal: controller.signal });
    await callMcpTool(mcpServer(), transport, {
      call: toolCall(),
      signal: controller.signal,
    });

    expect(receivedSignals).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
    ]);
  });

  it('preserves the caller abort reason when cancelling an MCP HTTP request', async () => {
    vi.stubGlobal('fetch', vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })));
    const controller = new AbortController();
    const reason = new Error('automation cancelled');
    const request = fetchWithTimeout('https://mcp.example.test/rpc', {
      signal: controller.signal,
    }, 10_000);

    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
  });

  it('keeps caller cancellation connected after response headers arrive', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => new Response(new ReadableStream({
      start(streamController) {
        init?.signal?.addEventListener('abort', () => {
          streamController.error(init.signal?.reason);
        }, { once: true });
      },
    }))));
    const controller = new AbortController();
    const reason = new Error('cancel while reading');
    const response = await fetchWithTimeout('https://mcp.example.test/rpc', {
      signal: controller.signal,
    }, 10_000);
    const body = response.text();

    controller.abort(reason);

    await expect(body).rejects.toBe(reason);
  });

  it('emits the released Native v1 envelope from the production transport', async () => {
    const posted: unknown[] = [];
    vi.stubGlobal('chrome', {
      runtime: {
        connectNative: vi.fn(() => ({
          postMessage: vi.fn((value: unknown) => posted.push(value)),
          onMessage: { addListener: vi.fn() },
          onDisconnect: { addListener: vi.fn() },
        })),
      },
    });

    await createMcpNativeMessagingTransport(mcpServer({
      kind: 'native_messaging',
      nativeHost: 'com.example.contract',
      command: 'node',
      args: ['server.mjs'],
      cwd: '/tmp/native-contract',
      env: { CONTRACT_ENV: 'visible' },
    }, 'native-contract')).notify!({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(posted).toEqual([MCP_NATIVE_ENVELOPE_FIXTURE]);
  });

  it('rejects an unknown transport before network access', () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('chrome', {
      permissions: {
        contains: vi.fn(async () => true),
        request: vi.fn(async () => true),
      },
    });
    const server = mcpServer({
      kind: 'future_transport',
      url: 'https://future-mcp.example.test/rpc',
    } as any);

    expect(() => createMcpTransport(server)).toThrowError(expect.objectContaining({
      code: MCP_UNKNOWN_TRANSPORT_CONTRACT.errorCode,
    }));
    expect(fetchMock).toHaveBeenCalledTimes(MCP_UNKNOWN_TRANSPORT_CONTRACT.networkRequests);
  });

  it('accepts exactly one correlated JSON-RPC result or error branch', () => {
    const request = {
      jsonrpc: '2.0',
      id: 'expected-id',
      method: 'contract',
    } as const;

    expect(normalizeJsonRpcResponse({
      jsonrpc: '2.0',
      id: 'expected-id',
      result: { value: true },
    }, request)).toEqual({
      jsonrpc: '2.0',
      id: 'expected-id',
      result: { value: true },
    });
    expect(normalizeJsonRpcResponse({
      jsonrpc: '2.0',
      id: 'expected-id',
      error: { code: -32000, message: 'server failed', data: { retryAfterMs: 10 } },
    }, request)).toEqual({
      jsonrpc: '2.0',
      id: 'expected-id',
      error: { code: -32000, message: 'server failed', data: { retryAfterMs: 10 } },
    });
  });

  it.each(MCP_STRICT_RESPONSE_REJECTIONS)('rejects malformed response: $name', ({ response }) => {
    expect(() => normalizeJsonRpcResponse(response, {
      jsonrpc: '2.0',
      id: 'expected-id',
      method: 'contract',
    })).toThrowError(expect.objectContaining({
      code: 'mcp_response_invalid',
      retryable: false,
    }));
  });

  it('accepts legacy SSE server messages before the correlated response', () => {
    const request = {
      jsonrpc: '2.0',
      id: 'expected-id',
      method: 'contract',
    } as const;

    expect(parseJsonRpcSseMessage(
      '{"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}',
      request,
    )).toBeNull();
    expect(parseJsonRpcSseMessage(
      '{"jsonrpc":"2.0","id":"server-request","method":"roots/list","params":{}}',
      request,
    )).toBeNull();
    expect(parseJsonRpcSseMessage(
      '{"jsonrpc":"2.0","id":"expected-id","result":{"ok":true}}',
      request,
    )).toEqual({
      jsonrpc: '2.0',
      id: 'expected-id',
      result: { ok: true },
    });
  });

  it('preserves structured and text-error output while truncating detail by UTF-8 bytes', async () => {
    const structured = await callMcpTool(
      mcpServer(),
      resultTransport({
        content: [{ type: 'text', text: 'ignored because structured content wins' }],
        structuredContent: { answer: 42 },
      }),
      { call: toolCall() },
    );
    expect(structured).toMatchObject({
      ok: true,
      summary: 'MCP 工具已执行',
      detail: '{\n  "answer": 42\n}',
      output: { answer: 42 },
      truncated: false,
    });

    const failed = await callMcpTool(
      mcpServer(),
      resultTransport({ content: [{ type: 'text', text: 'host failed' }], isError: true }),
      { call: toolCall() },
    );
    expect(failed).toMatchObject({
      ok: false,
      detail: 'host failed',
      error: { code: 'mcp_tool_result_error', message: 'host failed', retryable: false },
    });

    const truncated = await callMcpTool(
      mcpServer(),
      resultTransport({ structuredContent: '中文🙂' }),
      { call: toolCall(), maxResultBytes: 3 },
    );
    expect(truncated).toMatchObject({ truncated: true, detail: '中' });
    expect(new TextEncoder().encode(truncated.detail).byteLength).toBe(3);

    const exactBoundary = await callMcpTool(
      mcpServer(),
      resultTransport({ structuredContent: '中文🙂' }),
      { call: toolCall(), maxResultBytes: 10 },
    );
    expect(exactBoundary).toMatchObject({ truncated: false, detail: '中文🙂' });

    const truncatedError = await callMcpTool(
      mcpServer(),
      resultTransport({ content: [{ type: 'text', text: '中文🙂' }], isError: true }),
      { call: toolCall(), maxResultBytes: 3 },
    );
    expect(truncatedError).toMatchObject({
      ok: false,
      truncated: true,
      detail: '中',
      error: { message: '中' },
    });
  });

  it('caps paginated discovery exactly at maxToolCount', async () => {
    const requestedCursors: Array<string | undefined> = [];
    const pages = [
      {
        tools: [
          { name: 'first', description: 'First tool', inputSchema: { type: 'object' } },
          { name: 'second', description: 'Second tool', inputSchema: { type: 'object' } },
        ],
        nextCursor: 'page-2',
      },
      {
        tools: [
          { name: 'third', description: 'Third tool', inputSchema: { type: 'object' } },
          { name: 'fourth', description: 'Fourth tool', inputSchema: { type: 'object' } },
        ],
        nextCursor: 'page-3',
      },
    ];
    const transport: McpProtocolTransport = {
      async request(request) {
        const cursor = typeof request.params?.cursor === 'string' ? request.params.cursor : undefined;
        requestedCursors.push(cursor);
        const result = pages[requestedCursors.length - 1];
        return { jsonrpc: '2.0', id: request.id, result } as McpJsonRpcResponse<any>;
      },
    };
    const server = mcpServer();
    server.limits.maxToolCount = 3;

    await expect(listMcpTools(server, transport)).resolves.toMatchObject([
      { annotations: { mcpToolName: 'first' } },
      { annotations: { mcpToolName: 'second' } },
      { annotations: { mcpToolName: 'third' } },
    ]);
    expect(requestedCursors).toEqual([undefined, 'page-2']);
    expect(MCP_CURRENT_GAPS).toEqual([]);
  });

  it('stops paginating when the server repeats the same cursor', async () => {
    // ⚠️⚠️ 守的是一个真缺陷：循环条件只有「cursor 非空」+「工具数没到上限」，
    // 服务端若每页都回同一个 cursor 且工具数永远到不了上限，请求就**永不停止**，
    // 而 `refreshMcpServerDiscovery` 的 tail 也就永不完成 —— 该服务之后所有发现都排队。
    let requests = 0;
    const transport: McpProtocolTransport = {
      async request(request) {
        requests += 1;
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: { tools: [{ name: `tool_${requests}`, inputSchema: { type: 'object' } }], nextCursor: 'stuck' },
        } as McpJsonRpcResponse<any>;
      },
    };

    await expect(listMcpTools(mcpServer(), transport)).rejects.toMatchObject({
      code: 'mcp_pagination_stalled',
    });
    // 第一页 cursor 为空、返回 'stuck'；第二页带着 'stuck' 再拿回 'stuck' ⇒ 立刻停。
    expect(requests).toBe(2);
  });

  /**
   * **「达到工具数上限」与「cursor 不前进」是两件事 —— 前者是正常结束。**
   *
   * 两条闸门在循环里的顺序是：
   * ```ts
   * if (!cursor || tools.length >= maxToolCount) break;   // ← 先
   * if (cursor === previousCursor) throw stalled;          // ← 后
   * ```
   * 所以「服务端第 N 页回了**同一个** cursor，但这一页恰好把工具数推过上限」走的是
   * 正常 `break`，**不报 `mcp_pagination_stalled`**。
   *
   * ⚠️ **这是刻意的**：用户要的是「最多 N 个工具」，已经拿够了就没什么可报的；
   * 报一条停滞错误反而会让这次成功的发现变成一个错误状态。
   * ⚠️ **两条闸门顺序反过来就会误报** —— 那时「拿够了」也会被当成「服务端卡住」。
   * 这条用例把顺序钉住：把两句对调，它就变红。
   */
  it('ends normally, not as stalled, when the last page repeats a cursor but fills the cap', async () => {
    const server = mcpServer();
    server.limits.maxToolCount = 2;
    let requests = 0;
    const transport: McpProtocolTransport = {
      async request(request) {
        requests += 1;
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            // 每页一个工具、永远回同一个 cursor —— 单看 cursor 就是「卡住」，
            // 但第二页拿满 2 个之后本该正常结束。
            tools: [{ name: `tool_${requests}`, inputSchema: { type: 'object' } }],
            nextCursor: 'stuck',
          },
        } as McpJsonRpcResponse<any>;
      },
    };

    await expect(listMcpTools(server, transport)).resolves.toHaveLength(2);
    // 第一页 cursor 空 → 不判停滞；第二页拿满上限 → break，走不到那条 throw。
    expect(requests).toBe(2);
  });

  it('bounds discovery when the server keeps inventing fresh cursors', async () => {    // ⚠️ 服务端自己也在 `MAX_DISCOVERY_PAGES + 8` 之后抛错 —— 否则「页数上界被删掉」
    // 这个变异会让测试**挂死**而不是变红（挂死的测试不算红）。
    let requests = 0;
    const transport: McpProtocolTransport = {
      async request(request) {
        requests += 1;
        if (requests > MAX_DISCOVERY_PAGES + 8) throw new Error('runaway pagination');
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: { tools: [], nextCursor: `cursor-${requests}` },
        } as McpJsonRpcResponse<any>;
      },
    };

    await expect(listMcpTools(mcpServer(), transport)).rejects.toMatchObject({
      code: 'mcp_pagination_incomplete',
    });
    expect(requests).toBe(MAX_DISCOVERY_PAGES);
  });

  it('gives tools/list the discovery ceiling rather than the per-call result limit', async () => {
    // ⚠️⚠️ 守的是「`limits.maxResultBytes` 被当成发现上限」这个缺陷。它约束的是
    // 「一次工具调用的结果多大」，而 `tools/list` 的响应体随**工具数量**增长 ——
    // 实测 100 工具 ≈ 90 KB、128 工具 ≈ 155 KB，而默认 64 000 会让这两档整个发现失败。
    const seen: Array<number | undefined> = [];
    const transport: McpProtocolTransport = {
      async request(_request, options) {
        seen.push(options?.maxResponseBytes);
        return {
          jsonrpc: '2.0',
          id: 1,
          result: { tools: [{ name: 'only_tool', inputSchema: { type: 'object' } }] },
        } as McpJsonRpcResponse<any>;
      },
    };

    await listMcpTools(mcpServer(), transport);
    expect(seen).toEqual([Math.max(64_000, MAX_DISCOVERY_RESPONSE_BYTES)]);
  });

  it('never narrows discovery below a user-raised result limit', async () => {
    // 用户把「结果字节」调到比发现上界还大时，发现不该被这里收紧。
    const raised = mcpServer();
    raised.limits.maxResultBytes = MAX_DISCOVERY_RESPONSE_BYTES * 2;
    let seen: number | undefined;
    const transport: McpProtocolTransport = {
      async request(_request, options) {
        seen = options?.maxResponseBytes;
        return {
          jsonrpc: '2.0',
          id: 1,
          result: { tools: [{ name: 'only_tool', inputSchema: { type: 'object' } }] },
        } as McpJsonRpcResponse<any>;
      },
    };

    await listMcpTools(raised, transport);
    expect(seen).toBe(MAX_DISCOVERY_RESPONSE_BYTES * 2);
  });

  it('keeps the transport error code and retryable flag on a failed tool call', async () => {
    // ⚠️⚠️ 守的是一个真缺陷：catch 只认 `McpProtocolError`，其余一律报成
    // `mcp_tool_call_failed` + `retryable: true` ⇒ transport 层那五类显式声明
    // `retryable: false` 的错误（响应过大 / 响应非法 / 端点非法 / 缺宿主权限 / SSE 源不符）
    // 全被翻转成「可以重试」，而 `McpTransportError.retryable` 生产零读取。
    const nonRetryable = [
      ['mcp_response_too_large', 'MCP response exceeded 64000 bytes.'],
      ['mcp_response_invalid', 'MCP response id did not match the active request.'],
      ['mcp_endpoint_invalid', 'Invalid MCP server URL: not-a-url'],
      ['mcp_origin_permission_denied', 'Host permission was not granted.'],
      ['mcp_sse_endpoint_origin_mismatch', 'MCP SSE endpoint origin mismatch.'],
    ] as const;

    for (const [code, message] of nonRetryable) {
      const transport: McpProtocolTransport = {
        async request() {
          throw new McpTransportError(code, message, { retryable: false });
        },
      };
      const result = await callMcpTool(mcpServer(), transport, { call: toolCall() });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe(code);
      expect(result.error?.retryable).toBe(false);
    }
  });

  it('still reports an unknown failure as a retryable tool-call failure', async () => {
    const transport: McpProtocolTransport = {
      async request() {
        throw new Error('socket closed');
      },
    };
    const result = await callMcpTool(mcpServer(), transport, { call: toolCall() });
    expect(result.error).toMatchObject({ code: 'mcp_tool_call_failed', retryable: true });
  });

  it('names both versions when the server advertises an unsupported protocol version', async () => {
    // ⚠️ discovery 的失败路径只把 `error.message` 存进 `health.error`，而那是 MCP 页
    // 错误条**原样显示**的那一行 —— 版本号只放 `details` 的话，界面只剩
    // 「Unsupported MCP protocol version.」，用户不知道是版本问题、也不知道该升谁。
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ version: '1.11.9' }) },
    });
    const transport: McpProtocolTransport = {
      async request(request) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: { protocolVersion: '1999-01-01', capabilities: {} },
        } as McpJsonRpcResponse<any>;
      },
    };

    await expect(initializeMcpServer(mcpServer(), transport)).rejects.toMatchObject({
      code: 'mcp_protocol_version_unsupported',
      message: expect.stringMatching(/1999-01-01[\s\S]*2025-06-18/),
    });
  });
});

function resultTransport(result: unknown): McpProtocolTransport {
  return {
    async request(request) {
      return { jsonrpc: '2.0', id: request.id, result } as McpJsonRpcResponse<any>;
    },
  };
}

function toolCall(): ToolCall {
  return {
    name: 'contract_tool',
    invocationName: 'mcp_contract_contract_tool',
    descriptorId: 'mcp:contract:contract_tool',
    provider: {
      kind: 'mcp',
      id: 'contract',
      displayName: 'Contract MCP',
      transport: 'streamable_http',
    },
    payload: {},
    raw: '',
  };
}

function mcpServer(
  transport: McpServerConfig['transport'] = {
    kind: 'streamable_http',
    url: 'https://mcp.example.test/rpc',
  },
  id = 'contract',
): McpServerConfig {
  return {
    version: 1,
    id,
    displayName: 'Contract MCP',
    enabled: true,
    transport,
    headers: [],
    secrets: [],
    timeouts: { connectMs: 10_000, requestMs: 60_000, discoveryMs: 20_000 },
    limits: { maxResultBytes: 64_000, maxToolCount: 128 },
    allowlist: { mode: 'all', toolNames: [] },
    execution: { mode: 'auto', enabled: true },
    status: 'unknown',
    lastConnectedAt: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('MCP request headers', () => {
  /**
   * ⚠️⚠️ 守的是一个真缺陷：`buildMcpRequestHeaders` 返回普通对象，而 HTTP 头名是
   * **大小写不敏感**、对象键不是。用户自定义 `authorization` 头 + bearer secret 会留下
   * **两个键**，`Headers` 构造函数再把它们用 `", "` 拼起来 ⇒ 服务端收到
   * `"Bearer xxx, custom"`，那不是合法的 `Authorization` 值。
   */
  it('lets a secret replace a custom header instead of joining it', () => {
    const server = mcpServer();
    server.headers = [{ name: 'authorization', value: 'custom' }];
    server.secrets = [{ kind: 'bearer', value: 'token-1' }];

    const headers = buildMcpRequestHeaders(server);
    const authorizationKeys = Object.keys(headers).filter((name) => name.toLowerCase() === 'authorization');
    expect(authorizationKeys, '只能有一个 Authorization 键').toHaveLength(1);
    expect(headers[authorizationKeys[0]!]).toBe('Bearer token-1');
  });

  it('keeps unrelated custom headers while applying bearer auth', () => {
    const server = mcpServer();
    server.headers = [{ name: 'X-Tenant', value: 'acme' }];
    server.secrets = [{ kind: 'bearer', value: 'token-1' }];

    expect(buildMcpRequestHeaders(server)).toEqual({
      'X-Tenant': 'acme',
      Authorization: 'Bearer token-1',
    });
  });

  it('applies a header secret case-insensitively over a custom header', () => {
    const server = mcpServer();
    server.headers = [{ name: 'X-Api-Key', value: 'from-header' }];
    server.secrets = [{ kind: 'header', headerName: 'x-api-key', value: 'from-secret' }];

    const headers = buildMcpRequestHeaders(server);
    const keys = Object.keys(headers).filter((name) => name.toLowerCase() === 'x-api-key');
    expect(keys).toHaveLength(1);
    expect(headers[keys[0]!]).toBe('from-secret');
  });
});

describe('MCP tool result summary', () => {
  /**
   * ⚠️⚠️ 守的是一个跨层耦合缺陷：`getMcpToolResultSummary` 曾经**只按工具名**判
   * `python_exec`，而那个名字是 **Shell Local 的**（`core/shell/contracts.ts` 的
   * `SHELL_TOOL_NAMES`），本函数却在**通用 MCP 客户端**里。任何第三方服务只要也发布一个
   * 叫 `python_exec` 的工具，就会拿到 Shell 专用的「工具已执行」措辞。
   *
   * 判据与 `callMcpTool` 的续读分流同源（`isShellMcpServer`）—— 两处不许各判一套。
   */
  it('uses the generic wording for a non-Shell server that ships python_exec', async () => {
    const thirdParty = mcpServer({
      kind: 'streamable_http',
      url: 'https://third-party.test/mcp',
      // 名字叫 Shell Local 也不算 —— 身份只认 nativeHost（Q1）。
    }, 'third-party');
    thirdParty.displayName = 'Shell Local';

    const result = await callMcpTool(
      thirdParty,
      resultTransport({ content: [{ type: 'text', text: 'ok' }] }),
      { call: { ...toolCall(), name: 'python_exec', invocationName: 'python_exec' } },
    );
    expect(result.summary, '第三方同名工具不该拿 Shell 专用措辞').toBe('MCP 工具已执行');
  });

  it('keeps the Shell wording for the built-in host', async () => {
    const shell = mcpServer({ kind: 'native_messaging', nativeHost: 'com.zai_pp.shell' }, 'shell');
    shell.displayName = 'Shell Local';

    const result = await callMcpTool(
      shell,
      resultTransport({ content: [{ type: 'text', text: 'ok' }] }),
      { call: { ...toolCall(), name: 'python_exec', invocationName: 'python_exec' } },
    );
    expect(result.summary).toBe('工具已执行');
  });
});
