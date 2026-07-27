import type { WalkthroughStep } from "../types";

const ON_AI: WalkthroughStep["screen"] = { mode: "caregiver", screen: "ai" };

// Caregiver spotlight tour to the Weekly Summary (AskMeiScreen.tsx's Quick help
// launcher → weekly-summary tile, which opens WeeklySummarySheet). Highlight-only
// skeleton — owned/refined by its scenario agent.
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
    selector: '[data-tour="cg-askmei"]', // Quick help launcher row — existing, reused
    instructionKey: "walk.weeklySummaryTour.step2",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "weekly.tap-tile",
    screen: ON_AI,
    selector: '[data-walk="cg-weeklysummary-tile"]',
    instructionKey: "walk.weeklySummaryTour.step3",
    waitFor: { type: "click", source: "dom" },
  },
];
