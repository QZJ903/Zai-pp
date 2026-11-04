// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  encodeMcpStorageState,
  MCP_STORAGE_VERSION,
} from '../core/mcp/storage-codec';
import { normalizeMcpToolDescriptor } from '../core/mcp/client';
import { createMcpDescriptorId, createMcpInvocationName } from '../core/mcp/descriptor-identity';
import type { McpServerConfig, McpToolCacheEntry, McpToolDefinition } from '../core/mcp/types';

/**
 * **写侧归一化的产物必须能被读侧接受。**
 *
 * ⚠️⚠️ 守的是一个真缺陷：`normalizeToolSchema` 只补 `type` 与 `properties`，而
 * `isToolDescriptorSchema`（`storage-codec` → `isToolDescriptorRecord`）对
 * `properties` / `required` / `additionalProperties` / `description` 四个字段是严判的。
 * 第三方 MCP 服务端发布畸形 schema 时，那份描述符**写得进存储、读不出来** ——
 * 而读失败的后果不是「丢一条」，是 `mcp_storage_corrupt` 让**整份 MCP 存储打不开**，
 * 连 Shell Local 一起失效。
 *
 * 判据是「写侧产物直接喂读侧」：`encodeMcpStorageState` 就是 `decodeMcpStorageState`。
 */

const SERVER_ID = 'schema-roundtrip';

function server(): McpServerConfig {
  return {
    version: 1,
    id: SERVER_ID,
    displayName: 'Schema Roundtrip MCP',
    enabled: true,
    transport: { kind: 'streamable_http', url: 'https://mcp.example.test/rpc' },
    headers: [],
    secrets: [],
    timeouts: { connectMs: 10_000, requestMs: 60_000, discoveryMs: 20_000 },
    limits: { maxResultBytes: 64_000, maxToolCount: 128 },
    allowlist: { mode: 'all', toolNames: [] },
    execution: { mode: 'auto', enabled: true },
    status: 'ready',
    lastConnectedAt: 1,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function cacheEntry(tool: McpToolDefinition): McpToolCacheEntry {
  return {
    serverId: SERVER_ID,
    descriptors: [normalizeMcpToolDescriptor(server(), tool)],
    refreshedAt: 1,
    expiresAt: 2,
    health: {
      serverId: SERVER_ID,
      status: 'ready',
      checkedAt: 1,
      latencyMs: 3,
      toolCount: 1,
      error: null,
    },
  };
}

function roundTrip(tool: McpToolDefinition): void {
  expect(() => encodeMcpStorageState({
    version: MCP_STORAGE_VERSION,
    servers: [server()],
    toolCaches: [cacheEntry(tool)],
  })).not.toThrow();
}

describe('MCP tool schema write→read round trip', () => {
  it('accepts a well-formed schema', () => {
    roundTrip({
      name: 'ok_tool',
      inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    });
  });

  it('repairs a schema whose properties is an array', () => {
    roundTrip({ name: 'bad_properties', inputSchema: { type: 'object', properties: [] } });
  });

  it('drops a required list that contains non-strings', () => {
    roundTrip({ name: 'bad_required', inputSchema: { type: 'object', required: [1, 2] } });
  });

  it('drops a non-boolean, non-object additionalProperties', () => {
    roundTrip({ name: 'bad_additional', inputSchema: { type: 'object', additionalProperties: [] } });
  });

  it('drops a non-string description', () => {
    roundTrip({ name: 'bad_description', inputSchema: { type: 'object', description: 42 } });
  });

  it('keeps a valid additionalProperties object intact', () => {
    const descriptor = normalizeMcpToolDescriptor(server(), {
      name: 'kept_additional',
      inputSchema: { type: 'object', additionalProperties: { type: 'string' } },
    });
    expect(descriptor.inputSchema.additionalProperties).toEqual({ type: 'string' });
  });

  it('keeps a valid required list intact', () => {
    const descriptor = normalizeMcpToolDescriptor(server(), {
      name: 'kept_required',
      inputSchema: { type: 'object', required: ['a', 'b'] },
    });
    expect(descriptor.inputSchema.required).toEqual(['a', 'b']);
  });

  it('keeps an unrelated schema keyword untouched', () => {
    // 只清洗那四个受校验字段，其余原样带过（不要顺手删掉 $schema / title 之类）。
    const descriptor = normalizeMcpToolDescriptor(server(), {
      name: 'kept_keywords',
      inputSchema: { type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'T' },
    });
    expect(descriptor.inputSchema).toMatchObject({
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'T',
    });
  });

  it('keeps the descriptor identity derived from the server and tool name', () => {
    const descriptor = normalizeMcpToolDescriptor(server(), { name: 'identity_tool' });
    expect(descriptor.id).toBe(createMcpDescriptorId(SERVER_ID, 'identity_tool'));
    expect(descriptor.invocationName).toBe(createMcpInvocationName(SERVER_ID, 'identity_tool'));
  });
});