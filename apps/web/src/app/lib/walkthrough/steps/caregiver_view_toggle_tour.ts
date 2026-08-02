import type { WalkthroughStep } from "../types";

const ON_SETTINGS: WalkthroughStep["screen"] = { mode: "caregiver", screen: "settings" };

// Caregiver spotlight tour: where to switch into the elder's view of the app
// (SettingsScreen.tsx's mode-switch button). Highlight-only skeleton —
// owned/refined by its scenario agent. Note: tapping the final button really
// does open the mode picker, which is the feature being taught.
export const caregiverViewToggleTourSteps: WalkthroughStep[] = [
  {
    id: "viewtoggle.go-to-settings",
    screen: ON_SETTINGS,
    selector: '[data-tour="nav-settings"]', // caregiver BottomNav — always mounted
    instructionKey: "walk.caregiverViewToggleTour.step1",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "viewtoggle.switch-button",
    screen: ON_SETTINGS,
    selector: '[data-walk="cg-switch-mode"]',
    instructionKey: "walk.caregiverViewToggleTour.step2",
    waitFor: { type: "acknowledge", source: "dom" },
  },
];
