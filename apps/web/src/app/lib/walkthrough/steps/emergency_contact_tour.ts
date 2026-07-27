import type { WalkthroughStep } from "../types";

const ON_SETTINGS: WalkthroughStep["screen"] = { mode: "elderly", tab: "settings" };

// Spotlight tour of the emergency contact card (ElderlySettingsScreen.tsx) —
// highlight-only skeleton. The card only renders when the patient has a primary
// contact (seed data always does). Owned/refined by its scenario agent.
export const emergencyContactTourSteps: WalkthroughStep[] = [
  {
    id: "emergency.go-to-settings",
    screen: ON_SETTINGS,
    selector: '[data-tour="nav-settings"]', // ElderlyApp bottom nav — always mounted
    instructionKey: "walk.emergencyContactTour.step1",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "emergency.section",
    screen: ON_SETTINGS,
    selector: '[data-walk="elder-emergency-section"]',
    instructionKey: "walk.emergencyContactTour.step2",
    waitFor: { type: "acknowledge", source: "dom" },
  },
  {
    id: "emergency.call-button",
    screen: ON_SETTINGS,
    selector: '[data-walk="elder-emergency-call"]',
    instructionKey: "walk.emergencyContactTour.step3",
    waitFor: { type: "acknowledge", source: "dom" },
  },
];
