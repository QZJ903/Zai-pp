import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  EXTENSION_INTERNAL_TOOL_NAMES,
  isExtensionInternalTool,
} from '../core/mcp/internal-tools';
import { EXPOSED_SHELL_TOOL_NAMES, SHELL_TOOL_NAMES } from '../core/shell/contracts';
import {
  isFilteredZaiModelFacingTool,
} from '../core/zai/model-facing';
import { applyMcpToolPolicy } from '../core/mcp/client';
import { visibleMcpTools } from '../entrypoints/sidepanel/controllers/mcp-tools-controller';
import type { McpServerConfig, McpToolCacheEntry, ToolDescriptor } from '../core/types';

/**
 * **内部工具清单是唯一真源** —— 三个消费者各在一个层面：
 * ① 模型可见目录（`core/zai/model-facing.ts`）
 * ② 提示词里的工具名清单（`core/shell/contracts.ts` 的 `EXPOSED_SHELL_TOOL_NAMES`）
 * ③ MCP 页的工具列表（`McpPage.tsx` 的 `visibleMcpTools`）
 *
 * ⚠️⚠️ **只裁一层是个真实出现过的缺陷**：面板上能勾选、显示「已启用」，
 * 而模型根本看不见它 ⇒ 用户勾完去问模型，模型说不知道这个工具。
 */

const SHELL_PROVIDER = {
  kind: 'mcp',
  id: 'shell-local',
  displayName: 'Shell Local',
  transport: 'native_messaging',
} as const;

function shellDescriptor(name: string): ToolDescriptor {
  return {
    id: `mcp:shell-local:${name}`,
    provider: SHELL_PROVIDER,
    name,
    invocationName: name,
    title: name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  } as ToolDescriptor;
}

function shellServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'shell-local',
    displayName: 'Shell Local',
    enabled: true,
    transport: { kind: 'native_messaging', nativeHost: 'com.zai_pp.shell' },
    headers: [],
    secrets: [],
    timeouts: { connectMs: 5_000, requestMs: 120_000, discoveryMs: 10_000 },
    limits: { maxResultBytes: 128_000, maxToolCount: 12 },
    allowlist: { mode: 'all', toolNames: [] },
    execution: { enabled: true, mode: 'auto' },
    status: 'ready',
    lastConnectedAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as McpServerConfig;
}

describe('extension-internal tools', () => {
  it('only lists names the Shell host actually publishes', () => {
    // ⚠️ 手抄清单会与 `SHELL_TOOL_NAMES` 漂移，而漂移时没有任何报错。
    for (const name of EXTENSION_INTERNAL_TOOL_NAMES) {
      expect(SHELL_TOOL_NAMES, `${name} 应当存在于 host 发布清单里`).toContain(name);
    }
  });

  it('is excluded from the model-facing catalog', () => {
    for (const name of EXTENSION_INTERNAL_TOOL_NAMES) {
      expect(
        isFilteredZaiModelFacingTool(shellDescriptor(name)),
        `${name} 必须对模型不可见`,
      ).toBe(true);
    }
  });

  it('is excluded from the prompt tool-name list', () => {
    // ⚠️ 提示词里的「可识别的 shell 工具名」是另一层 —— 只裁模型目录不够。
    for (const name of EXTENSION_INTERNAL_TOOL_NAMES) {
      expect(EXPOSED_SHELL_TOOL_NAMES, `${name} 不该出现在提示词名单里`).not.toContain(name);
    }
    // 反面自检：非内部工具必须在名单里（否则「全部被裁」也会让上面那条绿）。
    expect(EXPOSED_SHELL_TOOL_NAMES.length).toBe(
      SHELL_TOOL_NAMES.length - EXTENSION_INTERNAL_TOOL_NAMES.size,
    );
  });

  it('stays enabled even when the allowlist denies it', () => {
    // ⚠️⚠️ **MCP 页不显示它 ⇒ 用户没有任何地方能把它打开**。若 allowlist 仍能把它关掉，
    // 本地 Skill 导入会报 `mcp_tool_disabled`，而界面上无从修复。
    const server = shellServer({
      allowlist: { mode: 'deny', toolNames: [...EXTENSION_INTERNAL_TOOL_NAMES, 'shell_exec'] },
    });
    for (const name of EXTENSION_INTERNAL_TOOL_NAMES) {
      const [descriptor] = applyMcpToolPolicy([shellDescriptor(name)], server);
      expect(descriptor!.execution.enabled, `${name} 不该被 allowlist 关掉`).toBe(true);
    }
    // 反面自检：同一个 deny 名单里的普通工具必须被关掉（否则上面那条是空断言）。
    const [ordinary] = applyMcpToolPolicy([shellDescriptor('shell_exec')], server);
    expect(ordinary!.execution.enabled).toBe(false);
  });

  it('still respects the server-level gates', () => {
    // ⚠️ **只跳过 allowlist 那一层** —— 用户关掉整个 Shell Local 时，导入当然也不该能用。
    for (const overrides of [
      { enabled: false },
      { execution: { enabled: false, mode: 'auto' as const } },
      { execution: { enabled: true, mode: 'disabled' as const } },
    ]) {
      const server = shellServer(overrides);
      const [descriptor] = applyMcpToolPolicy([shellDescriptor('local_skill_preview')], server);
      expect(descriptor!.execution.enabled, JSON.stringify(overrides)).toBe(false);
    }
  });

  it('answers membership through the single helper', () => {
    for (const name of EXTENSION_INTERNAL_TOOL_NAMES) {
      expect(isExtensionInternalTool(name)).toBe(true);
    }
    expect(isExtensionInternalTool('shell_exec')).toBe(false);
    expect(isExtensionInternalTool('local_folder_pick')).toBe(false);
  });

  it('is hidden from the MCP page tool list', () => {
    // ⚠️⚠️ **第三层**：面板上显示成可勾选的普通工具，会让用户以为勾上模型就能用。
    const cache = {
      serverId: 'shell-local',
      descriptors: SHELL_TOOL_NAMES.map(shellDescriptor),
      refreshedAt: 0,
      expiresAt: 0,
      health: { serverId: 'shell-local', status: 'ready', checkedAt: 0, latencyMs: 0, toolCount: SHELL_TOOL_NAMES.length, error: null },
    } as McpToolCacheEntry;

    const visible = visibleMcpTools(cache).map((tool) => tool.name);
    for (const name of EXTENSION_INTERNAL_TOOL_NAMES) {
      expect(visible, `${name} 不该出现在 MCP 页列表里`).not.toContain(name);
    }
    // 反面自检：其余工具一个都不能少（否则「全过滤掉」也会让上面那条绿）。
    expect(visible).toHaveLength(SHELL_TOOL_NAMES.length - EXTENSION_INTERNAL_TOOL_NAMES.size);
    expect(visible).toContain('local_folder_pick');
  });

  it('every MCP-page count goes through visibleMcpTools (no raw descriptor denominator)', () => {
    // ⚠️⚠️ **三个计数点，谁漏掉一处就会出现「页头 12 / 列表 11」这种对不上的显示**：
    // ① `McpPage` 的 `autoTools` 分母；② `McpPage` 的 `activeTools`；
    // ③ `useMcpPageController` 的页头 `toolCount`。
    // 判据收窄到「这些调用点传的是 visibleMcpTools 而不是 cache.descriptors」——
    // 只测 helper 本身（下面那些用例）挡不住「有人把调用点改回原始目录」。
    const page = readFileSync('entrypoints/sidepanel/pages/McpPage.tsx', 'utf8');
    expect(page, 'autoTools 的分母必须走 visibleMcpTools')
      .toContain('total: visibleMcpTools(cache).length');
    expect(page, 'activeTools 必须走 visibleMcpTools')
      .toContain('countEnabledMcpTools(server, visibleMcpTools(cache))');
    expect(page, '不许再有原始目录当分母').not.toContain('total: cache?.descriptors.length');

    const controller = readFileSync(
      'entrypoints/sidepanel/controllers/useMcpPageController.ts',
      'utf8',
    );
    expect(controller, '页头 toolCount 必须走 visibleMcpTools')
      .toContain('countEnabledMcpTools(server, visibleMcpTools(caches[server.id]))');
    expect(controller, '不许再有原始目录当分子')
      .not.toMatch(/countEnabledMcpTools\(server,\s*caches\[server\.id\]\?\.descriptors/);
  });

  it('the page actually goes through the helper (not a raw descriptor list)', () => {
    // ⚠️⚠️ **上面那条测的是 helper 本身** —— 把 `McpPage` 里那行改回
    // `cache?.descriptors ?? []` 它照样绿（实测）。这条补的是**接线**。
    const source = readFileSync('entrypoints/sidepanel/pages/McpPage.tsx', 'utf8');
    expect(source, 'MCP 页的工具列表必须经 visibleMcpTools').toContain('const tools = visibleMcpTools(cache)');
    expect(
      source,
      '计数与状态行也要同口径，不许回退到原始 descriptors / health.toolCount',
    ).not.toContain('countEnabledMcpTools(server, cache?.descriptors');
    expect(source).not.toContain('{ count: cache.health.toolCount }');
  });
});
