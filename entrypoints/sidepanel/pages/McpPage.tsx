import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { LocaleMessageKey, MessageParams, SupportedLocale } from '../../../core/i18n';
import type {
  McpCapabilityExposureMode,
  McpCapabilitySettings,
  McpCapabilitySettingsPatch,
  McpHeaderValue,
  McpSecretValue,
  McpServerConfig,
  McpServerCreateInput,
  McpServerStatus,
  McpServerTransportConfig,
  McpToolCacheEntry,
  ToolCallHistoryRecord,
  ToolDescriptor,
  ToolExecutionMode,
  PlatformEnvironment,
} from '../../../core/types';
import {
  MAX_ADAPTIVE_DIRECT_TOOLS,
  MAX_ADAPTIVE_PROMPT_BYTES,
  MIN_ADAPTIVE_DIRECT_TOOLS,
  MIN_ADAPTIVE_PROMPT_BYTES,
} from '../../../core/mcp/capability-settings';
import { SHELL_TOOL_NAMES } from '../../../core/shell/contracts';
import { isShellMcpServer } from '../../../core/shell/policy';
import PageIntro from '../components/PageIntro';
import { SVG_PATHS } from '../constants';
import { useI18n } from '../i18n';
import {
  countEnabledMcpTools,
  getAllowedMcpTransportKinds,
  describeMcpTool,
  isMcpNativeMessagingSupported,
  isMcpToolEnabled,
  isMcpToolSelected,
  orderMcpToolsByPin,
  visibleMcpTools,
  riskBadgeLabelKey,
  type McpToolRiskBadge,
} from '../controllers/mcp-tools-controller';
import { useMcpPageController } from '../controllers/useMcpPageController';
import {
  SettingsSection,
  StatusMessage,
  ToggleRow,
  useConfirm,
} from '../components/settings/primitives';

type McpTransportKind = McpServerTransportConfig['kind'];
type BusyAction = 'refresh' | 'test';
type Translator = (key: LocaleMessageKey, params?: MessageParams) => string;

type FormState = {
  displayName: string;
  enabled: boolean;
  transportKind: McpTransportKind;
  url: string;
  nativeHost: string;
  command: string;
  args: string;
  cwd: string;
  env: string;
  headers: McpHeaderValue[];
  secrets: McpSecretValue[];
  connectMs: string;
  requestMs: string;
  discoveryMs: string;
  maxResultBytes: string;
  maxToolCount: string;
  executionEnabled: boolean;
  executionMode: ToolExecutionMode;
};

const TRANSPORT_OPTIONS: { kind: McpTransportKind; label: string; hintKey: LocaleMessageKey }[] = [
  { kind: 'streamable_http', label: 'Streamable HTTP', hintKey: 'sidepanel.mcpPage.transportHints.streamableHttp' },
  { kind: 'http', label: 'HTTP', hintKey: 'sidepanel.mcpPage.transportHints.http' },
  { kind: 'sse', label: 'SSE', hintKey: 'sidepanel.mcpPage.transportHints.sse' },
  { kind: 'stdio_bridge', label: 'Stdio Bridge', hintKey: 'sidepanel.mcpPage.transportHints.stdioBridge' },
  { kind: 'native_messaging', label: 'Native', hintKey: 'sidepanel.mcpPage.transportHints.nativeMessaging' },
];

const DEFAULT_FORM: FormState = {
  displayName: '',
  enabled: true,
  transportKind: 'streamable_http',
  url: '',
  nativeHost: '',
  command: '',
  args: '',
  cwd: '',
  env: '',
  headers: [],
  secrets: [],
  connectMs: '10000',
  requestMs: '60000',
  discoveryMs: '20000',
  maxResultBytes: '64000',
  maxToolCount: '128',
  executionEnabled: true,
  executionMode: 'auto',
};

export default function McpPage() {
  const { t, locale } = useI18n();
  const { confirm, node: confirmNode } = useConfirm();
  const {
    servers,
    caches,
    selectedServerHistory,
    capabilitySettings,
    selected,
    selectedId,
    setSelectedId,
    loading,
    showForm,
    editing,
    busy,
    banner,
    platform,
    enabledCount,
    toolCount,
    nativeMessagingSupported,
    startCreate,
    startEdit,
    cancelForm,
    createShellPreset,
    saveServer,
    removeServer,
    patchServer,
    refreshServer,
    toggleTool,
    updateCapabilitySettings,
    setServerExposure,
    togglePinnedTool,
  } = useMcpPageController(t, confirm);

  return (
    <div className="p-4 space-y-3">
      <PageIntro
        title={t('sidepanel.mcpPage.title')}
        description={t('sidepanel.mcpPage.description')}
        meta={t('sidepanel.mcpPage.summary', {
          servers: servers.length,
          enabled: enabledCount,
          tools: toolCount,
        })}
        actions={(
          <>
            <button
              onClick={createShellPreset}
              disabled={!nativeMessagingSupported}
              title={!nativeMessagingSupported ? t('sidepanel.mcpPage.messages.nativeMessagingUnsupported') : undefined}
              className="ds-btn-secondary px-3 py-1.5 text-xs rounded-lg transition-all duration-150 disabled:opacity-50"
            >
              {t('sidepanel.mcpPage.shell')}
            </button>
            <button
              onClick={startCreate}
              className="ds-btn-primary px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-all duration-150 flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d={SVG_PATHS.plus} />
              </svg>
              {t('sidepanel.mcpPage.addServer')}
            </button>
          </>
        )}
      />

      {capabilitySettings && (
        <AdaptiveCapabilityBudget
          settings={capabilitySettings}
          onSave={updateCapabilitySettings}
          t={t}
        />
      )}

      {banner && (
        <StatusMessage tone={banner.tone === 'info' ? 'success' : banner.tone}>
          {banner.text}
        </StatusMessage>
      )}

      {showForm && (
        <div className="animate-slide-down">
          <McpServerForm
            key={editing?.id ?? 'create'}
            initial={editing}
            platform={platform}
            onSave={saveServer}
            onCancel={cancelForm}
          />
        </div>
      )}

      {confirmNode}

      {loading && servers.length === 0 ? (
        <EmptyState label={t('sidepanel.mcpPage.loading')} />
      ) : servers.length === 0 && !showForm ? (
        <EmptyState
          label={t('sidepanel.mcpPage.empty')}
          hint={t('sidepanel.mcpPage.emptyHint')}
          actions={
            <>
              <button
                onClick={startCreate}
                className="ds-btn-primary px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-all duration-150 flex items-center gap-1"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={SVG_PATHS.plus} />
                </svg>
                {t('sidepanel.mcpPage.emptyCreateAction')}
              </button>
              {nativeMessagingSupported && (
                <button
                  onClick={createShellPreset}
                  className="ds-btn-secondary px-3 py-1.5 text-xs rounded-lg transition-all duration-150"
                >
                  {t('sidepanel.mcpPage.emptyInstallShell')}
                </button>
              )}
            </>
          }
        />
      ) : (
        <div className="space-y-2">
          {servers.map((server) => {
            const isSelected = selected?.id === server.id;
            return (
              <div key={server.id} className="space-y-2">
                <ServerRow
                  server={server}
                  cache={caches[server.id] ?? null}
                  selected={isSelected}
                  expanded={isSelected}
                  onSelect={() => setSelectedId(isSelected ? null : server.id)}
                  onToggle={() => patchServer(server, { enabled: !server.enabled })}
                  onEdit={() => startEdit(server)}
                  onDelete={() => removeServer(server)}
                  t={t}
                />
                {isSelected && (
                  <ServerDetail
                    server={server}
                    cache={caches[server.id] ?? null}
                    history={selectedServerHistory}
                    busy={busy[server.id] ?? null}
                    exposureMode={capabilitySettings?.servers[server.id]?.mode ?? 'direct'}
                    pinnedDescriptorIds={capabilitySettings?.servers[server.id]?.pinnedDescriptorIds ?? []}
                    onPatch={(patch) => patchServer(server, patch)}
                    onSetExposure={(mode) => setServerExposure(
                      server,
                      mode,
                      capabilitySettings?.servers[server.id]?.pinnedDescriptorIds,
                    )}
                    onRefresh={() => refreshServer(server, 'refresh')}
                    onTest={() => refreshServer(server, 'test')}
                    onToggleTool={(tool) => toggleTool(server, tool)}
                    onTogglePinned={(tool) => togglePinnedTool(server, tool)}
                    t={t}
                    locale={locale}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AdaptiveCapabilityBudget({
  settings,
  onSave,
  t,
}: {
  settings: McpCapabilitySettings;
  onSave: (patch: McpCapabilitySettingsPatch) => Promise<void>;
  t: Translator;
}) {
  const [maxTools, setMaxTools] = useState(String(settings.adaptiveMaxDirectTools));
  const [maxBytes, setMaxBytes] = useState(String(settings.adaptiveMaxPromptBytes));
  const [error, setError] = useState('');

  useEffect(() => {
    setMaxTools(String(settings.adaptiveMaxDirectTools));
    setMaxBytes(String(settings.adaptiveMaxPromptBytes));
  }, [settings.adaptiveMaxDirectTools, settings.adaptiveMaxPromptBytes]);

  const save = async () => {
    const adaptiveMaxDirectTools = Number(maxTools);
    const adaptiveMaxPromptBytes = Number(maxBytes);
    if (
      !Number.isInteger(adaptiveMaxDirectTools) ||
      adaptiveMaxDirectTools < MIN_ADAPTIVE_DIRECT_TOOLS ||
      adaptiveMaxDirectTools > MAX_ADAPTIVE_DIRECT_TOOLS ||
      !Number.isInteger(adaptiveMaxPromptBytes) ||
      adaptiveMaxPromptBytes < MIN_ADAPTIVE_PROMPT_BYTES ||
      adaptiveMaxPromptBytes > MAX_ADAPTIVE_PROMPT_BYTES
    ) {
      setError(t('sidepanel.mcpPage.detail.adaptiveBudgetInvalid'));
      return;
    }
    setError('');
    await onSave({ adaptiveMaxDirectTools, adaptiveMaxPromptBytes });
  };

  return (
    <div className="ds-card rounded-lg p-3 space-y-2">
      <div>
        <div className="text-xs font-medium" style={{ color: 'var(--ds-text)' }}>
          {t('sidepanel.mcpPage.detail.adaptiveBudget')}
        </div>
        <div className="text-[11px] mt-0.5" style={{ color: 'var(--ds-text-tertiary)' }}>
          {t('sidepanel.mcpPage.detail.adaptiveBudgetDescription')}
        </div>
      </div>
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
        <Field label={t('sidepanel.mcpPage.detail.adaptiveMaxTools')}>
          <input
            type="number"
            min={MIN_ADAPTIVE_DIRECT_TOOLS}
            max={MAX_ADAPTIVE_DIRECT_TOOLS}
            value={maxTools}
            onChange={(event) => setMaxTools(event.target.value)}
            className="ds-input w-full rounded-lg px-2 py-1.5 text-xs"
          />
        </Field>
        <Field label={t('sidepanel.mcpPage.detail.adaptiveMaxPromptBytes')}>
          <input
            type="number"
            min={MIN_ADAPTIVE_PROMPT_BYTES}
            max={MAX_ADAPTIVE_PROMPT_BYTES}
            step="1000"
            value={maxBytes}
            onChange={(event) => setMaxBytes(event.target.value)}
            className="ds-input w-full rounded-lg px-2 py-1.5 text-xs"
          />
        </Field>
        <button
          type="button"
          onClick={() => { void save(); }}
          className="ds-btn-secondary px-2.5 py-1.5 text-[11px] rounded-md"
        >
          {t('sidepanel.mcpPage.detail.adaptiveBudgetApply')}
        </button>
      </div>
      {error && (
        <div className="text-[11px]" style={{ color: 'var(--ds-danger)' }}>{error}</div>
      )}
    </div>
  );
}

function McpServerForm({
  initial,
  platform,
  onSave,
  onCancel,
}: {
  initial: McpServerConfig | null;
  platform: PlatformEnvironment | null;
  onSave: (payload: McpServerCreateInput) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(() => initial ? formFromServer(initial) : DEFAULT_FORM);
  const [error, setError] = useState('');
  const supportedTransportKinds = getAllowedMcpTransportKinds(
    TRANSPORT_OPTIONS.map((item) => item.kind),
    platform,
  );
  const transportOptions = TRANSPORT_OPTIONS.filter((item) => supportedTransportKinds.includes(item.kind));
  const selectedTransport = transportOptions.find((item) => item.kind === form.transportKind) ?? transportOptions[0] ?? TRANSPORT_OPTIONS[0];
  const transportGroupRef = useRef<HTMLDivElement | null>(null);

  /**
   * Roving focus for the transport radio group — same contract as `SegmentedControl`
   * and the language group in `GeneralSubPage`: one Tab stop for the whole group, arrows
   * move focus AND selection. This strip is hand-rolled (its own pill styling), so it
   * does not inherit that behaviour from the shared component.
   */
  const onTransportKeyDown = (event: React.KeyboardEvent, index: number) => {
    const isForward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const isBackward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const isEdge = event.key === 'Home' || event.key === 'End';
    if (!isForward && !isBackward && !isEdge) return;
    event.preventDefault();
    const next = isEdge
      ? (event.key === 'Home' ? 0 : transportOptions.length - 1)
      : isForward
        ? (index + 1) % transportOptions.length
        : (index - 1 + transportOptions.length) % transportOptions.length;
    setTransportKind(transportOptions[next].kind);
    transportGroupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };

  useEffect(() => {
    if (supportedTransportKinds.includes(form.transportKind)) return;
    setForm((prev) => ({
      ...prev,
      transportKind: 'streamable_http',
      nativeHost: '',
    }));
  }, [form.transportKind, supportedTransportKinds.join('|')]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const setTransportKind = (kind: McpTransportKind) => {
    setForm((prev) => ({ ...prev, transportKind: kind }));
  };

  const save = async () => {
    const result = payloadFromForm(form, t, platform);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setError('');
    await onSave(result.payload);
  };

  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="ds-form rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13px] font-medium" style={{ color: 'var(--ds-text)' }}>
          {initial ? t('sidepanel.mcpPage.form.editTitle') : t('sidepanel.mcpPage.form.createTitle')}
        </div>
        <ToggleRow
          title={t('sidepanel.mcpPage.enabled')}
          enabled={form.enabled}
          onToggle={(next) => update('enabled', next)}
        />
      </div>

      {error && (
        <div className="rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--ds-danger)', background: 'var(--ds-danger-bg)', border: '1px solid var(--ds-danger-border)' }}>
          {error}
        </div>
      )}

      <SettingsSection title={t('sidepanel.mcpPage.form.basic')}>
        <Field label={t('sidepanel.mcpPage.form.name')}>
          <input
            value={form.displayName}
            onChange={(event) => update('displayName', event.target.value)}
            className="ds-input w-full rounded-lg px-3 py-2 text-sm"
            placeholder="Filesystem MCP"
          />
        </Field>

        <div>
          <span className="block text-xs mb-1" style={{ color: 'var(--ds-text-secondary)' }}>{t('sidepanel.mcpPage.form.transport')}</span>
          <div
            ref={transportGroupRef}
            className="flex flex-wrap gap-1.5"
            role="radiogroup"
            aria-label={t('sidepanel.mcpPage.form.transport')}
          >
            {transportOptions.map((item, index) => {
              const active = item.kind === form.transportKind;
              return (
                <button
                  key={item.kind}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  tabIndex={active ? 0 : -1}
                  onKeyDown={(event) => onTransportKeyDown(event, index)}
                  onClick={() => setTransportKind(item.kind)}
                  className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg border transition-all duration-150"
                  style={{
                    background: active ? 'var(--ds-blue-light)' : 'var(--ds-bg)',
                    color: active ? 'var(--ds-blue)' : 'var(--ds-text-secondary)',
                    borderColor: active ? 'var(--ds-selected-border)' : 'var(--ds-border)',
                  }}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
          <div className="text-[11px] mt-1.5" style={{ color: 'var(--ds-text-tertiary)' }}>{t(selectedTransport.hintKey)}</div>
        </div>

        {form.transportKind !== 'native_messaging' && (
          <Field
            label={form.transportKind === 'stdio_bridge' ? t('sidepanel.mcpPage.form.bridgeEndpointUrl') : t('sidepanel.mcpPage.form.serviceUrl')}
            hint={form.transportKind === 'stdio_bridge' ? t('sidepanel.mcpPage.form.bridgeEndpointHint') : undefined}
          >
            <input
              value={form.url}
              onChange={(event) => update('url', event.target.value)}
              className="ds-input w-full rounded-lg px-3 py-2 text-sm"
              placeholder={form.transportKind === 'stdio_bridge' ? 'http://127.0.0.1:8765/mcp' : 'https://example.com/mcp'}
            />
          </Field>
        )}

        {form.transportKind === 'native_messaging' && (
          <Field label="Native Host">
            <input
              value={form.nativeHost}
              onChange={(event) => update('nativeHost', event.target.value)}
              className="ds-input w-full rounded-lg px-3 py-2 text-sm"
              placeholder="com.example.mcp_host"
            />
          </Field>
        )}
      </SettingsSection>

      {form.transportKind === 'stdio_bridge' && (
        <SettingsSection title={t('sidepanel.mcpPage.form.stdioSection')}>
          <Field label={t('sidepanel.mcpPage.form.command')}>
            <input
              value={form.command}
              onChange={(event) => update('command', event.target.value)}
              className="ds-input w-full rounded-lg px-3 py-2 text-sm"
              placeholder="npx"
            />
          </Field>
          <Field label={t('sidepanel.mcpPage.form.args')}>
            <input
              value={form.args}
              onChange={(event) => update('args', event.target.value)}
              className="ds-input w-full rounded-lg px-3 py-2 text-sm"
              placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
            />
          </Field>
          <Field label={t('sidepanel.mcpPage.form.cwd')}>
            <input
              value={form.cwd}
              onChange={(event) => update('cwd', event.target.value)}
              className="ds-input w-full rounded-lg px-3 py-2 text-sm"
              placeholder="/Users/me/project"
            />
          </Field>
          <Field label={t('sidepanel.mcpPage.form.env')}>
            <textarea
              value={form.env}
              onChange={(event) => update('env', event.target.value)}
              className="ds-input w-full rounded-lg px-3 py-2 text-sm min-h-18 resize-y"
              placeholder={'KEY=value\nTOKEN=...'}
            />
          </Field>
        </SettingsSection>
      )}

      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen((prev) => !prev)}
          className="flex items-center gap-1.5 text-xs font-medium w-full"
          style={{ color: 'var(--ds-text-secondary)' }}
        >
          <svg
            className="w-3 h-3 transition-transform duration-200"
            style={{ transform: advancedOpen ? 'rotate(90deg)' : 'rotate(0)' }}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {t('sidepanel.mcpPage.form.advanced')}
          <span className="text-[10px] font-normal" style={{ color: 'var(--ds-text-tertiary)' }}>
            · {t('sidepanel.mcpPage.form.advancedHint')}
          </span>
        </button>
        {advancedOpen && (
          <div className="mt-2 space-y-3">
            {form.transportKind !== 'native_messaging' && (
              <HeaderEditor
                headers={form.headers}
                secrets={form.secrets}
                onHeadersChange={(headers) => update('headers', headers)}
                onSecretsChange={(secrets) => update('secrets', secrets)}
              />
            )}

            <div className="grid grid-cols-3 gap-2">
              <NumberField label={t('sidepanel.mcpPage.form.connectMs')} value={form.connectMs} onChange={(value) => update('connectMs', value)} />
              <NumberField label={t('sidepanel.mcpPage.form.requestMs')} value={form.requestMs} onChange={(value) => update('requestMs', value)} />
              <NumberField label={t('sidepanel.mcpPage.form.discoveryMs')} value={form.discoveryMs} onChange={(value) => update('discoveryMs', value)} />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <NumberField label={t('sidepanel.mcpPage.form.resultBytes')} value={form.maxResultBytes} onChange={(value) => update('maxResultBytes', value)} />
              <NumberField label={t('sidepanel.mcpPage.form.toolLimit')} value={form.maxToolCount} onChange={(value) => update('maxToolCount', value)} />
            </div>

            <div className="ds-surface-panel rounded-lg p-3 space-y-2">
              <ToggleRow
                title={t('sidepanel.mcpPage.form.defaultExecution')}
                description={t('sidepanel.mcpPage.form.allowInject')}
                enabled={form.executionEnabled}
                onToggle={(next) => update('executionEnabled', next)}
              />
              <select
                value={form.executionMode}
                onChange={(event) => update('executionMode', event.target.value as ToolExecutionMode)}
                className="ds-input w-full rounded-lg px-3 py-2 text-sm"
              >
                <option value="auto">{t('sidepanel.mcpPage.form.modeAuto')}</option>
                <option value="disabled">{t('sidepanel.mcpPage.form.modeDisabled')}</option>
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="ds-btn-cancel px-3 py-1.5 text-xs rounded-lg transition-colors">
          {t('common.cancel')}
        </button>
        <button onClick={save} className="ds-btn-primary px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-colors">
          {t('sidepanel.mcpPage.form.save')}
        </button>
      </div>
    </div>
  );
}

function HeaderEditor({
  headers,
  secrets,
  onHeadersChange,
  onSecretsChange,
}: {
  headers: McpHeaderValue[];
  secrets: McpSecretValue[];
  onHeadersChange: (headers: McpHeaderValue[]) => void;
  onSecretsChange: (secrets: McpSecretValue[]) => void;
}) {
  const { t } = useI18n();
  const updateHeader = (index: number, patch: Partial<McpHeaderValue>) => {
    onHeadersChange(headers.map((header, itemIndex) => itemIndex === index ? { ...header, ...patch } : header));
  };
  const updateSecret = (index: number, patch: Partial<McpSecretValue>) => {
    onSecretsChange(secrets.map((secret, itemIndex) => itemIndex === index ? { ...secret, ...patch } : secret));
  };

  return (
    <div className="ds-surface-panel rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium" style={{ color: 'var(--ds-text)' }}>Headers</span>
        <button
          onClick={() => onHeadersChange([...headers, { name: '', value: '' }])}
          className="ds-btn-secondary px-2 py-1 text-[11px] rounded-md"
        >
          {t('common.add')}
        </button>
      </div>
      {headers.map((header, index) => (
        <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
          <input
            value={header.name}
            onChange={(event) => updateHeader(index, { name: event.target.value })}
            className="ds-input min-w-0 rounded-lg px-2 py-1.5 text-xs"
            placeholder={t('sidepanel.mcpPage.headers.headerName')}
          />
          <input
            value={header.value}
            onChange={(event) => updateHeader(index, { value: event.target.value })}
            className="ds-input min-w-0 rounded-lg px-2 py-1.5 text-xs"
            placeholder={t('sidepanel.mcpPage.headers.headerValue')}
          />
          <button
            onClick={() => onHeadersChange(headers.filter((_, itemIndex) => itemIndex !== index))}
            className="ds-action-btn ds-action-btn-delete w-8 rounded-lg text-xs"
          >
            ×
          </button>
        </div>
      ))}

      <div className="flex items-center justify-between pt-1">
        <span className="text-xs font-medium" style={{ color: 'var(--ds-text)' }}>Secrets</span>
        <button
          onClick={() => onSecretsChange([...secrets, { id: crypto.randomUUID(), kind: 'bearer', value: '' }])}
          className="ds-btn-secondary px-2 py-1 text-[11px] rounded-md"
        >
          {t('common.add')}
        </button>
      </div>
      {secrets.map((secret, index) => (
        <div key={index} className="space-y-1.5">
          <div className="grid grid-cols-[90px_1fr_auto] gap-1.5">
            <select
              value={secret.kind}
              onChange={(event) => updateSecret(index, { kind: event.target.value as McpSecretValue['kind'] })}
              className="ds-input min-w-0 rounded-lg px-2 py-1.5 text-xs"
            >
              <option value="bearer">Bearer</option>
              <option value="basic">Basic</option>
              <option value="header">Header</option>
            </select>
            <input
              value={secret.value}
              onChange={(event) => updateSecret(index, { value: event.target.value })}
              className="ds-input min-w-0 rounded-lg px-2 py-1.5 text-xs"
              placeholder={t('sidepanel.mcpPage.headers.secretValue')}
              type="password"
            />
            <button
              onClick={() => onSecretsChange(secrets.filter((_, itemIndex) => itemIndex !== index))}
              className="ds-action-btn ds-action-btn-delete w-8 rounded-lg text-xs"
            >
              ×
            </button>
          </div>
          {secret.kind === 'header' && (
            <input
              value={secret.headerName ?? ''}
              onChange={(event) => updateSecret(index, { headerName: event.target.value })}
              className="ds-input w-full rounded-lg px-2 py-1.5 text-xs"
              placeholder={t('sidepanel.mcpPage.headers.secretHeaderName')}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function ServerRow({
  server,
  cache,
  selected,
  expanded,
  onSelect,
  onToggle,
  onEdit,
  onDelete,
  t,
}: {
  server: McpServerConfig;
  cache: McpToolCacheEntry | null;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  t: Translator;
}) {
  /**
   * ⚠️⚠️ **服务被关掉时必须以 `disabled` 收口，不能读缓存里的 `ready`。**
   *
   * 缓存（`health.status`）记的是「上次发现成不成功」，**关掉开关不会清缓存** ——
   * 指纹只含连接相关字段、不含 `enabled`。所以关掉之后缓存仍是 `ready`，
   * 只看缓存就会显示「已连接」，而实际上这个服务的工具一个都不会被提供。
   * 判据落在 `server.enabled` 上：它才是「此刻用不用」的唯一真源。
   */
  const status = statusMeta(
    server.enabled ? (cache?.health.status ?? server.status) : 'disabled',
    t,
  );
  // ⚠️ 计数与列表同口径 —— 分母不能含列表里看不见的内部工具，否则会出现
  // 「`10/12 自动` 而列表只有 11 条」这种对不上的显示。
  const activeTools = countEnabledMcpTools(server, visibleMcpTools(cache));

  return (
    <div
      className="ds-card rounded-lg p-3 cursor-pointer transition-colors"
      style={{ borderColor: selected ? 'var(--ds-selected-border)' : undefined }}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <svg
            className="w-3 h-3 shrink-0 transition-transform duration-200"
            style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0)', color: 'var(--ds-text-tertiary)' }}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-sm font-medium truncate" style={{ color: 'var(--ds-text)' }}>{server.displayName}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0" style={{ color: status.color, background: status.bg }}>
            {status.label}
          </span>
        </div>
        <div onClick={(event) => event.stopPropagation()}>
          <ToggleRow
            title={t('sidepanel.mcpPage.enabled')}
            enabled={server.enabled}
            onToggle={onToggle}
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 mt-1.5 pl-5">
        <div className="text-[11px] truncate" style={{ color: 'var(--ds-text-tertiary)' }}>
          {transportLabel(server.transport.kind)} · {t('sidepanel.mcpPage.row.autoTools', {
            active: activeTools,
            // ⚠️ 分母与列表同口径（剔掉内部工具）—— 否则全开时会显示「11/12 自动」
            // 而列表只有 11 条。
            total: visibleMcpTools(cache).length,
          })}
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={(event) => event.stopPropagation()}>
          <button onClick={onEdit} className="ds-action-btn ds-action-btn-edit px-2 py-1 text-[11px] rounded-md">
            {t('common.edit')}
          </button>
          <button onClick={onDelete} className="ds-action-btn ds-action-btn-delete px-2 py-1 text-[11px] rounded-md">
            {t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ServerDetail({
  server,
  cache,
  history,
  busy,
  exposureMode,
  pinnedDescriptorIds,
  onPatch,
  onSetExposure,
  onRefresh,
  onTest,
  onToggleTool,
  onTogglePinned,
  t,
  locale,
}: {
  server: McpServerConfig;
  cache: McpToolCacheEntry | null;
  history: ToolCallHistoryRecord[];
  busy: BusyAction | null;
  exposureMode: McpCapabilityExposureMode;
  pinnedDescriptorIds: readonly string[];
  onPatch: (patch: Partial<McpServerConfig>) => Promise<void>;
  onSetExposure: (mode: McpCapabilityExposureMode) => Promise<void>;
  onRefresh: () => void;
  onTest: () => void;
  onToggleTool: (tool: ToolDescriptor) => void;
  onTogglePinned: (tool: ToolDescriptor) => void;
  t: Translator;
  locale: SupportedLocale;
}) {
  // ⚠️ **内部工具不进这个列表** —— 它们由扩展自己调用（本地 Skill 导入读技能文件夹），
  // 模型看不见、用户也没有使用入口。显示成可勾选的普通工具只会误导
  //（勾上之后模型仍然不知道它存在）。真源见 `core/mcp/internal-tools.ts`。
  // ⚠️ 只裁**显示**：`cache.descriptors` 与 `health.toolCount` 仍是 host 的事实。
  const tools = visibleMcpTools(cache);
  // Pinning only reorders this list; the Schema projection keeps the server order.
  const orderedTools = orderMcpToolsByPin(tools, pinnedDescriptorIds);
  // 交给页面时已经是「这个服务」的记录（后台先按服务筛、再截），这里只裁展示条数。
  const serverHistory = history.slice(0, 5);
  // ⚠️ **算一次就够** —— 原先条件与正文各调一遍 `describeMcpFailure`，同一个 render
  // 走两遍那串 message 匹配（八档 `includes`）。
  const failureMessage = describeMcpFailure(server, cache, t);
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div className="ds-surface-panel rounded-lg p-3 space-y-3 animate-slide-down">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] truncate" style={{ color: 'var(--ds-text-tertiary)' }}>{endpointLabel(server)}</div>
        </div>
        <div className="flex gap-1.5">
          <button onClick={onTest} className="ds-btn-secondary px-2 py-1 text-[11px] rounded-md" disabled={busy !== null}>
            {busy === 'test' ? t('sidepanel.mcpPage.row.testing') : t('common.test')}
          </button>
          <button onClick={onRefresh} className="ds-btn-secondary px-2 py-1 text-[11px] rounded-md" disabled={busy !== null}>
            {busy === 'refresh' ? t('sidepanel.mcpPage.row.refreshing') : t('sidepanel.mcpPage.row.refreshTools')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <Metric label={t('sidepanel.mcpPage.detail.status')} value={statusMeta(server.enabled ? (cache?.health.status ?? server.status) : 'disabled', t).label} />
        <Metric label={t('sidepanel.mcpPage.detail.latency')} value={formatMs(cache?.health.latencyMs ?? null)} />
        <Metric label={t('sidepanel.mcpPage.detail.lastConnected')} value={formatTime(server.lastConnectedAt ?? cache?.health.checkedAt ?? null, locale)} />
        <Metric label={t('sidepanel.mcpPage.detail.transport')} value={transportLabel(server.transport.kind)} />
      </div>

      {failureMessage && (
        <div className="rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--ds-danger)', background: 'var(--ds-danger-bg)', border: '1px solid var(--ds-danger-border)' }}>
          {failureMessage}
        </div>
      )}

      {isShellMcpServer(server) && (
        <ShellSetupHint server={server} cache={cache} t={t} />
      )}

      <div className="ds-card rounded-lg p-3 space-y-2">
        <div>
          <div className="text-xs font-medium" style={{ color: 'var(--ds-text)' }}>
            {t('sidepanel.mcpPage.detail.promptExposure')}
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--ds-text-tertiary)' }}>
            {t('sidepanel.mcpPage.detail.promptExposureDescription')}
          </div>
        </div>
        <select
          value={exposureMode}
          onChange={(event) => { void onSetExposure(event.target.value as McpCapabilityExposureMode); }}
          className="ds-input w-full rounded-lg px-3 py-2 text-sm"
        >
          <option value="direct">{t('sidepanel.mcpPage.detail.exposureDirect')}</option>
          <option value="adaptive">{t('sidepanel.mcpPage.detail.exposureAdaptive')}</option>
          <option value="on_demand">{t('sidepanel.mcpPage.detail.exposureOnDemand')}</option>
        </select>
        {exposureMode === 'adaptive' && (
          <div className="text-[11px]" style={{ color: 'var(--ds-text-tertiary)' }}>
            {t('sidepanel.mcpPage.detail.exposureAdaptiveHint', { count: pinnedDescriptorIds.length })}
          </div>
        )}
        {exposureMode === 'on_demand' && (
          <div className="text-[11px]" style={{ color: 'var(--ds-text-tertiary)' }}>
            {t('sidepanel.mcpPage.detail.exposureOnDemandHint')}
          </div>
        )}
      </div>

      <div className="ds-card rounded-lg p-3 space-y-2">
        <ToggleRow
          title={t('sidepanel.mcpPage.detail.executionPolicy')}
          description={t('sidepanel.mcpPage.detail.injectionSummary', { count: countEnabledMcpTools(server, tools) })}
          enabled={server.execution.enabled}
          onToggle={(next) => onPatch({ execution: { ...server.execution, enabled: next } })}
        />
        <select
          value={server.execution.mode}
          onChange={(event) => onPatch({ execution: { ...server.execution, mode: event.target.value as ToolExecutionMode } })}
          className="ds-input w-full rounded-lg px-3 py-2 text-sm"
        >
          <option value="auto">{t('sidepanel.mcpPage.form.modeAuto')}</option>
          <option value="disabled">{t('sidepanel.mcpPage.form.modeDisabled')}</option>
        </select>
      </div>

      <CollapsibleSection
        label={t('sidepanel.mcpPage.detail.discoveredTools')}
        count={tools.length}
        defaultOpen
      >
        {tools.length === 0 ? (
          <div className="text-xs py-6 text-center" style={{ color: 'var(--ds-text-tertiary)' }}>
            {t('sidepanel.mcpPage.detail.noTools')}
          </div>
        ) : (
          <div className="space-y-2">
            {orderedTools.map((tool) => (
              <ToolRow
                key={tool.id}
                server={server}
                tool={tool}
                pinned={pinnedDescriptorIds.includes(tool.id)}
                onToggle={() => onToggleTool(tool)}
                onTogglePinned={() => onTogglePinned(tool)}
                t={t}
              />
            ))}
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection
        label={t('sidepanel.mcpPage.detail.recentCalls')}
        count={serverHistory.length}
        defaultOpen={false}
        open={historyOpen}
        onToggle={() => setHistoryOpen((prev) => !prev)}
      >
        {serverHistory.length === 0 ? (
          <div className="text-xs py-3 text-center" style={{ color: 'var(--ds-text-tertiary)' }}>
            {t('sidepanel.mcpPage.detail.noHistory')}
          </div>
        ) : (
          <div className="space-y-1.5">
            {serverHistory.map((record) => (
              <div key={record.id} className="ds-card rounded-lg px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium truncate" style={{ color: 'var(--ds-text)' }}>
                    {record.call.name}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ color: record.result.ok ? 'var(--ds-success)' : 'var(--ds-danger)', background: record.result.ok ? 'var(--ds-success-bg)' : 'var(--ds-danger-bg)' }}>
                    {record.result.ok ? t('sidepanel.mcpPage.success') : t('sidepanel.mcpPage.failure')}
                  </span>
                </div>
                <div className="text-[11px] mt-1 truncate" style={{ color: 'var(--ds-text-tertiary)' }}>
                  {formatTime(record.createdAt, locale)} · {record.result.summary}
                </div>
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>
    </div>
  );
}

function CollapsibleSection({
  label,
  count,
  defaultOpen,
  open: openProp,
  onToggle: onToggleProp,
  children,
}: {
  label: string;
  count: number;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen ?? false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;
  const toggle = () => (isControlled ? onToggleProp?.() : setInternalOpen((prev) => !prev));
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center justify-between w-full gap-2"
      >
        <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--ds-text)' }}>
          <svg
            className="w-3 h-3 transition-transform duration-200"
            style={{ transform: open ? 'rotate(90deg)' : 'rotate(0)', color: 'var(--ds-text-tertiary)' }}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {label}
          <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ color: 'var(--ds-text-tertiary)', background: 'var(--ds-surface)' }}>
            {count}
          </span>
        </span>
      </button>
      {open && children}
    </div>
  );
}

function ToolRow({
  server,
  tool,
  pinned,
  onToggle,
  onTogglePinned,
  t,
}: {
  server: McpServerConfig;
  tool: ToolDescriptor;
  pinned: boolean;
  onToggle: () => void;
  onTogglePinned: () => void;
  t: Translator;
}) {
  const enabled = isMcpToolEnabled(server, tool);
  const selected = isMcpToolSelected(server, tool);
  const presentation = describeMcpTool(tool, t);
  return (
    <div className="ds-card rounded-lg px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex items-center gap-1.5">
          <span className="text-xs font-medium truncate" style={{ color: 'var(--ds-text)' }}>{presentation.label}</span>
          <span
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium"
            style={riskBadgeStyle(presentation.risk)}
          >
            {t(riskBadgeLabelKey(presentation.risk))}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onTogglePinned}
            aria-pressed={pinned}
            className="ds-btn-secondary px-2 py-1 text-[10px] rounded-md"
          >
            {pinned ? t('sidepanel.mcpPage.detail.unpin') : t('sidepanel.mcpPage.detail.pin')}
          </button>
          <ToggleRow
            title={enabled
              ? t('sidepanel.mcpPage.auto')
              : selected
                ? t('sidepanel.mcpPage.selected')
                : t('sidepanel.mcpPage.disabled')}
            enabled={selected}
            onToggle={onToggle}
          />
        </div>
      </div>
      <div className="text-[11px] mt-1 leading-4" style={{ color: 'var(--ds-text-secondary)' }}>
        {presentation.summary}
      </div>
    </div>
  );
}

/**
 * 风险徽章的配色。
 *
 * 三档各用一种已有的语义色：只读 = 中性、写入 = 警告、执行 = 危险。
 * 与「只有两种颜色」相比，这里刻意让**写入**与**执行**分开 —— 用户最需要分辨的
 * 正是「它改我的文件」和「它在我机器上跑东西」。
 */
function riskBadgeStyle(risk: McpToolRiskBadge): CSSProperties {
  if (risk === 'read') {
    return {
      color: 'var(--ds-text-tertiary)',
      background: 'var(--ds-surface)',
      border: '1px solid var(--ds-border)',
    };
  }
  if (risk === 'write') {
    return {
      color: 'var(--ds-warning)',
      background: 'var(--ds-warning-bg)',
      border: '1px solid var(--ds-warning-border)',
    };
  }
  return {
    color: 'var(--ds-danger)',
    background: 'var(--ds-danger-bg)',
    border: '1px solid var(--ds-danger-border)',
  };
}

function EmptyState({ label, hint, actions }: { label: string; hint?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-14 gap-3 text-center">
      <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: 'var(--ds-surface)' }}>
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} style={{ color: 'var(--ds-text-tertiary)' }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5h3a3 3 0 110 6h-3m-3-6h-3a3 3 0 100 6h3m-1.5-3h6" />
        </svg>
      </div>
      <p className="text-sm" style={{ color: 'var(--ds-text-tertiary)' }}>{label}</p>
      {hint && <p className="text-[11px] -mt-1 max-w-[240px]" style={{ color: 'var(--ds-text-tertiary)' }}>{hint}</p>}
      {actions && <div className="flex flex-wrap gap-2 justify-center mt-1">{actions}</div>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs mb-1" style={{ color: 'var(--ds-text-secondary)' }}>{label}</span>
      {children}
      {hint && <span className="block text-[11px] mt-1" style={{ color: 'var(--ds-text-tertiary)' }}>{hint}</span>}
    </label>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <Field label={label}>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="ds-input w-full rounded-lg px-2 py-1.5 text-xs"
        inputMode="numeric"
      />
    </Field>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: 'var(--ds-bg)', border: '1px solid var(--ds-border)' }}>
      <div style={{ color: 'var(--ds-text-tertiary)' }}>{label}</div>
      <div className="mt-0.5 truncate" style={{ color: 'var(--ds-text)' }}>{value}</div>
    </div>
  );
}

function formFromServer(server: McpServerConfig): FormState {
  return {
    displayName: server.displayName,
    enabled: server.enabled,
    transportKind: server.transport.kind,
    url: server.transport.url ?? '',
    nativeHost: server.transport.nativeHost ?? '',
    command: server.transport.command ?? '',
    args: server.transport.args?.join(' ') ?? '',
    cwd: server.transport.cwd ?? '',
    env: Object.entries(server.transport.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
    headers: server.headers,
    secrets: server.secrets,
    connectMs: String(server.timeouts.connectMs),
    requestMs: String(server.timeouts.requestMs),
    discoveryMs: String(server.timeouts.discoveryMs),
    maxResultBytes: String(server.limits.maxResultBytes),
    maxToolCount: String(server.limits.maxToolCount),
    executionEnabled: server.execution.enabled,
    executionMode: server.execution.mode,
  };
}

function payloadFromForm(
  form: FormState,
  t: Translator,
  platform: PlatformEnvironment | null,
): { payload: McpServerCreateInput } | { error: string } {
  const displayName = form.displayName.trim();
  if (!displayName) return { error: t('sidepanel.mcpPage.validation.nameRequired') };

  const timeouts = {
    connectMs: boundedTimeoutMs(form.connectMs, t('sidepanel.mcpPage.form.connectMs'), t),
    requestMs: boundedTimeoutMs(form.requestMs, t('sidepanel.mcpPage.form.requestMs'), t),
    discoveryMs: boundedTimeoutMs(form.discoveryMs, t('sidepanel.mcpPage.form.discoveryMs'), t),
  };
  const limits = {
    maxResultBytes: positiveInt(form.maxResultBytes, t('sidepanel.mcpPage.form.resultBytes'), t),
    maxToolCount: positiveInt(form.maxToolCount, t('sidepanel.mcpPage.form.toolLimit'), t),
  };
  const invalidNumber = Object.values(timeouts).find((value) => typeof value === 'string') ||
    Object.values(limits).find((value) => typeof value === 'string');
  if (typeof invalidNumber === 'string') return { error: invalidNumber };

  const transportResult = transportFromForm(form, t, platform);
  if ('error' in transportResult) return transportResult;

  const headersResult = normalizeHeaders(form.headers, t);
  if ('error' in headersResult) return headersResult;

  const secretsResult = normalizeSecrets(form.secrets, t);
  if ('error' in secretsResult) return secretsResult;

  return {
    payload: {
      displayName,
      enabled: form.enabled,
      transport: transportResult.transport,
      headers: headersResult.headers,
      secrets: secretsResult.secrets,
      timeouts: timeouts as { connectMs: number; requestMs: number; discoveryMs: number },
      limits: limits as { maxResultBytes: number; maxToolCount: number },
      allowlist: {
        mode: 'all',
        toolNames: [],
      },
      execution: {
        enabled: form.executionEnabled,
        mode: form.executionMode,
      },
    },
  };
}

function transportFromForm(
  form: FormState,
  t: Translator,
  platform: PlatformEnvironment | null,
): { transport: McpServerTransportConfig } | { error: string } {
  if (form.transportKind === 'native_messaging') {
    if (!isMcpNativeMessagingSupported(platform)) {
      return { error: t('sidepanel.mcpPage.messages.nativeMessagingUnsupported') };
    }
    const nativeHost = form.nativeHost.trim();
    if (!nativeHost) return { error: t('sidepanel.mcpPage.validation.nativeHostRequired') };
    if (!/^[A-Za-z0-9_.-]+$/.test(nativeHost)) return { error: t('sidepanel.mcpPage.validation.nativeHostInvalid') };
    return { transport: { kind: 'native_messaging', nativeHost } };
  }

  const url = form.url.trim();
  if (!url) {
    return {
      error: t(form.transportKind === 'stdio_bridge'
        ? 'sidepanel.mcpPage.validation.bridgeEndpointRequired'
        : 'sidepanel.mcpPage.validation.serviceUrlRequired'),
    };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: t('sidepanel.mcpPage.validation.serviceUrlUnsupported') };
  } catch {
    return { error: t('sidepanel.mcpPage.validation.serviceUrlInvalid') };
  }

  if (form.transportKind !== 'stdio_bridge') {
    return { transport: { kind: form.transportKind, url } };
  }

  const env = parseEnv(form.env, t);
  if ('error' in env) return env;
  const command = form.command.trim();
  return {
    transport: {
      kind: 'stdio_bridge',
      url,
      command,
      args: command ? form.args.split(/\s+/).map((item) => item.trim()).filter(Boolean) : [],
      cwd: form.cwd.trim(),
      env: env.env,
    },
  };
}

function normalizeHeaders(headers: McpHeaderValue[], t: Translator): { headers: McpHeaderValue[] } | { error: string } {
  const normalized: McpHeaderValue[] = [];
  for (const header of headers) {
    const name = header.name.trim();
    const value = header.value;
    if (!name && !value) continue;
    if (!isHeaderName(name)) {
      return {
        error: t('sidepanel.mcpPage.validation.headerInvalidName', {
          name: name || t('sidepanel.mcpPage.validation.emptyValue'),
        }),
      };
    }
    if (value.includes('\n') || value.includes('\r')) {
      return { error: t('sidepanel.mcpPage.validation.headerInvalidValue', { name }) };
    }
    normalized.push({ name, value });
  }
  return { headers: normalized };
}

function normalizeSecrets(secrets: McpSecretValue[], t: Translator): { secrets: McpSecretValue[] } | { error: string } {
  const normalized: McpSecretValue[] = [];
  for (const secret of secrets) {
    const value = secret.value.trim();
    const headerName = secret.headerName?.trim();
    if (!value && !headerName && !secret.username) continue;
    if (secret.kind === 'header' && !isHeaderName(headerName ?? '')) {
      return { error: t('sidepanel.mcpPage.validation.headerSecretRequired') };
    }
    normalized.push({
      id: secret.id || crypto.randomUUID(),
      kind: secret.kind,
      value,
      headerName,
      username: secret.username?.trim(),
    });
  }
  return { secrets: normalized };
}

function parseEnv(value: string, t: Translator): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const index = line.indexOf('=');
    if (index <= 0) return { error: t('sidepanel.mcpPage.validation.envInvalid', { line }) };
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return { env };
}

/** 毫秒类字段（连接 / 请求 / 发现）的合法区间：1 秒 ~ 30 分钟。 */
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 1_800_000;

function positiveInt(value: string, label: string, t: Translator): number | string {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return t('sidepanel.mcpPage.validation.positiveInteger', { label });
  }
  return parsed;
}

/**
 * 毫秒字段专用校验：正整数 **且有上界**。
 *
 * ⚠️⚠️ **上界不是「顺手加的防呆」，是硬的** —— 这三个值最终进 `setTimeout`，而它的
 * `delay` 按 **signed 32-bit** 存储：超过 2_147_483_647 会溢出成「立刻触发」
 * （实测 `setTimeout(fn, 2**31)` 4ms 就跑）。用户填 3000000000 想表达「50 分钟」，
 * 实际效果是每次请求刚发出就超时，而界面只报「服务响应超时」，指不到这一项。
 *
 * ⚠️ 超范围时**不能复用 `positiveInteger`** —— 那句「必须是正整数」对一个
 * 3000000000 是误导（它确实是正整数），用户会一头雾水。
 *
 * ⚠️ 导出只是为了能喂真实输入测它（同 `describeMcpFailure` / `shellSetupMessage`）。
 */
export function boundedTimeoutMs(
  value: string,
  label: string,
  t: Translator,
): number | string {
  const parsed = positiveInt(value, label, t);
  if (typeof parsed === 'string') return parsed;
  if (parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    return t('sidepanel.mcpPage.validation.timeoutOutOfRange', {
      label,
      min: MIN_TIMEOUT_MS,
      max: MAX_TIMEOUT_MS,
    });
  }
  return parsed;
}

function isHeaderName(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

function statusMeta(status: McpServerStatus, t: Translator) {
  if (status === 'ready') return { label: t('sidepanel.mcpPage.status.ready'), color: 'var(--ds-success)', bg: 'var(--ds-success-bg)' };
  if (status === 'error') return { label: t('sidepanel.mcpPage.status.error'), color: 'var(--ds-danger)', bg: 'var(--ds-danger-bg)' };
  if (status === 'disabled') return { label: t('sidepanel.mcpPage.status.disabled'), color: 'var(--ds-text-tertiary)', bg: 'var(--ds-surface)' };
  return { label: t('sidepanel.mcpPage.status.unknown'), color: 'var(--ds-text-secondary)', bg: 'var(--ds-surface)' };
}

function ShellSetupHint({
  server,
  cache,
  t,
}: {
  server: McpServerConfig;
  cache: McpToolCacheEntry | null;
  t: Translator;
}) {
  const { message, isError } = shellSetupMessage(server, cache, t);
  const setup = shellInstallCommand();
  return (
    <NativeHostHint
      title="Shell Native Host"
      message={message}
      isError={isError}
      // ⚠️⚠️ **两个条件缺一不可。**
      // 组件默认「已就绪就折叠」（`useState(() => !ready)`，惰性初始化 ⇒ 之后不再重算）。
      // ① `!isError` —— 「连上了但少返回工具」那条告警的状态恰恰是 `ready`，
      //    只看 health 会让它躺在折叠区里，用户不展开就看不见（等于没提示）。
      // ② `health.status === 'ready'` —— 只看 `!isError` 会把 `disabled`（已建未启用）
      //    与 `installFirst`（请先安装）这两档也一起折叠掉，而那正是**首次使用、
      //    最该看见安装命令**的时刻；首帧 `cache` 为 null 时还会永久折叠（惰性初始化不再重算）。
      // ③ `server.enabled` —— 关掉服务时缓存仍是 `ready`（关开关不清缓存），
      //    不判它就会把「已停用」那一档也折叠掉，用户看不到「服务已创建但尚未启用」。
      ready={!isError && server.enabled && cache?.health.status === 'ready'}
      installSteps={(<>
        <div style={{ color: 'var(--ds-text-tertiary)' }}>
          {t('sidepanel.mcpPage.shellSetup.publishedIntro')}
        </div>
        <div className="mt-1 font-mono break-all select-all rounded px-2 py-1" style={{ color: 'var(--ds-text)', background: 'var(--ds-surface)' }}>
          {setup.command}
        </div>
        {/*
          * ⚠️ **备选命令只给源码开发者** —— 两条命令都在屏幕上，用户会犹豫抄哪条，
          * 所以主命令必须是「大多数人能直接跑」的那条（`npx`），源码那条降级到下方。
          */}
        <div className="mt-1" style={{ color: 'var(--ds-text-tertiary)' }}>
          {t('sidepanel.mcpPage.shellSetup.fallbackIntro')}
        </div>
        <div className="mt-1 font-mono break-all select-all rounded px-2 py-1" style={{ color: 'var(--ds-text)', background: 'var(--ds-surface)' }}>
          {setup.fallbackCommand}
        </div>
        <div className="mt-1" style={{ color: 'var(--ds-text-tertiary)' }}>
          {t('sidepanel.mcpPage.shellSetup.detectedExtensionId', { browser: browserLabel(setup.browser) })}
        </div>
        <div className="mt-1" style={{ color: 'var(--ds-text-tertiary)' }}>
          {t('sidepanel.mcpPage.shellSetup.installNote')}
        </div>
        <div className="mt-1" style={{ color: 'var(--ds-text-tertiary)' }}>
          {!server.enabled
            ? t('sidepanel.mcpPage.shellSetup.enableAndTest')
            : t('sidepanel.mcpPage.shellSetup.restartAndTest')}
        </div>
      </>)}
      t={t}
    />
  );
}

function NativeHostHint({
  title,
  message,
  isError,
  ready,
  installSteps,
  t,
}: {
  title: string;
  message: string;
  isError: boolean;
  ready: boolean;
  installSteps: ReactNode;
  t: Translator;
}) {
  // Expanded by default on error / not-installed; collapsed when already connected.
  // The toggle is fully user-controlled — initial state is derived from `ready`
  // via a lazy initializer so subsequent re-renders (frequent load() refreshes)
  // never reset the user's choice.
  const [open, setOpen] = useState(() => !ready);
  return (
    <div className="ds-card rounded-lg px-3 py-2 text-[11px] leading-4" style={{ color: 'var(--ds-text-secondary)' }}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex items-center gap-1.5 w-full"
      >
        <svg
          className="w-3 h-3 transition-transform duration-200"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0)', color: 'var(--ds-text-tertiary)' }}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="font-medium" style={{ color: 'var(--ds-text)' }}>{title}</span>
      </button>
      {open ? (
        <>
          {isError ? (
            <div className="rounded px-2 py-1 mt-1.5 mb-1.5" style={{ color: 'var(--ds-danger)', background: 'var(--ds-danger-bg)', border: '1px solid var(--ds-danger)' }}>
              {message}
            </div>
          ) : (
            <div className="mt-1">{message}</div>
          )}
          <div className="mt-1.5 space-y-0.5">{installSteps}</div>
        </>
      ) : (
        <div className="mt-1 text-[10px]" style={{ color: 'var(--ds-text-tertiary)' }}>
          {t('sidepanel.mcpPage.detail.hintExpand')}
        </div>
      )}
    </div>
  );
}

type NativeHostBrowser = 'chrome' | 'chromium' | 'edge';

/**
 * 两条安装命令：`npx` 是主路径，`npm run` 给源码开发者。
 *
 * ## 为什么主命令是 `npx`
 *
 * 下载扩展 zip 直接加载的人**手上没有这个仓库** —— 他抄 `npm run shell:install`
 * 只会得到「找不到 package.json」。而 `npx` 从 registry 取包、装完即止，
 * 不要求用户 clone，也不要求知道任何路径。
 *
 * ⚠️ **不做「按是否打包扩展」的分支** —— 那个判据（`update_url` 在不在 manifest 里）
 * 在本项目恒为「已打包以外」，因为本项目**不发布到商店**。而扩展也拿不到自己的
 * 文件系统路径（`chrome.runtime.getURL()` 给的是 `chrome-extension://<id>/`），
 * 所以「仓库在不在」这件事在扩展这一侧判不出来。两条都显示是最诚实的做法。
 *
 * ⚠️ **`--yes` 不能省** —— 首次 `npx` 会问 `Ok to proceed? (y)`，
 * 而卡片上是「可复制的单行命令」，用户不看解释直接把整行粘进终端时会被那个交互卡住。
 *
 * ⚠️ **不传 `--skip-officecli`** —— 那是上游的开关（它自带 OfficeCLI 安装），
 * 本项目没有这块能力，installer 对未知长参数**直接抛错** ⇒ 传了命令必失败。
 */
function shellInstallCommand(): {
  browser: NativeHostBrowser;
  command: string;
  fallbackCommand: string;
} {
  const browser = currentNativeHostBrowser();
  const extensionArg = ` --extension-id ${chrome.runtime.id || '<extension-id>'}`;
  const installArgs = `install --browser ${browser}${extensionArg}`;
  return {
    browser,
    command: `npx --yes zai-pp-shell-host ${installArgs}`,
    fallbackCommand: `npm run shell:install -- ${installArgs}`,
  };
}

function currentNativeHostBrowser(): NativeHostBrowser {
  const ua = navigator.userAgent;
  if (/\bEdg\//.test(ua)) return 'edge';
  if (/\bChromium\//.test(ua) && !/\bChrome\//.test(ua)) return 'chromium';
  return 'chrome';
}

function browserLabel(browser: NativeHostBrowser): string {
  if (browser === 'edge') return 'Edge';
  if (browser === 'chromium') return 'Chromium';
  return 'Chrome';
}

/**
 * 把服务返回的原始英文错误翻成人话。
 *
 * ⚠️ **第三方服务没有 `shellSetupMessage` 那一层** —— 它只对内置 Shell 生效，其余服务
 * 的错误条一直原样渲染 `health.error` / `lastError`，而那里面装的是**上一次发现的原始
 * 异常 message**（`MCP server returned HTTP 401.` / `Cannot reach MCP server at …` /
 * `MCP response exceeded 64000 bytes…`）。用户看到一句英文，既不知道是自己哪一项配置
 * 的问题，也不知道该去哪儿改。
 *
 * ⚠️⚠️ **只能按 message 的措辞判，按 `mcp_xxx` 错误码判是死的。**
 * `McpTransportError` / `McpProtocolError` 都是 `super(message)` —— **code 不在 message 里**。
 * 而这里拿到的是 `health.error`（= `persistMcpDiscoveryFailure` 里的
 * `providerError.message`）或 `server.lastError`（= 同一个 `health.error` 抄过去的），
 * 两者都只有 message、没有 code。实测 24 个 `mcp_*` 码**没有一个把 code 写进 message**：
 * `mcp_origin_permission_denied` 的原文是 `Host permission was not granted for …`、
 * `mcp_response_too_large` 是 `MCP response exceeded N bytes…`。
 * ⇒ 早期版本写的那几个 `lower.includes('mcp_xxx')` 分支**全是死判据**，
 * `permissionDenied` 那一档更是永远走不到、直接落到 fallback 显示英文。
 *
 * ⚠️ **判据按「稳定片段」分档，映射不到就原样回落** —— 不做精确匹配，因为
 * message 里的 URL / 端口号 / 字节数都是变量，且上游措辞会变。回落那一档保证
 * 「至少不比现在少信息」。
 *
 * ⚠️ **`not found` 不能裸判**：`health.error` 可能是**服务端原文**
 * （`unwrapMcpResponse` 对 JSON-RPC error 直接 `throw new McpProtocolError(code, response.error.message)`），
 * 第三方服务返回一句带 `not found` 的话就会被显示成「未找到 Native Host —— 请先运行安装命令」，
 * 而用户实际遇到的问题跟 host 毫无关系。**只认带 host 语义的组合**。
 *
 * ⚠️ **导出是为了可测**：它是这一条的完整判据，页面渲染测试要走三层组件才碰得到。
 */
export function describeMcpFailure(
  server: McpServerConfig,
  cache: McpToolCacheEntry | null,
  t: Translator,
): string | null {
  const raw = (cache?.health.error ?? server.lastError ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  // ⚠️ **`t()` 的模板串后缀必须写成字面量** —— `tests/i18n-unreferenced-keys.test.ts` 靠
  // 「字面前缀 + 字面后缀」判一个键有没有人引用；抽成 `pick(suffix)` 之后它静态求值不出来，
  // 那一整段键会被判成零引用（门禁要么假红、要么被迫开白名单）。与 `shellSetupMessage`
  // 同一个写法。
  const key = 'sidepanel.mcpPage.detail.failure';

  if (lower.includes('forbidden') || lower.includes('http 401') || lower.includes('http 403') || lower.includes('unauthorized')) {
    return t(`${key}.forbidden` as LocaleMessageKey);
  }
  // ⚠️ **只认带 host 语义的组合**（理由见函数头）。四句覆盖全部 native 侧失败：
  // `chrome.runtime.lastError` 的原文 `Specified native messaging host not found.`、
  // `Native messaging host is not configured.`、`Browser native messaging is unavailable.`、
  // `Native host disconnected.`。
  if (lower.includes('native messaging host not found')
    || lower.includes('specified native messaging host')
    || lower.includes('native messaging host is not configured')
    || lower.includes('native messaging is unavailable')
    || lower.includes('native host disconnected')) {
    return t(`${key}.hostNotFound` as LocaleMessageKey);
  }
  // ⚠️ 三句来自 `mcp_origin_permission_denied` / `_check_unavailable` / `_check_failed`。
  // 按 code 判的那一版是死判据（那几个 message 里都没有 code），这一档曾经永远落到 fallback。
  if (lower.includes('host permission was not granted')
    || lower.includes('host permission cannot be verified')
    || lower.includes('host permission could not be verified')) {
    return t(`${key}.permissionDenied` as LocaleMessageKey);
  }
  if (lower.includes('protocol version mismatch')) {
    return t(`${key}.versionMismatch` as LocaleMessageKey);
  }
  if (lower.includes('exceeded') && lower.includes('bytes')) {
    return t(`${key}.responseTooLarge` as LocaleMessageKey);
  }
  if (lower.includes('was not valid json')
    || lower.includes('was not a plain json object')
    || lower.includes('did not include a result')
    || lower.includes('did not include a body')
    || lower.includes('ended without a matching response')) {
    return t(`${key}.responseInvalid` as LocaleMessageKey);
  }
  if (lower.includes('timed out')
    || (lower.includes('exceeded') && lower.includes('ms'))) {
    return t(`${key}.timeout` as LocaleMessageKey);
  }
  if (lower.includes('failed to fetch')
    || lower.includes('cannot reach')
    || lower.includes('connection refused')) {
    return t(`${key}.cannotConnect` as LocaleMessageKey);
  }
  return t(`${key}.fallback` as LocaleMessageKey, { detail: raw });
}

/**
 * Shell Native Host 那一栏该显示什么。
 *
 * ⚠️ **导出是为了可测** —— 它是这一栏的全部判据，而页面渲染测试要走
 * `展开服务行 → ServerDetail → ShellSetupHint` 三层，脆弱且慢。
 */
export function shellSetupMessage(
  server: McpServerConfig,
  cache: McpToolCacheEntry | null,
  t: Translator,
): { message: string; isError: boolean } {
  const setupKey = 'sidepanel.mcpPage.shellSetup';
  // ⚠️⚠️ **关掉服务这一档必须排在所有缓存判据之前。**
  // 缓存记的是「上次发现成不成功」，**关开关不清缓存**（指纹只看连接字段、不含 `enabled`）
  // ⇒ 关掉之后 `health.status` 仍是 `ready`，后面那条 `ready` 分支会继续报「已连接，发现 12 个工具」，
  // 而实际上这个服务的工具一个都不会被提供。**「此刻用不用」的唯一真源是 `server.enabled`。**
  if (!server.enabled) {
    return { message: t(`${setupKey}.disabled` as LocaleMessageKey), isError: false };
  }
  const error = `${cache?.health.error ?? ''} ${server.lastError ?? ''}`.toLowerCase();
  if (error.includes('forbidden')) {
    return { message: t(`${setupKey}.forbidden` as LocaleMessageKey), isError: true };
  }
  /**
   * ⚠️⚠️ **下面这两条原先按 `native_host_unavailable` / `native_messaging_unavailable`
   * 这类 code 判 —— 那是死的**，理由同 `describeMcpFailure` 的函数头：
   * `McpTransportError` 的 code 不在 message 里，而这里拿到的是 message。
   * 现在改成按 message 的实际措辞判。
   *
   * ⚠️ **`not found` 不能裸判**（同一个坑）：它会把任何带这个词的错误都翻成
   * 「未找到 Native Host，请先运行安装命令」，而用户可能只是 host 版本旧、或服务端返回了别的错。
   * 只认带 native messaging 语义的组合。
   */
  if (error.includes('native messaging host not found')
    || error.includes('specified native messaging host')
    || error.includes('native messaging host is not configured')
    || error.includes('native host disconnected')) {
    return { message: t(`${setupKey}.notFound` as LocaleMessageKey), isError: true };
  }
  if (error.includes('browser native messaging is unavailable')) {
    return { message: t('sidepanel.mcpPage.shellSetup.unavailable'), isError: true };
  }
  if (error.includes('failed to fetch') ||
    error.includes('cannot reach') ||
    error.includes('connection refused')
  ) {
    return { message: t(`${setupKey}.cannotConnect` as LocaleMessageKey), isError: true };
  }
  // ⚠️⚠️ **「连上了、但少返回了工具」这一档必须排在 `ready` 之前。**
  //
  // 它是 Native Host 版本旧时**唯一**的可见信号：那时 `health.status` 是 `ready`、
  // `health.error` 为空 ⇒ 下面那条 `ready` 分支会报「已连接，发现 N 个工具」，
  // 而工具列表里就是少几个、**一句话都不解释**（用户只能猜「是不是坏了」）。
  //
  // ⚠️ 判据是「应有 − 实有」，不是「数量对不对」：缺的可能是任意一个工具，不只 python。
  // ⚠️ `SHELL_TOOL_NAMES` 是**完整清单**（含 `local_skill_preview`，host 侧也真的发布它），
  // 不能换成 `EXPOSED_SHELL_TOOL_NAMES`（那个是给提示词看的裁剪版），否则会假报缺失。
  if (cache?.health.status === 'ready') {
    const missing = missingShellTools(cache.descriptors);
    // ⚠️⚠️ **撞到本地「工具上限」时不报缺失。**
    // `cache.descriptors` 来自 `listMcpTools`，而它在 allowlist 过滤**之前**就
    // `slice(0, server.limits.maxToolCount)`（`core/mcp/client.ts`）—— 上限在 MCP 页
    // 高级表单里**可编辑**，而后台的自动抬升（`buildShellToolLimitUpgrade`）只在启动时
    // 对存量记录跑一次。用户把上限调到 8 再刷新，就会看到「4 个工具没有返回……
    // 多半是 Native Host 版本旧了，重装并重启浏览器」—— 原因是**他自己的设置**，
    // 而提示指向重装 ⇒ 让人白装一遍。
    //
    // 判据：**实有数量没撞到上限**才说明是 host 少发。撞到了就是本地截断。
    // ⚠️ **已知漏报面**（可接受）：host 少发的数量恰好等于上限时（如都等于 8），
    // 这里会判成「不是缺失」。失败方向是**不提示**，比让人白装一遍轻。
    const truncatedLocally = cache.descriptors.length >= server.limits.maxToolCount;
    if (missing.length > 0 && !truncatedLocally) {
      return {
        message: t(`${setupKey}.missingTools` as LocaleMessageKey, {
          count: missing.length,
          tools: missing.join(t(`${setupKey}.listSeparator` as LocaleMessageKey)),
        }),
        isError: true,
      };
    }
    // ⚠️ **这里报的是「你能看到几个」，不是 `health.toolCount`** ——
    // 后者是 host 发布的总数（含不出现在列表里的内部工具），两个数一起显示会
    // 出现「发现 12 个工具」而列表只有 11 条。⚠️ 「host 有没有少发」由上面那条
    // `missingShellTools` 判据独立负责，它仍用完整清单，不受这里影响。
    return {
      message: t(`${setupKey}.ready` as LocaleMessageKey, { count: visibleMcpTools(cache).length }),
      isError: false,
    };
  }
  return { message: t(`${setupKey}.installFirst` as LocaleMessageKey), isError: false };
}

/**
 * Native Host 应该发布、但这次发现没回来的工具名。
 *
 * ⚠️ **判据是「应有 − 实有」**：`SHELL_TOOL_NAMES` 是完整清单（12 个，含
 * `local_skill_preview` —— host 侧 `skill-provider.mjs` 确实发布它）。
 * 不能用 `EXPOSED_SHELL_TOOL_NAMES`（那是给提示词看的裁剪版，会假报缺失）。
 */
export function missingShellTools(descriptors: readonly { name: string }[] | undefined): string[] {
  const present = new Set((descriptors ?? []).map((descriptor) => descriptor.name));
  return SHELL_TOOL_NAMES.filter((name) => !present.has(name));
}

function transportLabel(kind: McpTransportKind): string {
  return TRANSPORT_OPTIONS.find((item) => item.kind === kind)?.label ?? kind;
}

function endpointLabel(server: McpServerConfig): string {
  if (server.transport.kind === 'native_messaging') return server.transport.nativeHost || 'Native Messaging';
  if (server.transport.kind === 'stdio_bridge') return `${server.transport.url || 'Bridge URL'} · ${server.transport.command || 'command'}`;
  return server.transport.url || transportLabel(server.transport.kind);
}

function formatMs(value: number | null | undefined): string {
  return typeof value === 'number' ? `${value} ms` : '-';
}

function formatTime(value: number | null | undefined, locale?: SupportedLocale): string {
  if (!value) return '-';
  return new Date(value).toLocaleString(locale);
}
