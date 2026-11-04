import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpServer,
  getAllMcpServers,
  getMcpServerById,
  getMcpToolCache,
  saveMcpDiscoveryResult,
  updateMcpServer,
} from '../core/mcp/store';
import { MCP_STORAGE_KEY } from '../core/mcp/storage-codec';
import { createShellMcpPresetInput } from '../core/shell';
import { createMcpDescriptorId, createMcpInvocationName } from '../core/mcp/descriptor-identity';
import type { McpServerConfig } from '../core/mcp/types';
import type { ToolDescriptor } from '../core/types';

/**
 * **「配置有没有变」的判据必须与键序无关。**
 *
 * ⚠️⚠️ 这条守的是一个真机撞到的缺陷：`normalizeServerForMutation` 重建 `timeouts` 时
 * 按源码声明序（`connectMs` / `requestMs` / `discoveryMs`），而 `chrome.storage` 读回的
 * 是**键名字母序**（`connectMs` / `discoveryMs` / `requestMs`）。同一个值、两种键序
 * ⇒ `mcpDiscoveryFingerprint` 不相等 ⇒ `shouldInvalidateMcpToolCache` 判真 ⇒
 * **任何一次配置写入都清空工具缓存、把状态打成 `unknown`、抹掉上次连接时间**。
 *
 * 真机症状：MCP 页里关掉一个工具（或改个显示名），「发现工具」从 12 变成 0、
 * 状态从「已连接」变成「未知」、延迟与上次连接都变成 `-`，必须手动点一次刷新工具。
 *
 * ⚠️ **桩必须模拟真机的键序**：`chrome.storage.local.get` 返回**按键名排序**的对象。
 * 若桩直接回放内存里的对象（键序原样保留），这个缺陷**测不出来** ——
 * 第一版桩就是那样，所以当时误判成「不复现」。
 */

let storage: Record<string, unknown>;

/** 模拟 `chrome.storage` 的 JSON 往返：对象的键名会被规整成有序。 */
function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSortKeys);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source).sort().map((key) => [key, deepSortKeys(source[key])]),
    );
  }
  return value;
}

beforeEach(() => {
  storage = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({
          [key]: storage[key] === undefined ? undefined : deepSortKeys(storage[key]),
        })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          storage = { ...storage, ...values };
        }),
      },
    },
    runtime: { getManifest: vi.fn(() => ({ version: '0.0.0' })) },
  });
});

function descriptor(serverId: string, name: string): ToolDescriptor {
  return {
    id: createMcpDescriptorId(serverId, name),
    provider: { kind: 'mcp', id: serverId, displayName: 'Shell Local', transport: 'native_messaging' },
    name,
    invocationName: createMcpInvocationName(serverId, name),
    title: name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  } as ToolDescriptor;
}

/** 建一个已发现过的 Shell 服务（缓存里有一条 ready 记录）。 */
async function seedDiscoveredServer(): Promise<{ id: string; toolNames: string[] }> {
  const created = await createMcpServer(createShellMcpPresetInput({ enabled: true }));
  const server = (await getMcpServerById(created.id, { includeSecrets: true }))!;
  const toolNames = ['shell_status', 'python_status', 'python_exec'];
  await saveMcpDiscoveryResult({
    serverId: server.id,
    descriptors: toolNames.map((name) => descriptor(server.id, name)),
    refreshedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    health: {
      serverId: server.id,
      status: 'ready',
      checkedAt: Date.now(),
      latencyMs: 4,
      toolCount: toolNames.length,
      error: null,
    },
  }, server);
  return { id: server.id, toolNames };
}

describe('MCP 配置指纹：与键序无关', () => {
  it('改 allowlist 不清缓存（真机那个「关掉一个工具就变成 0 个」）', async () => {
    const { id } = await seedDiscoveredServer();
    expect(await getMcpToolCache(id), '前置：发现后应当有缓存').not.toBeNull();

    await updateMcpServer(id, { allowlist: { mode: 'deny', toolNames: ['python_exec'] } } as never);

    expect(
      await getMcpToolCache(id),
      '改 allowlist 不影响发现结果 —— 缓存必须留着，否则用户关一个工具就要重新刷新',
    ).not.toBeNull();
    expect((await getMcpServerById(id))?.status, '状态不该被改成 unknown').toBe('ready');
  });

  it('改显示名不清缓存', async () => {
    const { id } = await seedDiscoveredServer();
    await updateMcpServer(id, { displayName: 'Renamed Shell' } as never);
    expect(await getMcpToolCache(id)).not.toBeNull();
    expect((await getMcpServerById(id))?.status).toBe('ready');
  });

  it('改执行策略不清缓存', async () => {
    const { id } = await seedDiscoveredServer();
    await updateMcpServer(id, { execution: { enabled: false } } as never);
    // ⚠️ `applyMcpToolPolicy` 在**读时**会把 `execution.enabled` 重新算进 descriptor
    // （`core/mcp/client.ts`）⇒ 这条路径本来就不需要重新发现。
    expect(await getMcpToolCache(id)).not.toBeNull();
  });
});

describe('MCP 配置指纹：真值变化仍然要清缓存', () => {
  /** 每一条都改一个「会影响发现结果」的字段，缓存都必须失效。 */
  const invalidatingPatches: Array<[string, Record<string, unknown>]> = [
    ['transport.url', { transport: { kind: 'http', url: 'https://example.test/mcp' } }],
    ['transport.nativeHost', { transport: { kind: 'native_messaging', nativeHost: 'com.other.host' } }],
    ['transport.env', { transport: { kind: 'native_messaging', nativeHost: 'com.zai_pp.shell', env: { A: '1' } } }],
    ['headers', { headers: [{ name: 'X-Test', value: '1' }] }],
    ['secrets', { secrets: [{ kind: 'bearer', value: 'token' }] }],
    // ⚠️ 上限在 `listMcpTools` 里就 slice（`core/mcp/client.ts`），改小必须重新发现 ——
    // 读时不会纠正（`applyMcpToolPolicy` 只打标记、不过滤）。
    ['limits.maxToolCount', { limits: { maxResultBytes: 128000, maxToolCount: 2 } }],
    // ⚠️ `discoveryMs` 是 `tools/list` 的超时，改大可能让本来失败的发现成功。
    ['timeouts.discoveryMs', { timeouts: { connectMs: 5000, requestMs: 120000, discoveryMs: 30000 } }],
  ];

  for (const [label, patch] of invalidatingPatches) {
    it(`改 ${label} 会清缓存`, async () => {
      const { id } = await seedDiscoveredServer();
      await updateMcpServer(id, patch as never);
      expect(await getMcpToolCache(id), `${label} 影响发现结果 ⇒ 缓存必须失效`).toBeNull();
      expect((await getMcpServerById(id))?.status).toBe('unknown');
    });
  }
});

describe('MCP 配置指纹：改用等价路径写回时不该误判', () => {
  it('反复写入同一份配置（值不变）不清缓存', async () => {
    // ⚠️ 这条守的是键序问题的**另一面**：即使值完全不变，只要每次写入走一遍
    // `normalizeServerForMutation`（重建 `timeouts` 的键序），旧实现也会判「变了」。
    const { id } = await seedDiscoveredServer();
    const before = await getMcpServerById(id, { includeSecrets: true });
    expect(before).not.toBeNull();

    for (let round = 0; round < 3; round += 1) {
      await updateMcpServer(id, {
        displayName: `Shell Local ${round}`,
        timeouts: before!.timeouts,
        limits: before!.limits,
      } as never);
    }

    expect(
      await getMcpToolCache(id),
      '值的集合没变（只有 displayName 变），缓存不该被清',
    ).not.toBeNull();
  });

  it('只改 secret 的 id 不清缓存（它是 UI 身份，不影响连接）', async () => {
    // ⚠️ 指纹**刻意只取 secret 的四个连接相关字段**，`id` 被排除 ——
    // 原实现那句注释就是这么说的。若把原始 `secrets` 直接交给 canonicalize，
    // `id` 会进指纹 ⇒ 每次保存都会因为重新生成的 id 而白清一次缓存。
    const created = await createMcpServer({
      displayName: 'Shell Local',
      enabled: true,
      transport: { kind: 'native_messaging', nativeHost: 'com.zai_pp.shell' },
      headers: [],
      secrets: [{ id: 'id-A', kind: 'bearer', value: 'v1' }],
      timeouts: { connectMs: 5000, requestMs: 120000, discoveryMs: 10000 },
      limits: { maxResultBytes: 128000, maxToolCount: 12 },
    } as never);
    const server = (await getMcpServerById(created.id, { includeSecrets: true }))!;
    await saveMcpDiscoveryResult({
      serverId: server.id,
      descriptors: [descriptor(server.id, 'shell_status')],
      refreshedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      health: {
        serverId: server.id,
        status: 'ready',
        checkedAt: Date.now(),
        latencyMs: 1,
        toolCount: 1,
        error: null,
      },
    }, server);

    // 只换 id，凭据值不变
    await updateMcpServer(created.id, {
      secrets: [{ id: 'id-B', kind: 'bearer', value: 'v1' }],
    } as never);

    expect(
      await getMcpToolCache(created.id),
      'secret 的 id 是 UI 身份、不影响连接 —— 只换它不该清缓存',
    ).not.toBeNull();
  });

  it('transport 缺省 env 的记录写入后不清缓存', async () => {
    // ⚠️ 守的是 `env: server.transport.env ?? {}` 那个 `?? {}` ——
    // 指纹的**另一侧**（`normalizeServerForMutation` → `stringRecordValue`）会把缺省的
    // `env` 补成 `{}`；若指纹这边留着 `undefined`，`JSON.stringify` 会整个丢掉这个键
    // ⇒ 两侧不等 ⇒ 每一次写入都清缓存。真机那份 `servers[0]` 是有 `env: {}` 的，
    // 但**老记录可能缺这个字段**（`normalizeServerForMutation` 的注释就在讲这件事）。
    const created = await createMcpServer({
      displayName: 'Shell Local',
      enabled: true,
      // ⚠️ 刻意不带 env
      transport: { kind: 'native_messaging', nativeHost: 'com.zai_pp.shell' },
      headers: [],
      secrets: [],
      timeouts: { connectMs: 5000, requestMs: 120000, discoveryMs: 10000 },
      limits: { maxResultBytes: 128000, maxToolCount: 12 },
    } as never);
    const server = (await getMcpServerById(created.id, { includeSecrets: true }))!;
    expect(server.transport.env, '前置：建出来时应当被补成 {}').toEqual({});
    await saveMcpDiscoveryResult({
      serverId: server.id,
      descriptors: [descriptor(server.id, 'shell_status')],
      refreshedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      health: {
        serverId: server.id,
        status: 'ready',
        checkedAt: Date.now(),
        latencyMs: 1,
        toolCount: 1,
        error: null,
      },
    }, server);

    // 存储里手工抹掉 env，模拟「老记录缺这个字段」
    const raw = storage[MCP_STORAGE_KEY] as Record<string, unknown>;
    const storedServer = (raw.servers as Array<Record<string, unknown>>)[0]!;
    const transport = storedServer.transport as Record<string, unknown>;
    delete transport.env;
    expect('env' in transport, '前置：env 已从存储里抹掉').toBe(false);

    await updateMcpServer(created.id, { displayName: 'Renamed' } as never);
    expect(
      await getMcpToolCache(created.id),
      '缺省 env 的记录写入配置后，缓存不该被清',
    ).not.toBeNull();
  });

  it('storage 里那台真机的字段形状能被正确读回', async () => {
    // 真机 `servers[0]` 的实际形状（从 chrome.storage 导出）：
    // `timeouts` 是字母序，`transport` 的键也是字母序。
    const { id } = await seedDiscoveredServer();
    const raw = storage[MCP_STORAGE_KEY] as Record<string, unknown>;
    const servers = raw.servers as Array<Record<string, unknown>>;
    const stored = servers[0]!;
    expect(Object.keys(stored.timeouts as object), '桩必须模拟真机的字母序').toEqual(
      ['connectMs', 'discoveryMs', 'requestMs'],
    );
    expect(stored.status).toBe('ready');

    await updateMcpServer(id, { allowlist: { mode: 'deny', toolNames: [] } } as never);
    expect(await getMcpToolCache(id)).not.toBeNull();
  });
});
describe('MCP 发现不改配置时间（页面列表顺序只在用户改配置时变）', () => {
  /** 按**这台服务自己的 transport** 造描述符 —— 写侧产物必须能过读侧校验（provider.transport 必须相等）。 */
  function descriptorFor(server: McpServerConfig, name: string): ToolDescriptor {
    return {
      id: createMcpDescriptorId(server.id, name),
      provider: {
        kind: 'mcp',
        id: server.id,
        displayName: server.displayName,
        transport: server.transport.kind,
      },
      name,
      invocationName: createMcpInvocationName(server.id, name),
      title: name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      execution: { mode: 'auto', enabled: true, risk: 'low' },
    } as ToolDescriptor;
  }

  /**
   * ⚠️⚠️ 守的是一个真缺陷：`applyMcpServerHealthPatch` 曾经也写 `updatedAt`，
   * 而 `getAllMcpServers` **按 `updatedAt` 降序**返回、MCP 页直接照这个顺序渲染。
   * 于是「发现一次」= 「这条服务跳到列表最前面」，而**发现失败走的是同一个补丁** ——
   * 一个刚连不上的服务也会被顶到榜首。
   *
   * 判据取自 `updateMcpServerHealth` 自己的契约：「records connection health
   * **without treating it as a configuration mutation**」。
   */
  it('一次成功的发现不改 updatedAt', async () => {
    const { id } = await seedDiscoveredServer();
    const before = (await getMcpServerById(id))!;

    await saveMcpDiscoveryResult({
      serverId: id,
      descriptors: [descriptorFor(before, 'shell_status')],
      refreshedAt: Date.now() + 1_000,
      expiresAt: Date.now() + 61_000,
      health: {
        serverId: id,
        status: 'ready',
        checkedAt: Date.now() + 1_000,
        latencyMs: 3,
        toolCount: 1,
        error: null,
      },
    }, before);

    const after = (await getMcpServerById(id))!;
    expect(after.updatedAt, '发现不是配置变更，不许改 updatedAt').toBe(before.updatedAt);
    // 但健康字段本身必须照常更新，否则这条用例会因为「什么都没写」而恒绿。
    expect(after.lastConnectedAt, '成功发现要更新 lastConnectedAt').not.toBe(before.lastConnectedAt);
    expect(after.status).toBe('ready');
  });

  it('一次失败的发现既不改 updatedAt、也不动 lastConnectedAt', async () => {
    const { id } = await seedDiscoveredServer();
    const before = (await getMcpServerById(id))!;

    await saveMcpDiscoveryResult({
      serverId: id,
      descriptors: [],
      refreshedAt: Date.now(),
      expiresAt: Date.now() + 30_000,
      health: {
        serverId: id,
        status: 'error',
        checkedAt: Date.now() + 1_000,
        latencyMs: null,
        toolCount: 0,
        error: 'connect ECONNREFUSED',
      },
    }, before);

    const after = (await getMcpServerById(id))!;
    expect(after.updatedAt, '发现失败同样不是配置变更').toBe(before.updatedAt);
    expect(after.lastConnectedAt, '失败不许动「上次连接」').toBe(before.lastConnectedAt);
    expect(after.status).toBe('error');
    expect(after.lastError).toContain('ECONNREFUSED');
  });

  it('列表顺序只由配置变更决定', async () => {
    // ⚠️ **必须控制时钟** —— `updatedAt` 取 `Date.now()`，同一毫秒内建两条会撞成平局、
    // 排序退回原序，这条用例就变成靠运气绿（第一版实测：`expected 'Second' to be 'First renamed'`）。
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(1_000);
      const first = await createMcpServer({
        displayName: 'First',
        transport: { kind: 'streamable_http', url: 'https://a.test/mcp' },
      });
      clock.mockReturnValue(2_000);
      await createMcpServer({
        displayName: 'Second',
        transport: { kind: 'streamable_http', url: 'https://b.test/mcp' },
      });

      // 晚建的在前。
      let order = (await getAllMcpServers()).map((server) => server.displayName);
      expect(order.slice(0, 2)).toEqual(['Second', 'First']);

      // 对 First 做一次成功发现：顺序不许变。
      clock.mockReturnValue(3_000);
      const firstRecord = (await getMcpServerById(first.id))!;
      await saveMcpDiscoveryResult({
        serverId: first.id,
        descriptors: [descriptorFor(firstRecord, 'a_tool')],
        refreshedAt: 3_000,
        expiresAt: 63_000,
        health: {
          serverId: first.id,
          status: 'ready',
          checkedAt: 3_000,
          latencyMs: 2,
          toolCount: 1,
          error: null,
        },
      }, firstRecord);
      order = (await getAllMcpServers()).map((server) => server.displayName);
      expect(order.slice(0, 2), '发现一次不许让 First 跳到 Second 前面').toEqual(['Second', 'First']);

      // 用户改配置 ⇒ 这次才该浮到最前。
      clock.mockReturnValue(4_000);
      await updateMcpServer(first.id, { displayName: 'First renamed' } as never);
      order = (await getAllMcpServers()).map((server) => server.displayName);
      expect(order[0]).toBe('First renamed');
    } finally {
      clock.mockRestore();
    }
  });
});
