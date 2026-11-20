import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Minimal Korean / English switch for the screens in the demo video. Korean stays the default; `?lang=en` in the
 * page URL (before the hash) or the toggle selects English, and the choice is kept per browser.
 */
export type Lang = 'ko' | 'en';
const STORAGE_KEY = 'bubblelock.lang';

function initialLang(): Lang {
  try {
    const query = new URLSearchParams(window.location.search).get('lang');
    if (query === 'en' || query === 'ko') return query;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'ko') return stored;
  } catch { /* storage can be blocked; Korean stays */ }
  return 'ko';
}

interface LangContext { readonly lang: Lang; setLang(lang: Lang): void }
const Context = createContext<LangContext>({ lang: 'ko', setLang: () => undefined });

export function LangProvider({ children }: { readonly children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = lang;
    try { window.localStorage.setItem(STORAGE_KEY, lang); } catch { /* per-browser convenience only */ }
  }, [lang]);
  const value = useMemo(() => ({ lang, setLang }), [lang]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** `tr(korean, english)` keeps both strings next to each other at the call site. */
export function useLang() {
  const { lang, setLang } = useContext(Context);
  const tr = useCallback((ko: string, en: string) => (lang === 'en' ? en : ko), [lang]);
  return { lang, setLang, tr };
}

export function LangToggle() {
  const { lang, setLang } = useLang();
  return <div className="lang-switch" role="group" aria-label={lang === 'en' ? 'Language' : '언어'}>
    <button type="button" aria-pressed={lang === 'ko'} onClick={() => setLang('ko')} lang="ko">한국어</button>
    <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')} lang="en">English</button>
  </div>;
}
