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
      // MANUAL CONFIRM: the person taps Save themselves (waitFor, no act/Next) —
      // nothing is written on autopilot. Same pattern as accept_caregiver_link.ts.
      id: "autoCond.confirm",
      screen: ON_SETTINGS,
      selector: '[data-walk="elder-profile-save"]',
      instructionKey: "walk.confirmSave",
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
