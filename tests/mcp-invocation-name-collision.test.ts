// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { disambiguateMcpInvocationNames } from '../entrypoints/background/tool-provider-composition';
import { ToolProviderRegistry, type RuntimeToolProvider } from '../core/tool/provider-registry';
import { createMcpDescriptorId, createMcpInvocationName } from '../core/mcp/descriptor-identity';
import type { ToolDescriptor } from '../core/tool/types';

/**
 * **MCP 的 invocationName 去重必须把分配出来的名字回填到已占用集合。**
 *
 * ⚠️⚠️ 守的是一个真缺陷：`mcp_<serverId>_<toolName>` 里的 serverId 与 toolName 都做过
 * `[^A-Za-z0-9_]+ → _` 归一，于是 `read-file` 与 `read_file` 会撞名；去重给后者加 `_2`。
 * 若这个名字不回填，一个**同时**发布 `read-file` / `read_file` / `read_file_2` 的服务端
 * 会产出一对仍然同名的描述符 ⇒ registry 的 `assertDescriptorContracts` 抛
 * `tool_invocation_duplicate` ⇒ **整个工具注册表失效**（不止这三个工具）。
 */

const SERVER_ID = 'server-1';

function descriptor(toolName: string): ToolDescriptor {
  return {
    id: createMcpDescriptorId(SERVER_ID, toolName),
    provider: { kind: 'mcp', id: SERVER_ID, displayName: 'Collision MCP', transport: 'streamable_http' },
    name: toolName,
    invocationName: createMcpInvocationName(SERVER_ID, toolName),
    title: toolName,
    description: toolName,
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
}

function names(descriptors: readonly ToolDescriptor[]): string[] {
  return descriptors.map((item) => item.invocationName);
}

describe('MCP invocation name disambiguation', () => {
  it('keeps every invocation name unique when a server publishes the suffixed twin too', () => {
    const resolved = disambiguateMcpInvocationNames([
      descriptor('read-file'),
      descriptor('read_file'),
      descriptor('read_file_2'),
    ]);

    const resolvedNames = names(resolved);
    expect(new Set(resolvedNames).size, `去重后仍有重名：${resolvedNames.join(' / ')}`)
      .toBe(resolvedNames.length);
    // 原来不冲突的那条不许被改名。
    expect(resolved[0]?.invocationName).toBe(createMcpInvocationName(SERVER_ID, 'read-file'));
  });

  it('leaves identity fields untouched and only rewrites the invocation name', () => {
    const source = [descriptor('read-file'), descriptor('read_file')];
    const resolved = disambiguateMcpInvocationNames(source);

    expect(resolved.map((item) => item.id)).toEqual(source.map((item) => item.id));
    expect(resolved.map((item) => item.name)).toEqual(source.map((item) => item.name));
    expect(resolved.map((item) => item.provider)).toEqual(source.map((item) => item.provider));
    expect(resolved[0]?.invocationName).toBe(source[0]?.invocationName);
    expect(resolved[1]?.invocationName).not.toBe(source[1]?.invocationName);
  });

  it('keeps the whole tool registry alive for a server whose names collide twice', () => {
    const resolved = disambiguateMcpInvocationNames([
      descriptor('read-file'),
      descriptor('read_file'),
      descriptor('read_file_2'),
    ]);
    const provider: RuntimeToolProvider = {
      registration: { kind: 'mcp' },
      async listTools() { return resolved; },
      async execute() { return { ok: true, summary: 'noop' }; },
    };

    // 没有回填那一版会在这里抛 tool_invocation_duplicate。
    return expect(new ToolProviderRegistry([provider]).listTools({ locale: 'en', includeDisabled: false }))
      .resolves.toHaveLength(3);
  });

  it('does not steal an original name that appears later in the list', () => {
    // ⚠️ 这条单独守「两遍分配」：若只补 `occupied.add(candidate)` 而不先占位全部原名，
    // `read_file` 改名时会抢走 `read_file_2` 这个稍后才出现的原名。
    const resolved = disambiguateMcpInvocationNames([
      descriptor('read-file'),
      descriptor('read_file'),
      descriptor('read_file_2'),
    ]);
    const third = resolved[2];
    expect(third?.invocationName, '原名 read_file_2 必须保住，不能被打包的 _2 抢走')
      .toBe(createMcpInvocationName(SERVER_ID, 'read_file_2'));
  });
});