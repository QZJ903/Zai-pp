import type {
  McpHeaderValue,
  McpServerSecretKind,
  McpSecretValue,
  McpServerConfig,
  McpServerCreateInput,
  McpServerId,
  McpServerStatus,
  McpServerStorageState,
  McpServerUpdateInput,
  McpToolAllowlist,
  McpToolCacheEntry,
} from './types';
import { MCP_DEFAULT_LIMITS, MCP_DEFAULT_TIMEOUTS } from './constants';
import { createSerialOperationQueue } from '../persistence/serial-operation-queue';
import {
  encodeMcpStorageState,
  MCP_SERVER_CONFIG_VERSION,
  MCP_STORAGE_KEY,
  migrateMcpStorageState,
  type McpStorageMigration,
} from './storage-codec';

const REDACTED_SECRET_VALUE = '********';
const mcpStorageOperations = createSerialOperationQueue();

export class McpDiscoveryConfigChangedError extends Error {
  readonly code = 'mcp_discovery_config_changed';
  readonly retryable = true;

  constructor(serverId: McpServerId) {
    super(`MCP server configuration changed during discovery: ${serverId}`);
    this.name = 'McpDiscoveryConfigChangedError';
  }
}

/**
 * All server records, newest **configuration change** first.
 *
 * ⚠️ Sorted by `updatedAt`, which is written only by `createMcpServer` / `updateMcpServer`
 * — i.e. by the user. Discovery and health checks deliberately leave it alone (see
 * `applyMcpServerHealthPatch`), so a tool refresh never reshuffles the MCP page's list,
 * and a *failed* connection cannot push a broken server to the top.
 */
export async function getAllMcpServers(options?: { includeSecrets?: boolean }): Promise<McpServerConfig[]> {
  return mcpStorageOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    const servers = [...state.servers].sort((a, b) => b.updatedAt - a.updatedAt);
    return options?.includeSecrets ? servers : servers.map(sanitizeMcpServerConfig);
  });
}

export async function getMcpServerById(
  id: McpServerId,
  options?: { includeSecrets?: boolean },
): Promise<McpServerConfig | null> {
  return mcpStorageOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    const server = state.servers.find((item) => item.id === id) ?? null;
    if (!server) return null;
    return options?.includeSecrets ? server : sanitizeMcpServerConfig(server);
  });
}

export async function createMcpServer(input: McpServerCreateInput): Promise<McpServerConfig> {
  return mcpStorageOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    const now = Date.now();
    const server = normalizeServerForMutation({
      version: MCP_SERVER_CONFIG_VERSION,
      id: crypto.randomUUID(),
      displayName: input.displayName,
      enabled: input.enabled ?? true,
      transport: input.transport,
      headers: input.headers ?? [],
      secrets: input.secrets ?? [],
      timeouts: input.timeouts ?? MCP_DEFAULT_TIMEOUTS,
      limits: input.limits ?? MCP_DEFAULT_LIMITS,
      allowlist: input.allowlist ?? {
        mode: 'all',
        toolNames: [],
      },
      execution: input.execution ?? {
        mode: 'auto',
        enabled: true,
      },
      status: input.enabled === false ? 'disabled' : 'unknown',
      lastConnectedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });

    await writeStateAlreadyOwned({
      ...state,
      servers: [server, ...state.servers.filter((item) => item.id !== server.id)],
    });

    return sanitizeMcpServerConfig(server);
  });
}

export async function updateMcpServer(
  id: McpServerId,
  patch: McpServerUpdateInput,
): Promise<McpServerConfig | null> {
  return mcpStorageOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    let updated: McpServerConfig | null = null;
    const cacheInvalidations = new Set<McpServerId>();
    const servers = state.servers.map((server) => {
      if (server.id !== id) return server;
      const nextPatch: McpServerUpdateInput = patch.secrets
        ? { ...patch, secrets: mergeRedactedSecrets(server.secrets, patch.secrets) }
        : patch;
      const nextServer = normalizeServerForMutation({
        ...server,
        ...nextPatch,
        updatedAt: Date.now(),
        status: resolvePatchedServerStatus(server, nextPatch),
      });
      if (shouldInvalidateMcpToolCache(server, nextServer)) {
        cacheInvalidations.add(server.id);
        updated = {
          ...nextServer,
          status: nextServer.enabled ? 'unknown' : 'disabled',
          lastConnectedAt: null,
          lastError: null,
        };
        return updated;
      }
      updated = nextServer;
      return updated;
    });

    if (!updated) return null;
    await writeStateAlreadyOwned({
      ...state,
      servers,
      toolCaches: cacheInvalidations.size > 0
        ? state.toolCaches.filter((cache) => !cacheInvalidations.has(cache.serverId))
        : state.toolCaches,
    });
    return sanitizeMcpServerConfig(updated);
  });
}

/**
 * 按**单个工具**增删白名单，读-改-写在同一个存储事务里完成。
 *
 * ⚠️⚠️ **为什么必须有这个入口，而不是让侧边栏算好整份名单再 `updateMcpServer`**：
 * 侧边栏算名单时用的是**它手上那份快照**，而快照要等后台广播回来才更新。
 * 用户连着点两个不同工具的开关，第二次算出的名单里没有第一次的改动 ⇒
 * **第一次被整份覆盖掉**（表现：点两个只开了一个，没有任何报错）。
 *
 * ⚠️ `invocationName` 也要一并删 —— 老数据里可能存的是带 server 前缀的那种名字。
 */
export async function setMcpToolSelection(
  id: McpServerId,
  tool: { name: string; invocationName?: string },
  selected: boolean,
): Promise<McpServerConfig | null> {
  return mcpStorageOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    let updated: McpServerConfig | null = null;
    const servers = state.servers.map((server) => {
      if (server.id !== id) return server;
      updated = normalizeServerForMutation({
        ...server,
        allowlist: nextAllowlistForTool(server.allowlist, tool, selected),
        updatedAt: Date.now(),
      });
      return updated;
    });
    if (!updated) return null;
    await writeStateAlreadyOwned({ ...state, servers });
    return sanitizeMcpServerConfig(updated);
  });
}

/**
 * 白名单增删的**唯一实现** —— 侧边栏与后台共用。
 *
 * ⚠️ 三条语义都在这里：`allow` 档点名启用、`deny` 档点名禁用、`all` 档关掉某个时
 * 才降级成 `deny`。任何一处各写一份，用户就会看到「面板勾了、实际没生效」。
 */
export function nextAllowlistForTool(
  allowlist: McpToolAllowlist,
  tool: { name: string; invocationName?: string },
  shouldEnable: boolean,
): McpToolAllowlist {
  const names = new Set(allowlist.toolNames);
  const removeTool = () => {
    names.delete(tool.name);
    if (tool.invocationName) names.delete(tool.invocationName);
  };

  if (allowlist.mode === 'allow') {
    if (shouldEnable) names.add(tool.name);
    else removeTool();
    return { mode: 'allow', toolNames: [...names] };
  }
  if (allowlist.mode === 'deny') {
    if (shouldEnable) removeTool();
    else names.add(tool.name);
    return { mode: names.size === 0 ? 'all' : 'deny', toolNames: [...names] };
  }
  return shouldEnable ? allowlist : { mode: 'deny', toolNames: [tool.name] };
}

/** Records connection health without treating it as a configuration mutation. */
export async function updateMcpServerHealth(
  id: McpServerId,
  patch: Partial<Pick<McpServerConfig, 'status' | 'lastConnectedAt' | 'lastError'>>,
): Promise<McpServerConfig | null> {
  return mcpStorageOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    let updated: McpServerConfig | null = null;
    const servers = state.servers.map((server) => {
      if (server.id !== id) return server;
      updated = applyMcpServerHealthPatch(server, patch);
      return updated;
    });

    if (!updated) return null;
    await writeStateAlreadyOwned({ ...state, servers });
    return sanitizeMcpServerConfig(updated);
  });
}

export async function deleteMcpServer(id: McpServerId): Promise<void> {
  await mcpStorageOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    await writeStateAlreadyOwned({
      ...state,
      servers: state.servers.filter((server) => server.id !== id),
      toolCaches: state.toolCaches.filter((cache) => cache.serverId !== id),
    });
  });
}

export async function getMcpToolCache(serverId: McpServerId): Promise<McpToolCacheEntry | null> {
  return mcpStorageOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    return state.toolCaches.find((cache) => cache.serverId === serverId) ?? null;
  });
}

export async function getAllMcpToolCaches(): Promise<McpToolCacheEntry[]> {
  return mcpStorageOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    return [...state.toolCaches].sort((a, b) => b.refreshedAt - a.refreshedAt);
  });
}

export async function saveMcpToolCache(entry: McpToolCacheEntry): Promise<void> {
  await mcpStorageOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    await writeStateAlreadyOwned({
      ...state,
      toolCaches: [entry, ...state.toolCaches.filter((cache) => cache.serverId !== entry.serverId)],
    });
  });
}

/**
 * Persists one discovery result and its matching server health as a single
 * whole-key commit. This prevents readers from observing a cache/health split
 * and keeps concurrent allowlist or execution-policy changes on the latest
 * server record owned by the storage queue.
 */
export async function saveMcpDiscoveryResult(
  entry: McpToolCacheEntry,
  expectedServer: McpServerConfig,
): Promise<void> {
  await mcpStorageOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    const currentServer = state.servers.find((server) => server.id === entry.serverId);
    if (!currentServer) {
      throw new Error(`MCP server not found during discovery commit: ${entry.serverId}`);
    }
    if (mcpDiscoveryFingerprint(currentServer) !== mcpDiscoveryFingerprint(expectedServer)) {
      throw new McpDiscoveryConfigChangedError(entry.serverId);
    }

    const servers = state.servers.map((server) => {
      if (server.id !== entry.serverId) return server;
      return applyMcpServerHealthPatch(server, {
        status: entry.health.status,
        lastConnectedAt: entry.health.status === 'ready'
          ? entry.health.checkedAt
          : undefined,
        lastError: entry.health.error,
      });
    });

    await writeStateAlreadyOwned({
      ...state,
      servers,
      toolCaches: [entry, ...state.toolCaches.filter((cache) => cache.serverId !== entry.serverId)],
    });
  });
}

export async function clearMcpToolCache(serverId: McpServerId): Promise<void> {
  await mcpStorageOperations.run(async () => {
    const state = await readStateAlreadyOwned();
    await writeStateAlreadyOwned({
      ...state,
      toolCaches: state.toolCaches.filter((cache) => cache.serverId !== serverId),
    });
  });
}

export function sanitizeMcpServerConfig(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    secrets: server.secrets.map(redactSecret),
  };
}

/**
 * Request headers for one server: user-configured `headers` first, `secrets` on top.
 *
 * ⚠️⚠️ **Overriding is case-insensitive, and a secret REPLACES a same-named custom
 * header — it does not coexist with it.** HTTP header names are case-insensitive, but a
 * plain object is not: writing `headers.Authorization` while `headers.authorization`
 * already exists leaves **two keys**, and the `Headers` constructor joins them with
 * `", "` ⇒ the server receives `"Bearer <token>, <user value>"`, which is not a valid
 * `Authorization` value. Whichever side the user configured, exactly one wins, and the
 * secret is the more specific intent.
 */
export function buildMcpRequestHeaders(server: McpServerConfig): Record<string, string> {
  const headers = new Map<string, { name: string; value: string }>();
  const put = (name: string, value: string): void => {
    // Key by lower-case, keep the first spelling of the name for the wire.
    const key = name.toLowerCase();
    headers.set(key, { name: headers.get(key)?.name ?? name, value });
  };

  for (const header of server.headers) {
    const name = header.name.trim();
    if (name) put(name, header.value);
  }
  for (const secret of server.secrets) {
    if (!secret.value) continue;
    if (secret.kind === 'bearer') put('Authorization', `Bearer ${secret.value}`);
    if (secret.kind === 'basic') put('Authorization', `Basic ${secret.value}`);
    if (secret.kind === 'header' && secret.headerName?.trim()) {
      put(secret.headerName.trim(), secret.value);
    }
  }

  return Object.fromEntries([...headers.values()].map((entry) => [entry.name, entry.value]));
}

/**
 * 读整份 MCP 状态。
 *
 * ⚠️⚠️ **工具缓存走容错读、服务记录保持严格** —— 理由见
 * `decodeMcpStorageStateTolerant` 的说明：缓存是派生数据（丢一条只是要重新发现），
 * 服务是权威数据（丢一条等于静默删掉用户的配置，因为下游写操作会带著不含它的
 * state 整份写回）。迁移仍然走严格版：那一档判的是**版本**，不该被容错掩盖。
 *
 * ⚠️ **这里不写回被跳过的缓存** —— 自愈靠「下一次任何写入都带著不含它的 state」，
 * 在这里写回会让打开一次 MCP 页变成 N+1 次整份 re-encode。
 */
async function readStateAlreadyOwned(): Promise<McpServerStorageState> {
  const data = await chrome.storage.local.get(MCP_STORAGE_KEY) as Record<string, unknown>;
  // ⚠️ **只走这一条**：`migrateMcpStorageState` 的 v2 分支内部已经用容错读，
  // 在它之后再单独 decode 一次会拿**原始**（可能是 v1）的 raw 再解一遍 ⇒
  // 老版本存储会在这里抛 `mcp_storage_version_unsupported`。
  const migration = migrateMcpStorageState(data[MCP_STORAGE_KEY]);
  if (migration.migrated) await writeStateAlreadyOwned(migration.state);
  logDroppedCaches(migration);
  return migration.state;
}

// ⚠️ **按「丢了几条」去重** —— 一次 `loadMcpSnapshot` 会读 1 + N 次（每个服务一次
// `getMcpToolCache`），而坏缓存不会在用户不写盘时被清掉 ⇒ 打开一次 MCP 页会打 N+1 条
// 一模一样的日志。同一个数字只报一次就够；数目变了（又坏了一条）才重新报。
let lastLoggedDroppedCaches = 0;

function logDroppedCaches(migration: McpStorageMigration): void {
  if (migration.droppedCaches <= 0 || migration.droppedCaches === lastLoggedDroppedCaches) return;
  lastLoggedDroppedCaches = migration.droppedCaches;
  // ⚠️ `log` 级、不是 `error` —— 丢弃是**自愈动作**（下次写入即清），
  // 而这条只在 `chrome://extensions` 的 SW 控制台可见，不进扩展错误面板。
  console.log('[Zai++] dropped malformed MCP tool caches', {
    dropped: migration.droppedCaches,
    kept: migration.state.toolCaches.length,
  });
}

async function writeStateAlreadyOwned(state: McpServerStorageState): Promise<void> {
  await chrome.storage.local.set({
    [MCP_STORAGE_KEY]: encodeMcpStorageState(state),
  });
}

function normalizeServerForMutation(raw: unknown): McpServerConfig {
  const value = raw && typeof raw === 'object' ? raw as Partial<McpServerConfig> : {};
  const now = Date.now();
  const enabled = value.enabled !== false;
  const status = normalizeServerStatus(value.status, enabled);
  return {
    version: MCP_SERVER_CONFIG_VERSION,
    id: stringValue(value.id) || crypto.randomUUID(),
    displayName: stringValue(value.displayName) || 'MCP Server',
    enabled,
    transport: {
      kind: value.transport?.kind ?? 'streamable_http',
      url: stringValue(value.transport?.url),
      nativeHost: stringValue(value.transport?.nativeHost),
      command: stringValue(value.transport?.command),
      args: stringArrayValue(value.transport?.args),
      cwd: stringValue(value.transport?.cwd),
      env: stringRecordValue(value.transport?.env),
    },
    headers: headerArrayValue(value.headers),
    secrets: secretArrayValue(value.secrets),
    timeouts: {
      connectMs: positiveNumber(value.timeouts?.connectMs, MCP_DEFAULT_TIMEOUTS.connectMs),
      requestMs: positiveNumber(value.timeouts?.requestMs, MCP_DEFAULT_TIMEOUTS.requestMs),
      discoveryMs: positiveNumber(value.timeouts?.discoveryMs, MCP_DEFAULT_TIMEOUTS.discoveryMs),
    },
    limits: {
      maxResultBytes: positiveNumber(value.limits?.maxResultBytes, MCP_DEFAULT_LIMITS.maxResultBytes),
      maxToolCount: positiveNumber(value.limits?.maxToolCount, MCP_DEFAULT_LIMITS.maxToolCount),
    },
    allowlist: {
      mode: value.allowlist?.mode === 'allow' || value.allowlist?.mode === 'deny' ? value.allowlist.mode : 'all',
      toolNames: stringArrayValue(value.allowlist?.toolNames),
    },
    execution: {
      // 'manual' was removed; any unknown/legacy value normalizes to 'auto'.
      mode: value.execution?.mode === 'disabled' ? 'disabled' : 'auto',
      enabled: value.execution?.enabled !== false,
    },
    status,
    lastConnectedAt: nullableNumber(value.lastConnectedAt),
    lastError: stringValue(value.lastError),
    createdAt: positiveNumber(value.createdAt, now),
    updatedAt: positiveNumber(value.updatedAt, now),
  };
}

function resolvePatchedServerStatus(
  server: McpServerConfig,
  patch: Pick<McpServerUpdateInput, 'enabled' | 'status'>,
): McpServerStatus {
  if (patch.enabled === false) return 'disabled';
  if (patch.status) return patch.status;
  if (patch.enabled === true && (!server.enabled || server.status === 'disabled')) return 'unknown';
  return server.status;
}

function resolveMcpServerHealthStatus(
  server: McpServerConfig,
  patch: Partial<Pick<McpServerConfig, 'status'>>,
): McpServerStatus {
  if (!server.enabled) return 'disabled';
  return patch.status ?? server.status;
}

/**
 * Applies a connection-health patch **without touching `updatedAt`**.
 *
 * ⚠️⚠️ **`updatedAt` means "the user last changed this configuration", and it is the
 * only sort key of the MCP page's server list** (`getAllMcpServers` sorts by it
 * descending). Writing it here made every discovery/health check look like a config
 * edit: the refreshed server jumped to the top of the list — and because a *failed*
 * discovery writes the same patch, a server that had just failed to connect also jumped
 * to the top. The function's own contract says it records health "without treating it as
 * a configuration mutation"; this is that contract expressed in code.
 *
 * Health has its own field: `lastConnectedAt` (only written when the check actually
 * succeeded) plus `status` / `lastError`.
 */
function applyMcpServerHealthPatch(
  server: McpServerConfig,
  patch: Partial<Pick<McpServerConfig, 'status' | 'lastConnectedAt' | 'lastError'>>,
): McpServerConfig {
  return {
    ...server,
    status: resolveMcpServerHealthStatus(server, patch),
    lastConnectedAt: patch.lastConnectedAt === undefined
      ? server.lastConnectedAt
      : patch.lastConnectedAt,
    lastError: patch.lastError === undefined ? server.lastError : patch.lastError,
  };
}

function normalizeServerStatus(
  status: McpServerStatus | undefined,
  enabled: boolean,
): McpServerStatus {
  if (!enabled) return 'disabled';
  return status && status !== 'disabled' ? status : 'unknown';
}

function redactSecret(secret: McpSecretValue): McpSecretValue {
  return {
    ...secret,
    value: secret.value ? REDACTED_SECRET_VALUE : '',
  };
}

function mergeRedactedSecrets(previous: McpSecretValue[], next: McpSecretValue[]): McpSecretValue[] {
  const usedPreviousIndexes = new Set<number>();
  return next.map((incoming) => {
    const secret = ensureSecretId(incoming);
    if (secret.value !== REDACTED_SECRET_VALUE) return secret;

    const idMatchIndex = secret.id
      ? previous.findIndex((item, index) => item.id === secret.id && !usedPreviousIndexes.has(index))
      : -1;
    const idMatch = idMatchIndex >= 0 ? previous[idMatchIndex] : undefined;
    if (idMatch) {
      usedPreviousIndexes.add(idMatchIndex);
      return { ...secret, value: idMatch.value };
    }

    const metadataMatches = previous
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => !usedPreviousIndexes.has(index) && secretMetadataMatches(secret, item));
    const metadataMatch = metadataMatches.length === 1 ? metadataMatches[0] : undefined;
    if (metadataMatch) {
      usedPreviousIndexes.add(metadataMatch.index);
      return { ...secret, value: metadataMatch.item.value };
    }

    return { ...secret, value: '' };
  });
}

function ensureSecretId(secret: McpSecretValue): McpSecretValue {
  return {
    ...secret,
    id: stringValue(secret.id) || crypto.randomUUID(),
  };
}

function secretMetadataMatches(left: McpSecretValue, right: McpSecretValue): boolean {
  return left.kind === right.kind &&
    stringValue(left.headerName) === stringValue(right.headerName) &&
    stringValue(left.username) === stringValue(right.username);
}

function shouldInvalidateMcpToolCache(previous: McpServerConfig, next: McpServerConfig): boolean {
  return mcpDiscoveryFingerprint(previous) !== mcpDiscoveryFingerprint(next);
}

/**
 * 配置「会不会影响发现结果」的指纹 —— 值相同就相等，**与键序无关**。
 *
 * ⚠️⚠️ **必须过 `canonicalizeForFingerprint`，不能直接 `JSON.stringify`**：
 * `normalizeServerForMutation` 重建 `timeouts` 时按源码声明序
 * （`connectMs` / `requestMs` / `discoveryMs`），而从 `chrome.storage` 读回的
 * 是**键名字母序**（`connectMs` / `discoveryMs` / `requestMs`）。
 * 同一个值、两种键序 ⇒ 指纹不相等 ⇒ 「配置变了」被误判 ⇒
 * **任何一次配置写入都会清空工具缓存、把状态打成 `unknown`、抹掉上次连接时间**
 * （表现：改个显示名或关掉一个工具，工具列表就变成 0 个、要重新刷新）。
 */
function mcpDiscoveryFingerprint(server: McpServerConfig): string {
  return JSON.stringify(canonicalizeForFingerprint({
    // Older valid records omit optional transport and secret fields. Mutating
    // status after discovery normalizes those omissions, which must not
    // invalidate the cache that discovery just wrote. Secret IDs are UI
    // identity only; they do not alter the connection or discovery result.
    transport: {
      kind: server.transport.kind,
      url: server.transport.url ?? '',
      nativeHost: server.transport.nativeHost ?? '',
      command: server.transport.command ?? '',
      args: server.transport.args ?? [],
      cwd: server.transport.cwd ?? '',
      // ⚠️ **`?? {}` 是承重的** —— `normalizeServerForMutation` 那一侧用
      // `stringRecordValue()` 把缺省的 `env` 补成 `{}`；若这里留着 `undefined`，
      // `JSON.stringify` 会**整个丢掉这个键** ⇒ 两侧指纹不等 ⇒ 又变成「每次写入都清缓存」。
      env: server.transport.env ?? {},
    },
    headers: server.headers,
    // ⚠️ **先按「影响连接的四个字段」投影，再排序** —— 不要直接把原始 `secrets`
    // 交给 canonicalize：那样 `id` 会进指纹（它是 UI 身份，不影响连接），
    // 而缺省字段会与补齐后的形状产生假差异。
    secrets: server.secrets.map((secret) => ({
      kind: secret.kind,
      headerName: secret.headerName ?? '',
      username: secret.username ?? '',
      value: secret.value,
    })),
    timeouts: server.timeouts,
    limits: server.limits,
  }));
}

/**
 * 递归按**键名**排序后再交给调用方序列化。
 *
 * ⚠️ **数组不排序** —— `headers` 与 `transport.args` 的顺序有语义，
 * 换个顺序就是另一份配置。
 */
function canonicalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForFingerprint);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, canonicalizeForFingerprint(source[key])]),
    );
  }
  return value;
}

function headerArrayValue(value: unknown): McpHeaderValue[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const header = item && typeof item === 'object' ? item as Partial<McpHeaderValue> : {};
      return {
        name: stringValue(header.name),
        value: stringValue(header.value),
      };
    })
    .filter((header) => header.name);
}

function secretArrayValue(value: unknown): McpSecretValue[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const secret = item && typeof item === 'object' ? item as Partial<McpSecretValue> : {};
      const kind: McpServerSecretKind = secret.kind === 'basic' || secret.kind === 'header' ? secret.kind : 'bearer';
      return {
        id: stringValue(secret.id) || crypto.randomUUID(),
        kind,
        headerName: stringValue(secret.headerName),
        username: stringValue(secret.username),
        value: stringValue(secret.value),
      };
    })
    .filter((secret) => secret.value || secret.headerName || secret.username);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringRecordValue(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries);
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
