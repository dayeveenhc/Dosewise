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
    // Act-less + reveal, for the same reason step 3 below is: clicking here
    // opened the patient dropdown and NEVER closed it (PatientSwitcher has no
    // outside-click close), so it stayed spread over the week strip that step 3
    // then spotlights — the only genuine occlusion the geometry sweep found,
    // reproducing identically at zoom 1.0 and 1.25. Opening a list and
    // abandoning it was never the point either: this step's own copy is "Tap
    // here to switch which person you're viewing", i.e. it POINTS at the
    // control rather than claiming to have used it, so pulsing it is the more
    // honest reading as well as the one that doesn't bury the next step.
    reveal: { screen: ON_TIMELINE, selector: '[data-tour="cg-patientswitcher"]' },
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
