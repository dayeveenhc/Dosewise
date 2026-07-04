import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type FontSize = "normal" | "large" | "xlarge";

interface AccessibilitySettings {
  fontSize: FontSize;
  highContrast: boolean;
  colourBlind: boolean;
}

interface AccessibilityContextValue extends AccessibilitySettings {
  setFontSize: (size: FontSize) => void;
  setHighContrast: (on: boolean) => void;
  setColourBlind: (on: boolean) => void;
}

const STORAGE_KEY = "dosewise:accessibility";

// html { font-size: var(--font-size) } in theme.css drives every rem-based
// Tailwind text utility, so changing this one variable rescales the app.
const FONT_SIZE_PX: Record<FontSize, string> = {
  normal: "15px",
  large: "17px",
  xlarge: "19px",
};

const DEFAULTS: AccessibilitySettings = { fontSize: "large", highContrast: false, colourBlind: false };

function loadInitial(): AccessibilitySettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

const AccessibilityContext = createContext<AccessibilityContextValue | null>(null);

export function AccessibilityProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AccessibilitySettings>(loadInitial);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    document.documentElement.style.setProperty("--font-size", FONT_SIZE_PX[settings.fontSize]);
    document.documentElement.classList.toggle("high-contrast", settings.highContrast);
    return () => {
      document.documentElement.style.removeProperty("--font-size");
      document.documentElement.classList.remove("high-contrast");
    };
  }, [settings]);

  const value: AccessibilityContextValue = {
    ...settings,
    setFontSize: (fontSize) => setSettings(s => ({ ...s, fontSize })),
    setHighContrast: (highContrast) => setSettings(s => ({ ...s, highContrast })),
    setColourBlind: (colourBlind) => setSettings(s => ({ ...s, colourBlind })),
  };

  return <AccessibilityContext.Provider value={value}>{children}</AccessibilityContext.Provider>;
}

export function useAccessibility() {
  const ctx = useContext(AccessibilityContext);
  if (!ctx) throw new Error("useAccessibility must be used within AccessibilityProvider");
  return ctx;
}
