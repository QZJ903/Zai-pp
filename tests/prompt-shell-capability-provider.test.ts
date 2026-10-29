import { describe, expect, it } from 'vitest';
import { buildPromptAugmentation } from '../core/prompt';
import { normalizeMcpToolDescriptor, type McpServerConfig, type McpToolDefinition } from '../core/mcp';

/**
 * **「有没有本地 Shell 能力」只能按 transport 判，不能按工具名判。**
 *
 * 按名字判的后果：一个第三方 MCP 服务只要恰好提供一个叫 `shell_exec` / `python_exec`
 * 的工具，就会触发整段「Shell MCP 能力」/「Python 快速验证能力」/「沙盒与宿主机」——
 * 而那些段落里的话（「Shell MCP 已通过扩展连接」「Windows 下 Shell Local 默认使用
 * PowerShell」「用 `<shell_exec>` 跑本地命令」）**只对本地 native host 成立**。
 *
 * ⚠️⚠️ **也不能按 `provider.id` 判** —— 那是 `createMcpServer` 里的
 * `crypto.randomUUID()`，每次安装都不同（`'shell-local'` 只出现在测试夹具里）。
 * 按 id 判会永远不命中、整段**静默消失**，比按名字判更糟。
 */

function server(id: string, transport: 'native_messaging' | 'streamable_http'): McpServerConfig {
  return {
    version: 1,
    id,
    displayName: id,
    enabled: true,
    transport: transport === 'native_messaging'
      ? { kind: 'native_messaging', nativeHost: 'com.zai_pp.shell' }
      : { kind: 'streamable_http', url: 'https://example.test/mcp' },
    headers: [],
    secrets: [],
    timeouts: { connectMs: 5_000, requestMs: 60_000, discoveryMs: 10_000 },
    limits: { maxResultBytes: 128_000, maxToolCount: 16 },
    allowlist: { mode: 'all', toolNames: [] },
    execution: { mode: 'auto', enabled: true },
    status: 'ready',
    lastConnectedAt: 0,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function tool(name: string): McpToolDefinition {
  return {
    name,
    title: name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    annotations: { risk: 'low' },
  };
}

function renderOne(serverId: string, transport: 'native_messaging' | 'streamable_http', toolName: string): string {
  return buildPromptAugmentation('列一下目录。', {
    memories: [],
    toolDescriptors: [normalizeMcpToolDescriptor(server(serverId, transport), tool(toolName))],
    locale: 'zh-CN',
    systemPromptEnabled: true,
  }).augmented;
}

describe('local shell capability is judged by transport, not by tool name', () => {
  it('injects the shell guidance for a native-messaging tool', () => {
    const text = renderOne('uuid-shell-server', 'native_messaging', 'shell_exec');

    expect(text, '本地 Shell 工具应当触发 Shell MCP 能力段').toContain('### Shell MCP 能力');
    expect(text, '本地 Shell 工具应当触发沙盒与宿主机段').toContain('## 沙盒与宿主机');
  });

  it('does not inject shell guidance for a third-party tool that merely reuses the name', () => {
    const text = renderOne('third-party-mcp', 'streamable_http', 'shell_exec');

    // ⚠️ 三段都按同一个判据裁 —— 只裁其中一段会让另外两段继续说着不成立的话。
    expect(text, '第三方同名工具不该触发 Shell MCP 能力段').not.toContain('### Shell MCP 能力');
    expect(text, '第三方同名工具不该触发沙盒与宿主机段').not.toContain('## 沙盒与宿主机');
    // 但工具本身照常渲染（它确实可调用，只是不走本地 XML 通道）。
    expect(text, '工具本身仍要出现在目录里').toContain('### Tool');
  });

  it('does not inject the python guidance for a third-party python_exec', () => {
    const text = renderOne('third-party-mcp', 'streamable_http', 'python_exec');

    expect(text, '第三方同名工具不该触发 Python 能力段').not.toContain('### Python 快速验证能力');
  });

  it('injects the python guidance for the native host python tools', () => {
    const text = renderOne('uuid-shell-server', 'native_messaging', 'python_exec');

    expect(text).toContain('### Python 快速验证能力');
  });
});
