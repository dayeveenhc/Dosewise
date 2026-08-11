import type { WalkthroughParams, WalkthroughStep } from "../types";

// Guided Auto-Navigation — autonomous "save a question for my doctor". Mei taps
// across to the Reminders tab (deliberately as a visible, animated tab change,
// so the elder sees WHERE their questions live rather than just being teleported
// there), opens the add box, types the question, saves, then VERIFIES the row
// really landed in `doctor_questions` before completing.
//
// The verify is only possible because the add box now performs a real write
// (lib/doctor.ts::createDoctorQuestion) rather than pushing onto local state.

const ON_REMINDERS: WalkthroughStep["screen"] = { mode: "elderly", tab: "notifications" };
const Q_INPUT = '[data-walk="elder-doctor-q-input"]';

export function addDoctorQuestionAutoSteps(p: WalkthroughParams = {}): WalkthroughStep[] {
  const question = p.question?.trim() || "Is it normal to feel dizzy after my medicine?";
  return [
    {
      id: "autoDoctorQ.openTab",
      screen: { mode: "elderly", tab: "ai" },
      // Honour the declared screen. Without this the step never navigated and
      // only worked because its target is a GLOBAL nav button that exists on
      // every tab — the same shape as the elder-cat-medicines break (a step
      // whose declared screen and actual entry state were not enforced to
      // agree, which held right up until someone launched it from elsewhere).
      onEnter: { mode: "elderly", tab: "ai" },
      selector: '[data-tour="nav-notifications"]',
      instructionKey: "walk.autoDoctorQ.openTab",
      // Driving the real nav button (rather than jumping the tab in state) is
      // the point: the animated press is what shows them the tab moving.
      act: { kind: "click", selector: '[data-tour="nav-notifications"]' },
    },
    {
      // Reminders is split into Messages / For my doctor now — the add box only
      // exists once the doctor tab is showing.
      id: "autoDoctorQ.openTabQuestions",
      screen: ON_REMINDERS,
      onEnter: ON_REMINDERS,
      selector: '[data-walk="elder-doctorq-tab"]',
      instructionKey: "walk.autoDoctorQ.openQuestionsTab",
      act: { kind: "click", selector: '[data-walk="elder-doctorq-tab"]' },
    },
    {
      id: "autoDoctorQ.openBox",
      screen: ON_REMINDERS,
      selector: '[data-walk="elder-add-doctor-q"]',
      instructionKey: "walk.autoDoctorQ.openBox",
      act: { kind: "click", selector: '[data-walk="elder-add-doctor-q"]' },
    },
    {
      id: "autoDoctorQ.type",
      screen: ON_REMINDERS,
      selector: Q_INPUT,
      instructionKey: "walk.autoDoctorQ.type",
      act: { kind: "fill", selector: Q_INPUT, value: question },
    },
    {
      // Confirm phase (Item 5, "ConfirmBack-Phase", decision B): a brief recap
      // of the question Mei typed, gated on trust/risk at RUNTIME by
      // Walkthrough.tsx/orchestrate.ts (not here). Keeps `selector` on the real
      // Save button so the spotlight/placement geometry stays unchanged. The
      // review field (moved here from what used to be the overloaded
      // confirm/waitFor step below) is safe to read live: Q_INPUT is a plain
      // controlled field with no intermediate "add to list" click that would
      // clear it before this step is reached.
      id: "autoDoctorQ.confirm",
      screen: ON_REMINDERS,
      selector: '[data-walk="elder-doctor-q-save"]',
      instructionKey: "walk.confirmSave",
      confirm: { recap: true },
      review: [{ labelKey: "walk.review.question", selector: Q_INPUT }],
    },
    {
      // MANUAL SUBMIT: the person has reviewed the recap above and now taps
      // Save THEMSELVES — nothing is committed on autopilot. This used to be an
      // `act: click` on the real Save button with verify/reveal riding the same
      // step, so the doctor_questions row was written before the person had any
      // say; the terminal gate opened AFTER the write, far too late to be
      // consent. Now matches the shape its four *_auto siblings all document.
      id: "autoDoctorQ.submit",
      screen: ON_REMINDERS,
      selector: '[data-walk="elder-doctor-q-save"]',
      instructionKey: "walk.confirmSubmit",
      waitFor: { type: "click", source: "dom" },
    },
    {
      // Act-less Verify tail: re-query doctor_questions before claiming success.
      // Spotlights the newest card (the question just saved — it prepends), not
      // the whole list: the full list is taller than the viewport band, so the
      // callout could never clear it (the sweep's callout-could-not-clear).
      id: "autoDoctorQ.verify",
      screen: ON_REMINDERS,
      selector: '[data-walk="elder-doctor-q-latest"]',
      instructionKey: "walk.autoDoctorQ.save",
      verify: { kind: "doctor-question-exists", question },
      reveal: { screen: ON_REMINDERS, selector: '[data-walk="elder-doctor-q-latest"]' },
    },
  ];
}
