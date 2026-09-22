import { lazy, Suspense, useState } from 'react';
import RouteFallback from '../components/RouteFallback';
import { SubTabs } from '../components/settings/primitives';
import { useSettingsController } from '../controllers/useSettingsController';
import { useI18n } from '../i18n';

const MemoryPage = lazy(() => import('./MemoryPage'));
const SavedPage = lazy(() => import('./SavedPage'));
const DataSubPage = lazy(() => import('../components/settings/DataSubPage'));

type LibrarySubTab = 'memory' | 'saved' | 'data';

const SUB_TABS: { key: LibrarySubTab; labelKey: 'sidepanel.libraryPage.tabs.memory' | 'sidepanel.libraryPage.tabs.saved' | 'sidepanel.libraryPage.tabs.data' }[] = [
  { key: 'memory', labelKey: 'sidepanel.libraryPage.tabs.memory' },
  { key: 'saved', labelKey: 'sidepanel.libraryPage.tabs.saved' },
  { key: 'data', labelKey: 'sidepanel.libraryPage.tabs.data' },
];

export default function LibraryPage() {
  const [sub, setSub] = useState<LibrarySubTab>('memory');
  const { t } = useI18n();
  const settingsState = useSettingsController();

  return (
    <div className="flex flex-col h-full">
      <SubTabs
        tabs={SUB_TABS.map((tab) => ({ key: tab.key, label: t(tab.labelKey) }))}
        value={sub}
        onChange={setSub}
        ariaLabel={t('sidepanel.libraryPage.navLabel')}
      />

      {/* No padding here: each sub-page root already carries `p-4`, so an
          extra layer would double the inset. */}
      <div className="flex-1 overflow-y-auto">
        <Suspense fallback={<RouteFallback />}>
          {sub === 'memory' && <MemoryPage />}
          {sub === 'saved' && <SavedPage />}
          {sub === 'data' && <DataSubPage state={settingsState} />}
        </Suspense>
      </div>
    </div>
  );
}
