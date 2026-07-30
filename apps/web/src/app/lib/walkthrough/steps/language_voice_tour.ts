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
// Every step is user-driven (waitFor, never `act`) → the overlay classes the
// tour as non-autonomous, so it renders Exit but NO Next button (the whole
// Next/Replay block in Walkthrough.tsx is gated on `autonomous`). Because
// nothing is paced (no PaceController is instantiated for waitFor steps), the
// tour records ZERO walkthrough phase-log entries — the honest shape a
// user-driven tour has (mirrors notifications_tour / request_refill).
//
// Step 1 has NO onEnter: its whole point is the person tapping Settings to
// travel there (the bottom nav is always mounted, so it needs no switch first).
// Steps 2–3 carry onEnter so their Settings-only targets are present no matter
// the entry point (a harmless no-op once step 1's tap has switched the tab),
// matching notifications_tour's per-step onEnter.
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
    onEnter: ON_SETTINGS,
    // Spotlights the whole Voice & Language card, which contains the Read-Aloud
    // toggle. "acknowledge" is satisfied by a real click anywhere in the card —
    // the person taps the Read-Aloud toggle itself (a descendant button), which
    // both flips voiceOutput and, bubbling to this card, advances the step
    // (Walkthrough.tsx treats click|acknowledge identically).
    selector: '[data-tour="elder-language"]',
    instructionKey: "walk.languageVoiceTour.step2",
    waitFor: { type: "acknowledge", source: "dom" },
  },
  {
    id: "langvoice.pick-language",
    screen: ON_SETTINGS,
    onEnter: ON_SETTINGS,
    selector: '[data-walk="elder-language-select"]',
    instructionKey: "walk.languageVoiceTour.step3",
    // A native <select>: "select-change" advances only on a genuine value change
    // (the person picking a language), not a bare tap — so the tour completing
    // is itself evidence the language actually changed.
    waitFor: { type: "select-change", source: "dom" },
  },
];
