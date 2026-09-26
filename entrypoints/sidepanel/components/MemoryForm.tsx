import { useState } from 'react';
import type { Memory, MemoryType, NewMemory } from '../../../core/types';
import { MEMORY_TYPE_CONFIG } from '../constants';
import { useI18n } from '../i18n';

interface Props {
  initial?: Memory | null;
  onSave: (mem: NewMemory) => void;
  onCancel: () => void;
}

export default function MemoryForm({ initial, onSave, onCancel }: Props) {
  const { t } = useI18n();
  const [type, setType] = useState<MemoryType>(initial?.type ?? 'topic');
  const [name, setName] = useState(initial?.name ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [tags, setTags] = useState(initial?.tags?.join(', ') ?? '');
  /**
   * 校验提示。**不能只 `return` 就完事** —— 那会让「点了保存没有任何反应」：
   * 表单不关、不报错、也不保存，用户只能反复点。
   */
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !content.trim()) {
      setValidationError(t('sidepanel.memory.form.requiredFields'));
      return;
    }
    setValidationError(null);
    onSave({
      type,
      name: name.trim(),
      content: content.trim(),
      description: name.trim(),
      tags: tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
      pinned: initial?.pinned ?? false,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="ds-form rounded-xl p-4 space-y-3">
      <div className="flex gap-1.5">
        {MEMORY_TYPE_CONFIG.map((typeConfig) => (
          <button
            key={typeConfig.key}
            type="button"
            onClick={() => setType(typeConfig.key)}
            className="px-2.5 py-1 text-[11px] rounded-md font-medium transition-all duration-150"
            style={{
              background: type === typeConfig.key ? typeConfig.bg : 'var(--ds-surface)',
              color: type === typeConfig.key ? typeConfig.color : 'var(--ds-text-tertiary)',
              border: `1px solid ${type === typeConfig.key ? typeConfig.border : 'var(--ds-border)'}`,
            }}
          >
            {t(typeConfig.labelKey)}
          </button>
        ))}
      </div>

      <input
        type="text"
        placeholder={t('sidepanel.memory.form.namePlaceholder')}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          if (validationError) setValidationError(null);
        }}
        className="ds-input w-full px-3 py-2 text-sm rounded-lg transition-all duration-150"
      />

      <textarea
        placeholder={t('sidepanel.memory.form.contentPlaceholder')}
        rows={3}
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          if (validationError) setValidationError(null);
        }}
        className="ds-input w-full px-3 py-2 text-sm rounded-lg resize-none transition-all duration-150"
      />

      <input
        type="text"
        placeholder={t('sidepanel.memory.form.tagsPlaceholder')}
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        className="ds-input w-full px-3 py-2 text-sm rounded-lg transition-all duration-150"
      />

      {validationError && (
        <div
          className="text-[11px] rounded-lg px-2.5 py-1.5"
          style={{
            color: 'var(--ds-danger)',
            background: 'var(--ds-danger-bg)',
            border: '1px solid var(--ds-danger-border)',
          }}
          role="alert"
        >
          {validationError}
        </div>
      )}

      <div className="flex gap-2 justify-end pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="ds-btn-cancel px-3.5 py-1.5 text-xs font-medium rounded-lg transition-all duration-150"
        >
          {t('common.cancel')}
        </button>
        <button
          type="submit"
          className="ds-btn-primary px-4 py-1.5 text-xs font-medium text-white rounded-lg transition-all duration-150"
        >
          {initial ? t('common.update') : t('common.save')}
        </button>
      </div>
    </form>
  );
}
