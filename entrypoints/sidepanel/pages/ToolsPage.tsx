import type { McpServerConfig, McpToolCacheEntry } from '../../../core/types';
import PageIntro from '../components/PageIntro';
import { StatusMessage } from '../components/settings/primitives';
import { AutomationSection } from './AutomationPage';
import { isMcpToolEnabled } from '../controllers/mcp-tools-controller';
import { useToolsPageController } from '../controllers/useToolsPageController';
import { useI18n } from '../i18n';

function PythonToolCard({
  server,
  cache,
  busy,
  message,
  messageTone,
  nativeMessagingSupported,
  onCreate,
  onRefresh,
  onToggle,
}: {
  server: McpServerConfig | null;
  cache: McpToolCacheEntry | null;
  busy: 'idle' | 'creating' | 'refreshing' | 'toggling';
  message: string;
  messageTone: 'success' | 'error' | 'warning' | 'info';
  nativeMessagingSupported: boolean;
  onCreate: () => void;
  onRefresh: () => void;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const pythonStatus = cache?.descriptors.find((tool) => tool.name === 'python_status') ?? null;
  const pythonExec = cache?.descriptors.find((tool) => tool.name === 'python_exec') ?? null;
  const enabled = Boolean(server && pythonExec && isMcpToolEnabled(server, pythonExec));
  const hasShell = Boolean(server);
  const canToggle = Boolean(server && pythonExec && busy === 'idle');
  const statusText = !server
    ? nativeMessagingSupported
      ? t('sidepanel.toolsPage.pythonStatusNoShell')
      : t('sidepanel.toolsPage.pythonStatusUnsupported')
    : !cache
      ? t('sidepanel.toolsPage.pythonStatusNoCache')
      : pythonExec
        ? enabled ? t('sidepanel.toolsPage.pythonStatusEnabled') : t('sidepanel.toolsPage.pythonStatusDiscovered')
        : t('sidepanel.toolsPage.pythonStatusMissing');

  return (
    <div className="ds-surface-panel rounded-xl p-4 flex items-start gap-3">
      <svg
        className="w-5 h-5 shrink-0 mt-0.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
        style={{ color: enabled ? 'var(--ds-blue)' : 'var(--ds-text-tertiary)' }}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
      </svg>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-medium truncate" style={{ color: 'var(--ds-text)' }}>
              {t('sidepanel.toolsPage.pythonTitle')}
            </div>
            <div className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--ds-text-tertiary)' }}>
              {statusText}
            </div>
          </div>
          <button
            onClick={onToggle}
            disabled={!canToggle}
            aria-pressed={enabled}
            aria-label={t('sidepanel.toolsPage.pythonTitle')}
            className="ds-switch relative shrink-0 w-10 h-[22px] rounded-full transition-colors duration-200 disabled:opacity-50"
            style={{ background: enabled ? 'var(--ds-blue)' : 'var(--ds-border)' }}
          >
            <span
              className="ds-switch-thumb absolute top-[3px] left-[3px] w-4 h-4 rounded-full transition-transform duration-200"
              style={{ transform: enabled ? 'translateX(18px)' : 'translateX(0)' }}
            />
          </button>
        </div>

        <div className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--ds-text-secondary)' }}>
          {t('sidepanel.toolsPage.pythonDescription')}
        </div>

        <div className="flex flex-wrap gap-1.5 mt-2">
          {!hasShell && (
            <button
              onClick={onCreate}
              disabled={busy !== 'idle' || !nativeMessagingSupported}
              className="ds-btn-secondary px-2 py-1 text-[11px] rounded-md disabled:opacity-50"
            >
              {busy === 'creating' ? t('sidepanel.toolsPage.pythonCreating') : t('sidepanel.toolsPage.pythonCreate')}
            </button>
          )}
          {hasShell && (
            <button
              onClick={onRefresh}
              disabled={busy !== 'idle'}
              className="ds-btn-secondary px-2 py-1 text-[11px] rounded-md disabled:opacity-50"
            >
              {busy === 'refreshing' ? t('sidepanel.toolsPage.pythonRefreshing') : t('sidepanel.toolsPage.pythonRefresh')}
            </button>
          )}
          {pythonStatus && (
            <span className="px-2 py-1 text-[10px] rounded-md" style={{ color: 'var(--ds-success)', background: 'var(--ds-success-bg)' }}>
              {t('sidepanel.toolsPage.pythonStatusAvailable')}
            </span>
          )}
        </div>

        {message && (
          <div className="mt-2">
            <StatusMessage tone={messageTone}>{message}</StatusMessage>
          </div>
        )}
        {server && cache && !pythonExec && (
          <div className="mt-2">
            <StatusMessage tone="error">{t('sidepanel.toolsPage.pythonMissingDetail')}</StatusMessage>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ToolsPage() {
  const { t } = useI18n();
  const {
    pythonServer,
    pythonCache,
    pythonBusy,
    pythonMessage,
    pythonMessageTone,
    nativeMessagingSupported,
    createPythonShell,
    refreshPythonTools,
    togglePython,
  } = useToolsPageController(t);

  return (
    <div className="p-4 space-y-4">
      <PageIntro
        title={t('sidepanel.toolsPage.toolTitle')}
        description={t('sidepanel.toolsPage.toolDescription')}
      />

      <div className="space-y-2">
        <PythonToolCard
          server={pythonServer}
          cache={pythonCache}
          busy={pythonBusy}
          message={pythonMessage}
          messageTone={pythonMessageTone}
          nativeMessagingSupported={nativeMessagingSupported}
          onCreate={createPythonShell}
          onRefresh={refreshPythonTools}
          onToggle={togglePython}
        />
      </div>

      <div
        className="text-[11px] px-3 py-2 rounded-lg"
        style={{
          color: 'var(--ds-text-tertiary)',
          background: 'var(--ds-surface)',
        }}
      >
        {t('sidepanel.toolsPage.disabledNotice')}
      </div>

      <AutomationSection />
    </div>
  );
}
