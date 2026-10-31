import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocaleMessageKey, MessageParams } from '../../../core/i18n';
import { MEMORY_RECORD_MISSING_CODE } from '../../../core/messaging/error-code';
import type { Memory, NewMemory } from '../../../core/types';
import { createRequestGenerationFence } from '../async-state';
import { formatRuntimeError, getRuntimeErrorMessage } from '../runtime-response';
import { decodeMemoryList, libraryController } from './library-controller';

type Translator = (key: LocaleMessageKey, params?: MessageParams) => string;
type Confirm = (options: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}) => Promise<boolean>;
type Feedback = {
  clear(): void;
  error(message: string): void;
};

export function useMemoryPageController(t: Translator, confirm: Confirm, feedback: Feedback) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const requestFence = useRef(createRequestGenerationFence());
  const translatorRef = useRef(t);
  const feedbackRef = useRef(feedback);
  translatorRef.current = t;
  feedbackRef.current = feedback;

  const showOperationError = useCallback((error: unknown) => {
    feedbackRef.current.error(translatorRef.current('sidepanel.memoryPage.operationFailed', {
      error: formatRuntimeError(error, translatorRef.current, { bare: true }),
    }));
  }, []);

  const load = useCallback(async () => {
    const generation = requestFence.current.begin();
    try {
      const next = await libraryController.getMemories();
      if (!requestFence.current.isCurrent(generation)) return;
      setMemories(next);
      setLoadFailed(false);
    } catch (error) {
      if (!requestFence.current.isCurrent(generation)) return;
      setLoadFailed(true);
      showOperationError(error);
    } finally {
      if (requestFence.current.isCurrent(generation)) setLoading(false);
    }
  }, [showOperationError]);

  useEffect(() => {
    void load();
    const applyStateUpdate = (message: { type?: string; memories?: unknown }) => {
      if (message.type !== 'STATE_UPDATED') return;
      requestFence.current.invalidate();
      setLoading(false);
      try {
        const next = decodeMemoryList(message.memories, 'memoryUpdate');
        setMemories(next);
        setLoadFailed(false);
      } catch (error) {
        setLoadFailed(true);
        showOperationError(error);
      }
    };
    const reloadWhenVisible = () => {
      if (!document.hidden) void load();
    };
    chrome.runtime.onMessage.addListener(applyStateUpdate);
    document.addEventListener('visibilitychange', reloadWhenVisible);
    window.addEventListener('focus', reloadWhenVisible);
    return () => {
      requestFence.current.invalidate();
      chrome.runtime.onMessage.removeListener(applyStateUpdate);
      document.removeEventListener('visibilitychange', reloadWhenVisible);
      window.removeEventListener('focus', reloadWhenVisible);
    };
  }, [load]);

  const remove = useCallback(async (id: number) => {
    const approved = await confirm({
      title: t('sidepanel.memoryPage.deleteConfirm'),
      message: t('sidepanel.memoryPage.deleteConfirm'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    });
    if (!approved) return;
    try {
      feedback.clear();
      await libraryController.deleteMemory(id);
      // ⚠️ **删掉正在编辑的那条时必须收掉表单** —— 否则表单还开着、`editingMemory`
      // 还指着那条已不存在的记录，再点保存就会撞上「行不在了」。
      // 与技能页的「删掉正在编辑的技能就关表单」同一口径。
      if (editingMemory?.id === id) {
        setShowForm(false);
        setEditingMemory(null);
      }
      await load();
    } catch (error) {
      showOperationError(error);
    }
  }, [confirm, editingMemory?.id, feedback, load, showOperationError, t]);

  const save = useCallback(async (memory: NewMemory) => {
    try {
      feedback.clear();
      if (editingMemory?.id) {
        await libraryController.updateMemory({
          ...editingMemory,
          ...memory,
          updatedAt: Date.now(),
        });
      } else {
        await libraryController.saveMemory(memory);
      }
      setShowForm(false);
      setEditingMemory(null);
      await load();
    } catch (error) {
      // ⚠️ **「那条记忆已经不在了」要有自己的文案** —— 通用那条是
      // 「记忆操作失败：{error}」，而这里 `error` 是一个裸码（`memory_record_missing`），
      // 直接拼进去用户看到的是蛇形标识符。⚠️ 别把这条判据搬进
      // `showOperationError`：它服务记忆页全部失败，加码表会让每条链路都多一层分派。
      if (getRuntimeErrorMessage(error) === MEMORY_RECORD_MISSING_CODE) {
        feedbackRef.current.error(translatorRef.current('sidepanel.memoryPage.recordMissing'));
      } else {
        showOperationError(error);
      }
      // ⚠️ **不清 `editingMemory` / `showForm`** —— 表单里还是用户刚敲的内容，
      // 关掉就没了；留着至少还能自己复制走。
    }
  }, [editingMemory, feedback, load, showOperationError]);

  const togglePin = useCallback(async (memory: Memory) => {
    try {
      feedback.clear();
      await libraryController.updateMemory({ ...memory, pinned: !memory.pinned });
      await load();
    } catch (error) {
      showOperationError(error);
    }
  }, [feedback, load, showOperationError]);

  return {
    memories,
    loading,
    loadFailed,
    showForm,
    editingMemory,
    toggleCreateForm() {
      setEditingMemory(null);
      setShowForm((visible) => !visible);
    },
    edit(memory: Memory) {
      setEditingMemory(memory);
      setShowForm(true);
    },
    cancelEdit() {
      setShowForm(false);
      setEditingMemory(null);
    },
    remove,
    save,
    togglePin,
  };
}
