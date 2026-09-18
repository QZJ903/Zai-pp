import { SVG_PATHS } from '../../constants';
import { useI18n } from '../../i18n';
import { SettingsSection, Slider, ToggleRow } from './primitives';
import type { SettingsState } from '../../controllers/useSettingsController';

export default function AppearanceSubPage({ state }: { state: SettingsState }) {
  const { t } = useI18n();

  return (
    <div className="space-y-5">
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
            <img
              src={state.bgPreview}
              alt={t('sidepanel.settings.backgroundPreviewAlt')}
              className="w-full h-full object-cover"
              onError={() => { state.setBgUrl(''); }}
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
          onChange={state.handleOpacityChange}
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