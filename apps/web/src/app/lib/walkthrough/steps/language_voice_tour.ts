import type { WalkthroughStep } from "../types";

const ON_SETTINGS: WalkthroughStep["screen"] = { mode: "elderly", tab: "settings" };

// Spotlight tour of the Voice & Language section (ElderlySettingsScreen.tsx) —
// highlight-only skeleton: the elder taps every step themselves. Owned/refined
// by its scenario agent; keep anchors in sync with the settings screen.
export const languageVoiceTourSteps: WalkthroughStep[] = [
  {
    id: "langvoice.go-to-settings",
    screen: ON_SETTINGS,
    selector: '[data-tour="nav-settings"]', // ElderlyApp bottom nav — always mounted
    instructionKey: "walk.languageVoiceTour.step1",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "langvoice.section",
    screen: ON_SETTINGS,
    selector: '[data-tour="elder-language"]',
    instructionKey: "walk.languageVoiceTour.step2",
    waitFor: { type: "acknowledge", source: "dom" },
  },
  {
    id: "langvoice.pick-language",
    screen: ON_SETTINGS,
    selector: '[data-walk="elder-language-select"]',
    instructionKey: "walk.languageVoiceTour.step3",
    waitFor: { type: "acknowledge", source: "dom" },
  },
];
