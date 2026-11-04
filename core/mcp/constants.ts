import type { McpServerResultLimits, McpServerTimeouts } from './types';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

// MCP servers negotiate the version they actually implement during initialize.
// Keep released historical versions explicit so an older server does not get
// turned into an empty discovery cache, while unknown/future versions remain
// fail-closed in the client.
//
// ⚠️ **`MCP_PROTOCOL_VERSION`（请求版本）与这份清单是两件事**：请求仍发
// `MCP_PROTOCOL_VERSION`，清单回答的是「服务端回哪个版本我们还能继续用」。
// 协商结果全仓只有一个消费者 —— `transports/http.ts` 把它填进 `MCP-Protocol-Version`
// 请求头（规范要求客户端在后续请求里带上协商版本），没有任何代码按版本走不同逻辑。
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  '2024-11-05',
  '2025-03-26',
  MCP_PROTOCOL_VERSION,
  '2025-11-25',
] as const;

/**
 * Hard page cap for `tools/list` pagination.
 *
 * A server that keeps answering with a fresh cursor and no tools never satisfies the
 * "cursor empty or tool cap reached" exit condition, so the loop needs its own bound.
 * 64 pages is far above any real server (a 128-tool cap is reached in one or two pages
 * in practice) while still terminating.
 */
export const MAX_DISCOVERY_PAGES = 64;

/**
 * Response-size ceiling for a single `tools/list` page.
 *
 * ⚠️⚠️ **This is deliberately NOT `limits.maxResultBytes`.** That field answers
 * "how large may one tool call's result be", and a `tools/list` page grows with the
 * *number of tools* — an unrelated quantity. Measured: 100 tools with 5 parameters
 * per tool is ~90 KB, 128 tools with 6 parameters is ~155 KB, against a 64 000-byte
 * default. Discovery of any mid-sized server therefore failed outright.
 *
 * 512 KiB keeps a hard ceiling (the point of the byte guard is to stop a runaway
 * server, not to bound a result) with generous headroom over the largest realistic page.
 */
export const MAX_DISCOVERY_RESPONSE_BYTES = 512 * 1024;

export const MCP_DEFAULT_TIMEOUTS: McpServerTimeouts = {
  connectMs: 10_000,
  requestMs: 60_000,
  discoveryMs: 20_000,
};

export const MCP_DEFAULT_LIMITS: McpServerResultLimits = {
  maxResultBytes: 64_000,
  maxToolCount: 128,
};
