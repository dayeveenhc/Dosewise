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
// Clock format for every time the app SHOWS. Stored times are unaffected —
// Medication.times stay 12h display strings; this only decides how they render
// (see lib/medications.ts::formatClock).
export type TimeFormat = "12h" | "24h";

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
  timeFormat: TimeFormat;
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
  // TrustMode (Item 2): permanent override that forces the walkthrough's
  // manual tap-gate regardless of walkthroughCompletionCount below.
  walkthroughManualMode: boolean;
  // TrustMode (Item 2): device-local count of COMPLETED walkthroughs, any
  // task (not per-task). Distinct from lib/profile.ts's server-synced
  // ProfileDetails.completedWalkthroughs — that string SET exists only to
  // suppress Mei's proactive re-offers of a specific task and has no
  // counting concept; this is a plain tally compared against
  // TRUST_MODE_THRESHOLD (lib/walkthrough/pacing.ts) to decide
  // requireExplicitAdvance.
  walkthroughCompletionCount: number;
}

interface AccessibilityContextValue extends AccessibilitySettings {
  // Derived convenience flags for the screens that only care "is it on".
  highContrast: boolean;
  colourBlind: boolean;
  setFontSize: (size: FontSize) => void;
  setContrast: (mode: ContrastMode) => void;
  setColourVision: (mode: ColourVisionMode) => void;
  setTimeFormat: (format: TimeFormat) => void;
  setVoiceOutput: (on: boolean) => void;
  setNotification: (key: keyof NotificationPrefs, on: boolean) => void;
  setWalkthroughManualMode: (on: boolean) => void;
  incrementWalkthroughCompletionCount: () => void;
}

const STORAGE_KEY = "dosewise:accessibility";

// html { font-size: var(--font-size) } in theme.css drives every rem-based
// Tailwind text utility, so changing this one variable rescales the app.
//
// It is NOT enough on its own: the screens size their text in explicit pixels
// (a bare `text-[NNpx]` utility), and a px value ignores the rem base
// entirely — which is why the slider used to move and change almost nothing.
// Those classes are written as `text-[calc(15px*var(--dw-text))]`, so
// `--dw-text` below is what actually resizes the app's text. Scaling type
// rather than the whole UI (`zoom`) is deliberate: the layouts are tuned to a
// fixed 390px frame, and zooming the surface pushed cards off the edge of it.
// The elder shell ALSO proportionally zooms its content area from this
// setting (ElderlyApp.tsx contentZoom, via CONTENT_ZOOM below) for the same
// reason — px utilities don't follow --dw-text either.
const FONT_SIZE_PX: Record<FontSize, string> = {
  small: "13px",
  normal: "15px",
  large: "17px",
  xlarge: "19px",
  xxlarge: "21px",
};

// Multiplier applied to every px-sized text class in the app, DERIVED from the
// table above rather than hand-tuned beside it: two near-identical curves would
// drift the first time either end was adjusted.
const BASE_FONT_PX = Number.parseFloat(FONT_SIZE_PX.normal);
const textScale = (size: FontSize) => String(Number.parseFloat(FONT_SIZE_PX[size]) / BASE_FONT_PX);

// The proportional content-area zoom each shell applies from the Text-size
// setting (see the note above — px utilities don't follow --font-size, so the
// slider needs this to actually move the reading surface). "large" is the
// default → 1 (no change out of the box). Shared by BOTH shells so the elder
// and caregiver Text-size sliders behave identically.
export const CONTENT_ZOOM: Record<FontSize, number> = {
  small: 0.85,
  normal: 0.92,
  large: 1,
  xlarge: 1.12,
  xxlarge: 1.25,
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
  timeFormat: "12h",
  voiceOutput: true,
  notifications: DEFAULT_NOTIFICATIONS,
  walkthroughManualMode: false,
  walkthroughCompletionCount: 0,
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
    root.style.setProperty("--dw-text", textScale(settings.fontSize));
    root.classList.remove(...ALL_CLASSES);
    const contrastClass = CONTRAST_CLASS[settings.contrast];
    const colourClass = COLOUR_VISION_CLASS[settings.colourVision];
    if (contrastClass) root.classList.add(contrastClass);
    if (colourClass) root.classList.add(colourClass);
    return () => {
      root.style.removeProperty("--font-size");
      root.style.removeProperty("--dw-text");
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
    setTimeFormat: (timeFormat) => setSettings(s => ({ ...s, timeFormat })),
    setVoiceOutput: (voiceOutput) => setSettings(s => ({ ...s, voiceOutput })),
    setNotification: (key, on) => setSettings(s => ({ ...s, notifications: { ...s.notifications, [key]: on } })),
    setWalkthroughManualMode: (walkthroughManualMode) => setSettings(s => ({ ...s, walkthroughManualMode })),
    incrementWalkthroughCompletionCount: () => setSettings(s => ({ ...s, walkthroughCompletionCount: s.walkthroughCompletionCount + 1 })),
  };

  return <AccessibilityContext.Provider value={value}>{children}</AccessibilityContext.Provider>;
}

export function useAccessibility() {
  const ctx = useContext(AccessibilityContext);
  if (!ctx) throw new Error("useAccessibility must be used within AccessibilityProvider");
  return ctx;
}

// The content-area zoom scale for the current Text-size setting. Both shells use
// this so their sliders scale the reading surface identically.
export function useContentZoom(): number {
  return CONTENT_ZOOM[useAccessibility().fontSize];
}
