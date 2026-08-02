import type { WalkthroughParams, WalkthroughStep } from "../types";

// Guided Auto-Navigation — autonomous profile edit (weight). Mei opens Settings →
// Your Profile, updates the weight field with the patient's value (params.value),
// saves, then VERIFIES the new value really persisted. weightKg is the simplest
// field: a plain number input + a single Save.

const ON_SETTINGS: WalkthroughStep["screen"] = { mode: "elderly", tab: "settings" };

export function editProfileAutoSteps(p: WalkthroughParams = {}): WalkthroughStep[] {
  const value = p.value?.trim() || "62";
  return [
    {
      id: "autoProfile.expand",
      screen: ON_SETTINGS,
      onEnter: ON_SETTINGS,
      selector: '[data-walk="elder-profile-toggle"]',
      instructionKey: "walk.autoProfile.expand",
      act: { kind: "click", selector: '[data-walk="elder-profile-toggle"]' },
    },
    {
      // The profile opens read-only now — unlock it before typing, or every
      // field below is disabled and the fill silently does nothing.
      id: "autoProfile.edit",
      screen: ON_SETTINGS,
      selector: '[data-walk="elder-profile-edit"]',
      instructionKey: "walk.autoProfile.edit",
      act: { kind: "click", selector: '[data-walk="elder-profile-edit"]' },
    },
    {
      id: "autoProfile.weight",
      screen: ON_SETTINGS,
      selector: '[data-walk="elder-profile-weight"]',
      instructionKey: "walk.autoProfile.weight",
      act: { kind: "fill", selector: '[data-walk="elder-profile-weight"]', value },
    },
    {
      // MANUAL CONFIRM: the person taps Save themselves (waitFor, no act/Next) —
      // nothing is written on autopilot. Same pattern as accept_caregiver_link.ts.
      id: "autoProfile.confirm",
      screen: ON_SETTINGS,
      selector: '[data-walk="elder-profile-save"]',
      instructionKey: "walk.confirmSave",
      waitFor: { type: "click", source: "dom" },
    },
    {
      // Act-less Verify tail: re-query the real profile before claiming success.
      id: "autoProfile.verify",
      screen: ON_SETTINGS,
      selector: '[data-walk="elder-profile-weight"]',
      instructionKey: "walk.autoProfile.save",
      verify: { kind: "profile-field", field: "weightKg", value },
      reveal: { screen: ON_SETTINGS, selector: '[data-walk="elder-profile-weight"]' },
    },
  ];
}
