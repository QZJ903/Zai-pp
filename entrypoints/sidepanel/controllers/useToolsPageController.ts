import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocaleMessageKey, MessageParams } from '../../../core/i18n';
import type { McpServerConfig, McpToolCacheEntry, PlatformEnvironment } from '../../../core/types';
import { createRequestGenerationFence } from '../async-state';
import { getRuntimeErrorMessage } from '../runtime-response';
import {
  createPythonToolTogglePatch,
  findMcpPreset,
  getMcpPresetInput,
  isMcpNativeMessagingSupported,
  isMcpToolEnabled,
  isShellMcpServer,
  mcpToolsController,
} from './mcp-tools-controller';

export type PythonBusyState = 'idle' | 'creating' | 'refreshing' | 'toggling';
export type ControllerMessageTone = 'success' | 'error' | 'warning' | 'info';

type Translator = (key: LocaleMessageKey, params?: MessageParams) => string;

export function useToolsPageController(t: Translator) {
  const [pythonServer, setPythonServer] = useState<McpServerConfig | null>(null);
  const [pythonCache, setPythonCache] = useState<McpToolCacheEntry | null>(null);
  const [pythonBusy, setPythonBusy] = useState<PythonBusyState>('idle');
  const [pythonMessage, setPythonMessage] = useState('');
  const [pythonMessageTone, setPythonMessageTone] = useState<ControllerMessageTone>('info');
  const [platform, setPlatform] = useState<PlatformEnvironment | null>(null);
  const pythonFence = useRef(createRequestGenerationFence());

  const loadPythonTool = useCallback(async () => {
    const generation = pythonFence.current.begin();
    try {
      const { servers, platform: environment } = await mcpToolsController.loadMcpServerState();
      if (!pythonFence.current.isCurrent(generation)) return;
      setPlatform(environment);
      const shell = servers.find(isShellMcpServer) ?? null;
      setPythonServer(shell);
      if (!shell) {
        setPythonCache(null);
        return;
      }
      const cache = await mcpToolsController.getToolCache(shell);
      if (pythonFence.current.isCurrent(generation)) setPythonCache(cache);
    } catch (error) {
      if (!pythonFence.current.isCurrent(generation)) return;
      setPythonMessageTone('error');
      setPythonMessage(getRuntimeErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    void loadPythonTool();
    const reloadForRuntimeUpdate = (message: { type?: string }) => {
      if (message.type === 'MCP_SERVERS_UPDATED' || message.type === 'TOOL_DESCRIPTORS_UPDATED') {
        void loadPythonTool();
      }
    };
    chrome.runtime.onMessage.addListener(reloadForRuntimeUpdate);
    return () => {
      pythonFence.current.invalidate();
      chrome.runtime.onMessage.removeListener(reloadForRuntimeUpdate);
    };
  }, [loadPythonTool]);

  const createPythonShell = useCallback(async () => {
    setPythonBusy('creating');
    setPythonMessage('');
    try {
      if (!isMcpNativeMessagingSupported(platform)) {
        setPythonMessageTone('error');
        setPythonMessage(t('sidepanel.toolsPage.pythonStatusUnsupported'));
        return;
      }
      if (findMcpPreset(pythonServer ? [pythonServer] : [], 'shell')) {
        setPythonMessageTone('info');
        setPythonMessage(t('sidepanel.toolsPage.shellExists'));
        return;
      }
      await mcpToolsController.createServer(getMcpPresetInput('shell'));
      setPythonMessageTone('success');
      setPythonMessage(t('sidepanel.toolsPage.shellCreated'));
      await loadPythonTool();
    } catch (error) {
      setPythonMessageTone('error');
      setPythonMessage(getRuntimeErrorMessage(error));
    } finally {
      setPythonBusy('idle');
    }
  }, [loadPythonTool, platform, pythonServer, t]);

  const refreshPythonTools = useCallback(async () => {
    if (!pythonServer) return;
    setPythonBusy('refreshing');
    setPythonMessage('');
    try {
      const cache = await mcpToolsController.connectServer(pythonServer, 'refresh');
      setPythonCache(cache);
      if (cache.descriptors.some((tool) => tool.name === 'python_exec')) {
        setPythonMessageTone('success');
        setPythonMessage(t('sidepanel.toolsPage.pythonFound'));
      } else {
        setPythonMessageTone('error');
        setPythonMessage(t('sidepanel.toolsPage.pythonMissingAfterRefresh'));
      }
      await loadPythonTool();
    } catch (error) {
      setPythonMessageTone('error');
      setPythonMessage(getRuntimeErrorMessage(error));
    } finally {
      setPythonBusy('idle');
    }
  }, [loadPythonTool, pythonServer, t]);

  const togglePython = useCallback(async () => {
    if (!pythonServer) return;
    const pythonExec = pythonCache?.descriptors.find((tool) => tool.name === 'python_exec');
    if (!pythonExec) {
      setPythonMessageTone('error');
      setPythonMessage(t('sidepanel.toolsPage.pythonMissingBeforeToggle'));
      return;
    }
    const shouldEnable = !isMcpToolEnabled(pythonServer, pythonExec);
    setPythonBusy('toggling');
    setPythonMessage('');
    try {
      const saved = await mcpToolsController.updateServer(
        pythonServer,
        createPythonToolTogglePatch(pythonServer, pythonExec),
      );
      if (!saved) throw new Error('MCP server no longer exists.');
      setPythonMessageTone('success');
      setPythonMessage(t(shouldEnable
        ? 'sidepanel.toolsPage.pythonEnabled'
        : 'sidepanel.toolsPage.pythonDisabled'));
      await loadPythonTool();
    } catch (error) {
      setPythonMessageTone('error');
      setPythonMessage(getRuntimeErrorMessage(error));
    } finally {
      setPythonBusy('idle');
    }
  }, [loadPythonTool, pythonCache, pythonServer, t]);

  return {
    pythonServer,
    pythonCache,
    pythonBusy,
    pythonMessage,
    pythonMessageTone,
    nativeMessagingSupported: isMcpNativeMessagingSupported(platform),
    createPythonShell,
    refreshPythonTools,
    togglePython,
  };
}
