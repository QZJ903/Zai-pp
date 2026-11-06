import { lazy, Suspense, useState } from 'react';
import type { LocaleMessageKey } from '../../core/i18n';
import RouteErrorBoundary from './components/RouteErrorBoundary';
import RouteFallback from './components/RouteFallback';
import WhatsNewPanel from './components/WhatsNewPanel';
import { useI18n } from './i18n';

type Tab = 'library' | 'capabilities' | 'settings';

const LibraryPage = lazy(() => import('./pages/LibraryPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const CapabilitiesPage = lazy(() => import('./pages/CapabilitiesPage'));

const TABS: { key: Tab; labelKey: LocaleMessageKey; icon: string }[] = [
  { key: 'library', labelKey: 'app.tabs.library', icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5s3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18s-3.332.477-4.5 1.253' },
  { key: 'capabilities', labelKey: 'app.tabs.capabilities', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
  { key: 'settings', labelKey: 'app.tabs.settings', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
];

export default function App() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('library');

  return (
    <div className="ds-app-shell">
      <nav className="side-tabs" aria-label={t('app.sideNavLabel')}>
        {TABS.map((tabConfig) => {
          const label = t(tabConfig.labelKey);
          return (
            <button
              key={tabConfig.key}
              type="button"
              onClick={() => setTab(tabConfig.key)}
              className={`side-tab${tab === tabConfig.key ? ' side-tab-active' : ''}`}
              aria-current={tab === tabConfig.key ? 'page' : undefined}
              title={label}
            >
              <svg
                className="side-tab-icon"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d={tabConfig.icon} />
              </svg>
              <span className="side-tab-label">{label}</span>
              {tab === tabConfig.key && <span className="side-tab-indicator" />}
            </button>
          );
        })}
      </nav>

      <main className="ds-app-main">
        <WhatsNewPanel />
        <RouteErrorBoundary
          title={t('sidepanel.errorBoundary.title')}
          reloadLabel={t('sidepanel.errorBoundary.reload')}
        >
          <Suspense fallback={<RouteFallback />}>
            {tab === 'library' && <LibraryPage />}
            {tab === 'capabilities' && <CapabilitiesPage />}
            {tab === 'settings' && <SettingsPage />}
          </Suspense>
        </RouteErrorBoundary>
      </main>
    </div>
  );
}
