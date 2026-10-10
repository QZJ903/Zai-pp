import http from 'node:http';
import assert from 'node:assert/strict';

/**
 * MCP 的**活体往返**冒烟：起一个本地 mock MCP server，走真实 HTTP + JSON-RPC，
 * 验证 `initialize` / `tools/list` / `tools/call` / 超时四条路径的**传输形状**。
 *
 * ⚠️⚠️ **本脚本刻意只验传输层，不复刻任何生产逻辑。**
 * 它曾经手抄了 9 个生产函数（`normalizeMcpToolDescriptor` / `applyMcpToolPolicy` /
 * `renderToolSchemas` / `createToolInvocationCatalog` / `createMcpInvocationName` /
 * `fetchWithTimeout` / `extractToolCalls` / `stripToolCalls` / `escapeRegExp`），
 * 断言的两侧**都来自脚本自己** —— 往生产里注入缺陷（改 `### Tool` 前缀、让长名不进 catalog）
 * 时它**三次全绿**。那部分已经搬进 `tests/mcp-live-roundtrip.test.ts`，
 * 那里**直接 import 生产**、并且进 `npm test`（GitHub CI 也跑得到）。
 *
 * ⚠️ **超时也走平台原语**（`AbortSignal.timeout`），不再手抄生产的
 * `fetchWithTimeout` + `mcp_transport_timeout` 映射 —— 那种副本会把
 * 「超时被映射成哪个错误码」这件事变成脚本自证。该契约由
 * `tests/mcp-live-roundtrip.test.ts` 对着生产 transport 测。
 *
 * ⚠️ **本脚本保留的理由**：它验的是「真 HTTP + 真 JSON-RPC 信封」这一层 ——
 * vitest 那份虽然也起真 server，但它用的是生产 transport；这里是**手写的最小客户端**，
 * 能反过来确认「服务端契约本身」没变（两者互为对照）。
 *
 * ⚠️ **本脚本不 import 任何 `core/` 模块**（只依赖 `node:http` 与 `node:assert`）。
 * 解析 / 渲染 / 描述符投影的契约由 `tests/mcp-live-roundtrip.test.ts` 对着真源测。
 */
const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * ⚠️ **只保留本脚本真正消费的字段**（`transport.url` 与 `timeouts.requestMs`）。
 * 不镜像生产 `McpServerConfig` 的完整形状 —— 那样会让读者以为这里的
 * `allowlist` / `limits` / `execution` 也在被验证，而它们没有任何消费者。
 * 那些字段的语义由 `tests/mcp-live-roundtrip.test.ts` 对着生产测。
 */
const serverConfig = {
  transport: {
    kind: 'streamable_http',
    url: '',
  },
  timeouts: {
    requestMs: 1000,
  },
};

const mockTools = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Return the text argument.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'blocked',
    title: 'Blocked',
    description: 'A disabled mock tool.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

const { server, url } = await startMockMcpServer();
serverConfig.transport.url = url;

try {
  const initialize = await requestJsonRpc(serverConfig, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    clientInfo: { name: 'Zai++ smoke', version: '0.0.0' },
  });
  assert.equal(initialize.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(initialize.serverInfo.name, 'mock-mcp');

  const listed = await requestJsonRpc(serverConfig, 'tools/list');
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['echo', 'blocked']);

  const callResult = await requestJsonRpc(serverConfig, 'tools/call', {
    name: 'echo',
    arguments: { text: 'hello' },
  });
  assert.equal(callResult.isError, false);
  assert.deepEqual(callResult.structuredContent, { echoed: 'hello' });
  assert.match(callResult.content[0].text, /hello/);

  // 服务端报错走 JSON-RPC `error` 分支（不是 HTTP 错误）：断言**传输形状**本身，
  // 不引用任何错误码字符串 —— 脚本侧的码与生产不是同一套，比它等于自证。
  await assert.rejects(
    requestJsonRpc(serverConfig, 'explode', {}),
    (error) => /boom/.test(error.message),
  );

  // 超时：只验「到点会中止」这个传输行为，错误码的映射归生产的 transport 测。
  await assert.rejects(
    requestJsonRpc(serverConfig, 'slow', {}, { timeoutMs: 10 }),
    (error) => error.name === 'TimeoutError' || error.name === 'AbortError',
  );

  console.log('mcp smoke: discovery ok');
  console.log('mcp smoke: tool call ok');
  console.log('mcp smoke: json-rpc error + timeout paths ok');
} finally {
  await new Promise((resolve) => server.close(resolve));
}

function startMockMcpServer() {
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }

    const body = await readBody(request);
    const message = JSON.parse(body);
    if (message.method === 'slow') {
      await delay(100);
    }

    const { result, error } = routeJsonRpc(message);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      ...(error ? { error } : { result }),
    }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address === 'object');
      resolve({ server, url: `http://127.0.0.1:${address.port}/mcp` });
    });
  });
}

function routeJsonRpc(message) {
  if (message.method === 'initialize') {
    return {
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '1.0.0' },
      },
    };
  }
  if (message.method === 'tools/list') {
    return { result: { tools: mockTools } };
  }
  if (message.method === 'tools/call') {
    const args = message.params?.arguments ?? {};
    return {
      result: {
        content: [{ type: 'text', text: `echo:${args.text ?? ''}` }],
        structuredContent: { echoed: args.text ?? '' },
        isError: false,
      },
    };
  }
  if (message.method === 'explode') {
    return { error: { code: -32603, message: 'boom' } };
  }
  return { result: {} };
}

async function requestJsonRpc(config, method, params, options = {}) {
  const response = await fetch(config.transport.url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      ...(params ? { params } : {}),
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? config.timeouts.requestMs),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message);
  }
  return data.result;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
