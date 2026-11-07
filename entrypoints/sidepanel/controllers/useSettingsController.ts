import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_BACKGROUND_OPACITY,
  clampBackgroundOpacity,
  normalizeBackgroundConfig,
} from '../../../core/background/config';
import { decodeRuntimeConfigResponse } from '../../../core/messaging/bootstrap-client';
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
 * Re-reads the stored background configuration for a write with no known base.
 *
 * Unlike the mount-time read this one **does not fall back**: the whole point is
 * to learn the current value, and a default would be written back as if it were
 * the truth. `null` normalizes to the empty config here, which is a real value —
 * the caller merges a patch into it either way.
 */
async function readBackgroundConfigForWrite(): Promise<BackgroundConfig> {
  const stored = await sidepanelRuntimeClient.request({ type: 'GET_BACKGROUND' });
  return normalizeBackgroundConfig(stored as BackgroundConfig | null) ?? DEFAULT_BACKGROUND_CONFIG;
}

/**
 * Copy for the memory-import entry point.
 *
 * `entryInvalid` is a function rather than a template string so the message goes
 * through the translator's own parameter formatting instead of hand-rolled
 * placeholder replacement.
 */
export interface ImportLabels {
  arrayError: string;
  jsonError: string;
  entryInvalid(index: number, field: string): string;
}

/**
 * A failure whose message is already the copy to show.
 *
 * The import path produces two kinds of error: ones that need translating (the
 * background's field paths, the parser's position string) and ones built from a
 * localized label here. This marks the second kind so the shared catch does not
 * run it through the translator twice.
 */
class LocalizedImportError extends Error {}

/**
 * Turns a background import failure into something a user can act on.
 *
 * `IMPORT_MEMORY_DRAFTS` reports the field-level decoder error verbatim, so the
 * raw value is a path string like `memories[3].content must be a non-empty
 * string`. The record index is the only part of that a user can use — it points
 * at the entry they have to fix in their file — so it is lifted out and wrapped
 * in localized copy. Anything else is passed through: an unrecognized message is
 * more useful than a generic one.
 */
function describeImportFailure(error: unknown, labels: ImportLabels): string {
  const raw = typeof error === 'string' ? error : '';
  if (!raw) return labels.jsonError;
  const entry = /^memories\[(\d+)\]\.([A-Za-z0-9_]+)/.exec(raw);
  // The decoder reports a zero-based index; the user is looking at a file,
  // where the first record is number one.
  if (entry) return labels.entryInvalid(Number(entry[1]) + 1, entry[2]);
  return raw;
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
  /**
   * Last background configuration this controller knows to be on disk.
   *
   * `null` means **unknown**, not "no background". The two are different states
   * and only one of them may be used as the base of a write: when the mount-time
   * read fails (an invalidated extension context, a slow service worker),
   * merging a patch into the default value would persist "background off, no
   * image" over whatever the user had.
   */
  const bgConfigRef = useRef<BackgroundConfig | null>(DEFAULT_BACKGROUND_CONFIG);

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
      // A failed read (`settingsLoadFallback` hands back `null`) must NOT be
      // projected onto the default configuration: `bgConfigRef` is the base every
      // write merges into, so "empty" here would be written back over the user's
      // saved background the next time any control on the page is touched.
      const normalizedBg = normalizeBackgroundConfig(bgCfg as BackgroundConfig | null);
      if (normalizedBg) {
        syncBgState(normalizedBg);
      } else {
        bgConfigRef.current = null;
      }
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
      // The base of the write is the last configuration known to be on disk.
      // When it is unknown, read it once more inside the same queue slot rather
      // than merging into a default: a failed read is not an empty background.
      const base = bgConfigRef.current ?? await readBackgroundConfigForWrite();
      const config = normalizeBackgroundConfig({
        ...base,
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
      // Returns the promise on purpose: `Slider` rolls the thumb back only when
      // `onCommit` rejects. The banner is the user-visible report, the rethrow is
      // what keeps the control from claiming a value that was never stored.
      return saveBgConfig({ opacity })
        .then(() => setBgOpacity(opacity))
        .catch((error) => {
          onBackgroundError(error);
          throw error;
        });
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

  /**
   * Imports a memory JSON file.
   *
   * `readText` is injected so the read itself can be exercised: `file.text()`
   * rejects when the file was moved or locked, and that rejection used to escape
   * before the `try` existed — the click looked like it did nothing at all.
   */
  const handleImport = useCallback(
    async (
      labels: ImportLabels,
      onResult?: (result: { ok: boolean; imported?: number; error?: string }) => void,
      readText: (file: File) => Promise<string> = (file) => file.text(),
    ) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const text = await readText(file);
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            // A syntax error carries the parser's own English position string.
            // Someone who broke a comma needs to be told it is the JSON, not
            // where the engine gave up.
            throw new LocalizedImportError(labels.jsonError);
          }
          if (!Array.isArray(parsed)) {
            throw new LocalizedImportError(labels.arrayError);
          }
          const result = await sidepanelRuntimeClient.request({
            type: 'IMPORT_MEMORY_DRAFTS',
            payload: { memories: parsed },
          });
          if (!result?.ok) {
            throw new Error(String(result?.error ?? labels.jsonError));
          }
          const imported = typeof result.count === 'number' ? result.count : parsed.length;
          // 这里不做 `+ imported` 的乐观更新：handler 在写入之后会广播 STATE_UPDATED，
          // 那份广播带的就是权威列表，两者相加会双计。
          onResult?.({ ok: true, imported });
        } catch (error) {
          if (error instanceof LocalizedImportError) {
            onResult?.({ ok: false, error: error.message });
            return;
          }
          // The runtime client rejects on a domain failure unless `acceptFailure`
          // is set, so the background's field-level message arrives here as an
          // exception. It is translated on the way out for the same reason.
          const message = error instanceof Error ? error.message : '';
          onResult?.({
            ok: false,
            error: message ? describeImportFailure(message, labels) : labels.jsonError,
          });
        }
      };
      input.click();
    },
    [],
  );

  /**
   * Clears every stored memory.
   *
   * One background command, one transaction, one state broadcast. Driving this
   * from a loop of `DELETE_MEMORY` calls meant N sequential round trips and N
   * full re-reads of the memory store (each delete acknowledged its own state
   * update), so the cost grew faster than the record count — a few hundred
   * memories already took seconds and left a half-cleared store on any failure.
   *
   * ⚠️ **"That record is already gone" no longer needs its own branch here** —
   * a single clear is idempotent by construction, so the race the loop had to
   * tolerate cannot occur. Other failures still propagate: a corrupted store or
   * a full quota has to reach the user.
   */
  const handleClearAllMemories = useCallback(async () => {
    await libraryController.clearMemories();
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