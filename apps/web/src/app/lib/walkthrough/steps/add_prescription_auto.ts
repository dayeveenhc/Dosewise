import type { WalkthroughParams, WalkthroughStep } from "../types";

// Guided Auto-Navigation flagship — the autonomous add-prescription (manual)
// flow: Mei opens the form, fills each field herself (visibly, one at a time)
// with the patient's REAL values (params), submits, then VERIFIES the medication
// really landed on the list by re-querying Supabase before completing. If Verify
// fails the run stops and shows walk.verifyFailed — it never claims a save it
// can't prove.
//
// Values come from Mei's start_walkthrough params (safe defaults for a bare
// demo trigger). SAFETY: the prescription is proposed in chat first
// (add_prescription confirmed=false → OpenFDA interaction check); this
// walkthrough performs only the save.

const ON_RX: WalkthroughStep["screen"] = { mode: "elderly", tab: "prescriptions" };

export function addPrescriptionAutoSteps(p: WalkthroughParams = {}): WalkthroughStep[] {
  const name = p.name?.trim() || "Metformin";
  const dose = p.dose?.trim() || "500mg";
  const purpose = p.purpose?.trim() || "General health";
  return [
    {
      id: "autoRx.open",
      screen: ON_RX,
      onEnter: ON_RX,
      selector: '[data-tour="elder-add-prescription"]',
      instructionKey: "walk.autoRx.open",
      act: { kind: "click", selector: '[data-tour="elder-add-prescription"]' },
    },
    {
      id: "autoRx.name",
      screen: ON_RX,
      selector: '[data-walk="rx-name"] input',
      instructionKey: "walk.autoRx.name",
      act: { kind: "fill", selector: '[data-walk="rx-name"] input', value: name },
    },
    {
      id: "autoRx.dose",
      screen: ON_RX,
      selector: '[data-walk="rx-dose"]',
      instructionKey: "walk.autoRx.dose",
      act: { kind: "fill", selector: '[data-walk="rx-dose"]', value: dose },
    },
    {
      id: "autoRx.purpose",
      screen: ON_RX,
      selector: '[data-walk="rx-purpose"] input',
      instructionKey: "walk.autoRx.purpose",
      act: { kind: "fill", selector: '[data-walk="rx-purpose"] input', value: purpose },
    },
    {
      // MANUAL CONFIRM: Mei filled everything, but the person taps Save THEMSELVES
      // — nothing is committed on autopilot. A waitFor step (no act, no Next
      // button), so the run pauses here until the real tap. Mirrors the consent
      // pattern in accept_caregiver_link.ts.
      id: "autoRx.confirm",
      screen: ON_RX,
      selector: '[data-walk="rx-submit"]',
      instructionKey: "walk.confirmSave",
      waitFor: { type: "click", source: "dom" },
      // Show what Mei actually typed, read live from these exact fields — the
      // SAME selectors the fill acts above used, so the card and the actor can
      // never disagree about which field is which. Tapping Change focuses the
      // first one; nothing here can save.
      review: [
        { labelKey: "wizard.medicationName", selector: '[data-walk="rx-name"] input' },
        { labelKey: "prescription.dose", selector: '[data-walk="rx-dose"]' },
        { labelKey: "prescription.purposeCondition", selector: '[data-walk="rx-purpose"] input' },
      ],
    },
    {
      // Act-less Verify tail: re-query the real medication list (host polls
      // fetchElderMedications) — the write's own "Saved" is never trusted. On
      // pass, Reveal navigates to the Home timeline, where ElderlyHomeScreen's
      // justAddedMed pulse-highlights the new dose card as proof.
      id: "autoRx.verify",
      screen: ON_RX,
      selector: '[data-walk="rx-submit"]',
      instructionKey: "walk.autoRx.submit",
      verify: { kind: "medication-exists", name },
      reveal: { screen: { mode: "elderly", tab: "home" }, selector: '[data-tour="elder-schedule"]' },
    },
  ];
}
