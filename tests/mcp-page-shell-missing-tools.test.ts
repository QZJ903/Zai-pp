import { describe, expect, it } from 'vitest';
import { translate } from '../core/i18n';
import { SHELL_MCP_NATIVE_HOST, SHELL_MCP_SERVER_NAME, SHELL_TOOL_NAMES } from '../core/shell';
import type { McpServerConfig, McpToolCacheEntry, ToolDescriptor } from '../core/types';
import { missingShellTools, shellSetupMessage } from '../entrypoints/sidepanel/pages/McpPage';

/**
 * MCP 页的 Shell Native Host 提示：**「连上了、但少返回了工具」必须有可见信号。**
 *
 * 这一档以前是**空的** —— `shellSetupMessage` 的全部判据都是 `health.error` /
 * `lastError` / `health.status`，而 host 版本旧导致少发工具时 `status` 是 `ready`、
 * `error` 为空 ⇒ 页面报「已连接，发现 N 个工具」，然后工具列表里就是少几个、
 * **一句话都不解释**。用户只能猜「是不是坏了」。
 *
 * 唯一有这条提示的是工具页那张 Python 卡片（2.15.52 删掉后就没有落点了），
 * 所以搬到这里 —— 且判据从「只是 python_exec」放宽成「应有 − 实有」，
 * 因为缺的可能是任意一个工具。
 *
 * ⚠️ **测的是纯函数、不是页面渲染。** 走渲染要穿过「展开服务行 → ServerDetail →
 * ShellSetupHint」三层，还夹着 `.ds-card` 选择器套娃与默认折叠状态 —— 全是与这条判据
 * 无关的噪音，且实测连撞两次假红（一次点到外层卡片、一次提示落在折叠区里）。
 * 判据本身是纯函数，就直接测纯函数。
 */

describe('shellSetupMessage', () => {
  it('reports exactly which shell tools the host did not return', () => {
    const cache = shellCache(['shell_exec', 'python_exec']);
    const result = shellSetupMessage(shellServer, cache, translateAt('zh-CN'));

    expect(result.isError).toBe(true);
    expect(result.message).toContain('2 个工具没有返回');
    expect(result.message).toContain('shell_exec');
    expect(result.message).toContain('python_exec');
  });

  it('stays quiet when every shell tool is present', () => {
    const result = shellSetupMessage(shellServer, shellCache([]), translateAt('zh-CN'));

    expect(result.isError).toBe(false);
    expect(result.message).toContain(`已连接，发现 ${SHELL_TOOL_NAMES.length} 个工具`);
    expect(result.message).not.toContain('个工具没有返回');
  });

  it('keeps the transport-error branches ahead of the missing-tool check', () => {
    // ⚠️ 顺序是承重的：host 根本没装上时 `descriptors` 一定是空的，
    // 若缺失检查排在前面，用户会看到「12 个工具没有返回」而不是「未找到 Native Host」。
    const cache = shellCache(SHELL_TOOL_NAMES);
    cache.health.status = 'error';
    cache.health.error = 'native messaging host not found';

    const result = shellSetupMessage(shellServer, cache, translateAt('zh-CN'));
    expect(result.message).toContain('未找到 Native Host');
    expect(result.message).not.toContain('个工具没有返回');
  });

  it('does not report missing tools when the local tool limit truncated them', () => {
    // ⚠️⚠️ **这条守的是「假报」**：`listMcpTools` 在 allowlist 过滤**之前**就
    // `slice(0, limits.maxToolCount)`，而上限在 MCP 页高级表单里可编辑。
    // 用户把它调到 8 再刷新，工具列表只剩 8 个 —— 若不加判据，页面会报
    // 「4 个工具没有返回……多半是 Native Host 版本旧了，重装并重启浏览器」，
    // 而原因是**用户自己的设置** ⇒ 让人白装一遍。
    //
    // 判据：实有数量**没撞到**上限，才说明是 host 少发。
    const limited: McpServerConfig = { ...shellServer, limits: { ...shellServer.limits, maxToolCount: 8 } };
    const truncated = { ...shellCache([]), descriptors: allShellDescriptors().slice(0, 8) };

    const result = shellSetupMessage(limited, truncated, translateAt('zh-CN'));
    expect(result.isError).toBe(false);
    expect(result.message).not.toContain('个工具没有返回');

    // 反面：同样是 8 个工具，但上限还是 12 ⇒ 那就是 host 真的少发了，必须报。
    const hostShort = shellSetupMessage(shellServer, truncated, translateAt('zh-CN'));
    expect(hostShort.isError).toBe(true);
    expect(hostShort.message).toContain('4 个工具没有返回');
  });
});

describe('missingShellTools', () => {
  it('compares against the full tool list, not the model-facing subset', () => {
    // ⚠️ 用 `EXPOSED_SHELL_TOOL_NAMES` 会**假报缺失**（它剔掉了 `local_skill_preview`），
    // 而 host 侧 `skill-provider.mjs` 确实发布那个工具。
    expect(missingShellTools(allShellDescriptors())).toEqual([]);
    expect([...missingShellTools([])].sort()).toEqual([...SHELL_TOOL_NAMES].sort());
  });
});

function translateAt(locale: 'zh-CN' | 'en') {
  return (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => (
    translate(locale, key, params)
  );
}

/** 造一份 shell 工具缓存，`omit` 里的名字不出现。 */
function shellCache(omit: readonly string[]): McpToolCacheEntry {
  return {
    serverId: shellServer.id,
    descriptors: allShellDescriptors().filter((descriptor) => !omit.includes(descriptor.name)),
    refreshedAt: now,
    expiresAt: now + 60_000,
    health: {
      serverId: shellServer.id,
      status: 'ready',
      checkedAt: now,
      latencyMs: 10,
      toolCount: SHELL_TOOL_NAMES.length - omit.length,
      error: null,
    },
  };
}

function allShellDescriptors(): ToolDescriptor[] {
  return SHELL_TOOL_NAMES.map((name) => ({
    id: `mcp:${shellServer.id}:${name}`,
    provider: {
      kind: 'mcp' as const,
      id: shellServer.id,
      displayName: shellServer.displayName,
      transport: 'native_messaging' as const,
    },
    name,
    invocationName: name,
    title: name,
    description: name,
    inputSchema: { type: 'object' as const, properties: {} },
    execution: { mode: 'auto' as const, enabled: true, risk: 'low' as const },
  }));
}

const now = 1_718_000_000_000;

const shellServer: McpServerConfig = {
  version: 1,
  id: 'server-shell',
  displayName: SHELL_MCP_SERVER_NAME,
  enabled: true,
  transport: { kind: 'native_messaging', nativeHost: SHELL_MCP_NATIVE_HOST },
  headers: [],
  secrets: [],
  timeouts: { connectMs: 5_000, requestMs: 120_000, discoveryMs: 10_000 },
  limits: { maxResultBytes: 128_000, maxToolCount: 12 },
  allowlist: { mode: 'allow', toolNames: [...SHELL_TOOL_NAMES] },
  execution: { mode: 'auto', enabled: true },
  status: 'ready',
  lastConnectedAt: now,
  lastError: null,
  createdAt: now,
  updatedAt: now,
};
describe('missingTools separator', () => {
  it('uses an English separator in the English locale', () => {
    // ⚠️ `missing.join('、')` 会被 i18n 覆盖审计漏掉（`、` 的 Script 是 Common，
    // 不是 Han）⇒ 英文界面会渲染成 `shell_exec、python_exec`。分隔符必须走 i18n。
    const cache = shellCache(['shell_exec', 'python_exec']);
    const result = shellSetupMessage(shellServer, cache, translateAt('en'));
    expect(result.message).toContain('shell_exec, python_exec');
    expect(result.message).not.toContain('、');
  });
});
