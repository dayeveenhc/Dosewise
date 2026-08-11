import type { WalkthroughStep } from "../types";

const ON_WIZARD: WalkthroughStep["screen"] = { mode: "onboarding" };
// Every wizard step's Continue/Create button shares one selector (only one is
// ever mounted at a time — see ContinueButton in GuidedSetupWizard.tsx) and
// advancement rides the wizard's own step-transition event, never the click
// alone: createAccount() only calls goNext() after a successful signup, and
// finish() only fires wizard-finished after its writes actually resolve.
const CONTINUE = '[data-walk="wizard-continue-button"]';
const stepTransition = (toStep: string): WalkthroughStep["waitFor"] => ({
  type: "step-transition", source: "app-event", event: "wizard-step-changed", toStep,
});

// The onboarding wizard — GuidedSetupWizard.tsx / SetupMethodScreen.tsx. Real
// step order per CONTEXT.md: account -> profile -> conditions -> allergies ->
// routine -> current-meds -> med-history -> done.
export const onboardingSteps: WalkthroughStep[] = [
  {
    id: "wizard.choose-guided",
    screen: ON_WIZARD,
    selector: '[data-walk="setup-method-guided"]',
    instructionKey: "walk.wizard.chooseGuided",
    waitFor: { type: "click", source: "dom" },
  },

  // ---- account ----
  { id: "wizard.account.fullname", screen: ON_WIZARD, selector: '[data-walk="wizard-fullname"]',
    instructionKey: "walk.wizard.preferredName", waitFor: { type: "input", source: "dom", on: "blur", validate: "nonEmpty" } },
  { id: "wizard.account.email", screen: ON_WIZARD, selector: '[data-walk="wizard-email"]',
    instructionKey: "walk.wizard.email",
    waitFor: { type: "input", source: "dom", on: "blur", validate: { pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" } } },
  { id: "wizard.account.password", screen: ON_WIZARD, selector: '[data-walk="wizard-password"]',
    instructionKey: "walk.wizard.password", waitFor: { type: "input", source: "dom", on: "blur", validate: "nonEmpty" } },
  { id: "wizard.account.create", screen: ON_WIZARD, selector: CONTINUE,
    instructionKey: "walk.wizard.createAccount", waitFor: stepTransition("profile") },

  // ---- profile ----
  { id: "wizard.profile.dob", screen: ON_WIZARD, selector: '[data-walk="wizard-dob"]',
    instructionKey: "walk.wizard.dob", waitFor: { type: "input", source: "dom", on: "change", validate: "nonEmpty" } },
  // Spotlight the whole picker (the first-button-only cutout looked like only
  // one gender was on offer); the listener arms every button, so any choice
  // satisfies the step.
  { id: "wizard.profile.gender", screen: ON_WIZARD, selector: '[data-walk="wizard-gender-picker"]',
    instructionKey: "walk.wizard.gender",
    waitFor: { type: "click", source: "dom", selector: '[data-walk="wizard-gender-picker"] button' } },
  { id: "wizard.profile.weight", screen: ON_WIZARD, selector: '[data-walk="wizard-weight"]',
    instructionKey: "walk.wizard.weight", waitFor: { type: "input", source: "dom", on: "blur", validate: "nonEmpty" } },
  { id: "wizard.profile.height", screen: ON_WIZARD, selector: '[data-walk="wizard-height"]',
    instructionKey: "walk.wizard.height", waitFor: { type: "input", source: "dom", on: "blur", validate: "nonEmpty" } },
  { id: "wizard.profile.continue", screen: ON_WIZARD, selector: CONTINUE,
    instructionKey: "walk.wizard.continue", waitFor: stepTransition("conditions") },

  // ---- conditions ----
  { id: "wizard.conditions.add", screen: ON_WIZARD, selector: '[data-walk="wizard-conditions-taglist-add-btn"]',
    instructionKey: "walk.wizard.conditions", waitFor: { type: "click", source: "dom" } },
  { id: "wizard.conditions.continue", screen: ON_WIZARD, selector: CONTINUE,
    instructionKey: "walk.wizard.continueOrSkip", waitFor: stepTransition("allergies") },

  // ---- allergies ----
  { id: "wizard.allergies.general", screen: ON_WIZARD, selector: '[data-walk="wizard-allergies-taglist-add-btn"]',
    instructionKey: "walk.wizard.allergies", waitFor: { type: "click", source: "dom" } },
  { id: "wizard.allergies.drug", screen: ON_WIZARD, selector: '[data-walk="wizard-drug-allergies-taglist-add-btn"]',
    instructionKey: "walk.wizard.drugAllergies", waitFor: { type: "click", source: "dom" } },
  { id: "wizard.allergies.continue", screen: ON_WIZARD, selector: CONTINUE,
    instructionKey: "walk.wizard.continue", waitFor: stepTransition("routine") },

  // ---- routine (TimeField x5 — real signal is the event bus, not a DOM click,
  // since taps on the stepper only mutate the editor's local draft) ----
  { id: "wizard.routine.wakeTime", screen: ON_WIZARD, selector: '[data-walk="wizard-routine-wakeTime"]',
    instructionKey: "walk.wizard.routine.wakeTime",
    waitFor: { type: "value-change", source: "app-event", event: "wizard-routine-wakeTime-changed" },
    timeoutMs: 20000 },  // a signal that never arrives must surface, not hang
  { id: "wizard.routine.breakfast", screen: ON_WIZARD, selector: '[data-walk="wizard-routine-breakfast"]',
    instructionKey: "walk.wizard.routine.breakfast",
    waitFor: { type: "value-change", source: "app-event", event: "wizard-routine-breakfast-changed" },
    timeoutMs: 20000 },  // a signal that never arrives must surface, not hang
  { id: "wizard.routine.lunch", screen: ON_WIZARD, selector: '[data-walk="wizard-routine-lunch"]',
    instructionKey: "walk.wizard.routine.lunch",
    waitFor: { type: "value-change", source: "app-event", event: "wizard-routine-lunch-changed" },
    timeoutMs: 20000 },  // a signal that never arrives must surface, not hang
  { id: "wizard.routine.dinner", screen: ON_WIZARD, selector: '[data-walk="wizard-routine-dinner"]',
    instructionKey: "walk.wizard.routine.dinner",
    waitFor: { type: "value-change", source: "app-event", event: "wizard-routine-dinner-changed" },
    timeoutMs: 20000 },  // a signal that never arrives must surface, not hang
  { id: "wizard.routine.sleepTime", screen: ON_WIZARD, selector: '[data-walk="wizard-routine-sleepTime"]',
    instructionKey: "walk.wizard.routine.sleepTime",
    waitFor: { type: "value-change", source: "app-event", event: "wizard-routine-sleepTime-changed" },
    timeoutMs: 20000 },  // a signal that never arrives must surface, not hang
  { id: "wizard.routine.continue", screen: ON_WIZARD, selector: CONTINUE,
    instructionKey: "walk.wizard.continue", waitFor: stepTransition("current-meds") },

  // ---- current-meds ----
  { id: "wizard.currentmeds.open", screen: ON_WIZARD, selector: '[data-walk="wizard-medlist-open"]',
    instructionKey: "walk.wizard.addMedication", waitFor: { type: "click", source: "dom" } },
  { id: "wizard.currentmeds.times", screen: ON_WIZARD, selector: '[data-walk="wizard-medlist-timespicker"]',
    instructionKey: "walk.wizard.usualTimes",
    waitFor: { type: "value-change", source: "app-event", event: "wizard-medlist-times-changed" },
    timeoutMs: 20000 },  // a signal that never arrives must surface, not hang
  { id: "wizard.currentmeds.add", screen: ON_WIZARD, selector: '[data-walk="wizard-medlist-add-btn"]',
    instructionKey: "walk.wizard.addToList", waitFor: { type: "click", source: "dom" } },
  { id: "wizard.currentmeds.continue", screen: ON_WIZARD, selector: CONTINUE,
    instructionKey: "walk.wizard.continueOrSkip", waitFor: stepTransition("med-history") },

  // ---- med-history (same MedList, extractKind="past") ----
  { id: "wizard.medhistory.open", screen: ON_WIZARD, selector: '[data-walk="wizard-medlist-open"]',
    instructionKey: "walk.wizard.addPastMedication", waitFor: { type: "click", source: "dom" } },
  { id: "wizard.medhistory.continue", screen: ON_WIZARD, selector: CONTINUE,
    instructionKey: "walk.wizard.continueOrSkip", waitFor: stepTransition("done") },

  // ---- done ----
  { id: "wizard.done.finish", screen: ON_WIZARD, selector: CONTINUE,
    instructionKey: "walk.wizard.goToDosewise",
    waitFor: { type: "write-committed", source: "app-event", event: "wizard-finished" },
    timeoutMs: 20000 },  // a signal that never arrives must surface, not hang
];
