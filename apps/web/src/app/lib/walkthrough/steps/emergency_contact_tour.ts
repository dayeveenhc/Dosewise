import type { WalkthroughStep } from "../types";

const ON_SETTINGS: WalkthroughStep["screen"] = { mode: "elderly", tab: "settings" };

// Spotlight tour of the emergency contact card (ElderlySettingsScreen.tsx) —
// CONSENT flow, same family as accept_caregiver_link.ts. Steps 1-2 are
// AI-auto-advanced; the final Call step is `waitFor` (a REAL DOM click the
// elder performs), never `act` — so `autonomous` (components/Walkthrough.tsx)
// is false for it and the Next/Replay controls never render on the call step.
// The contact + its "Call" button are MOCK data
// (data/patients.ts's seeded contacts array, never fetched from Supabase —
// there is no contacts table) and the call itself is CallMockup.tsx, a purely
// local, client-side animation with no network/Supabase call — so the walk
// never performs, and cannot perform, the call on the elder's behalf. The
// final step's selector IS the real call button itself (no indirection): the
// elder's own tap both fires the real onClick (shows CallMockup) and — via
// the SAME click event bubbling to this step's native listener — advances/
// completes the tour. Nothing here ever calls el.click() programmatically.
// AI-automated (2026-07-28) for the NON-consent steps: Mei auto-advances the
// spotlight to the emergency section herself at the slow PACING rate. The final
// Call step stays a human tap (see below) — Mei must never auto-dial.
//
// Step 2 spotlights the section card, which is a plain container with no click
// handler, so it is `acknowledge`, not `act: click` — clicking it would achieve
// nothing and claiming an interaction that never happened is exactly the kind
// of dishonesty this engine is built to avoid.
export const emergencyContactTourSteps: WalkthroughStep[] = [
  {
    id: "emergency.go-to-settings",
    screen: ON_SETTINGS,
    selector: '[data-tour="nav-settings"]', // ElderlyApp bottom nav — always mounted
    instructionKey: "walk.emergencyContactTour.step1",
    act: { kind: "click", selector: '[data-tour="nav-settings"]' },
  },
  {
    id: "emergency.section",
    screen: ON_SETTINGS,
    onEnter: ON_SETTINGS,
    selector: '[data-walk="elder-emergency-section"]',
    instructionKey: "walk.emergencyContactTour.step2",
    // Act-less + reveal = autonomous "look here": the host scrolls to and
    // pulse-highlights the card, then the step waits on Next. No fake click.
    reveal: { screen: ON_SETTINGS, selector: '[data-walk="elder-emergency-section"]' },
  },
  {
    id: "emergency.call-button",
    screen: ON_SETTINGS,
    onEnter: ON_SETTINGS,
    // Consent: the elder taps Call THEMSELVES. NO `act` — Mei must never
    // auto-dial. This is the last step, so this real tap also completes the
    // tour (ElderlyApp's handleWalkthroughAdvance marks emergency_contact_tour
    // complete in profiles.accessibility.completedWalkthroughs — the one real
    // backend write in this scenario, itself only ever a consequence of this
    // exact human tap, never fired ahead of it).
    selector: '[data-walk="elder-emergency-call"]',
    instructionKey: "walk.emergencyContactTour.step3",
    waitFor: { type: "acknowledge", source: "dom" },
    // Backstop. The emergency card renders ONLY when an active caregiver link
    // exists (2026-08-02: it used to read a mock contact that was always
    // present, which quietly guaranteed this target). ElderlyApp refuses the
    // tour outright with no caregiver, so this should be unreachable — but a
    // link revoked mid-tour would otherwise leave a waitFor with no timeout
    // polling forever behind a scrim, which is the exact failure this engine
    // was rewritten to make impossible.
    timeoutMs: 20000,
  },
];
