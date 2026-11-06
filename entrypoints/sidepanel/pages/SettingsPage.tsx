import { lazy, Suspense, useState } from 'react';
import type { LocaleMessageKey } from '../../../core/i18n';
import PageIntro from '../components/PageIntro';
import RouteFallback from '../components/RouteFallback';
import { SkeletonList, SubTabs, useBanner } from '../components/settings/primitives';
import { useSettingsController } from '../controllers/useSettingsController';
import { formatRuntimeError } from '../runtime-response';
import { useI18n } from '../i18n';

const GeneralSubPage = lazy(() => import('../components/settings/GeneralSubPage'));
const PresetSubPage = lazy(() => import('../components/settings/PresetSubPage'));
const PromptSubPage = lazy(() => import('../components/settings/PromptSubPage'));
const UsageSubPage = lazy(() => import('../components/settings/UsageSubPage'));
const AboutSubPage = lazy(() => import('../components/settings/AboutSubPage'));

type SubTab = 'general' | 'preset' | 'prompt' | 'usage' | 'about';

const SUB_TABS: { key: SubTab; labelKey: LocaleMessageKey }[] = [
  { key: 'general', labelKey: 'sidepanel.settings.tabs.general' },
  { key: 'preset', labelKey: 'sidepanel.settings.tabs.preset' },
  { key: 'prompt', labelKey: 'sidepanel.settings.tabs.prompt' },
  { key: 'usage', labelKey: 'sidepanel.settings.tabs.usage' },
  { key: 'about', labelKey: 'sidepanel.settings.tabs.about' },
];

const SUB_DESCRIPTION_KEY: Record<SubTab, LocaleMessageKey> = {
  general: 'sidepanel.settings.generalDescription',
  preset: 'sidepanel.presetPage.description',
  prompt: 'sidepanel.settings.promptDescription',
  usage: 'sidepanel.settings.usageDescription',
  about: 'sidepanel.settings.aboutTagline',
};

export default function SettingsPage() {
  const { t } = useI18n();
  const [sub, setSub] = useState<SubTab>('general');
  const banner = useBanner();
  const state = useSettingsController({
    error: (error) => banner.show(
      'error',
      t('sidepanel.settings.backgroundSaveFailed', {
        error: formatRuntimeError(error, t, { bare: true }),
      }),
    ),
  });

  return (
    <div className="ds-settings-shell">
      <div className="px-4 pt-4 pb-2">
        <PageIntro
          title={t('sidepanel.settings.title')}
          description={t(SUB_DESCRIPTION_KEY[sub])}
          meta={state.version ? `v${state.version}` : undefined}
        />
      </div>

      <SubTabs
        tabs={SUB_TABS.map((tab) => ({ key: tab.key, label: t(tab.labelKey) }))}
        value={sub}
        onChange={setSub}
        ariaLabel={t('sidepanel.settings.navLabel')}
      />

      <div className="ds-settings-content">
        {state.loading ? (
          <SkeletonList rows={3} />
        ) : (
          <Suspense fallback={<RouteFallback />}>
            {sub === 'general' && <GeneralSubPage state={state} banner={banner.node} />}
            {sub === 'preset' && <PresetSubPage />}
            {sub === 'prompt' && <PromptSubPage />}
            {sub === 'usage' && <UsageSubPage />}
            {sub === 'about' && <AboutSubPage state={state} />}
          </Suspense>
        )}
      </div>
    </div>
  );
}
