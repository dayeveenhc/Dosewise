import type { WalkthroughStep } from "../types";

const ON_SETTINGS: WalkthroughStep["screen"] = { mode: "caregiver", screen: "settings" };

// Caregiver spotlight tour: where to switch into the elder's view of the app
// (SettingsScreen.tsx's mode-switch button). Mei auto-advances the spotlight
// herself at the slow PACING rate — the person just watches. The final tap
// really does open the mode picker, which IS the feature being taught.
//
// DO NOT "fix" step 2 into an act-less reveal. The 2026-08-07 geometry sweep
// reported it as `callout-missing` and read that as the tour stranding the
// person: step 2's click reaches `App.tsx::openModeSwitch`, which sets
// `appMode: "onboarding"` and unmounts the whole caregiver branch — the
// <Walkthrough> overlay with it. That observation is correct and the
// conclusion is wrong. The screen it lands on is the app's own "Who are you
// using Dosewise for today?" PICKER, with real buttons, and the flow continues
// into ElderlyApp from there. `e2e/scenarios/s27` drives exactly that path and
// asserts it end to end ("the tap opened the real mode picker" → a real role
// switch → the caregiver's OWN identity in the elder shell, with no backend
// write). Making the step act-less breaks s27 and removes the thing the tour
// exists to demonstrate.
//
// The overlay unmounting here is intentional navigation out of the shell that
// owns it, not the "callout is the only host of Exit" invariant failing.
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
