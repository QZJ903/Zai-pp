/**
 * MCP 的活体往返冒烟：起一个本地 mock MCP server，走真实 HTTP + JSON-RPC。
 *
 * 两种用法：
 *   `node scripts/mcp-live-mock.mjs`          自检一遍（下面那三段）
 *   `node scripts/mcp-live-mock.mjs --serve`  只起服务、不退出 ——
 *     把侧边栏 MCP 页的服务器地址指向打印出来的 URL，就能拿它做**手动联调**
 *
 * ⚠️⚠️ **本脚本刻意不复刻任何生产逻辑。**
 * 它曾经手抄了 XML 工具调用的提取与剥离（`extractToolCalls` / `stripToolCalls`），
 * 断言的两侧都来自脚本自己 —— 那种断言只能证明副本没变。
 * 解析 / 渲染 / 描述符投影的契约已由 `tests/mcp-live-roundtrip.test.ts`
 * **直接 import 生产**覆盖，并且进 `npm test`（GitHub CI 跑得到）。
 *
 * ⚠️ **不要在此复刻续跑提示词的文案** —— 手抄一份拼成仿制提示词、再断言自己那份，
 * 断言只能证明副本没变，测不到真源；两份文案会各自演进且没有任何报错。
 * 续跑提示词的契约由 `tests/zai-continuation-prompt.test.ts` 对着真源测。
 *
 * ⚠️ **本脚本不 import 任何 `core/` 模块**（只依赖 `node:http` 与 `node:assert`），
 * 所以它验证的是「MCP 传输形状」这一层，不覆盖扩展内的执行链。
 */
import http from 'node:http';
import assert from 'node:assert/strict';

const TOOL_NAME = 'echo';

const serverConfig = {
  id: 'mock',
  displayName: 'Mock MCP',
  enabled: true,
  transport: {
    kind: 'streamable_http',
    url: '',
  },
  execution: {
    mode: 'auto',
    enabled: true,
  },
};

const toolInputSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
  },
  required: ['text'],
};

const { server, url } = await startMockMcpServer();
serverConfig.transport.url = url;

if (process.argv.includes('--serve')) {
  console.log(`mock MCP server: ${url}`);
  console.log('Press Ctrl+C to stop.');
  await new Promise((resolve) => {
    const done = () => {
      server.close(resolve);
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
} else {
  try {
    await verifyToolCallRoundTrip();
    await verifyAutomationHistory();
    console.log('mcp live mock: tool-call round trip ok');
    console.log('mcp live mock: automation record shape ok');
    console.log(`mcp live mock: server ${url}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** 一次 `tools/call` 的往返：请求形状 → 服务端 → 结果形状。 */
async function verifyToolCallRoundTrip() {
  const result = await callEcho('manual');

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { echoed: 'manual' });
  assert.match(result.detail, /manual/);
}

/**
 * 一次往返的记录形状（`source` / `tool` / `result` 三样都在）。
 *
 * ⚠️ 这里验的是**结果的形状**，不是扩展的执行链 —— 记录由谁累积、累积几轮
 * 是执行侧的事，本脚本不建模。
 */
async function verifyAutomationHistory() {
  const result = await callEcho('automation');
  const record = { source: 'automation', tool: TOOL_NAME, result };

  assert.equal(record.source, 'automation');
  assert.equal(record.result.output.echoed, 'automation');
}

/** 调一次 `echo`，把 JSON-RPC 结果整理成工具结果形状。 */
async function callEcho(text) {
  const result = await requestJsonRpc('tools/call', {
    name: TOOL_NAME,
    arguments: { text },
  });
  const output = result.structuredContent ?? null;
  return {
    ok: result.isError !== true,
    summary: result.isError ? 'MCP tool returned an error' : 'MCP tool executed',
    detail: JSON.stringify(output, null, 2),
    output,
    provider: { kind: 'mcp', id: serverConfig.id, displayName: serverConfig.displayName },
    name: TOOL_NAME,
  };
}

function startMockMcpServer() {
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }

    const message = JSON.parse(await readBody(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: routeJsonRpc(message),
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
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-mcp', version: '1.0.0' },
    };
  }
  if (message.method === 'tools/list') {
    return {
      tools: [{
        name: TOOL_NAME,
        title: 'Echo',
        description: 'Return the text argument.',
        inputSchema: toolInputSchema,
      }],
    };
  }
  if (message.method === 'tools/call') {
    return {
      content: [{ type: 'text', text: `echo:${message.params?.arguments?.text ?? ''}` }],
      structuredContent: { echoed: message.params?.arguments?.text ?? '' },
      isError: false,
    };
  }
  return {};
}

async function requestJsonRpc(method, params) {
  const response = await fetch(serverConfig.transport.url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
  assert.equal(response.ok, true);
  const data = await response.json();
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
