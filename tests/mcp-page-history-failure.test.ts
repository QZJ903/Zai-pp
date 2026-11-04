import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpDescriptorId,
  createMcpInvocationName,
} from '../core/mcp/descriptor-identity';
import type { McpServerConfig, McpToolCacheEntry, ToolCallHistoryRecord } from '../core/types';
import McpPage from '../entrypoints/sidepanel/pages/McpPage';

/**
 * MCP 页「最近调用」区块的**失败语义**：这一轮历史读取失败，只能降级成一条
 * 错误横幅，**不能把上一次已确认的记录清空**。
 *
 * 守的是 `useMcpPageController.load()` 的 catch 分支 —— 它只
 * `showBanner('error', ...)`，完全不碰 `servers` / `history` 等 state。一旦有人
 * 「顺手」在失败分支里把 state 归零（例如为了收口 loading 而先清空列表），用户会
 * 看到已确认的记录凭空消失，而真实故障只是「这一次读失败」。这条断言把那个边界钉死：
 * 失败横幅必须出现，且上一轮的记录必须仍在文档里。
 *
 * 带宽上只覆盖本项目真正会发的命令（`loadMcpSnapshot` 那 5 条），其余命令一律显式
 * 抛错，避免将来新增依赖时被静默的空响应掩盖。
 */

let container: HTMLDivElement;
let root: Root | null;
let historyResponse: unknown;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  // ⚠️ 响应是 `{ records, dropped }` 而不是裸数组（dropped 给内容脚本打页面日志用）。
  historyResponse = { records: [toolHistoryRecord], dropped: 0 };

  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-extension-id',
      // 只有 Shell 预设的安装命令会读 manifest；这里给一份最小形态，
      // 免得将来非 Shell 分支也顺带取用时直接抛。
      getManifest: vi.fn(() => ({ version: '0.0.0' })),
      sendMessage: vi.fn(async (message: { type?: string }) => {
        if (message.type === 'GET_MCP_SERVERS') return [server];
        if (message.type === 'GET_PLATFORM_CAPABILITIES') return platformEnvironment;
        if (message.type === 'GET_MCP_TOOL_CACHE') return toolCache;
        if (message.type === 'GET_TOOL_CALL_HISTORY') return historyResponse;
        if (message.type === 'GET_MCP_CAPABILITY_SETTINGS') return capabilitySettings;
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
  if (root) {
    act(() => root?.unmount());
  }
  container.remove();
  vi.unstubAllGlobals();
});

describe('McpPage recent call history failures', () => {
  it('shows a history load failure without discarding the last confirmed history', async () => {
    await renderMcpPage();

    const recentCalls = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('最近调用'),
    );
    expect(recentCalls).toBeTruthy();
    await act(async () => {
      recentCalls!.click();
    });
    expect(container.textContent).toContain('history_tool');

    historyResponse = { ok: false, error: 'tool history storage is corrupt' };
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();

    expect(container.textContent).toContain('tool history storage is corrupt');
    expect(container.textContent).toContain('history_tool');
  });
});

async function renderMcpPage() {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(McpPage));
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

const toolCache: McpToolCacheEntry = {
  serverId: server.id,
  descriptors: [],
  refreshedAt: now,
  expiresAt: now + 60_000,
  health: {
    serverId: server.id,
    status: 'ready',
    checkedAt: now,
    latencyMs: 10,
    toolCount: 0,
    error: null,
  },
};

const toolHistoryRecord: ToolCallHistoryRecord = {
  id: 'history-1',
  call: {
    id: 'call-1',
    descriptorId: createMcpDescriptorId(server.id, 'history_tool'),
    provider: {
      kind: 'mcp',
      id: server.id,
      displayName: server.displayName,
      transport: 'http',
    },
    name: 'history_tool',
    invocationName: createMcpInvocationName(server.id, 'history_tool'),
    payload: {},
    raw: '<history_tool>{}</history_tool>',
  },
  result: { ok: true, summary: 'history result' },
  source: 'manual_chat',
  createdAt: now,
};
