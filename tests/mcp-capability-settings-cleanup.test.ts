import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MCP_CAPABILITY_SETTINGS_STORAGE_KEY,
  deleteMcpCapabilityServerSettings,
  getMcpCapabilitySettings,
  setMcpCapabilityServerExposure,
} from '../core/mcp/capability-settings';

/**
 * **删服务时，它在另一个键里的暴露设置也要删掉。**
 *
 * ⚠️⚠️ 守的是一个「成对动作缺一半」的缺陷：`DELETE_MCP_SERVER` 只清 `servers` 与
 * `toolCaches`，而 `mode` / `pinnedDescriptorIds` 存在 `zai_pp_mcp_capability_settings`
 * 里 —— 那一格会随删除次数单调增长。它读不到、也不报错，所以永远不会被发现。
 */

let storage: Record<string, unknown>;

beforeEach(() => {
  storage = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (Object.hasOwn(storage, key) ? { [key]: storage[key] } : {})),
        set: vi.fn(async (values: Record<string, unknown>) => {
          storage = { ...storage, ...values };
        }),
      },
    },
  });
});

describe('deleteMcpCapabilityServerSettings', () => {
  it('drops exactly the deleted server and keeps the rest', async () => {
    await setMcpCapabilityServerExposure({ serverId: 'keep-me', mode: 'adaptive', pinnedDescriptorIds: ['mcp:keep-me:a'] });
    await setMcpCapabilityServerExposure({ serverId: 'doomed', mode: 'on_demand' });

    const next = await deleteMcpCapabilityServerSettings('doomed');
    expect(Object.keys(next.servers)).toEqual(['keep-me']);
    expect(next.servers['keep-me']?.mode).toBe('adaptive');

    // 落盘的也必须是删过的那份。
    const stored = await getMcpCapabilitySettings();
    expect(Object.keys(stored.servers)).toEqual(['keep-me']);
  });

  it('is idempotent for an unknown server and does not write', async () => {
    await setMcpCapabilityServerExposure({ serverId: 'keep-me', mode: 'direct' });
    const writesBefore = (chrome.storage.local.set as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    const next = await deleteMcpCapabilityServerSettings('never-existed');
    expect(Object.keys(next.servers)).toEqual(['keep-me']);
    expect((chrome.storage.local.set as unknown as { mock: { calls: unknown[] } }).mock.calls.length, '不存在的键不该触发写盘')
      .toBe(writesBefore);
    expect(storage[MCP_CAPABILITY_SETTINGS_STORAGE_KEY]).toBeDefined();
  });
});
