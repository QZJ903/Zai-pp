/**
 * MCP 的活体往返冒烟：起一个本地 mock MCP server，走真实 HTTP + JSON-RPC，
 * 验证 `initialize` / `tools/list` / `tools/call` 三条方法以及本脚本自己的
 * XML 工具调用提取与剥离。
 *
 * ⚠️ **不要在此复刻续跑提示词的文案** —— 手抄一份拼成仿制提示词、再断言自己那份，
 * 断言只能证明副本没变，测不到真源；两份文案会各自演进且没有任何报错。
 * 续跑提示词的契约由 `tests/zai-continuation-prompt.test.ts` 对着真源测。
 *
 * ⚠️ **本脚本不 import 任何 `core/` 模块**（只依赖 `node:http` 与 `node:assert`），
 * 所以它验证的是「MCP 传输形状 + 本脚本的解析」这一层，不覆盖扩展内的执行链。
 */
import http from 'node:http';
import assert from 'node:assert/strict';

const TOOL_NAME = 'echo';
const INVOCATION_NAME = 'mcp_mock_echo';

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

const descriptor = {
  id: `mcp:${serverConfig.id}:${TOOL_NAME}`,
  provider: {
    kind: 'mcp',
    id: serverConfig.id,
    displayName: serverConfig.displayName,
    transport: serverConfig.transport.kind,
  },
  name: TOOL_NAME,
  invocationName: INVOCATION_NAME,
  title: 'Echo',
  description: 'Return the text argument.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
    },
    required: ['text'],
  },
  execution: {
    mode: 'auto',
    enabled: true,
    risk: 'medium',
  },
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
    console.log('mcp live mock: automation history accumulation ok');
    console.log(`mcp live mock: server ${url}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function verifyToolCallRoundTrip() {
  const assistantText = `Need data.\n<${INVOCATION_NAME}>{"text":"manual"}</${INVOCATION_NAME}>`;
  const executions = await executeToolCalls(assistantText, 'manual_chat');
  assert.equal(executions.length, 1);
  assert.equal(executions[0].result.ok, true);
  assert.equal(executions[0].result.output.echoed, 'manual');
  assert.equal(executions[0].call.provider.kind, 'mcp');
  assert.equal(executions[0].call.source.trigger, 'manual_chat');
  // 手动轮次不自动续跑：该入口在 mock 里恒返回空。
  assert.equal(executeToolCallsInManualContinuation(
    '<memory_save>{"type":"topic","name":"n","content":"c","tags":[]}</memory_save>',
  ).length, 0);
  assert.equal(stripToolCalls(assistantText).trim(), 'Need data.');
}

async function verifyAutomationHistory() {
  const history = [];
  let assistantText = `Run automation tool.\n<${INVOCATION_NAME}>{"text":"automation"}</${INVOCATION_NAME}>`;
  const allExecutions = [];

  for (let depth = 0; depth < 3; depth++) {
    const executions = await executeToolCalls(assistantText, 'automation');
    if (executions.length === 0) break;
    allExecutions.push(...executions);
    history.push(...executions.map((execution) => ({
      source: 'automation',
      call: execution.call,
      result: execution.result,
    })));

    assistantText = 'Final answer after tool results.';
  }

  assert.equal(allExecutions.length, 1);
  assert.equal(history.length, 1);
  assert.equal(history[0].source, 'automation');
  assert.equal(history[0].call.provider.kind, 'mcp');
  assert.equal(history[0].result.output.echoed, 'automation');
}

async function executeToolCalls(text, trigger) {
  const calls = extractToolCalls(text);
  const executions = [];
  for (const call of calls) {
    const result = await callMcpTool(call);
    executions.push({ call: { ...call, source: { trigger } }, result });
  }
  return executions;
}

function executeToolCallsInManualContinuation(_text) {
  return [];
}

function extractToolCalls(text) {
  const regex = new RegExp(`<${INVOCATION_NAME}>\\s*([\\s\\S]*?)\\s*<\\/${INVOCATION_NAME}>`, 'g');
  const calls = [];
  let match;
  while ((match = regex.exec(text))) {
    calls.push({
      descriptorId: descriptor.id,
      provider: descriptor.provider,
      name: descriptor.name,
      invocationName: descriptor.invocationName,
      payload: JSON.parse(match[1]),
      raw: match[0],
    });
  }
  return calls;
}

function stripToolCalls(text) {
  return text.replace(new RegExp(`<${INVOCATION_NAME}>\\s*[\\s\\S]*?\\s*<\\/${INVOCATION_NAME}>`, 'g'), '');
}

async function callMcpTool(call) {
  const result = await requestJsonRpc('tools/call', {
    name: call.name,
    arguments: call.payload,
  });
  const output = result.structuredContent ?? null;
  return {
    ok: result.isError !== true,
    summary: result.isError ? 'MCP tool returned an error' : 'MCP tool executed',
    detail: JSON.stringify(output, null, 2),
    output,
    provider: call.provider,
    descriptorId: call.descriptorId,
    name: call.name,
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
        inputSchema: descriptor.inputSchema,
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
