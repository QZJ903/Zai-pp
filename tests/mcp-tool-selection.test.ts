import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpDescriptorId,
  createMcpInvocationName,
} from '../core/mcp/descriptor-identity';
import type { McpServerConfig, McpToolCacheEntry, ToolDescriptor } from '../core/types';
import McpPage from '../entrypoints/sidepanel/pages/McpPage';

/**
 * 工具开关必须走「按单个工具改」的那条命令。
 *
 * ⚠️⚠️ 守的是一个**静默**缺陷：侧边栏自己算整份 `allowlist` 再 `UPDATE_MCP_SERVER`
 * 提交时，算的是**它手上那份快照**，而快照要等后台广播回来才更新。用户连着点两个
 * 不同工具的开关，第二次算出的名单里没有第一次的改动 ⇒ **第一次被整份覆盖掉**
 * （表现：点了两个只开了一个，没有任何报错）。
 *
 * ⚠️ 判据是「页面真的发出了哪条命令」，不是「源码里写了哪个函数名」—— 后者是
 * 同义反复，前者能抓住「改回整份提交」这个变异。
 */

let container: HTMLDivElement;
let root: Root | null;
let sent: Array<{ type?: string; payload?: unknown }>;
let runtimeListener: ((message: { type?: string }) => void) | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  sent = [];
  runtimeListener = null;

  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-extension-id',
      getManifest: vi.fn(() => ({ version: '0.0.0' })),
      sendMessage: vi.fn(async (message: { type?: string; payload?: unknown }) => {
        sent.push(message);
        if (message.type === 'GET_MCP_SERVERS') return [server, secondServer];
        if (message.type === 'GET_PLATFORM_CAPABILITIES') return platformEnvironment;
        if (message.type === 'GET_MCP_TOOL_CACHE') {
          const serverId = (message.payload as { serverId?: string } | undefined)?.serverId;
          return serverId === secondServer.id ? secondToolCache : toolCache;
        }
        if (message.type === 'GET_MCP_CAPABILITY_SETTINGS') return capabilitySettings;
        if (message.type === 'GET_TOOL_CALL_HISTORY') return { records: [], dropped: 0 };
        if (message.type === 'SET_MCP_TOOL_SELECTION') return { ...server };
        if (message.type === 'UPDATE_MCP_SERVER') return { ...server };
        throw new Error(`Unexpected command: ${message.type}`);
      }),
      onMessage: {
        addListener: vi.fn((listener: (message: { type?: string }) => void) => {
          runtimeListener = listener;
        }),
        removeListener: vi.fn(),
      },
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('McpPage tool toggles', () => {
  it('sends one per-tool command per toggle instead of resubmitting the whole allowlist', async () => {
    await renderMcpPage();
    // ⚠️ 首个服务是**自动展开**的（`load()` 的初始选中），不要再点一次 —— 那会把详情收起来。

    await click(toolToggleButton('alpha_tool'));
    await click(toolToggleButton('beta_tool'));

    const perTool = sent.filter((message) => message.type === 'SET_MCP_TOOL_SELECTION');
    expect(perTool.map((message) => (message.payload as { toolName: string }).toolName))
      .toEqual(['alpha_tool', 'beta_tool']);

    // ⚠️ 反面：整份提交那条一次都不该被工具开关触发（改回旧写法时这里会红）。
    expect(sent.filter((message) => message.type === 'UPDATE_MCP_SERVER')).toHaveLength(0);
  });
});

describe('McpPage selected server survives a reload', () => {
  /**
   * ⚠️⚠️ 守的是「切服务后详情弹回去」：选中项原先只有 `load()` 内部回填 ref，
   * 而所有外部改选中项的地方只调 React setter ⇒ 下一次 `load()` 读到旧 ref、
   * 且旧服务仍在列表里 ⇒ 详情面板跳回上一个服务。
   *
   * 判据是**页面上真的显示了谁**，不是「ref 有没有赋值」—— 后者是同义反复。
   */
  it('keeps the newly selected server after MCP_SERVERS_UPDATED reloads the page', async () => {
    await renderMcpPage();
    // 初始选中第一个服务（`load()` 的初始选中），详情里是它的工具。
    expect(container.textContent).toContain('alpha_tool');

    await click(serverCard('Second MCP'));
    expect(container.textContent).toContain('gamma_tool');

    // 后台广播回来 ⇒ 整页 `load()`。这里正是原先弹回去的那一步。
    await act(async () => {
      runtimeListener?.({ type: 'MCP_SERVERS_UPDATED' });
    });
    await settle();

    expect(container.textContent).toContain('gamma_tool');
    expect(container.textContent).not.toContain('alpha_tool');
  });
});

async function renderMcpPage() {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(McpPage));
  });
  await settle();
}

/**
 * 某条工具卡片里的开关按钮。
 *
 * ⚠️⚠️ **两条都会让人拿错按钮**（第一版各撞一次，都是假红）：
 * ① 不能笼统取 `button[aria-pressed]` —— 详情里还有「执行策略」那个 ToggleRow；
 * ② 工具卡片里**有两个** `aria-pressed`：左边是「置顶」，右边 `.ds-switch` 才是开关。
 * 按「卡片正文含该工具名」+ `.ds-switch` 定位。
 */
function toolToggleButton(toolName: string): HTMLButtonElement {
  const card = Array.from(container.querySelectorAll('.ds-card'))
    .find((node) => node.textContent?.includes(toolName));
  expect(card, `找不到 ${toolName} 的卡片`).toBeTruthy();
  const toggle = card?.querySelector<HTMLButtonElement>('button.ds-switch');
  expect(toggle, `找不到 ${toolName} 的开关`).toBeTruthy();
  return toggle as HTMLButtonElement;
}

/**
 * 某个服务的行卡片（点它切换选中）。
 *
 * ⚠️ 按**卡片正文里含服务名**定位，不能按 `.ds-card` 的下标 —— 页头还有「自适应 Prompt
 * 预算」那张卡，下标会整体偏移一位。
 */
function serverCard(displayName: string): HTMLElement {
  const card = Array.from(container.querySelectorAll<HTMLElement>('.ds-card'))
    .find((node) => node.textContent?.includes(displayName));
  expect(card, `找不到 ${displayName} 的服务行`).toBeTruthy();
  return card as HTMLElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const now = 1_718_000_000_000;

const platformEnvironment = {
  kind: 'browser_extension',
  name: 'WebExtension',
  capabilities: { nativeMessaging: true },
};

const capabilitySettings = {
  version: 1,
  adaptiveMaxDirectTools: 8,
  adaptiveMaxPromptBytes: 24_000,
  servers: {},
};

const server: McpServerConfig = {
  version: 1,
  id: 'server-1',
  displayName: 'Example MCP',
  enabled: true,
  transport: { kind: 'http', url: 'https://example.test/mcp' },
  headers: [],
  secrets: [],
  timeouts: { connectMs: 10_000, requestMs: 60_000, discoveryMs: 20_000 },
  limits: { maxResultBytes: 64_000, maxToolCount: 128 },
  allowlist: { mode: 'all', toolNames: [] },
  execution: { mode: 'auto', enabled: true },
  status: 'ready',
  lastConnectedAt: now,
  lastError: null,
  createdAt: now,
  updatedAt: now,
};

function listedTool(name: string): ToolDescriptor {
  return {
    id: createMcpDescriptorId(server.id, name),
    provider: {
      kind: 'mcp',
      id: server.id,
      displayName: server.displayName,
      transport: 'http',
    },
    name,
    invocationName: createMcpInvocationName(server.id, name),
    title: name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
}

const toolCache: McpToolCacheEntry = {
  serverId: server.id,
  descriptors: [listedTool('alpha_tool'), listedTool('beta_tool')],
  refreshedAt: now,
  expiresAt: now + 60_000,
  health: {
    serverId: server.id,
    status: 'ready',
    checkedAt: now,
    latencyMs: 10,
    toolCount: 2,
    error: null,
  },
};

const secondServer: McpServerConfig = {
  ...server,
  id: 'server-2',
  displayName: 'Second MCP',
};

function secondListedTool(name: string): ToolDescriptor {
  return {
    id: createMcpDescriptorId(secondServer.id, name),
    provider: {
      kind: 'mcp',
      id: secondServer.id,
      displayName: secondServer.displayName,
      transport: 'http',
    },
    name,
    invocationName: createMcpInvocationName(secondServer.id, name),
    title: name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
}

const secondToolCache: McpToolCacheEntry = {
  serverId: secondServer.id,
  descriptors: [secondListedTool('gamma_tool')],
  refreshedAt: now,
  expiresAt: now + 60_000,
  health: {
    serverId: secondServer.id,
    status: 'ready',
    checkedAt: now,
    latencyMs: 10,
    toolCount: 1,
    error: null,
  },
};
