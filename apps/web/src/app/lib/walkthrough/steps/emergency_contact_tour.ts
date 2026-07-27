import type { WalkthroughStep } from "../types";

const ON_SETTINGS: WalkthroughStep["screen"] = { mode: "elderly", tab: "settings" };

// Spotlight tour of the emergency contact card (ElderlySettingsScreen.tsx) —
// CONSENT flow, same family as accept_caregiver_link.ts. Mei only ever points
// and narrates: every step below is `waitFor` (a REAL DOM click the elder
// performs), never `act` — so `autonomous` (components/Walkthrough.tsx) is
// false for all three and the Next/Replay controls never render on any of
// them, the call step included. The contact + its "Call" button are MOCK data
// (data/patients.ts's seeded contacts array, never fetched from Supabase —
// there is no contacts table) and the call itself is CallMockup.tsx, a purely
// local, client-side animation with no network/Supabase call — so the walk
// never performs, and cannot perform, the call on the elder's behalf. The
// final step's selector IS the real call button itself (no indirection): the
// elder's own tap both fires the real onClick (shows CallMockup) and — via
// the SAME click event bubbling to this step's native listener — advances/
// completes the tour. Nothing here ever calls el.click() programmatically.
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
    // Consent: the elder taps Call THEMSELVES. NO `act` — Mei must never
    // auto-dial. This is the last step, so this real tap also completes the
    // tour (ElderlyApp's handleWalkthroughAdvance marks emergency_contact_tour
    // complete in profiles.accessibility.completedWalkthroughs — the one real
    // backend write in this scenario, itself only ever a consequence of this
    // exact human tap, never fired ahead of it).
    selector: '[data-walk="elder-emergency-call"]',
    instructionKey: "walk.emergencyContactTour.step3",
    waitFor: { type: "acknowledge", source: "dom" },
    skippable: false,
  },
];
