import { useEffect, useState } from 'react';
import type { Skill } from '../../../core/types';
import { slugifySkillName } from '../../../core/skill/slug';
import { ToggleRow } from './settings/primitives';
import { useI18n } from '../i18n';

interface Props {
  initialSkill?: Skill | null;
  /**
   * 已经占用的名字（builtin + 其它来源的全部技能）。
   *
   * ⚠️ **判重必须在提交前做** —— 名字是这条技能的身份：`/name` 激活只按名字找，
   * 同名两条时恒取列表里最前的那条，用户没有办法指定「我要第二条」。
   * 后端也会拒（`saveSkill`），这里只是让用户当场看到原因。
   */
  occupiedNames?: ReadonlySet<string>;
  onSave: (skill: Skill) => void;
  onCancel: () => void;
}

export default function SkillForm({ initialSkill, occupiedNames, onSave, onCancel }: Props) {
  const { t } = useI18n();
  const [name, setName] = useState(initialSkill?.name ?? '');
  const [description, setDescription] = useState(initialSkill?.description ?? '');
  const [instructions, setInstructions] = useState(initialSkill?.instructions ?? '');
  const [memoryEnabled, setMemoryEnabled] = useState(initialSkill?.memoryEnabled ?? false);
  /**
   * 校验提示。**不能只 `return` 就完事** —— 那会让「点了保存没有任何反应」：
   * 表单不关、不报错、也不保存，用户只能反复点。
   */
  const [validationError, setValidationError] = useState<string | null>(null);

  const normalizedName = slugifySkillName(name);
  const isEditing = Boolean(initialSkill);

  useEffect(() => {
    setName(initialSkill?.name ?? '');
    setDescription(initialSkill?.description ?? '');
    setInstructions(initialSkill?.instructions ?? '');
    setMemoryEnabled(initialSkill?.memoryEnabled ?? false);
    setValidationError(null);
  }, [initialSkill]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // ⚠️⚠️ **三档必须各说一句，不能都 `return`** —— 静默返回的表现是「点了保存，
    // 表单不关、不报错、也不保存」。而且不能把三档混成一句：
    // 名字打了中文却说「名称不能为空」等于在骗人（用户明明输了字）。
    if (!name.trim()) {
      setValidationError(t('sidepanel.skill.form.nameRequired'));
      return;
    }
    if (!normalizedName) {
      // 归一后为空 = 打进去的字符全部不合法（中文、空格、符号都会被换成短横线再去掉）。
      setValidationError(t('sidepanel.skill.form.nameCharset'));
      return;
    }
    if (!instructions.trim()) {
      setValidationError(t('sidepanel.skill.form.instructionsRequired'));
      return;
    }
    // ⚠️ **`initialSkill?.name` 的豁免不能省** —— 编辑一条技能时它的名字本来就在
    // `occupiedNames` 里，不豁免的话「只改描述」也会被自己挡住。
    if (occupiedNames?.has(normalizedName) && normalizedName !== initialSkill?.name) {
      setValidationError(t('sidepanel.skill.form.nameTaken'));
      return;
    }
    setValidationError(null);
    onSave({
      name: normalizedName,
      description: description.trim(),
      instructions: instructions.trim(),
      source: 'custom',
      memoryEnabled,
      enabled: initialSkill?.enabled !== false,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="ds-form rounded-xl p-4 space-y-3">
      <div>
        <input
          type="text"
          placeholder={t('sidepanel.skill.form.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="ds-input w-full px-3 py-2 text-sm rounded-lg transition-all duration-150"
        />
        {normalizedName && (
          <p className="text-[11px] mt-1" style={{ color: 'var(--ds-text-tertiary)' }}>
            {t('sidepanel.skill.form.triggerCommand')} <code className="font-mono" style={{ color: 'var(--ds-blue)' }}>/{normalizedName}</code>
          </p>
        )}
      </div>

      <input
        type="text"
        placeholder={t('sidepanel.skill.form.descriptionPlaceholder')}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="ds-input w-full px-3 py-2 text-sm rounded-lg transition-all duration-150"
      />

      <div>
        <label className="text-[11px] mb-1.5 block font-medium" style={{ color: 'var(--ds-text-tertiary)' }}>
          {t('sidepanel.skill.form.instructionsLabel')}
        </label>
        <textarea
          rows={6}
          placeholder={t('sidepanel.skill.form.instructionsPlaceholder')}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          className="ds-input w-full px-3 py-2 text-sm font-mono rounded-lg resize-none transition-all duration-150"
        />
      </div>

      <ToggleRow
        title={t('sidepanel.skill.form.memoryInjectionLabel')}
        enabled={memoryEnabled}
        onToggle={(next) => setMemoryEnabled(next)}
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
          {isEditing ? t('common.saveChanges') : t('common.save')}
        </button>
      </div>
    </form>
  );
}
