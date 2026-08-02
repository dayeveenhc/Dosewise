import type { WalkthroughStep } from "../types";

const ON_SETTINGS: WalkthroughStep["screen"] = { mode: "caregiver", screen: "settings" };

// Caregiver spotlight tour: where to switch into the elder's view of the app
// (SettingsScreen.tsx's mode-switch button). Highlight-only skeleton —
// owned/refined by its scenario agent. Note: tapping the final button really
// does open the mode picker, which is the feature being taught.
// AI-automated (2026-07-28): Mei auto-advances the spotlight herself at the slow
// PACING rate — the person just watches. The final tap opens the mode picker
// (the feature being taught); it only surfaces the picker, nothing is committed.
export const caregiverViewToggleTourSteps: WalkthroughStep[] = [
  {
    id: "viewtoggle.go-to-settings",
    screen: ON_SETTINGS,
    selector: '[data-tour="nav-settings"]', // caregiver BottomNav — always mounted
    instructionKey: "walk.caregiverViewToggleTour.step1",
    act: { kind: "click", selector: '[data-tour="nav-settings"]' },
  },
  {
    id: "viewtoggle.switch-button",
    screen: ON_SETTINGS,
    onEnter: ON_SETTINGS,
    selector: '[data-walk="cg-switch-mode"]',
    instructionKey: "walk.caregiverViewToggleTour.step2",
    act: { kind: "click", selector: '[data-walk="cg-switch-mode"]' },
  },
];
