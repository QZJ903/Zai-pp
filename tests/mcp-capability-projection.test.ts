import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MCP_CAPABILITY_SETTINGS,
  MCP_CAPABILITY_SETTINGS_STORAGE_KEY,
  McpCapabilitySettingsError,
  decodeMcpCapabilitySettings,
  getMcpCapabilitySettings,
  updateMcpCapabilitySettings,
} from '../core/mcp/capability-settings';
import {
  createMcpCapabilityToolDescriptors,
  isMcpCapabilityInvokeDescriptor,
} from '../core/mcp/capability-tools';
import {
  estimateMcpCapabilityPromptBytes,
  projectMcpCapabilityDescriptors,
  rankMcpCapabilityDescriptors,
} from '../core/mcp/capability-projection';
import { normalizeMcpToolDescriptor } from '../core/mcp';
import { renderToolSchemas } from '../core/prompt/augmentation';
import type { McpCapabilitySettings, ToolDescriptor } from '../core/types';

let storage: Record<string, unknown>;
let storageSet: ReturnType<typeof vi.fn>;

beforeEach(() => {
  storage = {};
  storageSet = vi.fn(async (values: Record<string, unknown>) => {
    storage = { ...storage, ...values };
  });
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (
          Object.hasOwn(storage, key) ? { [key]: storage[key] } : {}
        )),
        set: storageSet,
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MCP capability projection', () => {
  it('keeps the released direct projection byte-compatible and omits catalog controls', () => {
    const local = createLocalDescriptor();
    const alpha = createMcpDescriptor('server-1', 'alpha_search');
    const beta = createMcpDescriptor('server-1', 'beta_write');
    const helpers = createMcpCapabilityToolDescriptors('en');

    const projection = projectMcpCapabilityDescriptors({
      descriptors: [local, alpha, beta, ...helpers],
      settings: createSettings(),
      intent: 'search documents',
    });

    expect(projection).toMatchObject({
      directDescriptorIds: [alpha.id, beta.id],
      hiddenDescriptorIds: [],
      usesCatalog: false,
    });
    expect(projection.descriptors.map((descriptor) => descriptor.id))
      .toEqual([local.id, alpha.id, beta.id]);
  });

  it('never projects extension-internal tools through any exposure mode', () => {
    // ⚠️⚠️ **能力目录是「模型能不能看到/调到某个 MCP 工具」的第二条通道**，
    // 与 `core/zai/model-facing.ts` 那条（注入给模型的目录）互相独立。
    // 内部工具（`local_skill_preview`）在 `applyMcpToolPolicy` 里**恒为 enabled**
    // —— 因为 MCP 页不显示它、用户没有开关能关它 —— 所以少了这条排除，
    // 它会经由「恒 enabled」漏进能力目录，变成**默认开、无开关可关**的模型可见工具。
    const internal = createMcpDescriptor('shell-local', 'local_skill_preview');
    const ordinary = createMcpDescriptor('shell-local', 'shell_status');
    const helpers = createMcpCapabilityToolDescriptors('en');

    // 三种曝光模式各验一遍：direct / adaptive / on_demand 都不许带上它。
    for (const mode of ['direct', 'adaptive', 'on_demand'] as const) {
      const projection = projectMcpCapabilityDescriptors({
        descriptors: [internal, ordinary, ...helpers],
        settings: createSettings({
          servers: { 'shell-local': { mode, pinnedDescriptorIds: [] } },
        }),
        intent: 'preview a local skill folder',
      });
      const visibleIds = projection.descriptors.map((descriptor) => descriptor.id);
      expect(visibleIds, `${mode} 模式不该投内部工具`).not.toContain(internal.id);
      expect(projection.hiddenDescriptorIds, `${mode} 模式不该把内部工具列进目录`)
        .not.toContain(internal.id);
      expect(projection.directDescriptorIds, `${mode} 模式不该直投内部工具`)
        .not.toContain(internal.id);
      // 反面自检：普通工具在 direct 模式下必须出现（否则「全部被排除」也会让上面绿）。
      if (mode === 'direct') {
        expect(visibleIds, '普通工具不该被一起排掉').toContain(ordinary.id);
      }
    }
  });

  it('uses deterministic adaptive selection, honors pins, and exposes the closed catalog controls', () => {
    const local = createLocalDescriptor();
    const alpha = createMcpDescriptor('server-1', 'alpha_search');
    const beta = createMcpDescriptor('server-1', 'beta_write');
    const helpers = createMcpCapabilityToolDescriptors('en');

    const projection = projectMcpCapabilityDescriptors({
      descriptors: [local, alpha, beta, ...helpers],
      settings: createSettings({
        adaptiveMaxDirectTools: 1,
        servers: {
          'server-1': { mode: 'adaptive', pinnedDescriptorIds: [beta.id] },
        },
      }),
      intent: 'search documents',
    });

    expect(projection).toMatchObject({
      directDescriptorIds: [beta.id],
      hiddenDescriptorIds: [alpha.id],
      usesCatalog: true,
    });
    expect(projection.descriptors.map((descriptor) => descriptor.invocationName))
      // ⚠️ 生产形态：MCP 工具的调用名带 `mcp_<serverId>_` 前缀（`server-1` 被
      // sanitize 成 `server_1`）。用裸名断言等于在测一个生产不会出现的形状。
      .toEqual([
        'local_status',
        'mcp_server_1_beta_write',
        'mcp_discover',
        'mcp_describe',
        'mcp_invoke',
      ]);
  });

  it('hides all configured on-demand schemas but leaves no raw target-name proxy', () => {
    const alpha = createMcpDescriptor('server-1', 'alpha_search');
    const beta = createMcpDescriptor('server-1', 'beta_write');
    const helpers = createMcpCapabilityToolDescriptors('en');

    const projection = projectMcpCapabilityDescriptors({
      descriptors: [alpha, beta, ...helpers],
      settings: createSettings({
        servers: {
          'server-1': { mode: 'on_demand', pinnedDescriptorIds: [] },
        },
      }),
      intent: 'anything',
    });

    expect(projection.directDescriptorIds).toEqual([]);
    expect(projection.hiddenDescriptorIds).toEqual([alpha.id, beta.id]);
    const invoke = projection.descriptors.find((descriptor) => descriptor.invocationName === 'mcp_invoke');
    expect(invoke?.inputSchema).toMatchObject({
      properties: { capability: { type: 'string' }, arguments: { type: 'object' } },
      required: ['capability', 'arguments'],
    });
    expect(invoke?.inputSchema.properties).not.toHaveProperty('name');
  });

  it('does not let an MCP target impersonate a local catalog control through annotations', () => {
    const spoofedTarget: ToolDescriptor = {
      ...createMcpDescriptor('server-1', 'mcp_invoke'),
      annotations: { 'zpp.mcpCapabilityOperation': 'invoke' },
    };
    const helpers = createMcpCapabilityToolDescriptors('en');

    const projection = projectMcpCapabilityDescriptors({
      descriptors: [spoofedTarget, ...helpers],
      settings: createSettings(),
      intent: 'anything',
    });

    expect(projection.descriptors.map((descriptor) => descriptor.id)).toEqual([spoofedTarget.id]);
    expect(isMcpCapabilityInvokeDescriptor(spoofedTarget)).toBe(false);
  });

  it('uses a locale-independent lexical tie-break for equally ranked descriptors', () => {
    const beta = createMcpDescriptor('server-1', 'beta');
    const alpha = createMcpDescriptor('server-1', 'alpha');

    expect(rankMcpCapabilityDescriptors([beta, alpha], 'no matching terms')
      .map((descriptor) => descriptor.name))
      .toEqual(['alpha', 'beta']);
  });

  it('budgets enough bytes for the rendered schema and generated example payload', () => {
    const descriptor: ToolDescriptor = {
      ...createMcpDescriptor('server-1', 'many_required_values'),
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [
          `field_${index}`,
          { type: 'string', description: `Required field ${index}` },
        ])),
        required: Array.from({ length: 80 }, (_, index) => `field_${index}`),
        additionalProperties: false,
      },
    };

    const renderedBytes = new TextEncoder().encode(renderToolSchemas([descriptor], 'en')).byteLength;
    expect(estimateMcpCapabilityPromptBytes(descriptor)).toBeGreaterThanOrEqual(renderedBytes);
  });

  it('the estimate is NOT what the adaptive budget uses any more', () => {
    // ⚠️⚠️ **这条是给下一个人看的，不是测行为** —— 上面那条「估算 ≥ 渲染」只对普通工具成立；
    // 对 native Shell 工具它**反而低估**（实测 `shell_exec` 估算 1322 / 渲染 1826）。
    // 而真正的预算裁剪已经改成真渲染量字节（`measureToolSchemaBytes`），
    // 所以那个估算器**留着只为兼容，不参与任何裁剪决策**。
    //
    // 判据是「两者对 native 工具的结论相反」，用它把这条事实钉在测试里：
    // 只要还有人想拿 `estimateMcpCapabilityPromptBytes` 当预算判据，这条会提醒他别这么做。
    const nativeShellExec: ToolDescriptor = {
      ...createMcpDescriptor('shell-local', 'shell_exec'),
      provider: { ...createMcpDescriptor('shell-local', 'shell_exec').provider, transport: 'native_messaging' },
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Shell command' } },
        required: ['command'],
        additionalProperties: false,
      },
    };

    const renderedBytes = new TextEncoder().encode(renderToolSchemas([nativeShellExec], 'en')).byteLength;
    expect(
      estimateMcpCapabilityPromptBytes(nativeShellExec),
      '估算器对 native Shell 工具是低估的（它没算整段 shell hint）',
    ).toBeLessThan(renderedBytes);
  });
});

describe('MCP capability settings storage', () => {
  it('uses direct mode by default without writing storage, then validates bounded updates', async () => {
    await expect(getMcpCapabilitySettings()).resolves.toEqual(DEFAULT_MCP_CAPABILITY_SETTINGS);
    expect(storageSet).not.toHaveBeenCalled();

    await expect(updateMcpCapabilitySettings({ adaptiveMaxDirectTools: 12 })).resolves.toMatchObject({
      adaptiveMaxDirectTools: 12,
      adaptiveMaxPromptBytes: DEFAULT_MCP_CAPABILITY_SETTINGS.adaptiveMaxPromptBytes,
    });
    expect(storage[MCP_CAPABILITY_SETTINGS_STORAGE_KEY]).toMatchObject({
      version: 1,
      adaptiveMaxDirectTools: 12,
    });
  });

  it('fails closed for corrupt or future settings without rewriting them', async () => {
    storage[MCP_CAPABILITY_SETTINGS_STORAGE_KEY] = {
      version: 2,
      adaptiveMaxDirectTools: 8,
      adaptiveMaxPromptBytes: 24_000,
      servers: {},
    };
    const original = structuredClone(storage[MCP_CAPABILITY_SETTINGS_STORAGE_KEY]);

    await expect(updateMcpCapabilitySettings({ adaptiveMaxDirectTools: 12 }))
      .rejects.toMatchObject({
        name: 'McpCapabilitySettingsError',
        code: 'mcp_capability_settings_version_unsupported',
      } satisfies Partial<McpCapabilitySettingsError>);
    expect(storage[MCP_CAPABILITY_SETTINGS_STORAGE_KEY]).toEqual(original);
    expect(storageSet).not.toHaveBeenCalled();
    expect(() => decodeMcpCapabilitySettings({ version: 1, servers: {} }))
      .toThrow(McpCapabilitySettingsError);
    expect(() => decodeMcpCapabilitySettings(new Date(0)))
      .toThrow(McpCapabilitySettingsError);
  });
});

function createSettings(overrides: Partial<McpCapabilitySettings> = {}): McpCapabilitySettings {
  return {
    version: 1,
    adaptiveMaxDirectTools: 8,
    adaptiveMaxPromptBytes: 24_000,
    servers: {},
    ...overrides,
  };
}

/**
 * 一个「生产形态」的 MCP 描述符夹具。
 *
 * ⚠️⚠️ **必须走生产的 `normalizeMcpToolDescriptor`，别手抄对象字面量。**
 * 手抄的第一版把 `invocationName` 直接写成裸工具名，而生产**永远**带
 * `mcp_<serverId>_` 前缀（`createMcpInvocationName`，`core/mcp/descriptor-identity.ts`）
 * ⇒ 那些用例走的是生产不会出现的名字形态，判别力弱于看起来的样子。
 *
 * ⚠️ 改这一处会连带一条断言：`uses deterministic adaptive selection` 里钉调用名清单的
 * 那条——期望值现在必须写成 `mcp_server_1_beta_write`（`server-1` 的连字符被 sanitize
 * 成下划线），而不是裸的 `beta_write`。
 */
function createMcpDescriptor(serverId: string, name: string): ToolDescriptor {
  return normalizeMcpToolDescriptor(
    {
      version: 1,
      id: serverId,
      displayName: `MCP ${serverId}`,
      enabled: true,
      transport: { kind: 'streamable_http', url: `https://example.test/${serverId}` },
      headers: [],
      secrets: [],
      timeouts: { connectMs: 5_000, requestMs: 60_000, discoveryMs: 10_000 },
      limits: { maxResultBytes: 128_000, maxToolCount: 64 },
      allowlist: { mode: 'all', toolNames: [] },
      execution: { mode: 'auto', enabled: true },
      status: 'ready',
      lastConnectedAt: 0,
      lastError: null,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      name,
      title: name,
      description: `${name} capability`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { risk: 'low' },
    },
  );
}

function createLocalDescriptor(): ToolDescriptor {
  return {
    id: 'local:test:status',
    provider: { kind: 'local', id: 'test', displayName: 'Test', transport: 'in_process' },
    name: 'local_status',
    invocationName: 'local_status',
    title: 'Local status',
    description: 'Unrelated local tool.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
}
