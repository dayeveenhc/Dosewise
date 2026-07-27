import type { WalkthroughStep } from "../types";

const ON_TIMELINE: WalkthroughStep["screen"] = { mode: "caregiver", screen: "timeline" };

// Caregiver spotlight tour of the patient schedule (TimelineScreen.tsx):
// switch patient, then read the week strip. Highlight-only skeleton —
// owned/refined by its scenario agent.
export const patientScheduleTourSteps: WalkthroughStep[] = [
  {
    id: "patsched.go-to-schedule",
    screen: ON_TIMELINE,
    selector: '[data-tour="nav-timeline"]', // caregiver BottomNav — always mounted
    instructionKey: "walk.patientScheduleTour.step1",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "patsched.patient-switcher",
    screen: ON_TIMELINE,
    selector: '[data-tour="cg-patientswitcher"]',
    instructionKey: "walk.patientScheduleTour.step2",
    waitFor: { type: "acknowledge", source: "dom" },
  },
  {
    id: "patsched.week-strip",
    screen: ON_TIMELINE,
    selector: '[data-walk="cg-week-strip"]',
    instructionKey: "walk.patientScheduleTour.step3",
    waitFor: { type: "acknowledge", source: "dom" },
  },
];
