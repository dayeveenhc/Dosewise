import type { WalkthroughStep } from "../types";

// Spotlight-and-narrate walkthroughs: Mei highlights one control at a time and
// explains it, but the ELDER performs every tap (the app's original walkthrough
// contract — see components/Walkthrough.tsx). None of these enter data, so none
// carries an `act` or a `verify`; there is nothing to save and therefore nothing
// that could be falsely claimed as saved.
//
// They live in one file rather than five because each is only two or three
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
    // Spotlight the "now" line (always rendered on today — it clamps to the
    // first/last hour row outside 6am–11pm) rather than the whole timeline,
    // which is taller than the viewport band so the callout could never clear
    // it. The acknowledge tap stays on the full timeline: tapping anywhere on
    // it advances, and it also covers the non-today edge where the now line
    // isn't rendered.
    selector: '[data-walk="elder-timeline-now"]',
    instructionKey: "walk.schedule.readTimeline",
    waitFor: { type: "acknowledge", source: "dom", selector: '[data-tour="elder-schedule"]' },
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

export const reminderSettingsSteps: WalkthroughStep[] = [
  navStep("reminders.open", "settings", "walk.reminders.openSettings"),
  {
    id: "reminders.medsToggle",
    screen: ON_SETTINGS,
    onEnter: ON_SETTINGS,
    selector: '[data-walk="elder-reminder-meds"]',
    instructionKey: "walk.reminders.medsToggle",
    waitFor: { type: "acknowledge", source: "dom" },
  },
];

export const textSizeSteps: WalkthroughStep[] = [
  navStep("textSize.open", "settings", "walk.textSize.openSettings"),
  {
    id: "textSize.slider",
    screen: ON_SETTINGS,
    onEnter: ON_SETTINGS,
    // Spotlight the whole labelled block, but WAIT on the range input itself —
    // this used to wait on the wrapping div, whose `.value` is undefined, so
    // the "did they move it?" check could never pass and the tour hung here.
    selector: '[data-tour="elder-fontsize"]',
    instructionKey: "walk.textSize.slider",
    waitFor: { type: "input", source: "dom", selector: '[data-walk="elder-fontsize-slider"]', on: "change" },
  },
  {
    id: "textSize.contrast",
    screen: ON_SETTINGS,
    selector: '[data-walk="elder-contrast"]',
    instructionKey: "walk.textSize.contrast",
    waitFor: { type: "acknowledge", source: "dom" },
  },
];
