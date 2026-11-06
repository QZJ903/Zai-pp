import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_BACKGROUND_OPACITY,
  clampBackgroundOpacity,
  normalizeBackgroundConfig,
} from '../../../core/background/config';
import { decodeRuntimeConfigResponse } from '../../../core/messaging/bootstrap-client';
import { MEMORY_RECORD_MISSING_CODE } from '../../../core/messaging/error-code';
import { getRuntimeErrorMessage } from '../runtime-response';
import type { BackgroundConfig } from '../../../core/types';
import { sidepanelRuntimeClient } from '../runtime-client';
import { createSerialOperationQueue } from '../../../core/persistence/serial-operation-queue';
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

/**
 * 背景设置写入的串行队列（一个存储键一条）。
 *
 * 这些写入是「拿 ref 读 → 合并 → 写」，两次请求重叠时后完成的那个会把更旧的快照
 * 写回去。与 `core/browser-control/settings.ts` 同形 —— 那边把同一条危害写在了注释里。
 *
 * ⚠️ **它是模块级单例，而本 controller 有两个实例**（`SettingsPage` 与 `LibraryPage`
 * 各挂一个）。对「同一个存储键」来说这是**对的**：队列要串的是对那个键的写入，
 * 不是某个组件实例的写入。但 `LibraryPage` 那份走默认的 `LOG_BACKGROUND_ERROR`，
 * 它若哪天也发起背景写入，失败提示只会进控制台 —— 那种情况下要把它的 feedback 接上。
 */
const backgroundWriteQueue = createSerialOperationQueue();

function settingsLoadFallback<T>(label: string, fallback: T): (error: unknown) => T {
  return (error) => {
    console.log(`[Zai++] Failed to load ${label} settings.`, error);
    return fallback;
  };
}

/**
 * 背景设置写入失败的出口。
 *
 * 设置壳自己没有任何提示条（`GeneralSubPage` 不渲染 `StatusMessage`），所以由持有它的
 * 页面注入 —— 与 `useMemoryPageController` 的 feedback 通道同一个形状。没有它，一次
 * 失败的保存是不可见的，界面会继续显示一个从未写入过的值。
 */
export interface SettingsBackgroundFeedback {
  /** 拿到原始错误 —— 调用方持有 `t`，所以本地化也归它。 */
  error(error: unknown): void;
}

/** 默认只打日志：`LibraryPage` 也用这个 controller（为了记忆总数），但它不显示背景控件。 */
const LOG_BACKGROUND_ERROR: SettingsBackgroundFeedback = {
  error(error: unknown) {
    console.log('[Zai++] background settings write failed.', error);
  },
};

export function useSettingsController(feedback: SettingsBackgroundFeedback = LOG_BACKGROUND_ERROR) {
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

  const feedbackRef = useRef(feedback);
  feedbackRef.current = feedback;
  const onBackgroundError = useCallback((error: unknown) => {
    feedbackRef.current.error(error);
  }, []);

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
        // ⚠️ **这里只量长度，不解码。** 走 `libraryController.getMemories()` 会把整份记忆解一遍，
        // 而任何一条形状不合都会让这次读抛错 ⇒ 「设置页读不到记忆总数」。
        // 与下面 `STATE_UPDATED` 的处置同口径：只需要 `.length` 就不该承担解码的失败面。
        // 导出与清空那两处仍然解码 —— 它们要的是记录本身，不是长度。
        sidepanelRuntimeClient.request({ type: 'GET_MEMORIES' })
          .then((value) => (Array.isArray(value) ? value.length : null))
          .catch(settingsLoadFallback<number | null>('memory count', null)),
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
      setMemoryCount(memories);
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

  /**
   * 记忆总数跟着每一次已提交的记忆变更走。
   *
   * 只为拿一个 `.length` 而把整份记忆解一遍不划算，而且**一条形状不合的记忆会让
   * 「设置页读不到总数」** —— 所以这里只测量广播里的数组，不 decode。
   * `useMemoryPageController` 那边要渲染记录，才必须 decode，两种需求不该抄。
   */
  useEffect(() => {
    const applyMemoryCount = (message: { type?: string; memories?: unknown }) => {
      if (message.type !== 'STATE_UPDATED') return;
      if (!Array.isArray(message.memories)) return;
      setMemoryCount(message.memories.length);
    };
    // 兜一层：这个 controller 也被只桩了部分 runtime 面的单测挂载，
    // 缺了监听注册表不该把整页带崩。
    const messageBus = typeof chrome !== 'undefined' ? chrome.runtime?.onMessage : undefined;
    if (!messageBus) return;
    messageBus.addListener(applyMemoryCount);
    return () => messageBus.removeListener(applyMemoryCount);
  }, []);

  // --- background ---
  /**
   * 落盘一份背景补丁。
   *
   * ⚠️ **内存里的 ref 只在写入成功后才推进** —— 先推进会让一次失败的保存泄进下一次
   * 写入（实测：把开关关掉落库失败后再拖透明度，那个从未写成功的 `enabled: false`
   * 会跟着新透明度一起发出去）。
   */
  const saveBgConfig = useCallback(async (patch: Partial<BackgroundConfig>) => {
    return backgroundWriteQueue.run(async () => {
      const config = normalizeBackgroundConfig({
        ...bgConfigRef.current,
        ...patch,
      });
      if (!config) return;
      await sidepanelRuntimeClient.request({ type: 'SAVE_BACKGROUND', payload: config });
      bgConfigRef.current = config;
      // 落库成功才推进「已保存的 URL」—— 预览与开关的可用性都跟着它走，
      // 保证它们描述的是**实际生效**的背景，而不是输入框里正在打的字。
      setBgConfirmedUrl(config.url ?? '');
    });
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
      onBackgroundError(error);
    }
  }, [onBackgroundError]);

  const handleBgToggle = useCallback(
    async (enabled: boolean) => {
      try {
        await saveBgConfig({ enabled });
        setBgEnabled(enabled);
      } catch (error) {
        onBackgroundError(error);
      }
    },
    [onBackgroundError, saveBgConfig],
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
      try {
        await saveBgConfig({ enabled: true, type: 'upload', imageData: data, url: '' });
        setBgType('upload');
        setBgImageData(data);
        setBgEnabled(true);
        setBgConfirmedUrl('');
      } catch (error) {
        onBackgroundError(error);
      } finally {
        e.target.value = '';
      }
    },
    [onBackgroundError, resizeImage, saveBgConfig],
  );

  const handleUrlConfirm = useCallback(async () => {
    if (!bgUrl.trim()) return;
    try {
      await saveBgConfig({ enabled: true, type: 'url', url: bgUrl, imageData: '' });
      setBgType('url');
      setBgImageData('');
      setBgEnabled(true);
    } catch (error) {
      onBackgroundError(error);
    }
  }, [bgUrl, onBackgroundError, saveBgConfig]);

  /**
   * 透明度只在松手时提交。
   *
   * 每格 `input` 落一次盘的话，一个有 20 格的滑块一次拖动就是 20 次整份写入 + 20 次广播。
   */
  const handleOpacityCommit = useCallback(
    (val: number) => {
      const opacity = clampBackgroundOpacity(val);
      saveBgConfig({ opacity })
        .then(() => setBgOpacity(opacity))
        .catch(onBackgroundError);
    },
    [onBackgroundError, saveBgConfig],
  );

  /**
   * 清除背景。
   *
   * ⚠️ **必须和 `saveBgConfig` 走同一条队列** —— 它也是「改变这个存储键」的写，
   * 而队列存在的理由正是「后完成的那次会把更旧的快照写回去」。不改的话实测能复现：
   * 拖透明度的 `SAVE_BACKGROUND` 还在飞时点清除，序列是
   * `SAVE start → CLEAR start → CLEAR done → SAVE done` ⇒ 后完成的 SAVE 把 ref 改回
   * 清除前那份配置并 `setBgConfirmedUrl(url)`，界面又长回预览图，而存储是干净的。
   */
  const handleClearBg = useCallback(async () => {
    try {
      await backgroundWriteQueue.run(async () => {
        await sidepanelRuntimeClient.request({ type: 'CLEAR_BACKGROUND' });
        bgConfigRef.current = DEFAULT_BACKGROUND_CONFIG;
      });
      setBgEnabled(false);
      setBgType('upload');
      setBgUrl('');
      setBgConfirmedUrl('');
      setBgImageData('');
      setBgOpacity(DEFAULT_BACKGROUND_OPACITY);
    } catch (error) {
      onBackgroundError(error);
    }
  }, [onBackgroundError]);

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
          // 这里不做 `+ imported` 的乐观更新：handler 在写入之后会广播 STATE_UPDATED，
          // 那份广播带的就是权威列表，两者相加会双计。
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
    handleOpacityCommit,
    handleClearBg,
    // data
    handleExport,
    handleExportLogs,
    handleImport,
    handleClearAllMemories,
  };
}

export type SettingsState = ReturnType<typeof useSettingsController>;