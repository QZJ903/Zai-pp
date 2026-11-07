import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_PROMPT_INJECTION_SETTINGS,
  normalizePromptInjectionSettings,
  type ForcedResponseLanguage,
  type PromptInjectionSettings,
  type PromptPresetCadence,
} from '../../../core/prompt/settings';
import { createSerialOperationQueue } from '../../../core/persistence/serial-operation-queue';
import { createRequestGenerationFence } from '../async-state';
import { useI18n } from '../i18n';
import { formatRuntimeError } from '../runtime-response';
import { sidepanelRuntimeClient } from '../runtime-client';

/**
 * One queue for this settings key.
 *
 * Module level on purpose: it serialises writes to a storage key, and that key
 * is shared by every mount of this panel, not owned by one component instance.
 */
const saveQueue = createSerialOperationQueue();

export default function PromptControlPanel() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<PromptInjectionSettings>(DEFAULT_PROMPT_INJECTION_SETTINGS);
  const [statusMessage, setStatusMessage] = useState('');
  const requestFence = useRef(createRequestGenerationFence());
  /**
   * The value the UI is currently showing, readable without waiting for a render.
   *
   * Two toggles can be clicked inside one tick, before React re-renders; without
   * this the second save would build its payload from the pre-first-click state
   * and silently undo it.
   */
  const settingsRef = useRef<PromptInjectionSettings>(DEFAULT_PROMPT_INJECTION_SETTINGS);
  /**
   * The last configuration the background confirmed, i.e. what a failed save has
   * to fall back to. Kept separately from `settings` because the shown value is
   * optimistically ahead of the store while a save is in flight.
   */
  const confirmedRef = useRef<PromptInjectionSettings>(DEFAULT_PROMPT_INJECTION_SETTINGS);

  const apply = (next: PromptInjectionSettings) => {
    settingsRef.current = next;
    setSettings(next);
  };

  useEffect(() => {
    const generation = requestFence.current.begin();
    sidepanelRuntimeClient.request(
      { type: 'GET_PROMPT_INJECTION_SETTINGS' },
      {
        unavailableMessage: t('sidepanel.promptControls.backendUnavailable'),
        decode: (value) => decodePromptSettings(
          value,
          t('sidepanel.promptControls.backendUnavailable'),
        ),
      },
    )
      .then((loaded) => {
        if (!requestFence.current.isCurrent(generation)) return;
        confirmedRef.current = loaded;
        apply(loaded);
      })
      .catch((error) => {
        if (!requestFence.current.isCurrent(generation)) return;
        confirmedRef.current = DEFAULT_PROMPT_INJECTION_SETTINGS;
        apply(DEFAULT_PROMPT_INJECTION_SETTINGS);
        setStatusMessage(t('sidepanel.promptControls.loadFailed', { error: formatRuntimeError(error, t, { bare: true }) }));
      });
    return () => requestFence.current.invalidate();
  }, [t]);

  /**
   * Persists a patch, one request at a time.
   *
   * Two toggles can be clicked faster than a round trip, and this panel sends
   * the **whole** settings object on every save. Overlapping requests therefore
   * race on that object: the older one either carries the newer one's change
   * back to its old value, or (on failure) reverts a field the newer save had
   * already committed. Serialising means each save reads the state the previous
   * one left behind, so the last click wins and every failure rolls back exactly
   * its own field.
   *
   * The optimistic update still happens on click — the switch has to move
   * immediately — and the queued body recomputes from the live value, so a
   * rollback from an earlier save is already folded in by the time this one runs.
   *
   * ⚠️ A failed save reverts the **whole** configuration to the last confirmed
   * one, which briefly also undoes a later click that is still queued. That is
   * deliberate: the queued slot then recomputes from the reverted value and
   * re-applies its own change, so the end state is right — only the intermediate
   * frame shows the rollback. Reverting per field would be enough only if the
   * payload were built per field, and it is not.
   */
  const save = async (patch: Partial<PromptInjectionSettings>) => {
    apply(normalizePromptInjectionSettings({ ...settingsRef.current, ...patch }));
    setStatusMessage('');
    return saveQueue.run(async () => {
      const next = normalizePromptInjectionSettings({ ...settingsRef.current, ...patch });
      apply(next);
      try {
        const saved = await sidepanelRuntimeClient.request(
          {
            type: 'SAVE_PROMPT_INJECTION_SETTINGS',
            payload: next,
          },
          {
            unavailableMessage: t('sidepanel.promptControls.backendUnavailable'),
            decode: (value) => decodePromptSettings(
              value,
              t('sidepanel.promptControls.backendUnavailable'),
            ),
          },
        );
        confirmedRef.current = saved;
        apply(saved);
        setStatusMessage('');
      } catch (error) {
        apply(confirmedRef.current);
        setStatusMessage(t('sidepanel.promptControls.saveFailed', { error: formatRuntimeError(error, t, { bare: true }) }));
      }
    });
  };

  return (
    <section className="space-y-3">
      <h2 className="text-[13px] font-medium" style={{ color: 'var(--ds-text)' }}>
        {t('sidepanel.promptControls.title')}
      </h2>
      <div className="ds-surface-panel rounded-xl p-4 space-y-3">
        <ToggleRow
          title={t('sidepanel.promptControls.memory')}
          description={t('sidepanel.promptControls.memoryDescription')}
          enabled={settings.memoryEnabled}
          onToggle={(enabled) => save({ memoryEnabled: enabled })}
        />
        <ToggleRow
          title={t('sidepanel.promptControls.systemPrompt')}
          description={t('sidepanel.promptControls.systemPromptDescription')}
          enabled={settings.systemPromptEnabled}
          onToggle={(enabled) => save({ systemPromptEnabled: enabled })}
        />

        <label className="block space-y-1">
          <span className="text-[11px]" style={{ color: 'var(--ds-text-secondary)' }}>
            {t('sidepanel.promptControls.presetCadence')}
          </span>
          <select
            value={settings.presetCadence}
            onChange={(event) => save({ presetCadence: event.target.value as PromptPresetCadence })}
            className="w-full px-3 py-2 text-xs rounded-lg border outline-none"
            style={{ background: 'var(--ds-bg)', borderColor: 'var(--ds-border)', color: 'var(--ds-text)' }}
          >
            <option value="default">{t('sidepanel.promptControls.cadenceDefault')}</option>
            <option value="first_message">{t('sidepanel.promptControls.cadenceFirst')}</option>
            <option value="every_message">{t('sidepanel.promptControls.cadenceEvery')}</option>
            <option value="off">{t('sidepanel.promptControls.cadenceOff')}</option>
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-[11px]" style={{ color: 'var(--ds-text-secondary)' }}>
            {t('sidepanel.promptControls.forceLanguage')}
          </span>
          <select
            value={settings.forceResponseLanguage}
            onChange={(event) => save({ forceResponseLanguage: event.target.value as ForcedResponseLanguage })}
            className="w-full px-3 py-2 text-xs rounded-lg border outline-none"
            style={{ background: 'var(--ds-bg)', borderColor: 'var(--ds-border)', color: 'var(--ds-text)' }}
          >
            <option value="auto">{t('sidepanel.promptControls.languageAuto')}</option>
            <option value="zh-CN">{t('sidepanel.promptControls.languageZh')}</option>
            <option value="en">{t('sidepanel.promptControls.languageEn')}</option>
          </select>
        </label>

        {statusMessage && (
          <div className="text-[11px] rounded-lg px-2 py-1.5" style={{ color: 'var(--ds-text-secondary)', background: 'var(--ds-surface)' }}>
            {statusMessage}
          </div>
        )}
      </div>
    </section>
  );
}

function decodePromptSettings(value: unknown, missingMessage: string): PromptInjectionSettings {
  if (value === null) throw new Error(missingMessage);
  return normalizePromptInjectionSettings(value);
}

function ToggleRow({
  title,
  description,
  enabled,
  onToggle,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="flex justify-between items-center gap-3">
      <div>
        <div className="text-xs font-medium" style={{ color: 'var(--ds-text)' }}>{title}</div>
        <div className="text-[11px] mt-0.5" style={{ color: 'var(--ds-text-tertiary)' }}>
          {description}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onToggle(!enabled)}
        className="relative shrink-0 w-10 h-[22px] rounded-full transition-colors duration-200"
        style={{ background: enabled ? 'var(--ds-blue)' : 'var(--ds-border)' }}
      >
        <span
          className="ds-switch-thumb absolute top-[3px] left-[3px] w-4 h-4 rounded-full transition-transform duration-200"
          style={{ transform: enabled ? 'translateX(18px)' : 'translateX(0)' }}
        />
      </button>
    </div>
  );
}
