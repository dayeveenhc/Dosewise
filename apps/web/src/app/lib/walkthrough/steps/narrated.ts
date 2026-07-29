import type { WalkthroughStep } from "../types";

// Spotlight-and-narrate walkthroughs: Mei highlights one control at a time and
// explains it, but the ELDER performs every tap (the app's original walkthrough
// contract — see components/Walkthrough.tsx). None of these enter data, so none
// carries an `act` or a `verify`; there is nothing to save and therefore nothing
// that could be falsely claimed as saved.
//
// They live in one file rather than nine because each is only two or three
// steps and they share the same shape; splitting them would be ceremony.

const ON_HOME: WalkthroughStep["screen"] = { mode: "elderly", tab: "home" };
const ON_SETTINGS: WalkthroughStep["screen"] = { mode: "elderly", tab: "settings" };

// Tap the real bottom-nav item. Every one of these starts from wherever the
// elder currently is (usually Ask Mei), so step one is always "get there".
const navStep = (id: string, tab: string, instructionKey: string): WalkthroughStep => ({
  id,
  screen: { mode: "elderly", tab: "ai" },
  selector: `[data-tour="nav-${tab}"]`,
  instructionKey,
  waitFor: { type: "click", source: "dom" },
});

export const checkScheduleSteps: WalkthroughStep[] = [
  navStep("schedule.open", "home", "walk.schedule.openHome"),
  {
    id: "schedule.readTimeline",
    screen: ON_HOME,
    onEnter: ON_HOME,
    selector: '[data-tour="elder-schedule"]',
    instructionKey: "walk.schedule.readTimeline",
    waitFor: { type: "acknowledge", source: "dom" },
  },
  {
    id: "schedule.now",
    screen: ON_HOME,
    selector: '[data-walk="elder-day-nav"]',
    instructionKey: "walk.schedule.dayStatus",
    waitFor: { type: "acknowledge", source: "dom" },
  },
];

export const logDoseSteps: WalkthroughStep[] = [
  navStep("logDose.open", "home", "walk.logDose.openHome"),
  {
    id: "logDose.tapTook",
    screen: ON_HOME,
    onEnter: ON_HOME,
    selector: '[data-walk="elder-take-dose"]',
    instructionKey: "walk.logDose.tapTook",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "logDose.confirm",
    screen: ON_HOME,
    selector: '[data-walk="elder-take-confirm"]',
    instructionKey: "walk.logDose.confirm",
    waitFor: { type: "click", source: "dom" },
  },
];

export const undoDoseSteps: WalkthroughStep[] = [
  navStep("undoDose.open", "home", "walk.undoDose.openHome"),
  {
    id: "undoDose.tapUndo",
    screen: ON_HOME,
    onEnter: ON_HOME,
    selector: '[data-walk="elder-undo-dose"]',
    instructionKey: "walk.undoDose.tapUndo",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "undoDose.confirm",
    screen: ON_HOME,
    selector: '[data-walk="confirm-dialog-confirm"]',
    instructionKey: "walk.undoDose.confirm",
    waitFor: { type: "click", source: "dom" },
  },
];

export const languageVoiceSteps: WalkthroughStep[] = [
  navStep("langVoice.open", "settings", "walk.langVoice.openSettings"),
  {
    id: "langVoice.section",
    screen: ON_SETTINGS,
    onEnter: ON_SETTINGS,
    selector: '[data-walk="elder-settings-voice"]',
    instructionKey: "walk.langVoice.openSection",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "langVoice.pickLanguage",
    screen: ON_SETTINGS,
    selector: '[data-walk="elder-language-select"]',
    instructionKey: "walk.langVoice.pickLanguage",
    waitFor: { type: "acknowledge", source: "dom" },
  },
  {
    id: "langVoice.readAloud",
    screen: ON_SETTINGS,
    selector: '[data-walk="elder-readaloud-toggle"]',
    instructionKey: "walk.langVoice.readAloud",
    waitFor: { type: "acknowledge", source: "dom" },
  },
];

export const reminderSettingsSteps: WalkthroughStep[] = [
  navStep("reminders.open", "settings", "walk.reminders.openSettings"),
  {
    id: "reminders.section",
    screen: ON_SETTINGS,
    onEnter: ON_SETTINGS,
    selector: '[data-walk="elder-settings-notifications"]',
    instructionKey: "walk.reminders.openSection",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "reminders.medsToggle",
    screen: ON_SETTINGS,
    selector: '[data-walk="elder-reminder-meds"]',
    instructionKey: "walk.reminders.medsToggle",
    waitFor: { type: "acknowledge", source: "dom" },
  },
];

export const emergencyContactSteps: WalkthroughStep[] = [
  navStep("emergency.open", "settings", "walk.emergency.openSettings"),
  {
    id: "emergency.section",
    screen: ON_SETTINGS,
    onEnter: ON_SETTINGS,
    selector: '[data-walk="elder-settings-emergency"]',
    instructionKey: "walk.emergency.openSection",
    waitFor: { type: "click", source: "dom" },
  },
  {
    // Ends on "here is the button", not on pressing it: this walkthrough is
    // about being able to FIND the contact in a hurry, and placing a call is
    // not something to trigger as a side effect of a lesson.
    id: "emergency.callButton",
    screen: ON_SETTINGS,
    selector: '[data-walk="elder-emergency-call"]',
    instructionKey: "walk.emergency.callButton",
    waitFor: { type: "acknowledge", source: "dom" },
  },
];

export const textSizeSteps: WalkthroughStep[] = [
  navStep("textSize.open", "settings", "walk.textSize.openSettings"),
  {
    id: "textSize.section",
    screen: ON_SETTINGS,
    onEnter: ON_SETTINGS,
    selector: '[data-walk="elder-settings-accessibility"]',
    instructionKey: "walk.textSize.openSection",
    waitFor: { type: "click", source: "dom" },
  },
  {
    id: "textSize.slider",
    screen: ON_SETTINGS,
    selector: '[data-tour="elder-fontsize"]',
    instructionKey: "walk.textSize.slider",
    waitFor: { type: "input", source: "dom", on: "change" },
  },
  {
    id: "textSize.contrast",
    screen: ON_SETTINGS,
    selector: '[data-walk="elder-contrast"]',
    instructionKey: "walk.textSize.contrast",
    waitFor: { type: "acknowledge", source: "dom" },
  },
];
