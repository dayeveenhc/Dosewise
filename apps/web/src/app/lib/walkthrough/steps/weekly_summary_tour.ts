import type { WalkthroughStep } from "../types";

const ON_AI: WalkthroughStep["screen"] = { mode: "caregiver", screen: "ai" };

// Caregiver spotlight tour to the Weekly Summary (AskMeiScreen.tsx's Quick help
// launcher → weekly-summary tile, which opens WeeklySummarySheet → AIScreen).
// Owned by the s29 weekly-summary scenario agent.
//
// PURELY VIEW/MOCK: the summary sheet renders AIScreen.tsx fed entirely by
// data/patients.ts's static PATIENTS[0]/WEEKLY_DATA — no Hermes tool, no
// Supabase read, no fetch of any kind (App.tsx only overwrites `patients` from
// real Supabase data in "elderly" mode; "caregiver" mode keeps the mock array
// untouched). So this tour only shows the person around; there is nothing to
// verify or reveal because nothing real changes or gets written.
//
// Every step is user-driven (waitFor, never `act`) → Walkthrough.tsx classes
// the tour as non-autonomous, so it renders Exit but NO Next button (the whole
// Next/Replay block is gated on `autonomous`, which requires an act or an
// act-less verify/reveal tail — this tour has neither). Because nothing is
// paced (no PaceController is ever instantiated for waitFor steps), the tour
// records ZERO walkthrough phase-log entries — the same honest shape as
// language_voice_tour / notifications_tour.
//
// Step 1 has NO onEnter: its whole point is the person tapping the AI tab to
// travel there themselves (the caregiver BottomNav is always mounted, so it
// needs no switch first). Steps 2–3 carry onEnter so their AskMei-only targets
// are present no matter the entry point (a harmless no-op once step 1's tap
// has already switched the screen, or when a walkthrough session resumes
// mid-tour after a reload) — matching language_voice_tour's per-step onEnter.
export const weeklySummaryTourSteps: WalkthroughStep[] = [
  {
    id: "weekly.go-to-askmei",
    screen: ON_AI,
    selector: '[data-tour="nav-ai"]', // caregiver BottomNav — always mounted
    instructionKey: "walk.weeklySummaryTour.step1",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "weekly.open-quickhelp",
    screen: ON_AI,
    onEnter: ON_AI,
    selector: '[data-tour="cg-askmei"]', // Quick help launcher row — existing, reused (also the onboarding GuidedTour's cg-askmei target)
    instructionKey: "walk.weeklySummaryTour.step2",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "weekly.tap-tile",
    screen: ON_AI,
    onEnter: ON_AI,
    selector: '[data-walk="cg-weeklysummary-tile"]',
    instructionKey: "walk.weeklySummaryTour.step3",
    waitFor: { type: "click", source: "dom" },
  },
];
