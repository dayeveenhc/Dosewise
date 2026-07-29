import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type FontSize = "small" | "normal" | "large" | "xlarge" | "xxlarge";
// Two real tiers rather than one boolean: "high" keeps the brand palette but
// pushes every pair to AAA, "max" drops to near-monochrome. A tinted
// "high contrast" is a compromise that serves neither mild low vision nor
// severe. See the matching classes in styles/theme.css.
export type ContrastMode = "normal" | "high" | "max";
// Which colour-vision deficiency to compensate for. Each mode re-picks the
// dose-status hues onto an axis that deficiency preserves AND raises contrast
// — the same person usually benefits from both.
export type ColourVisionMode = "off" | "deuteranopia" | "protanopia" | "tritanopia";

export interface NotificationPrefs {
  doseReminders: boolean;
  refillAlerts: boolean;
  caregiverNotes: boolean;
  missedDoseAlerts: boolean;
}

interface AccessibilitySettings {
  fontSize: FontSize;
  contrast: ContrastMode;
  colourVision: ColourVisionMode;
  // Whether Mei reads her replies aloud (browser speechSynthesis). The single
  // persisted source of truth for the "Read Aloud" toggle *and* the in-chat
  // voice switch — both read/write it here so they never disagree.
  voiceOutput: boolean;
  // Device-local notification preferences. They live here, alongside the other
  // device-local display settings, rather than in a provider of their own —
  // there is no server-side notification infrastructure to sync them to (see
  // CONTEXT.md's notification-tier note), so a second provider would be
  // ceremony around the same localStorage blob.
  notifications: NotificationPrefs;
}

interface AccessibilityContextValue extends AccessibilitySettings {
  // Derived convenience flags for the screens that only care "is it on".
  highContrast: boolean;
  colourBlind: boolean;
  setFontSize: (size: FontSize) => void;
  setContrast: (mode: ContrastMode) => void;
  setColourVision: (mode: ColourVisionMode) => void;
  setVoiceOutput: (on: boolean) => void;
  setNotification: (key: keyof NotificationPrefs, on: boolean) => void;
}

const STORAGE_KEY = "dosewise:accessibility";

// html { font-size: var(--font-size) } in theme.css drives every rem-based
// Tailwind text utility, so changing this one variable rescales the app.
const FONT_SIZE_PX: Record<FontSize, string> = {
  small: "13px",
  normal: "15px",
  large: "17px",
  xlarge: "19px",
  xxlarge: "21px",
};

const CONTRAST_CLASS: Record<ContrastMode, string | null> = {
  normal: null,
  high: "contrast-high",
  max: "contrast-max",
};

const COLOUR_VISION_CLASS: Record<ColourVisionMode, string | null> = {
  off: null,
  deuteranopia: "cb-deuteranopia",
  protanopia: "cb-protanopia",
  tritanopia: "cb-tritanopia",
};

const ALL_CLASSES = [
  ...Object.values(CONTRAST_CLASS),
  ...Object.values(COLOUR_VISION_CLASS),
].filter((c): c is string => !!c);

const DEFAULT_NOTIFICATIONS: NotificationPrefs = {
  doseReminders: true,
  refillAlerts: true,
  caregiverNotes: true,
  missedDoseAlerts: true,
};

const DEFAULTS: AccessibilitySettings = {
  fontSize: "large",
  contrast: "normal",
  colourVision: "off",
  voiceOutput: true,
  notifications: DEFAULT_NOTIFICATIONS,
};

function loadInitial(): AccessibilitySettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const saved = JSON.parse(raw) as Partial<AccessibilitySettings> & {
      // Pre-tier shape, still on existing installs.
      highContrast?: boolean;
      colourBlind?: boolean;
    };
    return {
      ...DEFAULTS,
      ...saved,
      contrast: saved.contrast ?? (saved.highContrast ? "high" : "normal"),
      colourVision: saved.colourVision ?? (saved.colourBlind ? "deuteranopia" : "off"),
      notifications: { ...DEFAULT_NOTIFICATIONS, ...(saved.notifications ?? {}) },
    };
  } catch {
    return DEFAULTS;
  }
}

const AccessibilityContext = createContext<AccessibilityContextValue | null>(null);

export function AccessibilityProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AccessibilitySettings>(loadInitial);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    const root = document.documentElement;
    root.style.setProperty("--font-size", FONT_SIZE_PX[settings.fontSize]);
    root.classList.remove(...ALL_CLASSES);
    const contrastClass = CONTRAST_CLASS[settings.contrast];
    const colourClass = COLOUR_VISION_CLASS[settings.colourVision];
    if (contrastClass) root.classList.add(contrastClass);
    if (colourClass) root.classList.add(colourClass);
    return () => {
      root.style.removeProperty("--font-size");
      root.classList.remove(...ALL_CLASSES);
    };
  }, [settings]);

  const value: AccessibilityContextValue = {
    ...settings,
    highContrast: settings.contrast !== "normal",
    colourBlind: settings.colourVision !== "off",
    setFontSize: (fontSize) => setSettings(s => ({ ...s, fontSize })),
    setContrast: (contrast) => setSettings(s => ({ ...s, contrast })),
    setColourVision: (colourVision) => setSettings(s => ({ ...s, colourVision })),
    setVoiceOutput: (voiceOutput) => setSettings(s => ({ ...s, voiceOutput })),
    setNotification: (key, on) => setSettings(s => ({ ...s, notifications: { ...s.notifications, [key]: on } })),
  };

  return <AccessibilityContext.Provider value={value}>{children}</AccessibilityContext.Provider>;
}

export function useAccessibility() {
  const ctx = useContext(AccessibilityContext);
  if (!ctx) throw new Error("useAccessibility must be used within AccessibilityProvider");
  return ctx;
}
