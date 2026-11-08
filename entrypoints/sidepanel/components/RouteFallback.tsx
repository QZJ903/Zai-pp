import { useI18n } from '../i18n';

const FALLBACK_ROWS = 3;

/**
 * Suspense fallback for lazily-loaded routes.
 *
 * ⚠️ **It announces itself to assistive tech** (`role="status"` + `aria-label`)
 * instead of being hidden. The skeleton itself carries no information, but "the
 * page is loading" is exactly the thing a screen-reader user needs to hear when
 * they navigate to a route — hiding it leaves them on a blank document with no
 * indication anything is happening. `Spinner` in `settings/primitives` uses the
 * same pattern; keeping the two aligned is why this file reads the shared
 * `common.loading` key rather than inventing its own string.
 */
export default function RouteFallback() {
  const { t } = useI18n();
  return (
    <div className="p-4 space-y-2" role="status" aria-label={t('common.loading')}>
      {Array.from({ length: FALLBACK_ROWS }, (_, index) => (
        <div key={index} className="ds-surface-panel p-3 space-y-2" aria-hidden="true">
          <div className="ds-skeleton rounded h-3" style={{ width: '60%' }} />
          <div className="ds-skeleton rounded h-2.5" style={{ width: '85%' }} />
        </div>
      ))}
    </div>
  );
}
