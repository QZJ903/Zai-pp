import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LocaleMessageKey, MessageParams } from '../../../core/i18n';
import type {
  McpCapabilityExposureMode,
  McpCapabilitySettings,
  McpCapabilitySettingsPatch,
  McpServerConfig,
  McpServerCreateInput,
  McpToolCacheEntry,
  PlatformEnvironment,
  ToolCallHistoryRecord,
  ToolDescriptor,
} from '../../../core/types';
import { createRequestGenerationFence } from '../async-state';
import { formatRuntimeError } from '../runtime-response';
import {
  McpPermissionError,
  countEnabledMcpTools,
  findMcpPreset,
  getMcpPresetInput,
  isMcpNativeMessagingSupported,
  isMcpToolSelected,
  mcpToolsController,
  visibleMcpTools,
  type McpConnectionAction,
  type McpPresetKind,
} from './mcp-tools-controller';

type Translator = (key: LocaleMessageKey, params?: MessageParams) => string;
type BusyAction = 'refresh' | 'test';
type Banner = { tone: 'success' | 'error' | 'info'; text: string };
type Confirm = (options: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}) => Promise<boolean>;

export function useMcpPageController(t: Translator, confirm: Confirm) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [caches, setCaches] = useState<Record<string, McpToolCacheEntry | null>>({});
  // ⚠️ **这是「当前选中那个服务」的记录**，不是全体最近 N 条 —— 后者会让不活跃的
  // 服务恒显示「暂无调用」（名额被别的服务占满）。取数带 `serverId`，先筛后截在后台。
  const [history, setHistory] = useState<ToolCallHistoryRecord[]>([]);
  const [capabilitySettings, setCapabilitySettings] = useState<McpCapabilitySettings | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [busy, setBusy] = useState<Record<string, BusyAction | null>>({});
  const [banner, setBanner] = useState<Banner | null>(null);
  const [platform, setPlatform] = useState<PlatformEnvironment | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionInitialized = useRef(false);
  const requestFence = useRef(createRequestGenerationFence());
  // 历史单独一条闸门：它在「切换选中服务」时独立触发，不能占用整页 load 的那条。
  const historyFence = useRef(createRequestGenerationFence());
  // `load()` 里要按「此刻选中的是谁」决定取哪份历史，而 state 在闭包里是旧值。
  const selectedIdRef = useRef<string | null>(null);

  const clearBanner = useCallback(() => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = null;
    setBanner(null);
  }, []);

  const showBanner = useCallback((tone: Banner['tone'], text: string) => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    setBanner({ tone, text });
    dismissTimer.current = tone === 'success'
      ? setTimeout(() => setBanner(null), 4000)
      : null;
  }, []);

  /**
   * 拉「某个服务」的最近调用。
   *
   * ⚠️ **失败只弹横幅、不动已有记录** —— 与整页 load 同口径：一次读失败不能把上一次
   * 已确认的列表清空（那会让用户以为记录凭空消失）。
   */
  const refreshHistory = useCallback(async (serverId: string | null) => {
    const generation = historyFence.current.begin();
    if (!serverId) {
      setHistory([]);
      return;
    }
    try {
      const records = await mcpToolsController.getServerHistory(serverId);
      if (historyFence.current.isCurrent(generation)) setHistory(records);
    } catch (error) {
      if (historyFence.current.isCurrent(generation)) {
        showBanner('error', formatRuntimeError(error, t));
      }
    }
  }, [showBanner, t]);

  const load = useCallback(async () => {
    const generation = requestFence.current.begin();
    setLoading(true);
    try {
      const snapshot = await mcpToolsController.loadMcpSnapshot();
      if (!requestFence.current.isCurrent(generation)) return;
      setPlatform(snapshot.platform);
      setServers(snapshot.servers);
      setCaches(snapshot.caches);
      setCapabilitySettings(snapshot.capabilitySettings);
      const shouldSelectInitialServer = !selectionInitialized.current
        && snapshot.servers.length > 0;
      if (shouldSelectInitialServer) selectionInitialized.current = true;
      const current = selectedIdRef.current;
      const nextSelected = current && snapshot.servers.some((server) => server.id === current)
        ? current
        : (shouldSelectInitialServer ? snapshot.servers[0]?.id ?? null : null);
      selectedIdRef.current = nextSelected;
      setSelectedId(nextSelected);
      // ⚠️ 历史不在 `loadMcpSnapshot` 里一起取 —— 它只跟「选中了谁」有关，与列表/缓存
      // 无关。这里补刷一次是因为 `focus` / `visibilitychange` 也会调 `load()`：那两条
      // 路径下选中项不一定变，光靠下面的 effect 刷不到（历史也可能已经过时）。
      void refreshHistory(nextSelected);
    } catch (error) {
      if (requestFence.current.isCurrent(generation)) {
        showBanner('error', formatRuntimeError(error, t) || t('sidepanel.mcpPage.messages.loadFailed'));
      }
    } finally {
      if (requestFence.current.isCurrent(generation)) setLoading(false);
    }
  }, [refreshHistory, showBanner, t]);

  // ⚠️⚠️ **ref 必须跟着 state 走** —— 只靠 `load()` 内部回填会让「外部改选中项」全部丢失：
  // 用户点 B（只调 `setSelectedId`）、下一次 `load()` 读到 ref 还是 A、且 A 仍在列表里
  // ⇒ 详情面板从 B 跳回 A。所有 `setSelectedId` 的调用点（点服务行、新建预设命中已存在、
  // 删除服务）都经这一行同步，不依赖调用方自己记得改 ref。
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    void load();
    const reloadForRuntimeUpdate = (message: { type?: string }) => {
      // ⚠️⚠️ **历史变了只刷历史，不整页重载** —— 工具每执行一次后台都会发
      // `TOOL_CALL_HISTORY_UPDATED`，而整页 `load()` 要发 1 + N 次 `GET_MCP_TOOL_CACHE`
      // （每个服务一次），每次后台还要解一遍整份 MCP state。那份开销原本是用来
      // 刷新「最近调用」的，而现在历史由 `refreshHistory` 单独取 ⇒ 整页重载纯属浪费。
      if (message.type === 'TOOL_CALL_HISTORY_UPDATED') {
        void refreshHistory(selectedIdRef.current);
        return;
      }
      if (message.type === 'MCP_SERVERS_UPDATED' || message.type === 'TOOL_DESCRIPTORS_UPDATED') {
        void load();
      }
    };
    const reloadWhenVisible = () => {
      if (!document.hidden) void load();
    };
    chrome.runtime.onMessage.addListener(reloadForRuntimeUpdate);
    document.addEventListener('visibilitychange', reloadWhenVisible);
    window.addEventListener('focus', reloadWhenVisible);
    return () => {
      requestFence.current.invalidate();
      historyFence.current.invalidate();
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      chrome.runtime.onMessage.removeListener(reloadForRuntimeUpdate);
      document.removeEventListener('visibilitychange', reloadWhenVisible);
      window.removeEventListener('focus', reloadWhenVisible);
    };
  }, [load, refreshHistory]);

  // 切换选中服务只影响「最近调用」那一块 ⇒ 只刷历史，不整页重载。
  // ⚠️ 首次挂载时选中项由 `load()` 设进来，这里会跟着跑一次；与 `load()` 里那次并发
  // 由 `historyFence` 收敛成「最后一次生效」，不会双写。
  useEffect(() => {
    void refreshHistory(selectedId);
  }, [refreshHistory, selectedId]);

  const startCreate = useCallback(() => {
    setEditing(null);
    clearBanner();
    setShowForm((visible) => !visible);
  }, [clearBanner]);

  const startEdit = useCallback((server: McpServerConfig) => {
    setEditing(server);
    clearBanner();
    setShowForm(true);
  }, [clearBanner]);

  const cancelForm = useCallback(() => {
    setShowForm(false);
    setEditing(null);
    clearBanner();
  }, [clearBanner]);

  const createPreset = useCallback(async (kind: McpPresetKind) => {
    clearBanner();
    if (!isMcpNativeMessagingSupported(platform)) {
      showBanner('error', t('sidepanel.mcpPage.messages.nativeMessagingUnsupported'));
      return;
    }
    const existing = findMcpPreset(servers, kind);
    if (existing) {
      setSelectedId(existing.id);
      showBanner('info', t('sidepanel.mcpPage.messages.shellExistsSelected'));
      return;
    }
    try {
      const server = await mcpToolsController.createServer(getMcpPresetInput(kind));
      setSelectedId(server.id);
      showBanner('success', t('sidepanel.mcpPage.messages.shellCreated'));
      await load();
    } catch {
      showBanner('error', t('sidepanel.mcpPage.messages.shellCreateFailed'));
    }
  }, [clearBanner, load, platform, servers, showBanner, t]);

  const saveServer = useCallback(async (payload: McpServerCreateInput) => {
    const editingServer = editing
      ? servers.find((server) => server.id === editing.id) ?? editing
      : null;
    const requestPayload = editingServer
      ? { ...payload, allowlist: editingServer.allowlist }
      : payload;
    try {
      if (editingServer) {
        const saved = await mcpToolsController.updateServer(editingServer, requestPayload);
        if (!saved) throw new Error('MCP server no longer exists.');
      } else {
        await mcpToolsController.createServer(requestPayload);
      }
      setShowForm(false);
      setEditing(null);
      clearBanner();
      await load();
    } catch {
      showBanner('error', t('sidepanel.mcpPage.messages.saveFailed'));
    }
  }, [clearBanner, editing, load, servers, showBanner, t]);

  const removeServer = useCallback(async (server: McpServerConfig) => {
    const approved = await confirm({
      title: t('sidepanel.mcpPage.messages.deleteConfirm', { name: server.displayName }),
      message: t('sidepanel.mcpPage.messages.deleteConfirm', { name: server.displayName }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    });
    if (!approved) return;
    try {
      await mcpToolsController.deleteServer(server.id);
      setSelectedId((current) => current === server.id ? null : current);
      await load();
    } catch (error) {
      showBanner('error', formatRuntimeError(error, t));
    }
  }, [confirm, load, showBanner, t]);

  const patchServer = useCallback(async (
    server: McpServerConfig,
    patch: Partial<McpServerConfig>,
  ) => {
    try {
      const saved = await mcpToolsController.updateServer(server, patch);
      if (!saved) throw new Error('MCP server no longer exists.');
      await load();
    } catch (error) {
      showBanner('error', formatRuntimeError(error, t));
    }
  }, [load, showBanner, t]);

  const setBusyState = useCallback((serverId: string, action: BusyAction | null) => {
    setBusy((current) => ({ ...current, [serverId]: action }));
  }, []);

  const connectServer = useCallback(async (
    server: McpServerConfig,
    action: McpConnectionAction,
  ) => {
    setBusyState(server.id, action);
    clearBanner();
    try {
      const cache = await mcpToolsController.connectServer(server, action);
      setCaches((current) => ({ ...current, [server.id]: cache }));
      if (cache.health.status === 'ready') {
        showBanner('success', t('sidepanel.mcpPage.messages.connectionSuccess', {
          // ⚠️⚠️ **报的是「你能看到几个」，不是 `health.toolCount`** —— 后者是 host
          // 发布的总数，含只由扩展自己调用的内部工具（`local_skill_preview`）⇒ 直接用它
          // 会出现横幅说「12 个工具」而下面列表只有 11 条，用户以为少了一个。
          // 同口径的另两处：页头汇总（`toolCount` 那个 `useMemo`）、服务行
          // `activeTools`；三处都过 `visibleMcpTools`。
          tools: visibleMcpTools(cache).length,
          latency: formatMilliseconds(cache.health.latencyMs),
        }));
      } else {
        showBanner('error', cache.health.error ?? t('sidepanel.mcpPage.messages.connectionFailed'));
      }
      await load();
    } catch (error) {
      if (error instanceof McpPermissionError) {
        showBanner('error', error.message !== 'MCP origin permission was denied.'
          ? error.message
          : t('sidepanel.mcpPage.messages.permissionRequired', {
            origin: error.origin ?? 'MCP Host',
          }));
      } else {
        showBanner('error', formatRuntimeError(error, t));
      }
    } finally {
      setBusyState(server.id, null);
    }
  }, [clearBanner, load, setBusyState, showBanner, t]);

  const toggleTool = useCallback(async (server: McpServerConfig, tool: ToolDescriptor) => {
    const selected = isMcpToolSelected(server, tool);
    try {
      // ⚠️⚠️ **走「按单个工具改」的命令，不在这里算整份 allowlist** —— 这里的 `server`
      // 是上一次快照，连点两个不同工具的开关时，第二次算出的名单里没有第一次的改动
      // ⇒ 第一次被整份覆盖（用户看到「点了两个只开了一个」）。后台在存储事务里读-改-写。
      const saved = await mcpToolsController.setToolSelection(server.id, tool, !selected);
      if (!saved) throw new Error('MCP server no longer exists.');
      await load();
    } catch (error) {
      showBanner('error', formatRuntimeError(error, t));
    }
  }, [load, showBanner, t]);

  const setServerExposure = useCallback(async (
    server: McpServerConfig,
    mode: McpCapabilityExposureMode,
    pinnedDescriptorIds?: readonly string[],
  ) => {
    try {
      const settings = await mcpToolsController.setServerExposure({
        serverId: server.id,
        mode,
        pinnedDescriptorIds,
      });
      setCapabilitySettings(settings);
    } catch (error) {
      showBanner('error', formatRuntimeError(error, t));
    }
  }, [showBanner, t]);

  const updateCapabilitySettings = useCallback(async (patch: McpCapabilitySettingsPatch) => {
    try {
      const settings = await mcpToolsController.updateCapabilitySettings(patch);
      setCapabilitySettings(settings);
    } catch (error) {
      showBanner('error', formatRuntimeError(error, t));
    }
  }, [showBanner, t]);

  const togglePinnedTool = useCallback(async (server: McpServerConfig, tool: ToolDescriptor) => {
    const configured = capabilitySettings?.servers[server.id];
    const pinned = new Set(configured?.pinnedDescriptorIds ?? []);
    if (pinned.has(tool.id)) pinned.delete(tool.id);
    else pinned.add(tool.id);
    await setServerExposure(server, configured?.mode ?? 'direct', [...pinned]);
  }, [capabilitySettings, setServerExposure]);

  const selected = selectedId
    ? servers.find((server) => server.id === selectedId) ?? null
    : null;
  const enabledCount = servers.filter((server) => server.enabled).length;
  // ⚠️ 与 MCP 页的工具列表同口径（剔掉内部工具）—— 否则页头显示 12、服务行显示 11。
  const toolCount = useMemo(() => servers.reduce(
    (sum, server) => sum + countEnabledMcpTools(server, visibleMcpTools(caches[server.id])),
    0,
  ), [caches, servers]);

  return {
    servers,
    caches,
    selectedServerHistory: history,
    capabilitySettings,
    selected,
    selectedId,
    setSelectedId,
    loading,
    showForm,
    editing,
    busy,
    banner,
    platform,
    enabledCount,
    toolCount,
    nativeMessagingSupported: isMcpNativeMessagingSupported(platform),
    clearBanner,
    startCreate,
    startEdit,
    cancelForm,
    createShellPreset: () => createPreset('shell'),
    saveServer,
    removeServer,
    patchServer,
    refreshServer: connectServer,
    toggleTool,
    updateCapabilitySettings,
    setServerExposure,
    togglePinnedTool,
  };
}

function formatMilliseconds(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
}
