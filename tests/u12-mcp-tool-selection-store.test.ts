import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpServer,
  getMcpServerById,
  nextAllowlistForTool,
  setMcpToolSelection,
} from '../core/mcp/store';
import type { McpServerCreateInput, McpToolAllowlist } from '../core/mcp/types';

/**
 * `setMcpToolSelection`：**读-改-写必须在存储事务内完成**。
 *
 * ⚠️⚠️ 守的是那个静默缺陷的另一半：界面已经改成「一次只改一个工具」，但如果后台
 * 仍然要调用方先算出整份名单，连点两个开关时第二次基于旧快照算，照样会覆盖第一次。
 * 这里直接打后台那一层：**不传基线名单，只传「哪个工具、开还是关」**。
 */

let storage: Record<string, unknown>;

beforeEach(() => {
  storage = {};
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'fixture-id') });
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => Object.prototype.hasOwnProperty.call(storage, key)
          ? { [key]: storage[key] }
          : {}),
        set: vi.fn(async (values: Record<string, unknown>) => {
          storage = { ...storage, ...values };
        }),
        remove: vi.fn(),
      },
    },
    permissions: { contains: vi.fn(), request: vi.fn() },
    runtime: { connectNative: vi.fn() },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const input: McpServerCreateInput = {
  displayName: 'Example MCP',
  enabled: true,
  transport: { kind: 'http', url: 'https://example.test/mcp' },
};

const toolA = { name: 'alpha_tool', invocationName: 'mcp_server-1_alpha_tool' };
const toolB = { name: 'beta_tool', invocationName: 'mcp_server-1_beta_tool' };

describe('setMcpToolSelection', () => {
  it('applies both edits when two tools are toggled back to back', async () => {
    const created = await createMcpServer(input);

    // ⚠️ 默认是 `all` 档 ⇒ 两个工具都**已选中**，所以这里两次都是「关掉」——
    // 在 `all` 档下传 `selected: true` 是 no-op（本来就选中），拿它测覆盖会假绿。
    // ⚠️ **第二次调用不读第一次的返回值** —— 这正是界面那边「快照还没更新」的形状。
    await setMcpToolSelection(created.id, toolA, false);
    await setMcpToolSelection(created.id, toolB, false);

    const server = await getMcpServerById(created.id);
    expect(server?.allowlist).toEqual({
      mode: 'deny',
      // 两个都关掉 ⇒ `deny` 名单里两条都在；先读后改意味着第一次不会被第二次覆盖。
      toolNames: ['alpha_tool', 'beta_tool'],
    });
  });

  it('stores only the tool name, never the invocation name', async () => {
    const created = await createMcpServer(input);
    await setMcpToolSelection(created.id, toolA, false);

    const server = await getMcpServerById(created.id);
    expect(server?.allowlist.toolNames).toEqual(['alpha_tool']);
    expect(server?.allowlist.toolNames).not.toContain('mcp_server-1_alpha_tool');
  });

  it('keeps both edits when the two toggles are issued concurrently', async () => {
    const created = await createMcpServer(input);

    // ⚠️⚠️ **这条守的是「读状态在存储事务之内」**。串行 await 两条抓不到它 ——
    // 第二次调用开始时第一次已经写完。并发才暴露：读若排在事务外，两次都拿到同一份
    // 旧 state，后写把前写覆盖掉（那正是界面连点两个开关时的真实形状）。
    await Promise.all([
      setMcpToolSelection(created.id, toolA, false),
      setMcpToolSelection(created.id, toolB, false),
    ]);

    const server = await getMcpServerById(created.id);
    expect(server?.allowlist).toEqual({
      mode: 'deny',
      toolNames: ['alpha_tool', 'beta_tool'],
    });
  });

  it('returns null for an unknown server instead of throwing', async () => {
    await createMcpServer(input);
    await expect(setMcpToolSelection('missing-server', toolA, true)).resolves.toBeNull();
  });
});

describe('nextAllowlistForTool', () => {
  const base: McpToolAllowlist = { mode: 'all', toolNames: [] };

  it('turning one tool off downgrades "all" to a deny list holding just that tool', () => {
    expect(nextAllowlistForTool(base, toolA, false)).toEqual({
      mode: 'deny',
      toolNames: ['alpha_tool'],
    });
  });

  it('re-enabling the last denied tool collapses back to "all"', () => {
    const denied: McpToolAllowlist = { mode: 'deny', toolNames: ['alpha_tool'] };
    expect(nextAllowlistForTool(denied, toolA, true)).toEqual({ mode: 'all', toolNames: [] });
  });

  it('keeps an allow list pointing at the tool name under "allow" mode', () => {
    const allow: McpToolAllowlist = { mode: 'allow', toolNames: [] };
    expect(nextAllowlistForTool(allow, toolA, true)).toEqual({
      mode: 'allow',
      toolNames: ['alpha_tool'],
    });
  });
});
