import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MCP_CAPABILITY_LEASE_STORAGE_KEY,
  MCP_CAPABILITY_LEASE_TTL_MS,
  McpCapabilityLeaseError,
  createToolCapabilityScope,
  issueMcpCapabilityLeases,
  resolveMcpCapabilityLease,
} from '../core/mcp/capability-lease';
import type { ToolDescriptor } from '../core/types';

let sessionStorage: Record<string, unknown>;
let sessionSet: ReturnType<typeof vi.fn>;
let uuid = 0;

beforeEach(() => {
  sessionStorage = {};
  uuid = 0;
  sessionSet = vi.fn(async (values: Record<string, unknown>) => {
    sessionStorage = { ...sessionStorage, ...values };
  });
  const nativeCrypto = globalThis.crypto;
  vi.stubGlobal('crypto', {
    subtle: nativeCrypto.subtle,
    randomUUID: vi.fn(() => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`),
  });
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: vi.fn(async (key: string) => (
          Object.hasOwn(sessionStorage, key) ? { [key]: sessionStorage[key] } : {}
        )),
        set: sessionSet,
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MCP capability leases', () => {
  it('binds a discovered capability to one trusted scope and consumes it exactly once', async () => {
    const descriptor = createDescriptor();
    const owner = createOwner('turn-a');
    const [issued] = await issueMcpCapabilityLeases({
      owner,
      descriptors: [descriptor],
      now: 1_000,
    });

    await expect(resolveMcpCapabilityLease({
      handle: issued.handle,
      owner,
      currentDescriptors: [descriptor],
      consume: true,
      now: 1_001,
    })).resolves.toEqual(descriptor);

    await expect(resolveMcpCapabilityLease({
      handle: issued.handle,
      owner,
      currentDescriptors: [descriptor],
      consume: true,
      now: 1_002,
    })).rejects.toMatchObject({
      name: 'McpCapabilityLeaseError',
      // ⚠️ **`consume` 现在直接把 lease 从池子里删掉**（不再标 `consumed` 占着名额
      // 等 15 分钟 TTL），所以重放看到的是「这个句柄不存在」而不是「这个句柄用过了」。
      // 两者对调用方是同一个意思，区别只在人肉排障时少一句「你重复用了」。
      code: 'mcp_capability_handle_invalid',
    } satisfies Partial<McpCapabilityLeaseError>);
  });

  it('frees the pool slot immediately on consume instead of holding it until the TTL', async () => {
    // ⚠️ 守的是「discover → invoke 这个正常循环会把池子越用越满」这个缺陷：
    // 池子 256 个、`mcp_discover` 一次默认签 8 个 ⇒ 标 `consumed` 不删的话，
    // 32 次 discover 就能把池子填满，之后所有 discover 报 `mcp_capability_lease_limit`，
    // 而 TTL 要 15 分钟才回收。消费即删之后，每次 invoke 都立刻还名额。
    const owner = createOwner('turn-pool');
    for (let round = 0; round < 40; round += 1) {
      const descriptor = createDescriptor();
      const [issued] = await issueMcpCapabilityLeases({ owner, descriptors: [descriptor], now: 1_000 + round * 10 });
      await expect(resolveMcpCapabilityLease({
        handle: issued!.handle,
        owner,
        currentDescriptors: [descriptor],
        consume: true,
        now: 1_000 + round * 10 + 1,
      })).resolves.toEqual(descriptor);
    }
    // 40 轮远小于 256，但若 consumed 条目留着，这里会累积到 40 条；
    // 断言池子里留不下任何一条 —— 这是「消费即回收」的直接观测面。
    const stored = sessionStorage[MCP_CAPABILITY_LEASE_STORAGE_KEY] as { leases?: Record<string, unknown> } | undefined;
    expect(Object.keys(stored?.leases ?? {})).toHaveLength(0);
  });

  it('rejects a handle from another scope and invalidates it if the descriptor security snapshot changes', async () => {
    const descriptor = createDescriptor();
    const owner = createOwner('turn-a');
    const [issued] = await issueMcpCapabilityLeases({ owner, descriptors: [descriptor], now: 1_000 });

    await expect(resolveMcpCapabilityLease({
      handle: issued.handle,
      owner: createOwner('turn-b'),
      currentDescriptors: [descriptor],
      consume: false,
      now: 1_001,
    })).rejects.toMatchObject({ code: 'mcp_capability_handle_owner_mismatch' });

    const [staleIssued] = await issueMcpCapabilityLeases({ owner, descriptors: [descriptor], now: 1_002 });
    await expect(resolveMcpCapabilityLease({
      handle: staleIssued.handle,
      owner,
      currentDescriptors: [createDescriptor({
        inputSchema: {
          type: 'object',
          properties: { destructive: { type: 'boolean' } },
          additionalProperties: false,
        },
      })],
      consume: true,
      now: 1_003,
    })).rejects.toMatchObject({ code: 'mcp_capability_descriptor_stale' });
  });

  it('allows an inline agent grant to continue the originating manual-chat capability scope', async () => {
    const descriptor = createDescriptor();
    const manualOwner = createGrantOwner('manual_chat');
    const [issued] = await issueMcpCapabilityLeases({
      owner: manualOwner,
      descriptors: [descriptor],
      now: 1_000,
    });

    await expect(resolveMcpCapabilityLease({
      handle: issued.handle,
      owner: createGrantOwner('agent_run'),
      currentDescriptors: [descriptor],
      consume: false,
      now: 1_001,
    })).resolves.toEqual(descriptor);
  });

  it('distinguishes expiration from unknown handles and fails closed on corrupt lease state', async () => {
    const descriptor = createDescriptor();
    const owner = createOwner('turn-a');
    const [issued] = await issueMcpCapabilityLeases({ owner, descriptors: [descriptor], now: 1_000 });

    await expect(resolveMcpCapabilityLease({
      handle: issued.handle,
      owner,
      currentDescriptors: [descriptor],
      consume: false,
      now: 1_000 + MCP_CAPABILITY_LEASE_TTL_MS,
    })).rejects.toMatchObject({ code: 'mcp_capability_handle_expired' });

    sessionStorage[MCP_CAPABILITY_LEASE_STORAGE_KEY] = { version: 1, leases: 'corrupt' };
    const original = structuredClone(sessionStorage[MCP_CAPABILITY_LEASE_STORAGE_KEY]);
    await expect(issueMcpCapabilityLeases({ owner, descriptors: [descriptor], now: 2_000 }))
      .rejects.toMatchObject({ code: 'mcp_capability_lease_state_invalid' });
    expect(sessionStorage[MCP_CAPABILITY_LEASE_STORAGE_KEY]).toEqual(original);
  });
});

function createOwner(scopeId: string) {
  return createToolCapabilityScope({
    kind: 'trusted',
    scopeId,
    trigger: 'sidepanel_chat',
    chatSessionId: 'chat-1',
  });
}

function createGrantOwner(trigger: 'manual_chat' | 'agent_run') {
  return createToolCapabilityScope({
    kind: 'grant',
    scopeId: 'request-1',
    trigger,
    chatSessionId: 'chat-1',
    subject: {
      surface: 'zai_content',
      documentSessionId: 'document-1',
      tabId: 7,
      frameId: 0,
      chatSessionId: 'chat-1',
    },
  });
}

function createDescriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id: 'mcp:server-1:write_document',
    provider: {
      kind: 'mcp',
      id: 'server-1',
      displayName: 'MCP Server',
      transport: 'streamable_http',
    },
    name: 'write_document',
    invocationName: 'write_document',
    title: 'Write document',
    description: 'Writes a document.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    execution: { mode: 'auto', enabled: true, risk: 'medium' },
    ...overrides,
  };
}
