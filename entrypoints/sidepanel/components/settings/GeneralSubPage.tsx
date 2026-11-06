import { useRef, type ReactNode } from 'react';
import type { LocalePreference } from '../../../../core/i18n';
import { SVG_PATHS } from '../../constants';
import { useI18n } from '../../i18n';
import { SettingsSection, Slider, ToggleRow } from './primitives';
import type { SettingsState } from '../../controllers/useSettingsController';

export default function GeneralSubPage({ state, banner }: { state: SettingsState; banner?: ReactNode }) {
  const { t, locale, preference: localePreference, setPreference: setLocalePreference } = useI18n();
  const languageGroupRef = useRef<HTMLDivElement | null>(null);

  const currentLanguageLabel =
    locale === 'en'
      ? t('sidepanel.settings.languageEnglish')
      : t('sidepanel.settings.languageChinese');
  const languageOptions: Array<{ value: LocalePreference; label: string }> = [
    { value: 'auto', label: t('sidepanel.settings.languageAuto') },
    { value: 'zh-CN', label: t('sidepanel.settings.languageChinese') },
    { value: 'en', label: t('sidepanel.settings.languageEnglish') },
  ];

  /**
   * Roving focus for the hand-rolled language radio group.
   *
   * `setPreference` is async (it writes storage first), so the selected option only
   * changes after the write lands — moving focus here, inside the event, is what keeps
   * repeated presses from computing the same target over and over.
   */
  const onLanguageKeyDown = (event: React.KeyboardEvent, index: number) => {
    const isForward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const isBackward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const isEdge = event.key === 'Home' || event.key === 'End';
    if (!isForward && !isBackward && !isEdge) return;
    event.preventDefault();
    const next = isEdge
      ? (event.key === 'Home' ? 0 : languageOptions.length - 1)
      : isForward
        ? (index + 1) % languageOptions.length
        : (index - 1 + languageOptions.length) % languageOptions.length;
    void setLocalePreference(languageOptions[next].value);
    languageGroupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div className="space-y-5">
      {banner}
      <SettingsSection
        title={t('sidepanel.settings.interfaceSection')}
        description={t('sidepanel.settings.interfaceLanguageDescription')}
      >
        <div>
          <div className="text-xs font-medium" style={{ color: 'var(--ds-text)' }}>
            {t('sidepanel.settings.interfaceLanguage')}
          </div>
          <div className="text-[11px] mt-1" style={{ color: 'var(--ds-text-secondary)' }}>
            {t('sidepanel.settings.languageCurrent', { language: currentLanguageLabel })}
          </div>
        </div>
        <div
          ref={languageGroupRef}
          className="grid grid-cols-3 gap-2"
          role="radiogroup"
          aria-label={t('sidepanel.settings.interfaceLanguage')}
        >
          {languageOptions.map((option, index) => {
            const active = localePreference === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                // Same roving contract as SegmentedControl: one Tab stop for the whole
                // group, arrows move focus AND selection. This strip is hand-rolled, so
                // it does not inherit that behaviour from the shared component.
                tabIndex={active ? 0 : -1}
                onKeyDown={(event) => onLanguageKeyDown(event, index)}
                onClick={() => void setLocalePreference(option.value)}
                className="min-w-0 px-2 py-2.5 text-[11px] leading-tight font-medium rounded-lg border transition-all duration-150"
                style={{
                  background: active ? 'var(--ds-blue-light)' : 'var(--ds-bg)',
                  color: active ? 'var(--ds-blue)' : 'var(--ds-text-secondary)',
                  borderColor: active ? 'var(--ds-selected-border)' : 'var(--ds-border)',
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('sidepanel.settings.keepaliveSection')}
        description={t('sidepanel.settings.keepaliveSectionDescription')}
      >
        <ToggleRow
          title={t('sidepanel.settings.keepaliveTitle')}
          description={t('sidepanel.settings.keepaliveDescription')}
          enabled={state.keepaliveEnabled}
          onToggle={state.handleKeepaliveToggle}
        />
      </SettingsSection>

      <SettingsSection
        title={t('sidepanel.settings.backgroundSection')}
        description={t('sidepanel.settings.customBackgroundDescription')}
      >
        <ToggleRow
          title={t('sidepanel.settings.customBackground')}
          description={t('sidepanel.settings.customBackgroundDescription')}
          enabled={state.bgEnabled}
          disabled={!state.bgPreview}
          onToggle={state.handleBgToggle}
        />

        <div className="flex gap-2">
          <input
            ref={state.fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={state.handleFileSelect}
          />
          <button
            onClick={() => state.fileInputRef.current?.click()}
            className="ds-btn-secondary flex-1 py-2 text-[11px] font-medium rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d={SVG_PATHS.upload} />
            </svg>
            {t('sidepanel.settings.uploadImage')}
          </button>
        </div>

        <div className="flex gap-2">
          <input
            type="url"
            placeholder={t('sidepanel.settings.imageUrlPlaceholder')}
            value={state.bgUrl}
            onChange={(e) => state.setBgUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && state.handleUrlConfirm()}
            className="w-full px-3 py-2 text-xs rounded-lg border outline-none transition-colors focus:border-[var(--ds-blue)]"
            style={{ background: 'var(--ds-bg)', borderColor: 'var(--ds-border)', color: 'var(--ds-text)' }}
          />
          <button
            onClick={state.handleUrlConfirm}
            disabled={!state.bgUrl.trim()}
            className="ds-btn-secondary shrink-0 px-3 py-2 text-[11px] font-medium rounded-lg transition-all duration-150 disabled:opacity-40"
          >
            {t('common.confirm')}
          </button>
        </div>

        {state.bgPreview && (
          <div
            className="relative rounded-lg overflow-hidden border"
            style={{ borderColor: 'var(--ds-border)', height: '120px' }}
          >
            {/*
             * 预览读的是**已保存**的地址（`bgPreview` 不从输入框的实时值派生），
             * 加载失败只说明那个地址取不到图，**不能在 `onError` 里动输入框** ——
             * 预览跟随输入框时，每敲一个字符都会拿半截 URL 去加载、失败即清空，
             * URL 永远填不完，且开关与清除按钮会随预览一起消失。
             */}
            <img
              src={state.bgPreview}
              alt={t('sidepanel.settings.backgroundPreviewAlt')}
              className="w-full h-full object-cover"
            />
            <div
              className="absolute inset-0 flex items-center justify-center text-[10px]"
              style={{
                background: `rgba(var(--ds-bg-rgb), ${(1 - state.bgOpacity).toFixed(3)})`,
                backdropFilter: `blur(${((1 - state.bgOpacity) * 8).toFixed(1)}px)`,
                WebkitBackdropFilter: `blur(${((1 - state.bgOpacity) * 8).toFixed(1)}px)`,
                color: 'var(--ds-text-secondary)',
                pointerEvents: 'none',
              }}
            >
              {t('sidepanel.settings.backgroundPreviewOverlay')}
            </div>
          </div>
        )}

        <Slider
          label={t('sidepanel.settings.backgroundOpacity')}
          value={state.bgOpacity}
          min={0.05}
          max={1}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onCommit={state.handleOpacityCommit}
        />

        {state.bgPreview && (
          <button
            onClick={state.handleClearBg}
            className="ds-btn-danger w-full py-2 text-[11px] font-medium rounded-lg transition-all duration-150"
          >
            {t('sidepanel.settings.clearBackground')}
          </button>
        )}
      </SettingsSection>
    </div>
  );
}
