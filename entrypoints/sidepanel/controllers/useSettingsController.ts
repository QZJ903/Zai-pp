import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_BACKGROUND_OPACITY,
  clampBackgroundOpacity,
  normalizeBackgroundConfig,
} from '../../../core/background/config';
import { decodeRuntimeConfigResponse } from '../../../core/messaging/bootstrap-client';
import { MEMORY_RECORD_MISSING_CODE } from '../../../core/messaging/error-code';
import { getRuntimeErrorMessage } from '../runtime-response';
import type {
  BackgroundConfig,
  Memory,
} from '../../../core/types';
import { sidepanelRuntimeClient } from '../runtime-client';
import { libraryController } from './library-controller';

/**
 * Central settings state + handlers.
 *
 * Previously SettingsPage.tsx held ~30 useState hooks and every handler inline.
 * Lifting them here lets each sub-page (General / Prompt / Usage ...)
 * consume only the slice it needs, while keeping the chrome.runtime message
 * contract byte-for-byte identical to the legacy implementation.
 */

const DEFAULT_BACKGROUND_CONFIG: BackgroundConfig = {
  enabled: false,
  type: 'upload',
  url: '',
  imageData: '',
  opacity: DEFAULT_BACKGROUND_OPACITY,
};

function settingsLoadFallback<T>(label: string, fallback: T): (error: unknown) => T {
  return (error) => {
    console.log(`[Zai++] Failed to load ${label} settings.`, error);
    return fallback;
  };
}

export function useSettingsController() {
  // --- shared / general ---
  /**
   * 记忆总数 —— **`null` 表示「没读到」，不是「没有记忆」**。
   *
   * ⚠️ 回落成 `0` 会让读取失败与「一条记忆都没有」长得一模一样，用户看不出该不该处理。
   * 渲染层把 `null` 画成占位符。
   */
  const [memoryCount, setMemoryCount] = useState<number | null>(null);
  const [version, setVersion] = useState('');
  const [loading, setLoading] = useState(true);

  // --- background ---
  /**
   * 「后台保活」开关（挂不挂 `chrome.debugger`）。
   *
   * ⚠️ **默认 false** = 与 `DEFAULT_TAB_KEEPALIVE_SETTINGS` 一致。
   * ⚠️ 首帧用 false 的另一个好处：加载完成前显示「关」比显示「开」安全 ——
   * 用户若在这几百毫秒里看到「开」，会以为它一直在挂调试横幅。
   */
  const [keepaliveEnabled, setKeepaliveEnabled] = useState(false);
  const [bgEnabled, setBgEnabled] = useState(false);
  const [bgType, setBgType] = useState<'upload' | 'url'>('upload');
  const [bgUrl, setBgUrl] = useState('');
  /**
   * **已保存**的 URL，与输入框的实时值 `bgUrl` 分开。
   *
   * ⚠️ 预览不能用 `bgUrl` —— 那样每敲一个字符都会把半截 URL 当成图片地址去加载，
   * 而加载失败的 `onError` 会把输入框清空，形成「打字即被抹掉、永远填不完」的死循环。
   * 预览只反映已落库的配置，输入过程与它无关。
   */
  const [bgConfirmedUrl, setBgConfirmedUrl] = useState('');
  const [bgImageData, setBgImageData] = useState('');
  const [bgOpacity, setBgOpacity] = useState(DEFAULT_BACKGROUND_OPACITY);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const bgConfigRef = useRef<BackgroundConfig>(DEFAULT_BACKGROUND_CONFIG);

  const bgPreview = bgType === 'url' ? bgConfirmedUrl : bgImageData;

  const syncBgState = useCallback((config: BackgroundConfig) => {
    bgConfigRef.current = config;
    setBgEnabled(config.enabled);
    setBgType(config.type);
    setBgUrl(config.url ?? '');
    setBgConfirmedUrl(config.url ?? '');
    setBgImageData(config.imageData ?? '');
    setBgOpacity(config.opacity);
  }, []);

  // --- initial load ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [memories, cfg, bgCfg, keepalive] = await Promise.all([
        libraryController.getMemories()
          .catch(settingsLoadFallback<Memory[] | null>('memory count', null)),
        sidepanelRuntimeClient.request(
          { type: 'GET_CONFIG' },
          { decode: decodeRuntimeConfigResponse },
        )
          .catch(settingsLoadFallback('extension version', undefined)),
        sidepanelRuntimeClient.request({ type: 'GET_BACKGROUND' })
          .catch(settingsLoadFallback('background', null)),
        sidepanelRuntimeClient.request({ type: 'GET_TAB_KEEPALIVE_SETTINGS' })
          .catch(settingsLoadFallback('tab keepalive', null)),
      ]);
      if (cancelled) return;
      setMemoryCount(memories ? memories.length : null);
      setVersion(cfg && 'version' in cfg ? cfg.version : '');
      const normalizedBg = normalizeBackgroundConfig(bgCfg as BackgroundConfig | null);
      if (normalizedBg) syncBgState(normalizedBg);
      // ⚠️ **读不到就保持 false** —— 与后台的归一化同口径
      // （`normalizeTabKeepaliveSettings` 只在显式 `=== true` 时开）。
      if (keepalive && typeof keepalive === 'object' && 'enabled' in keepalive) {
        setKeepaliveEnabled((keepalive as { enabled?: unknown }).enabled === true);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [syncBgState]);

  // --- background ---
  const saveBgConfig = useCallback(async (patch: Partial<BackgroundConfig>) => {
    const config = normalizeBackgroundConfig({
      ...bgConfigRef.current,
      ...patch,
    });
    if (!config) return;
    bgConfigRef.current = config;
    await sidepanelRuntimeClient.request({ type: 'SAVE_BACKGROUND', payload: config });
    // 落库成功才推进「已保存的 URL」—— 预览与开关的可用性都跟着它走，
    // 保证它们描述的是**实际生效**的背景，而不是输入框里正在打的字。
    setBgConfirmedUrl(config.url ?? '');
  }, []);

  /**
   * 切换「后台保活」。
   *
   * ⚠️ **先落库再改 state** —— 反过来会让界面显示成已关、实际后台还挂着
   * （`setTabKeepaliveEnabled` 里会同时卸掉已挂的会话，失败时必须能看出来）。
   */
  const handleKeepaliveToggle = useCallback(async (enabled: boolean) => {
    try {
      await sidepanelRuntimeClient.request({
        type: 'SET_TAB_KEEPALIVE_ENABLED',
        payload: { enabled },
      });
      setKeepaliveEnabled(enabled);
    } catch (error) {
      console.log('[Zai++] setting the tab keepalive switch failed', error);
    }
  }, []);

  const handleBgToggle = useCallback(
    async (enabled: boolean) => {
      setBgEnabled(enabled);
      await saveBgConfig({ enabled });
    },
    [saveBgConfig],
  );

  const resizeImage = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const MAX = 1920;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          const scale = Math.min(MAX / width, MAX / height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Failed to load image'));
      };
      img.src = objectUrl;
    });
  }, []);

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      let data: string;
      try {
        data = await resizeImage(file);
      } catch {
        return;
      }
      setBgType('upload');
      setBgImageData(data);
      setBgEnabled(true);
      bgConfigRef.current = {
        ...bgConfigRef.current,
        enabled: true,
        type: 'upload',
        imageData: data,
        url: '',
      };
      await saveBgConfig({ enabled: true, type: 'upload', imageData: data, url: '' });
      e.target.value = '';
    },
    [resizeImage, saveBgConfig],
  );

  const handleUrlConfirm = useCallback(async () => {
    if (!bgUrl.trim()) return;
    setBgType('url');
    setBgImageData('');
    setBgEnabled(true);
    bgConfigRef.current = {
      ...bgConfigRef.current,
      enabled: true,
      type: 'url',
      url: bgUrl,
      imageData: '',
    };
    await saveBgConfig({ enabled: true, type: 'url', url: bgUrl, imageData: '' });
  }, [bgUrl, saveBgConfig]);

  const handleOpacityChange = useCallback(
    (val: number) => {
      const opacity = clampBackgroundOpacity(val);
      setBgOpacity(opacity);
      bgConfigRef.current = {
        ...bgConfigRef.current,
        opacity,
      };
      void saveBgConfig({ opacity });
    },
    [saveBgConfig],
  );

  const handleClearBg = useCallback(async () => {
    setBgEnabled(false);
    setBgType('upload');
    setBgUrl('');
    setBgConfirmedUrl('');
    setBgImageData('');
    setBgOpacity(DEFAULT_BACKGROUND_OPACITY);
    bgConfigRef.current = DEFAULT_BACKGROUND_CONFIG;
    await sidepanelRuntimeClient.request({ type: 'CLEAR_BACKGROUND' });
  }, []);

  // --- data ---
  const handleExport = useCallback(async () => {
    const memories = await libraryController.getMemories();
    const blob = new Blob([JSON.stringify(memories, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zai-memories-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleExportLogs = useCallback(async () => {
    const result = await sidepanelRuntimeClient.request({ type: 'EXPORT_DIAGNOSTIC_LOGS' });
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zai-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleImport = useCallback(
    async (
      labels: { arrayError: string; jsonError: string },
      onResult?: (result: { ok: boolean; imported?: number; error?: string }) => void,
    ) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const text = await file.text();
        try {
          const parsed: unknown = JSON.parse(text);
          if (!Array.isArray(parsed)) {
            throw new Error(labels.arrayError);
          }
          const result = await sidepanelRuntimeClient.request({
            type: 'IMPORT_MEMORY_DRAFTS',
            payload: { memories: parsed },
          });
          if (!result?.ok) {
            throw new Error(result?.error || labels.jsonError);
          }
          const imported = typeof result.count === 'number' ? result.count : parsed.length;
          setMemoryCount((count) => (count === null ? null : count + imported));
          onResult?.({ ok: true, imported });
        } catch (error) {
          onResult?.({ ok: false, error: error instanceof Error ? error.message : labels.jsonError });
        }
      };
      input.click();
    },
    [],
  );

  const handleClearAllMemories = useCallback(async () => {
    const memories = await libraryController.getMemories();
    for (const mem of memories) {
      const id = mem.id;
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
        throw new Error('Memory id is missing.');
      }
      try {
        await libraryController.deleteMemory(id);
      } catch (error) {
        // ⚠️ **「这一条已经不在了」在这里算成功，不报错** —— 本函数的语义是
        // 「让这些 id 都不存在」，已经不在了 ⇒ 目标已达成。
        // ⚠️ **与记忆页单条删除的口径不同是有意的**：那里「不在了」是**意外**
        // （用户以为删掉了、其实这条早被别处删了，界面要告诉他），而这里是**遍历清空**，
        // 中间任何一条被别处删掉都属正常竞态；把它当失败会让整个「清空全部」中断在
        // 半路，且报出一个用户无法理解的蛇形码。
        // ⚠️ **其它错误照抛** —— 存储坏了、配额满了这些必须让用户看见。
        if (getRuntimeErrorMessage(error) === MEMORY_RECORD_MISSING_CODE) continue;
        throw error;
      }
    }
    setMemoryCount(0);
  }, []);

  return {
    // shared
    loading,
    memoryCount,
    version,
    // background
    bgEnabled,
    bgType,
    bgUrl,
    setBgUrl,
    bgImageData,
    bgOpacity,
    bgPreview,
    fileInputRef,
    keepaliveEnabled,
    handleKeepaliveToggle,
    handleBgToggle,
    handleFileSelect,
    handleUrlConfirm,
    handleOpacityChange,
    handleClearBg,
    // data
    handleExport,
    handleExportLogs,
    handleImport,
    handleClearAllMemories,
  };
}

export type SettingsState = ReturnType<typeof useSettingsController>;