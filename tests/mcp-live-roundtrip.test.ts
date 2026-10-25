import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MCP_PROTOCOL_VERSION,
  callMcpTool,
  createMcpTransport,
  initializeMcpServer,
  listMcpTools,
  normalizeMcpToolDescriptor,
} from '../core/mcp';
import { applyMcpToolPolicy } from '../core/mcp/client';
import { renderToolSchemas } from '../core/prompt/augmentation';
import {
  createToolCallFromInvocation,
  createToolInvocationCatalog,
  getPreferredToolInvocationName,
  getToolInvocationNames,
} from '../core/tool/invocation';
import { findZaiToolXmlBlocks } from '../core/zai/tool-xml';
import type { McpServerConfig, McpToolDefinition } from '../core/mcp';
import type { ToolCall } from '../core/types';

/**
 * **MCP 的活体往返：起一个真的 HTTP server，整条链走生产代码。**
 *
 * ⚠️⚠️ **为什么要有这个文件（而不是靠 `scripts/mcp-smoke.mjs`）**：
 * 那个脚本**自己手抄了 9 个生产函数**（`normalizeMcpToolDescriptor` / `applyMcpToolPolicy` /
 * `renderToolSchemas` / `createToolInvocationCatalog` / `createMcpInvocationName` /
 * `fetchWithTimeout` / `extractToolCalls` / `stripToolCalls` / `escapeRegExp`），
 * 断言的两侧**都来自脚本自己**。实测：往生产里注入三个缺陷（改 `### Tool` 前缀、
 * 把 catalog 的默认参数改成 `[]`、让长名不再进 catalog），**脚本三次全绿**。
 * ⇒ 它证明的是「脚本与它自己一致」，不是「生产是对的」。
 *
 * ⚠️ **那 9 个手抄是上游 ds++ 带来的**（逐字相同），**不是移植丢的**；但上游的 GitHub CI
 * 跑 `ci:quality`（含 `smoke:mcp`），而本仓的 `ci.yml` 只跑 `compile` / `test` / `build:chrome`
 * —— 两个叠加，这个弱点在本仓**完全没有发现渠道**。本文件把它补回来。
 *
 * ⚠️ **本文件用真 HTTP server 而不是桩 transport**：桩会把「传输层形状对不对」这件事测掉
 * （JSON-RPC 信封、`tools/list` 分页、超时映射），而那正是原脚本唯一真正在验的东西。
 */

const MOCK_TOOLS: McpToolDefinition[] = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Return the text argument.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'blocked',
    title: 'Blocked',
    description: 'A disabled mock tool.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** `deny` 模式 + 黑名单里有 `blocked` ⇒ 它必须被 `applyMcpToolPolicy` 关掉。 */
function mockServerConfig(endpoint: string): McpServerConfig {
  return {
    version: 1,
    id: 'mock',
    displayName: 'Mock MCP',
    enabled: true,
    transport: { kind: 'streamable_http', url: endpoint },
    headers: [],
    secrets: [],
    timeouts: { connectMs: 2_000, requestMs: 2_000, discoveryMs: 2_000 },
    limits: { maxResultBytes: 64_000, maxToolCount: 128 },
    allowlist: { mode: 'deny', toolNames: ['blocked'] },
    execution: { mode: 'auto', enabled: true },
    status: 'ready',
    lastConnectedAt: 0,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

let server: http.Server;
let endpoint = '';

/** 起一个最小可用的 MCP server（`initialize` / `tools/list` / `tools/call` / `slow`）。 */
async function startMockMcpServer(): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/mcp') {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id: unknown;
          method?: string;
          params?: { arguments?: Record<string, unknown> };
        };
        const finish = (result: unknown) => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
        };
        if (message.method === 'slow') {
          // 让客户端的超时先到（下面用 10ms 的超时打这一条）。
          setTimeout(() => finish({}), 300);
          return;
        }
        if (message.method === 'initialize') {
          finish({
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'mock-mcp', version: '1.0.0' },
          });
          return;
        }
        if (message.method === 'tools/list') {
          finish({ tools: MOCK_TOOLS });
          return;
        }
        if (message.method === 'tools/call') {
          const args = message.params?.arguments ?? {};
          finish({
            content: [{ type: 'text', text: `echo:${String(args.text ?? '')}` }],
            structuredContent: { echoed: args.text ?? '' },
            isError: false,
          });
          return;
        }
        finish({});
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}/mcp`);
    });
  });
}

beforeAll(async () => {
  // 生产的传输层要查 host 权限与扩展版本，两者在测试环境都不存在。
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '0.0.0' }) },
    permissions: { contains: async () => true, request: async () => true },
  });
  endpoint = await startMockMcpServer();
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server?.close(() => resolve()); });
  vi.unstubAllGlobals();
});

describe('MCP round trip over real HTTP uses production code end to end', () => {
  it('negotiates, discovers, and calls a tool through the production client', async () => {
    const config = mockServerConfig(endpoint);
    const transport = createMcpTransport(config);

    const initialized = await initializeMcpServer(config, transport);
    expect(initialized.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(initialized.serverInfo?.name).toBe('mock-mcp');

    const descriptors = await listMcpTools(config, transport);
    expect(descriptors.map((descriptor) => descriptor.name).sort()).toEqual(['blocked', 'echo']);
    // 长名由生产同一个工厂派生 —— 不手抄。
    expect(descriptors.find((d) => d.name === 'echo')?.invocationName).toBe('mcp_mock_echo');

    const policyApplied = applyMcpToolPolicy(descriptors, config);
    const injectable = policyApplied.filter(
      (descriptor) => descriptor.execution.enabled && descriptor.execution.mode === 'auto',
    );
    // `blocked` 在黑名单里 ⇒ 只剩 `echo`。
    expect(injectable.map((descriptor) => descriptor.name)).toEqual(['echo']);

    const echo = injectable[0]!;
    const call: ToolCall = {
      id: 'call-1',
      name: echo.name,
      invocationName: echo.invocationName,
      payload: { text: 'hello' },
      raw: '<mcp_mock_echo>{"text":"hello"}</mcp_mock_echo>',
    };
    const result = await callMcpTool(config, transport, { call, descriptor: echo });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ echoed: 'hello' });
  });

  it('renders the discovered tool with the production schema renderer', () => {
    const config = mockServerConfig(endpoint);
    const echo = normalizeMcpToolDescriptor(config, MOCK_TOOLS[0]!);

    const rendered = renderToolSchemas([echo], 'en');
    // ⚠️ 断言的是**生产的渲染结果**（`### Tool <名>` + 接受的长短两个标签名）。
    expect(rendered).toContain('### Tool echo');
    expect(rendered).toContain('Accepted tag names: mcp_mock_echo, echo');
    expect(rendered).toContain('Call it as a direct XML tag in the answer body');
    // 未注入的工具不得出现在提示词里。
    expect(rendered).not.toContain('mcp_mock_blocked');
    expect(rendered).not.toContain('"type":"function"');
  });

  it('parses the model-facing tags with the production block scanner', async () => {
    const config = mockServerConfig(endpoint);
    const echo = normalizeMcpToolDescriptor(config, MOCK_TOOLS[0]!);
    const catalog = createToolInvocationCatalog([echo]);

    const parse = (text: string) => findZaiToolXmlBlocks(text, catalog.invocationNames)
      .map((block) => createToolCallFromInvocation(
        block.name,
        block.body ? JSON.parse(block.body) as Record<string, unknown> : {},
        block.raw,
        catalog,
      ));

    // 长名与短名都认，且 `invocationName` 归一成权威长名（授权快照按它比对）。
    for (const text of [
      'Before <mcp_mock_echo>{"text":"hello"}</mcp_mock_echo> After',
      'Before <echo>{"text":"hello"}</echo> After',
    ]) {
      const calls = parse(text);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.name).toBe('echo');
      expect(calls[0]!.invocationName).toBe('mcp_mock_echo');
      expect(calls[0]!.payload).toEqual({ text: 'hello' });
    }

    // 空 body 是合法调用（payload 为空对象）。
    const emptyBody = parse('<echo></echo>');
    expect(emptyBody).toHaveLength(1);
    expect(emptyBody[0]!.payload).toEqual({});

    // 包装格式不是我们的标签语法 —— 一个都不该认出来。
    expect(parse('<tool_call>{"name":"mcp_mock_echo"}</tool_call>')).toHaveLength(0);
    expect(parse('<invoke name="mcp_mock_echo">{"text":"hello"}</invoke>')).toHaveLength(0);
  });

  it('prefers the short tag name when the catalog accepts it', async () => {
    const config = mockServerConfig(endpoint);
    const echo = normalizeMcpToolDescriptor(config, MOCK_TOOLS[0]!);
    const catalog = createToolInvocationCatalog([echo]);
    expect(getToolInvocationNames(echo, catalog)).toEqual(['mcp_mock_echo', 'echo']);
    expect(getPreferredToolInvocationName(echo, catalog)).toBe('echo');
  });

  it('maps a slow response to the production transport timeout code', async () => {
    const config = mockServerConfig(endpoint);
    const transport = createMcpTransport(config);
    await expect(
      transport.request(
        { jsonrpc: '2.0', id: 'slow-1', method: 'slow' },
        { timeoutMs: 10 },
      ),
    ).rejects.toMatchObject({ code: 'mcp_transport_timeout' });
  });
});
