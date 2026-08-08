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
      // Confirm phase (Item 5, "ConfirmBack-Phase", decision B): a brief recap
      // of the new weight, gated on trust/risk at RUNTIME by
      // Walkthrough.tsx/orchestrate.ts (not here — this step file only marks
      // that a recap belongs here). Keeps `selector` on the real Save button
      // (not e.g. the review card) so the spotlight/placement geometry
      // SpotlightVisual-Fix verified for this shape stays unchanged.
      id: "autoProfile.confirm",
      screen: ON_SETTINGS,
      selector: '[data-walk="elder-profile-save"]',
      instructionKey: "walk.confirmSave",
      confirm: { recap: true },
      // The weight input stays populated (it's a plain controlled field, not
      // a chip-list draft that clears itself) so a live read here is safe —
      // unlike add_condition_auto's TagList input.
      review: [{ labelKey: "settings.weightKg", selector: '[data-walk="elder-profile-weight"]' }],
    },
    {
      // MANUAL SUBMIT: the person has reviewed the recap above and now taps
      // Save THEMSELVES — nothing is committed on autopilot. A waitFor step (no
      // act, no Next button), so the run pauses here until the real tap. Mirrors
      // the consent pattern in accept_caregiver_link.ts.
      id: "autoProfile.submit",
      screen: ON_SETTINGS,
      selector: '[data-walk="elder-profile-save"]',
      instructionKey: "walk.confirmSubmit",
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
