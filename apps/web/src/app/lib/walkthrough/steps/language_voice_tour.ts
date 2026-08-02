import type { WalkthroughStep } from "../types";

const ON_SETTINGS: WalkthroughStep["screen"] = { mode: "elderly", tab: "settings" };

// Spotlight tour of the elder's Voice & Language settings
// (ElderlySettingsScreen.tsx) — the Read-Aloud toggle and the language selector.
// Owned by the s20 language-voice scenario agent.
//
// PURELY VIEW/CLIENT-SIDE: language & voiceOutput are localStorage-only settings
// (lib/languageContext.ts `dosewise-language`, accessibility.tsx
// `dosewise:accessibility`) — there is no Hermes tool and nothing is written to
// Supabase. So this tour only shows the person around; the value changes are
// their own, made client-side.
//
// Every step is `act` → the overlay classes each as autonomous, so each gets a
// PaceController, records phase-log entries, and holds at its commit gate until
// the person taps Next (Done on the last). Nothing advances on a timer.
//
// Step 1 has NO onEnter: its whole point is the person tapping Settings to
// travel there (the bottom nav is always mounted, so it needs no switch first).
// Steps 2–3 carry onEnter so their Settings-only targets are present no matter
// the entry point (a harmless no-op once step 1's tap has switched the tab),
// matching notifications_tour's per-step onEnter.
// AI-automated (2026-07-28): Mei auto-advances the spotlight herself at the slow
// PACING rate — the person just watches. She clicks the CONTAINER of each control
// (the card, the select) rather than toggling/changing the real setting, so the
// tour never silently flips Read-Aloud or switches the app's language on the
// person's behalf — it only shows them where these live.
export const languageVoiceTourSteps: WalkthroughStep[] = [
  {
    id: "langvoice.go-to-settings",
    screen: ON_SETTINGS,
    selector: '[data-tour="nav-settings"]', // ElderlyApp bottom nav — always mounted
    instructionKey: "walk.languageVoiceTour.step1",
    act: { kind: "click", selector: '[data-tour="nav-settings"]' },
  },
  {
    id: "langvoice.section",
    screen: ON_SETTINGS,
    onEnter: ON_SETTINGS,
    // Click the card CONTAINER (not the Read-Aloud toggle button inside it), so
    // the spotlight advances without flipping voiceOutput.
    selector: '[data-tour="elder-language"]',
    instructionKey: "walk.languageVoiceTour.step2",
    act: { kind: "click", selector: '[data-tour="elder-language"]' },
  },
  {
    id: "langvoice.pick-language",
    screen: ON_SETTINGS,
    onEnter: ON_SETTINGS,
    selector: '[data-walk="elder-language-select"]',
    instructionKey: "walk.languageVoiceTour.step3",
    // Click the <select> to spotlight it and advance — deliberately NOT a
    // `select` act, so the person's chosen language is never changed for them.
    act: { kind: "click", selector: '[data-walk="elder-language-select"]' },
  },
];
