import { SVG_PATHS } from '../../constants';
import { useI18n } from '../../i18n';
import PageIntro from '../PageIntro';
import { useBanner, useConfirm } from './primitives';
import type { SettingsState } from '../../controllers/useSettingsController';

export default function DataSubPage({ state }: { state: SettingsState }) {
  const { t } = useI18n();
  const { confirm, node: confirmNode } = useConfirm();
  const banner = useBanner();

  const onClearAll = async () => {
    const ok = await confirm({
      title: t('sidepanel.settings.clearAllMemories'),
      message: t('sidepanel.settings.clearAllConfirm'),
      confirmLabel: t('sidepanel.settings.clearAllMemories'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    await state.handleClearAllMemories();
  };

  return (
    <div className="p-4 space-y-3">
      <PageIntro
        title={t('sidepanel.settings.dataSection')}
        description={t('sidepanel.settings.dataDescription')}
      />

      {confirmNode}
      {banner.node}

      <div className="ds-surface-panel p-4 space-y-4">
        <div className="flex justify-between items-center text-sm">
          <span style={{ color: 'var(--ds-text-secondary)' }}>{t('sidepanel.settings.memoryTotal')}</span>
          <span className="text-lg font-semibold" style={{ color: 'var(--ds-blue)' }}>
            {state.memoryCount}
          </span>
        </div>

        <div className="flex gap-2">
          <button
            onClick={state.handleExport}
            className="ds-btn-secondary flex-1 py-2.5 text-xs font-medium rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d={SVG_PATHS.download} />
            </svg>
            {t('sidepanel.settings.exportMemories')}
          </button>
          <button
            onClick={() => void state.handleExportLogs().catch(() => banner.show('error', t('sidepanel.settings.operationFailed')))}
            className="ds-btn-secondary flex-1 py-2.5 text-xs font-medium rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5"
            title={t('sidepanel.settings.exportLogsHint')}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d={SVG_PATHS.download} />
            </svg>
            {t('sidepanel.settings.exportLogs')}
          </button>
          <button
            onClick={() => state.handleImport(
              {
                arrayError: t('sidepanel.settings.importMemoryArrayError'),
                jsonError: t('sidepanel.settings.jsonFormatError'),
              },
              (result) => {
                if (result.ok) {
                  banner.show('success', t('sidepanel.settings.importSuccess', { count: result.imported ?? 0 }));
                } else {
                  banner.show('error', result.error ?? t('sidepanel.settings.jsonFormatError'));
                }
              },
            )}
            className="ds-btn-secondary flex-1 py-2.5 text-xs font-medium rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d={SVG_PATHS.upload} />
            </svg>
            {t('sidepanel.settings.importMemories')}
          </button>
        </div>

        <button
          onClick={onClearAll}
          className="ds-btn-danger w-full py-2.5 text-xs font-medium rounded-lg transition-all duration-150"
        >
          {t('sidepanel.settings.clearAllMemories')}
        </button>
      </div>
    </div>
  );
}
