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
      id: "autoDoctorQ.save",
      screen: ON_REMINDERS,
      selector: '[data-walk="elder-doctor-q-save"]',
      instructionKey: "walk.autoDoctorQ.save",
      act: { kind: "click", selector: '[data-walk="elder-doctor-q-save"]' },
      verify: { kind: "doctor-question-exists", question },
      reveal: { screen: ON_REMINDERS, selector: '[data-walk="elder-doctor-questions"]' },
    },
  ];
}
