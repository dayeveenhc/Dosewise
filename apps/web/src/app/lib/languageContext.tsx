import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { LANGUAGE_OPTIONS, type AppLanguage } from "./language";

type LanguageContextValue = {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
};

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

// Fired on every language change so code that CANNOT use the hook can still
// stay current. The one real case is App.tsx, which renders LanguageProvider
// and therefore sits above it — see useStoredLanguage below.
const LANGUAGE_CHANGED = "dosewise-language-changed";

export function readStoredLanguage(): AppLanguage {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem("dosewise-language");
  return stored && LANGUAGE_OPTIONS.some(option => option.id === stored)
    ? (stored as AppLanguage)
    : "en";
}

/**
 * The stored language, re-read whenever it changes — for components ABOVE the
 * provider, where `useLanguage()` throws.
 *
 * Only App.tsx needs this, and it genuinely does: it owns LanguageProvider, so
 * a bare `readStoredLanguage()` in its body is a snapshot that `setLanguage`
 * can never invalidate. Its caregiver header, tour copy and confirm dialogs
 * were all reading that snapshot and staying in the previous language until
 * something unrelated happened to re-render.
 *
 * Prefer `useLanguage()` anywhere inside the provider. This is the escape
 * hatch, not the pattern.
 */
export function useStoredLanguage(): AppLanguage {
  const [language, setLanguage] = useState<AppLanguage>(readStoredLanguage);
  useEffect(() => {
    const sync = () => setLanguage(readStoredLanguage());
    window.addEventListener(LANGUAGE_CHANGED, sync);
    // `storage` covers the same app open in a second tab; the custom event
    // covers this one (storage does not fire in the tab that wrote it).
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(LANGUAGE_CHANGED, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return language;
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<AppLanguage>(readStoredLanguage);

  useEffect(() => {
    window.localStorage.setItem("dosewise-language", language);
    window.dispatchEvent(new Event(LANGUAGE_CHANGED));
  }, [language]);

  const value = useMemo(() => ({
    language,
    setLanguage: setLanguageState,
  }), [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used within a LanguageProvider");
  return context;
}
