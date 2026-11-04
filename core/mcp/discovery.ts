import type { ToolCall, ToolDescriptor, ToolResult } from '../tool/types';
import { haveEquivalentToolDescriptorSecurity } from '../tool/authorization';
import { applyMcpToolPolicy, callMcpTool, initializeMcpServer, listMcpTools } from './client';
import {
  getAllMcpServers,
  getAllMcpToolCaches,
  getMcpServerById,
  getMcpToolCache,
  saveMcpDiscoveryResult,
} from './store';
import { createMcpTransport } from './transports';
import type {
  McpServerConfig,
  McpServerHealth,
  McpServerId,
  McpToolCacheEntry,
} from './types';

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

/**
 * 传输层超时相对外层运行时超时的**提前量**。
 *
 * ⚠️⚠️ **必须让内层先到期，否则 MCP 自己的错误码永远拿不到。**
 *
 * `core/tool/runtime.ts` 的 `executeWithTimeout` 在 `providerRegistry.execute(...)`
 * **之前**就建了一个 `AbortScope`，时长取自描述符的 `execution.timeoutMs`；而 MCP 那条链
 * 在 `transports/common.ts` 的 `fetchWithTimeout` 里**又建一个**，时长也是同一个值
 * （描述符的 `execution.timeoutMs` 就是 `server.timeouts.requestMs`，见 `client.ts`）。
 * 同值定时器先建者先到期 ⇒ 外层赢。
 *
 * 而 `common.ts` 的 catch **第一个分支就是** `if (callerSignal?.aborted) throwSignalReason(callerSignal)`
 * ⇒ 外层先 abort 时，内层根本走不到 `mcp_transport_timeout` 那一支，
 * `McpTransportError('mcp_transport_timeout')` 的 `retryable: true` 也一起丢掉
 * （外层结果是 `tool_execution_timeout` + `retryable: false`）。
 * 同一类「服务端超时」在直连链与工具链上给出不同错误码与重试建议。
 *
 * ⇒ 这里把传给传输层的时长减一档，让内层先到期、保住它自己的语义。
 * 外层退回它本来的职责：兜住**根本不看 signal** 的 provider。
 *
 * 取 500ms：够盖住调度抖动，又短到不影响任何工具的实际可用时间。
 * 下限 1000ms 是防止「描述符声明了很小的超时（< 1500ms）」时减成负数或贴地。
 */
const MCP_TRANSPORT_TIMEOUT_BUFFER_MS = 500;
const MCP_TRANSPORT_TIMEOUT_FLOOR_MS = 1_000;

/**
 * 外层给了 `budgetMs` 之后，传输层该拿多少。
 *
 * ⚠️ **抽成具名函数是为了可测** —— 内联在 `executeMcpToolCall` 里的话，那条
 * 「内层必须早于外层到期」的判据没有任何行为入口（真跑一遍就是几百毫秒的计时断言，
 * 又慢又不稳）。这里能直接喂边界值。
 */
export function resolveMcpTransportTimeoutMs(budgetMs: number): number {
  return Math.max(
    MCP_TRANSPORT_TIMEOUT_FLOOR_MS,
    budgetMs - MCP_TRANSPORT_TIMEOUT_BUFFER_MS,
  );
}
const discoveryTails = new Map<McpServerId, Promise<void>>();

export async function refreshMcpServerDiscovery(
  serverId: McpServerId,
  options?: { cacheTtlMs?: number; signal?: AbortSignal },
): Promise<McpToolCacheEntry> {
  const previous = discoveryTails.get(serverId) ?? Promise.resolve();
  const operation = previous.then(
    () => discoverServerToolsById(serverId, options),
    () => discoverServerToolsById(serverId, options),
  );
  const tail = operation.then(() => undefined, () => undefined);
  discoveryTails.set(serverId, tail);
  return operation.finally(() => {
    if (discoveryTails.get(serverId) === tail) discoveryTails.delete(serverId);
  });
}

async function discoverServerToolsById(
  serverId: McpServerId,
  options?: { cacheTtlMs?: number; signal?: AbortSignal },
): Promise<McpToolCacheEntry> {
  throwIfMcpExecutionAborted(options?.signal);
  const server = await getMcpServerById(serverId, { includeSecrets: true });
  if (!server) throw new Error(`MCP server not found: ${serverId}`);
  return discoverServerTools(server, options);
}

export async function getMcpToolDescriptors(options?: {
  includeDisabled?: boolean;
  maxAgeMs?: number;
}): Promise<ToolDescriptor[]> {
  const [servers, caches] = await Promise.all([
    getAllMcpServers({ includeSecrets: false }),
    getAllMcpToolCaches(),
  ]);
  const now = Date.now();
  const serverMap = new Map(servers.map((server) => [server.id, server]));
  const descriptors: ToolDescriptor[] = [];

  for (const cache of caches) {
    const server = serverMap.get(cache.serverId);
    if (!server) continue;
    if (!options?.includeDisabled && !server.enabled) continue;
    if (options?.maxAgeMs != null && now - cache.refreshedAt > options.maxAgeMs) continue;
    // Expired descriptors are still useful for prompt injection; execution refreshes stale discovery before calling.
    const policyDescriptors = applyMcpToolPolicy(cache.descriptors, server);
    descriptors.push(
      ...policyDescriptors.filter((descriptor) =>
        options?.includeDisabled ||
        (descriptor.execution.enabled && descriptor.execution.mode !== 'disabled'),
      ),
    );
  }

  return descriptors;
}

export async function ensureMcpServerDiscovery(
  serverId: McpServerId,
  options?: { maxAgeMs?: number; cacheTtlMs?: number; signal?: AbortSignal },
): Promise<McpToolCacheEntry> {
  const cache = await getMcpToolCache(serverId);
  const now = Date.now();
  if (
    cache &&
    cache.expiresAt > now &&
    (options?.maxAgeMs == null || now - cache.refreshedAt <= options.maxAgeMs)
  ) {
    return cache;
  }
  return refreshMcpServerDiscovery(serverId, options);
}

export interface McpToolExecutionOptions {
  timeoutMs?: number;
  maxResultBytes?: number;
  signal?: AbortSignal;
}

export async function executeMcpToolCall(
  call: ToolCall,
  authorizedDescriptor: ToolDescriptor,
  options: McpToolExecutionOptions = {},
): Promise<ToolResult> {
  const serverId = authorizedDescriptor.provider.kind === 'mcp'
    ? authorizedDescriptor.provider.id
    : null;
  if (!serverId) {
    return {
      ok: false,
      summary: 'MCP 服务缺失',
      detail: 'Tool call does not include an MCP server id.',
      name: call.name,
      error: {
        code: 'mcp_server_id_missing',
        message: 'Tool call does not include an MCP server id.',
        retryable: false,
      },
    };
  }

  const server = await getMcpServerById(serverId, { includeSecrets: true });
  if (!server || !server.enabled) {
    return {
      ok: false,
      summary: 'MCP 服务不可用',
      detail: server ? 'MCP server is disabled.' : `MCP server not found: ${serverId}`,
      name: call.name,
      error: {
        code: server ? 'mcp_server_disabled' : 'mcp_server_not_found',
        message: server ? 'MCP server is disabled.' : `MCP server not found: ${serverId}`,
        retryable: false,
      },
    };
  }
  if (!server.execution.enabled || server.execution.mode === 'disabled') {
    return {
      ok: false,
      summary: 'MCP 工具执行已禁用',
      detail: `MCP execution is disabled on server ${server.displayName}.`,
      name: call.name,
      provider: call.provider,
      descriptorId: call.descriptorId,
      error: {
        code: 'mcp_execution_disabled',
        message: `MCP execution is disabled on server ${server.displayName}.`,
        retryable: false,
      },
    };
  }

  const cache = await ensureMcpServerDiscovery(server.id, { signal: options.signal });
  const descriptors = applyMcpToolPolicy(cache.descriptors, server);
  const descriptor = descriptors.find((item) => item.id === authorizedDescriptor.id);
  if (!descriptor) {
    return {
      ok: false,
      summary: 'MCP 工具不可用',
      detail: `MCP tool is not available on server ${server.displayName}.`,
      name: call.name,
      provider: call.provider,
      descriptorId: call.descriptorId,
      error: {
        code: 'mcp_tool_not_found',
        message: `MCP tool is not available on server ${server.displayName}.`,
        retryable: true,
      },
    };
  }
  if (!descriptor.execution.enabled || descriptor.execution.mode === 'disabled') {
    return {
      ok: false,
      summary: 'MCP 工具已禁用',
      detail: `MCP tool ${descriptor.name} is disabled by server policy.`,
      name: descriptor.name,
      provider: descriptor.provider,
      descriptorId: descriptor.id,
      error: {
        code: 'mcp_tool_disabled',
        message: `MCP tool ${descriptor.name} is disabled by server policy.`,
        retryable: false,
      },
    };
  }
  if (!await haveEquivalentToolDescriptorSecurity(authorizedDescriptor, descriptor)) {
    return {
      ok: false,
      summary: 'MCP 工具授权已过期',
      detail: `MCP tool ${authorizedDescriptor.name} changed after it was authorized.`,
      name: authorizedDescriptor.name,
      provider: authorizedDescriptor.provider,
      descriptorId: authorizedDescriptor.id,
      error: {
        code: 'mcp_tool_authorization_stale',
        message: `MCP tool ${authorizedDescriptor.name} changed after it was authorized.`,
        retryable: false,
      },
    };
  }
  const startedAt = Date.now();
  // ⚠️ **这个值原样提交给外层运行时，传输层拿到的是它减去缓冲后的那一档**
  // （理由见 `MCP_TRANSPORT_TIMEOUT_BUFFER_MS` 的注释）。
  const budgetMs = options.timeoutMs ?? descriptor?.execution.timeoutMs ?? server.timeouts.requestMs;
  const transportTimeoutMs = resolveMcpTransportTimeoutMs(budgetMs);
  try {
    const transport = createMcpTransport(server);
    await initializeMcpServer(server, transport, { signal: options.signal });
    return callMcpTool(server, transport, {
      call: {
        ...call,
        descriptorId: descriptor?.id ?? call.descriptorId,
        provider: descriptor?.provider ?? call.provider,
      },
      descriptor,
      timeoutMs: transportTimeoutMs,
      maxResultBytes: options.maxResultBytes ?? descriptor?.execution.maxResultBytes ?? server.limits.maxResultBytes,
      signal: options.signal,
    });
  } catch (err) {
    throwIfMcpExecutionAborted(options.signal);
    const completedAt = Date.now();
    const message = err instanceof Error ? err.message : String(err);
    const error = err && typeof err === 'object'
      ? err as { code?: unknown; retryable?: unknown; details?: unknown }
      : {};
    return {
      ok: false,
      summary: 'MCP 服务初始化失败',
      detail: message,
      name: descriptor.name,
      provider: descriptor.provider,
      descriptorId: descriptor.id,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      error: {
        code: typeof error.code === 'string' ? error.code : 'mcp_initialize_failed',
        message,
        retryable: typeof error.retryable === 'boolean' ? error.retryable : true,
        details: error.details && typeof error.details === 'object'
          ? error.details as Record<string, unknown>
          : undefined,
      },
    };
  }
}

async function discoverServerTools(
  server: McpServerConfig,
  options?: { cacheTtlMs?: number; signal?: AbortSignal },
): Promise<McpToolCacheEntry> {
  const startedAt = Date.now();
  let descriptors: ToolDescriptor[];
  try {
    const transport = createMcpTransport(server);
    await initializeMcpServer(server, transport, { signal: options?.signal });
    descriptors = await listMcpTools(server, transport, { signal: options?.signal });
    throwIfMcpExecutionAborted(options?.signal);
  } catch (err) {
    throwIfMcpExecutionAborted(options?.signal);
    return persistMcpDiscoveryFailure(server, startedAt, err, options);
  }

  const completedAt = Date.now();
  const health: McpServerHealth = {
    serverId: server.id,
    status: 'ready',
    checkedAt: completedAt,
    latencyMs: completedAt - startedAt,
    toolCount: descriptors.length,
    error: null,
  };
  const entry: McpToolCacheEntry = {
    serverId: server.id,
    descriptors,
    refreshedAt: completedAt,
    expiresAt: completedAt + (options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS),
    health,
  };
  await saveMcpDiscoveryResult(entry, server);
  return entry;
}

async function persistMcpDiscoveryFailure(
  server: McpServerConfig,
  startedAt: number,
  providerError: unknown,
  options?: { cacheTtlMs?: number; signal?: AbortSignal },
): Promise<McpToolCacheEntry> {
  const completedAt = Date.now();
  const message = providerError instanceof Error ? providerError.message : String(providerError);
  /**
   * ⚠️⚠️ **只存 `message`、不存 `code` —— 这是错误条唯一的输入，别改成只存 code。**
   *
   * `health.error` 会被两处消费：
   * ① `saveMcpDiscoveryResult` 把它抄进 `server.lastError`；
   * ② 侧边栏的 `describeMcpFailure` / `shellSetupMessage` 拿它翻人话。
   *
   * 而那两处**只能按 message 的措辞判** —— `McpTransportError` / `McpProtocolError` 都是
   * `super(message)`，构造时的 code **不在 message 里**。所以「按 `mcp_xxx` 码匹配」
   * 在消费侧永远落空（曾经真的这么写过，`permissionDenied` 那一档整条落到 fallback 显示英文）。
   *
   * ⇒ **想结构化报错，得把 code 也带上**（改类型 + 两个消费者），不能单方面把这里改成只存 code。
   */
  const previousCache = await getMcpToolCache(server.id);
  throwIfMcpExecutionAborted(options?.signal);
  const descriptors = previousCache?.descriptors ?? [];
  const health: McpServerHealth = {
    serverId: server.id,
    status: 'error',
    checkedAt: completedAt,
    latencyMs: completedAt - startedAt,
    toolCount: descriptors.length,
    error: message,
  };
  const entry: McpToolCacheEntry = {
    serverId: server.id,
    descriptors,
    refreshedAt: previousCache?.refreshedAt ?? completedAt,
    expiresAt: previousCache?.expiresAt
      ?? completedAt + Math.min(options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, 30_000),
    health,
  };
  await saveMcpDiscoveryResult(entry, server);
  return entry;
}

function throwIfMcpExecutionAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('MCP execution was aborted.', 'AbortError');
}
