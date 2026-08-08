import type { WalkthroughParams, WalkthroughStep } from "../types";

// Guided Auto-Navigation — autonomous "add a medical condition". Mei opens
// Settings → Your Profile, types the condition into the Conditions field, adds
// the chip, saves, then VERIFIES the condition really landed in the structured
// `conditions[]` (host re-queries fetchProfile) before completing.
//
// This is also the correct path for conditions: it writes structured
// `conditions[]` via the real form (which the profile UI reads), unlike the
// free-text `update_medical_profile` blob that never renders here.

const ON_SETTINGS: WalkthroughStep["screen"] = { mode: "elderly", tab: "settings" };
const CONDITIONS_INPUT = '[data-walk="elder-conditions"] input:not([type="file"])';

export function addConditionAutoSteps(p: WalkthroughParams = {}): WalkthroughStep[] {
  const condition = p.condition?.trim() || "High blood pressure";
  return [
    {
      id: "autoCond.expand",
      screen: ON_SETTINGS,
      onEnter: ON_SETTINGS,
      selector: '[data-walk="elder-profile-toggle"]',
      instructionKey: "walk.autoCond.expand",
      act: { kind: "click", selector: '[data-walk="elder-profile-toggle"]' },
    },
    {
      // The profile opens read-only now — unlock it before typing, or the
      // conditions field is disabled and the fill silently does nothing.
      id: "autoCond.edit",
      screen: ON_SETTINGS,
      selector: '[data-walk="elder-profile-edit"]',
      instructionKey: "walk.autoCond.edit",
      act: { kind: "click", selector: '[data-walk="elder-profile-edit"]' },
    },
    {
      id: "autoCond.type",
      screen: ON_SETTINGS,
      selector: CONDITIONS_INPUT,
      instructionKey: "walk.autoCond.type",
      act: { kind: "fill", selector: CONDITIONS_INPUT, value: condition },
    },
    {
      id: "autoCond.add",
      screen: ON_SETTINGS,
      selector: '[data-walk="elder-conditions-add-btn"]',
      instructionKey: "walk.autoCond.add",
      act: { kind: "click", selector: '[data-walk="elder-conditions-add-btn"]' },
    },
    {
      // Confirm phase (Item 5, "ConfirmBack-Phase", decision B): a brief recap,
      // gated on trust/risk at RUNTIME by Walkthrough.tsx/orchestrate.ts (not
      // here). Deliberately carries NO `review` — TagList's own "Add" button
      // (the previous step) clears its input the instant it commits the chip,
      // so a ReviewField reading that same selector would always read blank
      // and wrongly force the clarifying-question path on every single run.
      // Uses walk.confirmSubmit (not the walk.confirmSave every other *_auto
      // sibling uses here) for exactly that reason: confirmSave's copy tells
      // the person to "tap Change" for a Change button that, with no review
      // card, never renders — a tour must never claim an interaction that
      // doesn't happen. The condition chip is still visible (dimmed) on the
      // real form behind the spotlight cutout for the person to check.
      id: "autoCond.confirm",
      screen: ON_SETTINGS,
      selector: '[data-walk="elder-profile-save"]',
      instructionKey: "walk.confirmSubmit",
      confirm: { recap: true },
    },
    {
      // MANUAL SUBMIT: the person has reviewed the change above and now taps
      // Save THEMSELVES — nothing is committed on autopilot. A waitFor step (no
      // act, no Next button), so the run pauses here until the real tap. Mirrors
      // the consent pattern in accept_caregiver_link.ts.
      id: "autoCond.submit",
      screen: ON_SETTINGS,
      selector: '[data-walk="elder-profile-save"]',
      instructionKey: "walk.confirmSubmit",
      waitFor: { type: "click", source: "dom" },
    },
    {
      // Act-less Verify tail: re-query the structured conditions[] before success.
      id: "autoCond.verify",
      screen: ON_SETTINGS,
      selector: '[data-walk="elder-conditions"]',
      instructionKey: "walk.autoCond.save",
      verify: { kind: "profile-list-includes", field: "conditions", value: condition },
      reveal: { screen: ON_SETTINGS, selector: '[data-walk="elder-conditions"]' },
    },
  ];
}
