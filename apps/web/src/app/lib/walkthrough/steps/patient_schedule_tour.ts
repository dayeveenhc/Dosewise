import type { WalkthroughStep } from "../types";

const ON_TIMELINE: WalkthroughStep["screen"] = { mode: "caregiver", screen: "timeline" };

// Caregiver spotlight tour of the patient schedule (TimelineScreen.tsx):
// switch patient, then read the week strip. Highlight-only skeleton —
// owned/refined by its scenario agent.
// AI-automated (2026-07-28): Mei auto-advances the spotlight herself at the slow
// PACING rate — the person just watches. Read-only view (switch patient, read
// the week strip); nothing is written.
export const patientScheduleTourSteps: WalkthroughStep[] = [
  {
    id: "patsched.go-to-schedule",
    screen: ON_TIMELINE,
    selector: '[data-tour="nav-timeline"]', // caregiver BottomNav — always mounted
    instructionKey: "walk.patientScheduleTour.step1",
    act: { kind: "click", selector: '[data-tour="nav-timeline"]' },
  },
  {
    id: "patsched.patient-switcher",
    screen: ON_TIMELINE,
    onEnter: ON_TIMELINE,
    selector: '[data-tour="cg-patientswitcher"]',
    instructionKey: "walk.patientScheduleTour.step2",
    act: { kind: "click", selector: '[data-tour="cg-patientswitcher"]' },
  },
  {
    id: "patsched.week-strip",
    screen: ON_TIMELINE,
    onEnter: ON_TIMELINE,
    selector: '[data-walk="cg-week-strip"]',
    instructionKey: "walk.patientScheduleTour.step3",
    // The week strip is a plain container with no click handler — an act:click
    // here fired into the void while the tour reported it as an interaction.
    // Act-less + reveal: pulse-highlight it honestly, then wait on Next.
    reveal: { screen: ON_TIMELINE, selector: '[data-walk="cg-week-strip"]' },
  },
];
