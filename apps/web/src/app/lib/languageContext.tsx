import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { LANGUAGE_OPTIONS, type AppLanguage } from "./language";

type LanguageContextValue = {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
};

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

function readStoredLanguage(): AppLanguage {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem("dosewise-language");
  return stored && LANGUAGE_OPTIONS.some(option => option.id === stored)
    ? (stored as AppLanguage)
    : "en";
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<AppLanguage>(readStoredLanguage);

  useEffect(() => {
    window.localStorage.setItem("dosewise-language", language);
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
