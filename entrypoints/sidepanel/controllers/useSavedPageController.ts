import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocaleMessageKey, MessageParams } from '../../../core/i18n';
import { PAGE_CONTENT_SCRIPT_MISSING_CODE } from '../../../core/messaging/error-code';
import type { SavedItem, SavedItemInput } from '../../../core/saved-items/types';
import { createRequestGenerationFence } from '../async-state';
import { formatRuntimeError } from '../runtime-response';
import { decodeSavedItemList, libraryController } from './library-controller';

type Translator = (key: LocaleMessageKey, params?: MessageParams) => string;
type Confirm = (options: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}) => Promise<boolean>;
type Feedback = {
  clear(): void;
  success(message: string): void;
  error(message: string): void;
};

export function useSavedPageController(t: Translator, confirm: Confirm, feedback: Feedback) {
  const [items, setItems] = useState<SavedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const requestFence = useRef(createRequestGenerationFence());
  const translatorRef = useRef(t);
  const feedbackRef = useRef(feedback);
  translatorRef.current = t;
  feedbackRef.current = feedback;

  const operationError = useCallback((error: unknown) => {
    feedbackRef.current.error(translatorRef.current('sidepanel.savedPage.operationFailed', {
      error: formatRuntimeError(error, translatorRef.current, { bare: true }),
    }));
  }, []);

  const load = useCallback(async () => {
    const generation = requestFence.current.begin();
    try {
      const next = await libraryController.getSavedItems();
      if (!requestFence.current.isCurrent(generation)) return;
      setItems(next);
      setLoadFailed(false);
    } catch (error) {
      if (!requestFence.current.isCurrent(generation)) return;
      setLoadFailed(true);
      operationError(error);
    } finally {
      if (requestFence.current.isCurrent(generation)) setLoading(false);
    }
  }, [operationError]);

  useEffect(() => {
    void load();
    const applySavedItemsUpdate = (message: { type?: string; savedItems?: unknown }) => {
      if (message.type !== 'SAVED_ITEMS_UPDATED') return;
      requestFence.current.invalidate();
      setLoading(false);
      try {
        setItems(decodeSavedItemList(message.savedItems, 'savedItemsUpdate'));
        setLoadFailed(false);
      } catch (error) {
        setLoadFailed(true);
        operationError(error);
      }
    };
    chrome.runtime.onMessage.addListener(applySavedItemsUpdate);
    return () => {
      requestFence.current.invalidate();
      chrome.runtime.onMessage.removeListener(applySavedItemsUpdate);
    };
  }, [load, operationError]);

  const save = useCallback(async (payload: SavedItemInput): Promise<boolean> => {
    try {
      feedback.clear();
      await libraryController.saveSavedItem(payload);
      feedback.success(t('sidepanel.savedPage.saved'));
      await load();
      return true;
    } catch (error) {
      operationError(error);
      return false;
    }
  }, [feedback, load, operationError, t]);

  const remove = useCallback(async (id: string) => {
    const approved = await confirm({
      title: t('sidepanel.savedPage.deleteConfirm'),
      message: t('sidepanel.savedPage.deleteConfirm'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    });
    if (!approved) return;
    try {
      feedback.clear();
      await libraryController.deleteSavedItem(id);
      await load();
    } catch (error) {
      operationError(error);
    }
  }, [confirm, feedback, load, operationError, t]);

  const insertPrompt = useCallback(async (text: string) => {
    try {
      feedback.clear();
      await libraryController.insertSavedPrompt(text);
      feedback.success(t('sidepanel.savedPage.inserted'));
    } catch (error) {
      /**
       * ⚠️⚠️ **后台只能回码，文案在这一侧翻。**
       *
       * 「标签页里没有活着的内容脚本」（扩展刚重载 / 页面还没加载完）时
       * `chrome.tabs.sendMessage` 抛的是**英文技术串**
       * （`Could not establish connection. Receiving end does not exist.`），
       * 而 `formatRuntimeError` 只翻「裸错误码」、自然语言原样透出
       * ⇒ 用户看到一句英文，也不知道该刷新页面。
       *
       * ⚠️ 后台**不能**直接返回中文：`BACKGROUND_LOCALE_SECTIONS` 只含
       * `content` / `background` / `tool` / `prompt` 四段，`common` 不在里面
       * （那是把侧边栏资源挡在 service worker 包外的结构预算）。
       * ⇒ 与自动化链同一套做法：**后台回码、侧边栏映射**。
       */
      const raw = formatRuntimeError(error, t, { bare: true });
      const message = raw === PAGE_CONTENT_SCRIPT_MISSING_CODE
        ? t('common.pageContentScriptMissing')
        : raw;
      feedback.error(t('sidepanel.savedPage.insertFailed', { error: message }));
    }
  }, [feedback, t]);

  return { items, loading, loadFailed, save, remove, insertPrompt };
}
