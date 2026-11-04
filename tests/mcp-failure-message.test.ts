// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { describeMcpFailure } from '../entrypoints/sidepanel/pages/McpPage';
import { createTranslator } from '../core/i18n';
import type { McpServerConfig, McpToolCacheEntry } from '../core/mcp/types';

/**
 * **第三方 MCP 服务的错误条必须是人话。**
 *
 * ⚠️⚠️ 守的是一个真缺陷：`health.error` / `lastError` 里装的是**上一次发现的原始异常
 * message**（`MCP server returned HTTP 401.` / `Cannot reach MCP server at …` /
 * `MCP response exceeded 64000 bytes…`），而错误条一直原样渲染它。Shell 那一栏有
 * `shellSetupMessage` 做码到人话的映射，**其余服务没有** —— 用户看到一句英文，
 * 既不知道是自己哪一项配置的问题，也不知道该去哪儿改。
 */

const t = createTranslator('zh-CN').t as never;

function server(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    version: 1,
    id: 'remote',
    displayName: 'Remote',
    enabled: true,
    transport: { kind: 'streamable_http', url: 'https://remote.test/mcp' },
    headers: [],
    secrets: [],
    timeouts: { connectMs: 10_000, requestMs: 60_000, discoveryMs: 20_000 },
    limits: { maxResultBytes: 64_000, maxToolCount: 128 },
    allowlist: { mode: 'all', toolNames: [] },
    execution: { mode: 'auto', enabled: true },
    status: 'error',
    lastConnectedAt: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function cacheWith(error: string | null): McpToolCacheEntry {
  return {
    serverId: 'remote',
    descriptors: [],
    refreshedAt: 1,
    expiresAt: 2,
    health: { serverId: 'remote', status: error ? 'error' : 'ready', checkedAt: 1, latencyMs: null, toolCount: 0, error },
  };
}

describe('describeMcpFailure', () => {
  it('returns null when there is nothing to report', () => {
    expect(describeMcpFailure(server(), cacheWith(null), t)).toBeNull();
    expect(describeMcpFailure(server(), null, t)).toBeNull();
  });

  it('maps an auth rejection to an actionable sentence', () => {
    const message = describeMcpFailure(server(), cacheWith('MCP server returned HTTP 401.'), t)!;
    expect(message).toContain('401');
    expect(message, '要告诉用户去哪儿看').toMatch(/密钥|请求头/);
  });

  it('maps a connection failure', () => {
    const message = describeMcpFailure(server(), cacheWith('Cannot reach MCP server at https://remote.test/mcp. Start the local provider, verify the URL, then retry.'), t)!;
    expect(message).toMatch(/地址|端口|运行/);
  });

  it('maps the response-size limit and points at the setting to change', () => {
    const message = describeMcpFailure(server(), cacheWith('MCP response exceeded 64000 bytes before parsing completed.'), t)!;
    expect(message).toMatch(/结果字节/);
  });

  it('maps a protocol version mismatch', () => {
    const message = describeMcpFailure(
      server(),
      cacheWith('MCP protocol version mismatch: the server advertises "2025-11-25", but this extension requested 2025-06-18 and supports 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25.'),
      t,
    )!;
    expect(message).toMatch(/协议版本/);
  });

  it('falls back to the raw message instead of swallowing it', () => {
    // ⚠️ 映射不到的必须原样带出 —— 丢掉详情比显示英文更糟。
    const message = describeMcpFailure(server(), cacheWith('something nobody mapped'), t)!;
    expect(message).toContain('something nobody mapped');
  });

  it('reads lastError when the cache has no health error', () => {
    const message = describeMcpFailure(server({ lastError: 'MCP server returned HTTP 403.' }), null, t)!;
    expect(message).toContain('403');
  });

  /**
   * ⚠️⚠️ **两条判据都只能按 message 的措辞判，因为 code 不在 message 里。**
   *
   * `McpTransportError` / `McpProtocolError` 都是 `super(message)` —— 构造时的第一参
   * （`mcp_origin_permission_denied` 这种码）**不会进 message**。而这里拿到的是
   * `health.error`（= `providerError.message`）。早期版本写的那几个
   * `lower.includes('mcp_xxx')` 分支因此全是死判据。
   */
  it('maps a host-permission denial from its message wording, not its code', () => {
    // 原文来自 `common.ts` 的 `mcp_origin_permission_denied`：message 里**没有 code**。
    const message = describeMcpFailure(
      server(),
      cacheWith('Host permission was not granted for https://remote.test/*.'),
      t,
    )!;
    expect(message, '按 code 判的那一版在这里会落到 fallback 显示英文').toMatch(/授权/);
  });

  it('maps the three host-permission failure wordings', () => {
    // `_check_unavailable` 与 `_check_failed` 也是同一档，措辞不同。
    for (const raw of [
      'Host permission cannot be verified for https://remote.test.',
      'Host permission could not be verified for https://remote.test: boom',
    ]) {
      expect(describeMcpFailure(server(), cacheWith(raw), t)!, raw).toMatch(/授权/);
    }
  });

  /**
   * ⚠️⚠️ **`not found` 不能裸判。**
   *
   * `health.error` 可能是**服务端原文** —— `unwrapMcpResponse` 对 JSON-RPC error 直接
   * `throw new McpProtocolError(code, response.error.message)`，第三方服务写什么都行。
   * 裸判 `not found` 会把「工具不存在」翻成「未找到 Native Host，请先运行安装命令」，
   * 而用户实际遇到的问题跟 host 毫无关系。
   */
  it('does not mistake a server-authored "not found" for a missing native host', () => {
    for (const raw of [
      'tool "read_file" not found',
      'MCP response body is missing required field: result not found',
      'skill package not found',
    ]) {
      const message = describeMcpFailure(server(), cacheWith(raw), t)!;
      expect(message, `${raw} 不该被翻成「未找到 Native Host」`).not.toMatch(/Native Host/);
      expect(message, `${raw} 应原样回落，保住详情`).toContain(raw);
    }
  });

  it('still maps the real native-host wordings', () => {
    // 四句覆盖 native 侧的四种失败（见 `native.ts` 与 `chrome.runtime.lastError`）。
    for (const raw of [
      'Specified native messaging host not found.',
      'Native messaging host is not configured.',
      'Browser native messaging is unavailable.',
      'Native host disconnected.',
    ]) {
      expect(describeMcpFailure(server(), cacheWith(raw), t)!, raw).toMatch(/Native Host/);
    }
  });
});
