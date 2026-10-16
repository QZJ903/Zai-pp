import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  createTranslator,
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_PREFERENCE,
  resolveLocalePreference,
  type LocaleArrayKey,
  type LocaleMessageKey,
  type LocalePreference,
  type MessageParams,
  type SupportedLocale,
} from '../../core/i18n';
import {
  LOCALE_READ_TIMEOUT_MS,
  getLocalePreference,
  saveLocalePreference,
  watchLocalePreference,
} from '../../core/i18n/store';

interface I18nContextValue {
  locale: SupportedLocale;
  preference: LocalePreference;
  fallback: boolean;
  ready: boolean;
  t: (key: LocaleMessageKey, params?: MessageParams) => string;
  ta: (key: LocaleArrayKey) => readonly string[];
  setPreference: (preference: LocalePreference) => Promise<void>;
}

const defaultTranslator = createTranslator(DEFAULT_LOCALE);

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  preference: DEFAULT_LOCALE_PREFERENCE,
  fallback: false,
  ready: false,
  t: defaultTranslator.t,
  ta: defaultTranslator.ta,
  async setPreference() {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LocalePreference>(DEFAULT_LOCALE_PREFERENCE);
  const [ready, setReady] = useState(false);

  const resolved = useMemo(
    () => resolveLocalePreference(preference),
    [preference],
  );
  const translator = useMemo(
    () => createTranslator(resolved.locale),
    [resolved.locale],
  );

  useEffect(() => {
    let cancelled = false;
    // ⚠️ 两处细节：① 读 locale 要带上界（storage 半死时它永不落地，
    // `.finally` 就永远不执行、`ready` 永远停在 false）；② `.finally` **不改 rejection**，
    // 少了 `.catch` 会留下一条未处理拒绝。
    getLocalePreference(LOCALE_READ_TIMEOUT_MS)
      .then((nextPreference) => {
        if (!cancelled) setPreferenceState(nextPreference);
      })
      .catch((error) => {
        console.error('[Zai++] Failed to load locale preference.', error);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    const unsubscribe = watchLocalePreference((nextPreference) => {
      setPreferenceState(nextPreference);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const setPreference = useCallback(async (nextPreference: LocalePreference) => {
    const normalized = await saveLocalePreference(nextPreference);
    setPreferenceState(normalized);
  }, []);

  const value = useMemo<I18nContextValue>(() => ({
    locale: resolved.locale,
    preference,
    fallback: resolved.fallback,
    ready,
    t: translator.t,
    ta: translator.ta,
    setPreference,
  }), [preference, ready, resolved.fallback, resolved.locale, setPreference, translator.t, translator.ta]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
