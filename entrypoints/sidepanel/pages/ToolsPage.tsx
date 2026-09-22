import { useState } from 'react';
import type { LocaleMessageKey } from '../../../core/i18n';
import type { McpServerConfig, McpToolCacheEntry } from '../../../core/types';
import PageIntro from '../components/PageIntro';
import { SettingsSection, StatusMessage, ToggleRow } from '../components/settings/primitives';
import { isMcpToolEnabled, mcpToolsController } from '../controllers/mcp-tools-controller';
import { useToolsPageController } from '../controllers/useToolsPageController';
import { useI18n } from '../i18n';

type DiagState = 'idle' | 'running' | 'done' | 'err';
type DiagResult = Record<string, { status: number; length: number; error?: string; preview?: string }>;

function DiagSearch() {
  const { t } = useI18n();
  const [query, setQuery] = useState(t('sidepanel.toolsPage.diagnosticsDefaultQuery'));
  const [state, setState] = useState<DiagState>('idle');
  const [result, setResult] = useState<DiagResult | null>(null);

  const run = async () => {
    setState('running');
    setResult(null);
    try {
      setResult(await mcpToolsController.diagnoseWebSearch(query));
      setState('done');
    } catch {
      setState('err');
    }
  };

  const inputStyle = {
    background: 'var(--ds-bg)',
    borderColor: 'var(--ds-border)',
    color: 'var(--ds-text)',
  };

  return (
    <div className="ds-surface-panel rounded-xl p-4 space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          className="flex-1 px-3 py-2 text-xs rounded-lg border outline-none"
          style={inputStyle}
        />
        <button
          onClick={run}
          disabled={state === 'running' || !query.trim()}
          className="ds-btn-secondary shrink-0 px-3 py-2 text-[11px] font-medium rounded-lg disabled:opacity-40"
        >
          {state === 'running' ? t('sidepanel.toolsPage.diagnosticsRunning') : t('sidepanel.toolsPage.diagnosticsRun')}
        </button>
      </div>
      {result && (
        <div className="text-[11px] space-y-2">
          {Object.entries(result).map(([domain, info]) => (
            <div key={domain} className="rounded-lg px-3 py-2" style={{
              background: info.status >= 200 && info.status < 400 ? 'var(--ds-success-bg)' : 'var(--ds-danger-bg)',
            }}>
              <div style={{ fontWeight: 600, color: 'var(--ds-text)' }}>{domain}</div>
              <div style={{ color: 'var(--ds-text-secondary)' }}>
                HTTP {info.status} · {t('sidepanel.toolsPage.bytes', { count: info.length })}
                {info.error && <span style={{ color: 'var(--ds-danger)' }}> · {t('sidepanel.toolsPage.errorPrefix', { error: info.error })}</span>}
              </div>
              {info.preview && (
                <div className="mt-1 p-2 rounded text-[10px] leading-relaxed" style={{
                  background: 'var(--ds-bg)', color: 'var(--ds-text-secondary)', maxHeight: 80, overflow: 'hidden',
                }}>
                  {info.preview.slice(0, 300)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const WEB_TOOLS = [
  {
    key: 'web_search',
    nameKey: 'sidepanel.toolsPage.webSearchName',
    descriptionKey: 'sidepanel.toolsPage.webSearchDescription',
    icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
  },
  {
    key: 'web_fetch',
    nameKey: 'sidepanel.toolsPage.webFetchName',
    descriptionKey: 'sidepanel.toolsPage.webFetchDescription',
    icon: 'M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  },
] as const satisfies readonly {
  key: 'web_search' | 'web_fetch';
  nameKey: LocaleMessageKey;
  descriptionKey: LocaleMessageKey;
  icon: string;
}[];

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
    settings,
    settingsError,
    pythonServer,
    pythonCache,
    pythonBusy,
    pythonMessage,
    pythonMessageTone,
    nativeMessagingSupported,
    createPythonShell,
    refreshPythonTools,
    togglePython,
    toggleWebTool,
  } = useToolsPageController(t);

  return (
    <div className="p-4 space-y-4">
      <PageIntro
        title={t('sidepanel.toolsPage.toolTitle')}
        description={t('sidepanel.toolsPage.toolDescription')}
      />

      <div className="space-y-2">
        {WEB_TOOLS.map((tool) => (
          <div
            key={tool.key}
            className="ds-surface-panel rounded-xl p-4 flex items-start gap-3"
          >
            <svg
              className="w-5 h-5 shrink-0 mt-0.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              style={{ color: settings[tool.key] ? 'var(--ds-blue)' : 'var(--ds-text-tertiary)' }}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d={tool.icon} />
            </svg>

            <div className="flex-1 min-w-0">
              <ToggleRow
                title={t(tool.nameKey)}
                description={t(tool.descriptionKey)}
                enabled={settings[tool.key]}
                onToggle={(next) => toggleWebTool(tool.key, next)}
              />
            </div>
          </div>
        ))}
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

      {settingsError && <StatusMessage tone="error">{settingsError}</StatusMessage>}

      <div
        className="text-[11px] px-3 py-2 rounded-lg"
        style={{
          color: 'var(--ds-text-tertiary)',
          background: 'var(--ds-surface)',
        }}
      >
        {t('sidepanel.toolsPage.disabledNotice')}
      </div>

      <SettingsSection
        title={t('sidepanel.toolsPage.diagnosticTitle')}
        description={t('sidepanel.toolsPage.diagnosticDescription')}
      >
        <DiagSearch />
      </SettingsSection>
    </div>
  );
}
