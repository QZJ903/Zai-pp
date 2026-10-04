import {
  getAllMemories,
  getMemoryById,
  importMemoriesAtomically,
  saveMemory,
  updateMemory,
  deleteMemory,
  touchMemories,
  archiveStaleMemories,
} from '../core/memory/store';
import {
  getAllSkillSources,
  getAllSkills,
  getSkillLibrary,
  saveSkill,
  setSkillEnabled,
  setSkillsEnabled,
  stageDeleteSkillAlreadyLocked,
  stageDeleteSkillSourceAlreadyLocked,
} from '../core/skill/registry';
import {
  checkGitHubSkillSourceUpdates,
  importGitHubSkillSource,
  previewGitHubSkillSource,
  updateGitHubSkillSource,
} from '../core/skill/github-importer';
import {
  importLocalSkillSource,
  pickLocalSkillFolder,
  previewLocalSkillSource,
  relocateLocalSkillSource,
  updateLocalSkillSource,
} from '../core/skill/local-importer';
import {
  getAllPresets,
  savePreset,
  getActivePreset,
  setActivePresetId,
  stageDeletePresetAlreadyLocked,
} from '../core/preset/store';
import { getBackgroundConfig, saveBackgroundConfig, clearBackgroundConfig } from '../core/background/store';
import { clearUsageRecords, getUsageSummary, recordUsageTurn } from '../core/usage/store';
import { getExtensionVersion } from '../core/version';
import {
  recoverPendingSyncLocalApply,
  runLocalStateMutationWithRecovery,
} from '../core/sync/local-apply-runtime';
import { createSyncRecoveryBarrier } from '../core/sync/recovery-barrier';
import { clearToolCallHistory, getToolCallHistory } from '../core/tool/history';
import {
  appendExternalizedToolPayloadChunk,
  clearExternalizedToolPayloadNamespace,
} from '../core/tool/externalized-payload';
import {
  createInvalidToolCallResult,
  createRuntimeToolRuntime,
  type RuntimeToolCallOptions,
} from '../core/tool/runtime';
import { createProductionToolProviderRegistry } from './background/tool-provider-composition';
import { createMcpCapabilityInvocationResolver } from '../core/mcp/capability-runtime';
import {
  getMcpCapabilitySettings,
  setMcpCapabilityServerExposure,
  updateMcpCapabilitySettings,
} from '../core/mcp/capability-settings';
import { projectMcpCapabilityDescriptors } from '../core/mcp/capability-projection';
import {
  authorizeExternalToolPayloadChunk,
  closeToolAuthorization,
  createToolAuthorization,
  createToolAuthorizationResult,
} from '../core/tool/authorization';
import { ExternalPayloadAuthorizationCache } from '../core/tool/external-payload-authorization-cache';
import {
  browserControlService,
  getBrowserControlSettings,
  getBrowserControlState,
  saveBrowserControlSettings,
  setBrowserControlEnabled,
} from '../core/browser-control';
import {
  addConversationToProject,
  bindPendingProjectConversation,
  createProjectContext,
  stageDeleteProjectContextAndMemoriesAlreadyLocked,
  formatProjectPromptContext,
  getProjectContextState,
  getProjectForConversation,
  getProjectPromptContextForConversation,
  refreshProjectConversation,
  removeConversationFromProject,
  setPendingProjectContext,
  updateProjectContext,
} from '../core/project';
import {
  deleteSavedItem,
  getAllSavedItems,
  getSavedItemsState,
  saveSavedItem,
} from '../core/saved-items';
import {
  getPromptInjectionSettings,
  savePromptInjectionSettings,
} from '../core/prompt/settings';
import {
  getSkillAutoActivationSettings,
  saveSkillAutoActivationSettings,
} from '../core/skill/auto-activation-settings';
import { getCurrentPlatformEnvironment } from '../core/platform';
import { readOptionalChromeApi } from '../core/platform/chrome-api';
import {
  dismissWhatsNew,
  hasPendingWhatsNew,
  markWhatsNewPending,
} from '../core/whats-new';
import {
  createMcpServer,
  deleteMcpServer,
  getAllMcpServers,
  getMcpToolCache,
  getMcpServerById,
  updateMcpServer,
} from '../core/mcp/store';
import { refreshMcpServerDiscovery } from '../core/mcp/discovery';
import { getMcpOriginPattern, hasMcpServerOriginPermission } from '../core/mcp/transports';
import {
  buildShellAllowlistUpgrade,
  buildShellToolLimitUpgrade,
  createShellMcpPresetInput,
  isShellMcpServer,
} from '../core/shell';
import { getWebToolSettings, setWebToolEnabled } from '../core/tool/web-settings';
import {
  createAutomation,
  deleteAutomation,
  getAllAutomations,
  getAutomationById,
  getAutomationRuns,
  setAutomationStatus,
  updateAutomation,
  updateAutomationRuntime,
} from '../core/automation/store';
import { createAutomationRunnerFailure } from '../core/automation/messages';
import {
  AUTOMATION_WAKE_ALARM_NAME,
  AUTOMATION_WAKE_INTERVAL_MINUTES,
  cancelActiveAutomationRun,
  refreshAutomationNextRunAt,
  runAutomation,
  scanDueAutomations,
} from '../core/automation/scheduler';
import { createDomTaskCoordinator } from '../core/zai/dom-task-coordinator';
import { buildZaiChatSessionUrl } from '../core/zai/chat-session';
import { AUTH_READ_TIMEOUT_MS, loadZaiAuthFromStorage } from '../core/zai/auth';
import { createZaiModelCatalog } from '../core/zai/models';
import { createDomTaskRuntimeHandlers } from './background/dom-task-handlers';
import { broadcastRuntimeUpdate } from '../core/messaging/broadcast';
import { createBackgroundErrorResponse } from '../core/messaging/background-error';
import {
  authorizeRuntimeMessage,
  createRuntimeBoundaryErrorResponse,
  createRuntimeMessageContext,
  decodeRuntimeMessageEnvelope,
  RuntimeBoundaryError,
  type RuntimeMessageContext,
  type RuntimeMessageEnvelope,
} from '../core/messaging/runtime-boundary';
import { requiresCurrentToolAuthorizationSubject } from '../core/messaging/tool-runtime-contracts';
import { createRuntimeCommandRegistry } from '../core/messaging/runtime-command-registry';
import { createBootstrapRuntimeHandlers } from './background/bootstrap-handlers';
import { createDiagnosticsRuntimeHandlers } from './background/diagnostics-handlers';
import { createTrackedLocalStateMutationRunner } from './background/local-state-mutation-runner';
import { createPersistenceMutationBindings } from './background/persistence-mutation-bindings';
import { createPersistenceRuntimeHandlers } from './background/persistence-handlers';
import { createToolRuntimeHandlers } from './background/tool-runtime-handlers';
import { createTrustedToolExecutionContext } from './background/tool-execution-handlers';
import { createBackgroundRuntimeHandlers } from './background/background-runtime-handlers';
import { refreshRuntimeMessageContextFromBrowserTab } from './background/runtime-message-context';
import {
  createTranslator,
  DEFAULT_LOCALE,
  type LocaleMessageKey,
  type MessageParams,
  type SupportedLocale,
} from '../core/i18n/background';
import {
  LOCALE_READ_TIMEOUT_MS,
  getResolvedLocaleState,
  watchLocalePreference,
} from '../core/i18n/store';
import type {
  BackgroundConfig,
  CurrentGLMConversation,
  ToolCall,
  ToolDescriptor,
  ToolExecutionTrigger,
  ToolResult,
} from '../core/types';
import type { McpServerConfig } from '../core/mcp/types';
import type { AutomationRunnerRequest, AutomationRunnerResult } from '../core/automation/types';
import type { AutomationExecutionContext } from '../core/automation/execution';

const ZAI_HOME_URL = 'https://chat.z.ai/';
const ZAI_TAB_URL_PATTERN = '*://chat.z.ai/*';
/** 向 chat.z.ai 标签页请求 auth 刷新（content 从页面 localStorage 兜底读 token）。 */
const REFRESH_AUTH_MESSAGE = { type: 'REFRESH_ZAI_AUTH' } as const;
const domTaskCoordinator = createDomTaskCoordinator({
  homeUrl: ZAI_HOME_URL,
  tabUrlPattern: ZAI_TAB_URL_PATTERN,
  reportError: reportBackgroundStartupError,
});
// 模型清单：token 取自内容脚本捕获的登录态；抓不到就退回内置清单。
// ⚠️ 读 token 要带上界：`inFlight` 槽位在 `fetchLive` 的 `finally` 里释放，
// 而 storage 半死时那个 await 永不落地 ⇒ 槽位永久占住、清单再也刷不出来。
const zaiModelCatalog = createZaiModelCatalog({
  loadToken: async () => (await loadZaiAuthFromStorage(AUTH_READ_TIMEOUT_MS))?.token ?? null,
  fetchImpl: (input, init) => fetch(input, init),
});
const externalPayloadAuthorizationCache = new ExternalPayloadAuthorizationCache();
const {
  executeToolCall: executeRuntimeToolCall,
  getAuthorizationDescriptors: getRuntimeAuthorizationDescriptors,
  getToolDescriptors: getRuntimeToolDescriptors,
  refreshToolDescriptors: refreshRuntimeToolDescriptors,
} = createRuntimeToolRuntime(createProductionToolProviderRegistry(), {
  capabilityInvocationResolver: createMcpCapabilityInvocationResolver(),
});
let currentBackgroundLocale: SupportedLocale = DEFAULT_LOCALE;
let currentBackgroundTranslator = createTranslator(DEFAULT_LOCALE);
const syncLocalRecoveryBarrier = createSyncRecoveryBarrier({
  recover: recoverPendingSyncLocalApply,
  async notifyRecovered() {
    await Promise.all([
      broadcastStateUpdate(),
      broadcastProjectContextUpdate(),
      broadcastSavedItemsUpdate(),
    ]);
  },
  onRecoveryFailure(error) {
    reportBackgroundStartupError('sync_local_recovery_failed', error);
  },
  onNotificationFailure(error) {
    reportBackgroundStartupError('sync_local_recovery_broadcast_failed', error);
  },
});
const beginLocalStateMutation = createTrackedLocalStateMutationRunner({
  runWithRecovery: runLocalStateMutationWithRecovery,
  trackApply: (operation) => syncLocalRecoveryBarrier.trackApply(operation),
});
const persistenceMutations = createPersistenceMutationBindings({
  runLocalStateMutation: beginLocalStateMutation,
  stageDeleteSkillAlreadyLocked,
  stageDeleteSkillSourceAlreadyLocked,
  stageDeletePresetAlreadyLocked,
  stageDeleteProjectContextAndMemoriesAlreadyLocked,
  importGitHubSkillSource,
  importLocalSkillSource,
  updateLocalSkillSource,
  relocateLocalSkillSource,
  updateGitHubSkillSource,
  executeLocalSkillImporterToolCall,
});
const runtimeCommandRegistry = createRuntimeCommandRegistry({
  typedHandlers: [
    ...createDomTaskRuntimeHandlers({ coordinator: domTaskCoordinator }),
    ...createBootstrapRuntimeHandlers({
      getVersion: getExtensionVersion,
      dismissWhatsNew,
      refreshWhatsNewBadge,
    }),
    ...createDiagnosticsRuntimeHandlers({
      getVersion: getExtensionVersion,
    }),
    ...createPersistenceRuntimeHandlers({
      memory: {
        getAllMemories,
        getMemoryById,
        saveMemory,
        importMemoriesAtomically,
        updateMemory,
        deleteMemory,
        touchMemories,
        notifyCommittedStateUpdate,
      },
      skill: {
        getLocale: () => currentBackgroundLocale,
        getAllSkills: (locale) => getAllSkills({ locale }),
        getSkillLibrary,
        getAllSkillSources,
        saveSkill,
        deleteSkill: persistenceMutations.deleteSkill,
        setSkillEnabled,
        setSkillsEnabled,
        previewGitHubSkillSource,
        importGitHubSkillSource: persistenceMutations.importGitHubSkillSource,
        previewLocalSkillSource: (rootPath) => previewLocalSkillSource(
          rootPath,
          { executeToolCall: executeLocalSkillImporterToolCall },
        ),
        pickLocalSkillFolder: (defaultPath) => pickLocalSkillFolder(
          defaultPath,
          { executeToolCall: executeLocalSkillImporterToolCall },
        ),
        importLocalSkillSource: persistenceMutations.importLocalSkillSource,
        updateLocalSkillSource: persistenceMutations.updateLocalSkillSource,
        relocateLocalSkillSource: persistenceMutations.relocateLocalSkillSource,
        checkGitHubSkillSourceUpdates,
        updateGitHubSkillSource: persistenceMutations.updateGitHubSkillSource,
        deleteGitHubSkillSource: persistenceMutations.deleteGitHubSkillSource,
        broadcastStateUpdate,
      },
      library: {
        getAllPresets,
        savePreset,
        deletePreset: persistenceMutations.deletePreset,
        setActivePresetId,
        getActivePreset,
        getPromptInjectionSettings,
        savePromptInjectionSettings,
        getSkillAutoActivationSettings,
        saveSkillAutoActivationSettings,
        getAllSavedItems,
        saveSavedItem,
        deleteSavedItem,
        insertPromptIntoActiveGLMTab,
        broadcastStateUpdate,
        broadcastSavedItemsUpdate,
      },
      project: {
        getProjectContextState,
        createProjectContext,
        updateProjectContext,
        deleteProjectContext: persistenceMutations.deleteProjectContext,
        addConversationToProject,
        removeConversationFromProject,
        setPendingProjectContext,
        getCurrentGLMConversation,
        bindPendingProjectConversation,
        refreshProjectConversation,
        getProjectForConversation,
        getProjectPromptContextForConversation,
        formatProjectPromptContext,
        getLocale: () => currentBackgroundLocale,
        notifyCommittedProjectContextUpdate,
        notifyCommittedStateUpdate,
      },
      localPreference: {
        broadcastStateUpdate,
        getBackgroundConfig,
        saveBackgroundConfig,
        clearBackgroundConfig,
        broadcastBackgroundUpdate,
      },
    }),
    ...createToolRuntimeHandlers({
      mcp: {
        getAllMcpServers,
        getMcpCapabilitySettings,
        updateMcpCapabilitySettings,
        setMcpCapabilityServerExposure,
        getMcpServerById,
        createMcpServer,
        updateMcpServer,
        deleteMcpServer,
        getMcpToolCache,
        refreshMcpServerDiscovery,
        getMcpOriginPattern,
        hasMcpServerOriginPermission,
        broadcastMcpServersUpdate,
        broadcastToolDescriptorsUpdate,
      },
      browser: {
        getWebToolSettings,
        setWebToolEnabled,
        getBrowserControlSettings,
        saveBrowserControlSettings,
        setBrowserControlEnabled,
        getBrowserControlState,
        setBrowserControlTarget: (tabId) => browserControlService.setTarget(tabId),
        detachBrowserControl: () => browserControlService.detach(),
        requestHostPermission: (origins) => chrome.permissions.request({ origins }),
        fetch: (input, init) => fetch(input, init),
        broadcastToolDescriptorsUpdate,
        broadcastBrowserControlUpdate,
      },
      execution: {
        getLocale: () => currentBackgroundLocale,
        getToolDescriptors: getRuntimeToolDescriptors,
        getPromptToolDescriptors: getPromptToolDescriptors,
        getAuthorizationDescriptors: getRuntimeAuthorizationDescriptors,
        refreshToolDescriptors: refreshRuntimeToolDescriptors,
        createToolAuthorization,
        // Validate whether a directory belongs to an imported local
        // skill (owned and trusted by background).
        validateLocalSkillDirectory: async (dir: string): Promise<boolean> => {
          if (!dir) return false;
          const sources = await getAllSkillSources();
          // Treat dir as trusted when it matches an imported local
          // skill source's root path, OR when it matches the actual install
          // directory (localDirectory) of any imported local skill. The latter
          // is required because activeLocalSkillDir is set to the skill's
          // localDirectory (e.g. rootPath/subSkill) rather than the source
          // rootPath when a multi-skill folder is imported.
          if (sources.some(
            (source) => source.provider === 'local' && source.rootPath === dir,
          )) {
            return true;
          }
          const skills = await getAllSkills({ includeDisabled: true });
          return skills.some(
            (skill) => skill.remote?.provider === 'local' && skill.remote?.localDirectory === dir,
          );
        },
        closeToolAuthorization,
        authorizeExternalToolPayloadChunk,
        createToolAuthorizationResult,
        createInvalidToolCallResult,
        externalPayloadAuthorizationCache,
        appendExternalizedToolPayloadChunk,
        clearExternalizedToolPayloadNamespace,
        executeToolCall: executeRuntimeToolCall,
        getToolCallHistory,
        clearToolCallHistory,
        getPlatformEnvironment: getCurrentPlatformEnvironment,
        createRequestId: () => crypto.randomUUID(),
        now: () => Date.now(),
        broadcastToolDescriptorsUpdate,
        broadcastMcpServersUpdate,
        broadcastToolCallHistoryUpdate,
        notifyStateCommitted: notifyCommittedStateUpdate,
      },
    }),
    ...createBackgroundRuntimeHandlers({
      usage: {
        recordUsageTurn,
        getUsageSummary,
        clearUsageRecords,
      },
      automation: {
        getAllAutomations,
        getAutomationRuns,
        createAutomation,
        updateAutomation,
        setAutomationStatus,
        clearAutomationError: (id) => updateAutomationRuntime(id, { lastError: null }),
        deleteAutomation,
        refreshAutomationNextRunAt,
        cancelActiveAutomationRun,
        runAutomationNow,
        broadcastAutomationUpdate,
        broadcastAutomationRunsUpdate,
      },
      zaiModel: {
        getModelList: () => zaiModelCatalog.list(),
      },
    }),
  ],
});

function backgroundT(key: LocaleMessageKey, params?: MessageParams): string {
  return currentBackgroundTranslator.t(key, params);
}

async function refreshBackgroundLocale(): Promise<void> {
  // ⚠️ 读 locale 要带上界：storage 半死时那个 await 永不落地 ⇒ 这句之后的
  // `currentBackgroundLocale` 与 broadcast 全都不执行。
  const resolved = await getResolvedLocaleState(LOCALE_READ_TIMEOUT_MS);
  currentBackgroundLocale = resolved.locale;
  currentBackgroundTranslator = createTranslator(resolved.locale);
}
type SidePanelApi = {
  setPanelBehavior?: (options: { openPanelOnActionClick: boolean }) => Promise<void>;
};

type ActionApi = {
  setBadgeText?: (details: { text: string }) => Promise<void> | void;
  setBadgeBackgroundColor?: (details: { color: string }) => Promise<void> | void;
};

export default defineBackground(() => {
  void syncLocalRecoveryBarrier.ensureReady().catch(acknowledgeReportedSyncRecoveryFailure);
  enableSidePanelActionClick();
  registerWhatsNewInstallListener();
  registerAutomationAlarmListener();
  refreshBackgroundLocale()
    .catch((error) => reportBackgroundStartupError('locale_init_failed', error));
  watchLocalePreference(() => {
    refreshBackgroundLocale()
      .then(async () => {
        await broadcastStateUpdate();
        await broadcastToolDescriptorsUpdate();
      })
      .catch((error) => reportBackgroundStartupError('locale_refresh_failed', error));
  });

  syncLocalRecoveryBarrier.ensureReady()
    .then(() => archiveStaleMemories()
      .catch((error) => reportBackgroundStartupError('archive_stale_memories_failed', error)))
    .catch(acknowledgeReportedSyncRecoveryFailure);
  ensureBuiltInMcpPresets().catch((error) => reportBackgroundStartupError('builtin_mcp_presets_failed', error));
  refreshWhatsNewBadge().catch((error) => reportBackgroundStartupError('whats_new_badge_failed', error));
  ensureAutomationWakeAlarm().catch((error) => reportBackgroundStartupError('automation_alarm_create_failed', error));
  syncLocalRecoveryBarrier.ensureReady()
    .then(() => scanDueAutomationsFromWake()
      .catch((error) => reportBackgroundStartupError('automation_startup_scan_failed', error)))
    .catch(acknowledgeReportedSyncRecoveryFailure);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    let envelope: RuntimeMessageEnvelope | undefined;
    let context: RuntimeMessageContext;
    try {
      envelope = decodeRuntimeMessageEnvelope(message);
      context = createRuntimeMessageContext(sender, {
        runtimeId: chrome.runtime.id,
        extensionOrigin: chrome.runtime.getURL('/'),
        glmOrigin: new URL(ZAI_HOME_URL).origin,
      });
      authorizeRuntimeMessage(envelope, context);
    } catch (error) {
      sendResponse(createRuntimeBoundaryErrorResponse(error, envelope));
      return false;
    }

    const contextForDispatch = requiresCurrentToolAuthorizationSubject(envelope.type)
      ? refreshRuntimeMessageContextFromBrowserTab(context, {
        tabs: chrome.tabs,
        glmOrigin: new URL(ZAI_HOME_URL).origin,
      })
      : Promise.resolve(context);

    contextForDispatch
      .then((currentContext) => syncLocalRecoveryBarrier.ensureReady()
        .then(() => handleMessage(envelope, currentContext)))
      .then(sendResponse)
      .catch((error) => sendResponse(error instanceof RuntimeBoundaryError
        ? createRuntimeBoundaryErrorResponse(error, envelope)
        : createBackgroundErrorResponse(
          envelope,
          error,
          backgroundT('content.toolBlock.summaries.backgroundFailed'),
        )));
    return true;
  });
});

function registerAutomationAlarmListener() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== AUTOMATION_WAKE_ALARM_NAME) return;
    syncLocalRecoveryBarrier.ensureReady()
      .then(() => scanDueAutomationsFromWake()
        .catch((error) => reportBackgroundStartupError('automation_alarm_scan_failed', error)))
      .catch(acknowledgeReportedSyncRecoveryFailure);
  });
}

async function ensureAutomationWakeAlarm() {
  await chrome.alarms.create(AUTOMATION_WAKE_ALARM_NAME, {
    periodInMinutes: AUTOMATION_WAKE_INTERVAL_MINUTES,
  });
}

function enableSidePanelActionClick() {
  const sidePanel = readOptionalChromeApi(
    () => (chrome as typeof chrome & { sidePanel?: SidePanelApi }).sidePanel,
  );
  sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
    .catch((error) => reportBackgroundStartupError('sidepanel_behavior_failed', error));
}

function registerWhatsNewInstallListener() {
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason !== 'update') return;

    markWhatsNewPending(details.previousVersion ?? null)
      .then(() => refreshWhatsNewBadge())
      .catch((error) => reportBackgroundStartupError('whats_new_update_failed', error));
  });
}

async function refreshWhatsNewBadge() {
  const action = readOptionalChromeApi(
    () => (chrome as typeof chrome & { action?: ActionApi }).action,
  );
  if (!action?.setBadgeText) return;

  const showBadge = await hasPendingWhatsNew();
  await action.setBadgeText({ text: showBadge ? 'NEW' : '' });
  if (showBadge && action.setBadgeBackgroundColor) {
    await action.setBadgeBackgroundColor({ color: '#4D6BFE' });
  }
}

async function ensureBuiltInMcpPresets() {
  const servers = await getAllMcpServers();
  const shellServer = servers.find(isShellMcpServer);
  if (!shellServer) {
    await createMcpServer(createShellMcpPresetInput({ enabled: false }));
  } else {
    await ensureShellMcpCompatibility(shellServer);
  }
}

async function ensureShellMcpCompatibility(server: McpServerConfig) {
  let nextServer = server;
  // ⚠️ **工具上限与 allowlist 都要升** —— 只升 allowlist 的话，默认值改了也只对新装生效：
  // 存量记录的 `limits` 由 `normalizeServerForMutation` 从存储原样读出，
  // 而 `maxToolCount` 小于 host 工具总数时，尾部工具会在发现阶段被静默截断。
  const upgradedLimits = buildShellToolLimitUpgrade(server.limits);
  const upgradedAllowlist = buildShellAllowlistUpgrade(server.allowlist);
  if (upgradedLimits || upgradedAllowlist) {
    nextServer = await updateMcpServer(server.id, {
      ...(upgradedLimits ? { limits: upgradedLimits } : {}),
      ...(upgradedAllowlist ? { allowlist: upgradedAllowlist } : {}),
    }) ?? server;
  }

  if (!nextServer.enabled || !nextServer.execution.enabled || nextServer.execution.mode === 'disabled') {
    return;
  }

  const hasCache = Boolean(await getMcpToolCache(nextServer.id));
  if (!hasCache && !upgradedAllowlist && !upgradedLimits) return;

  try {
    await refreshMcpServerDiscovery(nextServer.id);
  } catch (error) {
    reportBackgroundStartupError('shell_mcp_discovery_refresh_failed', error);
  }
}

function reportBackgroundStartupError(code: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[GLM++] ${code}: ${detail}`, error);
}

function acknowledgeReportedSyncRecoveryFailure(error: unknown): void {
  // The recovery barrier invokes onRecoveryFailure before rejecting. Startup
  // observers consume that already-reported rejection to prevent an unhandled promise.
  void error;
}

async function handleMessage(
  message: RuntimeMessageEnvelope,
  context: RuntimeMessageContext,
) {
  return runtimeCommandRegistry.dispatch(message, context);
}

async function executeLocalSkillImporterToolCall(call: ToolCall): Promise<ToolResult> {
  return executeBackgroundRuntimeToolCall(call, 'manual_chat');
}

async function broadcastToTabs(payload: Record<string, unknown>, excludeTabId?: number) {
  await broadcastRuntimeUpdate(payload, excludeTabId, {
    tabUrlPattern: ZAI_TAB_URL_PATTERN,
    sendRuntimeMessage: (message) => chrome.runtime.sendMessage(message),
    queryTabsByUrl: (urlPattern) => chrome.tabs.query({ url: urlPattern }),
    sendTabMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
    reportError: reportBackgroundStartupError,
  });
}

async function broadcastStateUpdate(excludeTabId?: number) {
  const [memories, skills, activePreset, promptSettings, skillAutoActivation] = await Promise.all([
    getAllMemories(),
    getAllSkills({ locale: currentBackgroundLocale }),
    getActivePreset(),
    getPromptInjectionSettings(),
    getSkillAutoActivationSettings(),
  ]);
  await broadcastToTabs({ type: 'STATE_UPDATED', memories, skills, activePreset, promptSettings, skillAutoActivation }, excludeTabId);
}

async function notifyCommittedStateUpdate(excludeTabId?: number): Promise<void> {
  try {
    await broadcastStateUpdate(excludeTabId);
  } catch (error) {
    reportBackgroundStartupError('committed_state_broadcast_failed', error);
  }
}

async function broadcastBackgroundUpdate(config: BackgroundConfig | null) {
  await broadcastToTabs({ type: 'BACKGROUND_UPDATED', config });
}

async function broadcastMcpServersUpdate(excludeTabId?: number) {
  const servers = await getAllMcpServers();
  await broadcastToTabs({ type: 'MCP_SERVERS_UPDATED', servers }, excludeTabId);
}

async function broadcastToolDescriptorsUpdate(excludeTabId?: number) {
  const toolDescriptors = await getRuntimeToolDescriptors(currentBackgroundLocale);
  await broadcastToTabs({ type: 'TOOL_DESCRIPTORS_UPDATED', toolDescriptors }, excludeTabId);
}

async function broadcastBrowserControlUpdate(excludeTabId?: number) {
  await broadcastToTabs({ type: 'BROWSER_CONTROL_UPDATED' }, excludeTabId);
}

async function broadcastToolCallHistoryUpdate(excludeTabId?: number) {
  await broadcastToTabs({ type: 'TOOL_CALL_HISTORY_UPDATED' }, excludeTabId);
}

async function broadcastProjectContextUpdate(excludeTabId?: number) {
  const state = await getProjectContextState();
  await broadcastToTabs({ type: 'PROJECT_CONTEXT_UPDATED', state }, excludeTabId);
}

async function notifyCommittedProjectContextUpdate(excludeTabId?: number): Promise<void> {
  try {
    await broadcastProjectContextUpdate(excludeTabId);
  } catch (error) {
    reportBackgroundStartupError('committed_project_broadcast_failed', error);
  }
}

async function getCurrentGLMConversation(): Promise<
  { ok: true; conversation: CurrentGLMConversation } | { ok: false; error: string }
> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs.find((item) => item.id != null && isChatConversationUrl(item.url));
  if (!tab?.id) return { ok: false, error: 'no_active_glm_conversation' };

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_GLM_CONVERSATION' });
    if (response?.ok && response.conversation) {
      return { ok: true, conversation: response.conversation as CurrentGLMConversation };
    }
    return { ok: false, error: response?.error ?? 'no_current_conversation' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isGLMChatUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'chat.z.ai' && /^\/c\//.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** 当前活跃对话 URL（只匹配 chat.z.ai，项目页据此抓当前对话）。已不再支持 glm 域名。 */
function isChatConversationUrl(url: string | undefined): boolean {
  return isGLMChatUrl(url);
}

async function insertPromptIntoActiveGLMTab(
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (text.length === 0) {
    return { ok: false, error: 'empty_prompt_text' };
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs.find((item) => item.id != null && isGLMPageUrl(item.url));
  if (!tab?.id) {
    return { ok: false, error: backgroundT('background.auth.missingGLM') };
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'INSERT_PROMPT_TEXT', text });
    if (response?.ok) return { ok: true };
    return {
      ok: false,
      error: getPromptInsertionErrorMessage(response?.error),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getPromptInsertionErrorMessage(error: unknown): string {
  if (error === 'empty_prompt_text') return 'empty_prompt_text';
  if (error === 'prompt_input_not_found') return backgroundT('background.auth.missingGLM');
  return typeof error === 'string' && error.length > 0
    ? error
    : backgroundT('background.auth.missingGLM');
}

function isGLMPageUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname === 'chat.z.ai';
  } catch {
    return false;
  }
}

async function broadcastSavedItemsUpdate(excludeTabId?: number) {
  const savedItems = await getAllSavedItems();
  await broadcastToTabs({ type: 'SAVED_ITEMS_UPDATED', savedItems }, excludeTabId);
}

async function broadcastAutomationUpdate(excludeTabId?: number) {
  const automations = await getAllAutomations();
  await broadcastToTabs({ type: 'AUTOMATIONS_UPDATED', automations }, excludeTabId);
}

async function broadcastAutomationRunsUpdate(excludeTabId?: number) {
  await broadcastToTabs({ type: 'AUTOMATION_RUNS_UPDATED' }, excludeTabId);
}

async function executeBackgroundRuntimeToolCall(
  call: ToolCall,
  source: ToolExecutionTrigger,
  options?: RuntimeToolCallOptions,
): Promise<ToolResult> {
  return executeRuntimeToolCall(
    call,
    createTrustedToolExecutionContext(
      call,
      source,
      undefined,
      options?.trustedCapabilityScopeId,
    ),
    currentBackgroundLocale,
    options,
  );
}

async function getPromptToolDescriptors(
  locale: SupportedLocale,
  intent: string,
): Promise<ToolDescriptor[]> {
  const [descriptors, settings] = await Promise.all([
    getRuntimeToolDescriptors(locale),
    getMcpCapabilitySettings(),
  ]);
  return projectMcpCapabilityDescriptors({ descriptors, settings, intent }).descriptors;
}


async function scanDueAutomationsFromWake() {
  const result = await scanDueAutomations(executeAutomationWithContext);
  // `reconciled` 是「被改判为中断的悬挂 run」数：它同样改变侧边栏要显示的状态，
  // 漏掉它会出现「DB 已是 failed、UI 仍显示运行中」直到用户切走再切回。
  if (result.initialized > 0 || result.started > 0 || result.failed > 0 || result.reconciled > 0) {
    await broadcastAutomationUpdate();
  }
  if (result.started > 0 || result.failed > 0 || result.reconciled > 0) {
    await broadcastAutomationRunsUpdate();
    await broadcastToolCallHistoryUpdate();
  }
  return result;
}

async function runAutomationNow(id: string, excludeTabId?: number) {
  const automation = await getAutomationById(id);
  if (!automation) return { ok: false as const, error: 'automation_not_found' };

  const run = await runAutomation({
    automationId: id,
    trigger: 'manual',
    scheduledFor: null,
    executor: executeAutomationWithContext,
  });

  await broadcastAutomationUpdate(excludeTabId);
  await broadcastAutomationRunsUpdate(excludeTabId);
  await broadcastToolCallHistoryUpdate(excludeTabId);

  return run ?? { ok: false as const, error: 'automation_already_running' };
}

async function executeAutomationWithContext(
  request: AutomationRunnerRequest,
  execution: AutomationExecutionContext,
): Promise<AutomationRunnerResult> {
  execution.assertActive();
  const taskId = crypto.randomUUID();
  const prompt = request.prompt;
  // 固定会话：仅当该任务开启了 fixedSession 才沿用上次的 chatSessionId；
  // 否则传 null，强制每次新开对话（关闭开关 = 重新开一个窗口）。
  // 联网与固定会话互不影响：联网走扩展自带的 web_search / web_fetch，由内容脚本
  // 每轮注入目录，复用会话续写时同样可用。
  const searchEnabled = request.promptOptions?.searchEnabled === true;
  // 任务选定的模型（null = 跟随页面默认）。只在 chat 模式生效，判定在内容脚本。
  const model = request.promptOptions?.model ?? null;
  const chatSessionId = request.promptOptions?.fixedSession === true
    ? request.chatSessionId
    : null;

  let outcome;
  try {
    outcome = await domTaskCoordinator.startTask(
      {
        taskId,
        kind: 'automation',
        prompt,
        chatSessionId,
        searchEnabled,
        model,
      },
      {
        signal: execution.signal,
        deadlineAt: execution.deadlineAt,
        // 新会话在 chatNew 阶段读不到 /c/<id>，要等 SPA 跳转后才有值。一旦拿到就
        // 立刻落库：否则运行期间（以及中途暂停/点 Stop 之后的失败收尾）侧边栏
        // 一直显示会话「未创建」，「打开会话」按钮是灰的。
        onSessionStarted: (liveChatSessionId) => {
          void persistAutomationSession(request.automationId, liveChatSessionId);
        },
      },
    );
  } catch (error) {
    // coordinator 抛错（含 abort / deadline）→ 交给 scheduler 判定超时/取消。
    if (execution.signal.aborted) execution.assertActive();
    return createAutomationRunnerFailure(
      request,
      'dom_automation_failed',
      error instanceof Error ? error.message : String(error),
      'bridge',
      false,
      Date.now(),
      { externalOutcome: 'ambiguous', retrySafe: false },
    );
  }
  execution.assertActive();

  if (!outcome.ok) {
    const retrySafe = outcome.retrySafe === true;
    return createAutomationRunnerFailure(
      request,
      `dom_automation_${outcome.error}`,
      outcome.error,
      outcome.phase,
      retrySafe,
      Date.now(),
      { externalOutcome: retrySafe ? 'not_started' : 'ambiguous', retrySafe },
      // 失败也要把「页面上已经建好的会话」带回后台：用户中途暂停 / 点 Stop 时
      // 请求里的 chatSessionId 还是 null（新会话），只有这里能补上。
      outcome.chatSessionId,
    );
  }

  const finalChatSessionId = outcome.chatSessionId ?? chatSessionId;
  const completedAt = Date.now();
  return {
    ok: true,
    chatSessionId: finalChatSessionId ?? '',
    sessionUrl: finalChatSessionId ? buildZaiSessionUrl(finalChatSessionId) : null,
    parentMessageId: request.parentMessageId ?? 0,
    assistantMessageId: null,
    assistantText: outcome.assistantText,
    toolExecutions: outcome.toolExecutions,
    history: null,
    completedAt,
  };
}

function buildZaiSessionUrl(chatSessionId: string): string {
  return buildZaiChatSessionUrl(chatSessionId);
}

/**
 * 把「本次运行落在哪个会话」写进自动化记录。
 *
 * 运行期间就落库（不等 run 收尾）：中途暂停 / 点 Stop 会让 run 走失败收尾，
 * 而失败收尾的 runtimePatch 只有在 result 带 chatSessionId 时才写会话状态。
 * 提前落库能保证任何收尾路径下侧边栏都拿得到可打开的会话。
 */
async function persistAutomationSession(
  automationId: string,
  chatSessionId: string,
): Promise<void> {
  try {
    const automation = await getAutomationById(automationId);
    if (!automation) return;
    const nextSessionUrl = buildZaiSessionUrl(chatSessionId);
    // 早退条件必须校验 URL 与 id 一致：早期版本可能留下「新 id + 旧 url」的记录，
    // 只判存在性会跳过修复，「打开会话」会一直跳到上一次的对话。
    if (
      automation.glm.chatSessionId === chatSessionId &&
      automation.glm.sessionUrl === nextSessionUrl
    ) {
      return;
    }
    await updateAutomationRuntime(automationId, {
      glm: {
        ...automation.glm,
        chatSessionId,
        sessionUrl: nextSessionUrl,
      },
    });
    // 立刻广播：运行期间侧边栏就该能打开这个会话，不必等 run 收尾。
    await broadcastAutomationUpdate();
  } catch (error) {
    reportBackgroundStartupError('automation_session_persist_failed', error);
  }
}
