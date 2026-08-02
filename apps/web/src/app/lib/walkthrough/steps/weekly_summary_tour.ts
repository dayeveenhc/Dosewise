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
// Every step is `act` → Walkthrough.tsx classes each as autonomous, so each
// gets a PaceController, records phase-log entries, and holds at its commit gate
// until the person taps Next (Done on the last). Nothing advances on a timer.
//
// Step 1 has NO onEnter: its whole point is the person tapping the AI tab to
// travel there themselves (the caregiver BottomNav is always mounted, so it
// needs no switch first). Steps 2–3 carry onEnter so their AskMei-only targets
// are present no matter the entry point (a harmless no-op once step 1's tap
// has already switched the screen, or when a walkthrough session resumes
// mid-tour after a reload) — matching language_voice_tour's per-step onEnter.
// AI-automated (2026-07-28): Mei auto-advances the spotlight herself at the slow
// PACING rate — the person just watches. Purely view/mock (static WEEKLY_DATA),
// so auto-clicking through to open the summary sheet writes nothing.
export const weeklySummaryTourSteps: WalkthroughStep[] = [
  {
    id: "weekly.go-to-askmei",
    screen: ON_AI,
    selector: '[data-tour="nav-ai"]', // caregiver BottomNav — always mounted
    instructionKey: "walk.weeklySummaryTour.step1",
    act: { kind: "click", selector: '[data-tour="nav-ai"]' },
  },
  {
    id: "weekly.open-quickhelp",
    screen: ON_AI,
    onEnter: ON_AI,
    // The "Check-ins" CATEGORY tile. The caregiver Ask Mei rebuild (2026-08-02)
    // replaced the Quick-help popup with elder-style category tiles, deleting
    // `cg-quickhelp-btn` — and Weekly Summary now lives inside the `checkins`
    // category, so its row only mounts once this tile is opened.
    //
    // Still the real clickable BUTTON, never a wrapping container: an autonomous
    // act:click calls el.click() directly on the selector, which does nothing on
    // a plain <div> with no handler (the gotcha travel_mode_auto.ts documents).
    selector: '[data-walk="cg-cat-checkins"]',
    instructionKey: "walk.weeklySummaryTour.step2",
    act: { kind: "click", selector: '[data-walk="cg-cat-checkins"]' },
  },
  {
    id: "weekly.tap-tile",
    screen: ON_AI,
    onEnter: ON_AI,
    selector: '[data-walk="cg-weeklysummary-tile"]',
    instructionKey: "walk.weeklySummaryTour.step3",
    act: { kind: "click", selector: '[data-walk="cg-weeklysummary-tile"]' },
  },
];
