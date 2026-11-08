import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpDescriptorId, createMcpInvocationName } from '../core/mcp/descriptor-identity';
import type { McpServerConfig, McpToolCacheEntry, ToolDescriptor } from '../core/types';
import McpPage from '../entrypoints/sidepanel/pages/McpPage';

/**
 * **「连接成功，N 个工具」里的 N 必须是用户能在列表里数出来的那个数。**
 *
 * ⚠️⚠️ 守的是一个**只在内部工具存在时才会显形**的口径分裂：`health.toolCount` 是
 * host 发布的总数（12，含只由扩展自己调用的 `local_skill_preview`），而页面列表与
 * 服务行都过 `visibleMcpTools` 剔掉了它（11）。横幅原先直接报 `health.toolCount`
 * ⇒ 用户看到「连接成功，12 个工具」，往下数列表只有 11 条，**以为少了一个**。
 *
 * ⚠️ 判据是**横幅文案里的数字**，不是「有没有调 `visibleMcpTools`」—— 后者是源码
 * 断言，拦不住「调了但没用结果」这类变异。
 *
 * ⚠️ 同一事实的另两处（页头汇总 / 服务行 `activeTools`）本来就对；这条只补横幅那一处
 * 漏网的，同时把三者的口径钉在一起。
 */

const INTERNAL_TOOL = 'local_skill_preview';
const USER_VISIBLE_TOOLS = ['shell_exec', 'python_exec'];

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;

  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-extension-id',
      getManifest: vi.fn(() => ({ version: '0.0.0' })),
      sendMessage: vi.fn(async (message: { type?: string; payload?: unknown }) => {
        if (message.type === 'GET_MCP_SERVERS') return [shellServer];
        if (message.type === 'GET_PLATFORM_CAPABILITIES') return platformEnvironment;
        if (message.type === 'GET_MCP_TOOL_CACHE') return shellCache;
        // ⚠️ 「刷新工具」走这条 —— 它返回的就是带 `health.toolCount = 3` 的那份缓存。
        if (message.type === 'REFRESH_MCP_SERVER_TOOLS') return shellCache;
        if (message.type === 'GET_MCP_CAPABILITY_SETTINGS') return capabilitySettings;
        if (message.type === 'GET_TOOL_CALL_HISTORY') return { records: [], dropped: 0 };
        if (message.type === 'UPDATE_MCP_SERVER') return { ...shellServer };
        throw new Error(`Unexpected command: ${message.type}`);
      }),
      onMessage: {
        addListener: vi.fn(),
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

describe('McpPage connection banner tool count', () => {
  it('reports the number of tools the user can actually see, not the host total', async () => {
    await renderMcpPage();

    await click(buttonByText('刷新工具'));

    const banner = container.textContent ?? '';
    expect(banner, '横幅应当报列表里能数出来的 2 个').toContain('连接成功，2 个工具');
    // 反面：`health.toolCount` 是 3（含内部工具），报它就会说出这句。
    expect(banner, '不能报 host 发布的总数（含内部工具）').not.toContain('3 个工具');
  });

  it('keeps the row and page-header counts on the same footing', async () => {
    await renderMcpPage();
    // 服务行：3 个描述符里剔掉 1 个内部工具 ⇒ 2/2。
    // ⚠️ 这两处本来就对，写在这里是为了让「三处同口径」变成一条可执行的事实 ——
    // 任一处的 `visibleMcpTools` 被摘掉，这里会跟着红。
    expect(container.textContent).toContain('2/2');
    // 页头汇总：一个启用服务 × 2 个可见工具。
    expect(container.textContent).toContain('2 个自动工具');
  });
});

async function renderMcpPage() {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(McpPage));
  });
  await settle();
}

/** 按按钮文案定位。按钮里除了文案没有别的可辨别结构。 */
function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find((node) => node.textContent?.trim() === text);
  expect(button, `找不到文案为「${text}」的按钮`).toBeTruthy();
  return button as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

async function settle() {
  for (let index = 0; index < 8; index += 1) {
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

/**
 * ⚠️ 用 `native_messaging` 而不是 http：那条传输**不需要 origin 权限**，
 * 于是「点刷新」不会先弹一个权限请求 —— 那一步在 jsdom 里没有桩、会把用例卡在
 * `hostPermissions.request` 上。
 */
const shellServer: McpServerConfig = {
  version: 1,
  id: 'shell-local',
  displayName: 'Shell Local',
  enabled: true,
  transport: { kind: 'native_messaging', nativeHost: 'com.zai_pp.shell' },
  headers: [],
  secrets: [],
  timeouts: { connectMs: 10_000, requestMs: 120_000, discoveryMs: 20_000 },
  limits: { maxResultBytes: 64_000, maxToolCount: 12 },
  allowlist: { mode: 'all', toolNames: [] },
  execution: { mode: 'auto', enabled: true },
  status: 'ready',
  lastConnectedAt: now,
  lastError: null,
  createdAt: now,
  updatedAt: now,
};

function shellTool(name: string): ToolDescriptor {
  return {
    id: createMcpDescriptorId(shellServer.id, name),
    provider: {
      kind: 'mcp',
      id: shellServer.id,
      displayName: shellServer.displayName,
      transport: 'native_messaging',
    },
    name,
    invocationName: createMcpInvocationName(shellServer.id, name),
    title: name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
}

const shellCache: McpToolCacheEntry = {
  serverId: shellServer.id,
  // 三个描述符：两个用户可见 + 一个扩展内部工具（`EXTENSION_INTERNAL_TOOL_NAMES`）。
  descriptors: [shellTool('shell_exec'), shellTool('python_exec'), shellTool(INTERNAL_TOOL)],
  refreshedAt: now,
  expiresAt: now + 60_000,
  health: {
    serverId: shellServer.id,
    status: 'ready',
    checkedAt: now,
    latencyMs: 2,
    // ⚠️ **host 的事实：3**。页面能数出来的只有 2 —— 这条差异正是本文件要守的东西。
    toolCount: 3,
    error: null,
  },
};