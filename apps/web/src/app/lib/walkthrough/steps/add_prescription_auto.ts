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
  // Arrives as a STRING ("14") — walkthrough.py coerces every param via str().
  // Absent for the ordinary ongoing prescription, which is the common case, so
  // the two duration steps are omitted entirely rather than spotlighting a
  // control Mei has no value for.
  const durationDays = Number.parseInt(p.duration_days ?? "", 10);
  const hasDuration = Number.isFinite(durationDays) && durationDays > 0;
  // The sheet renders an exact-value preset for anything outside its standard
  // three, so a 5-day course is CLICKED as 5 days rather than snapped to the
  // nearest preset — silently rewriting a doctor's instruction is not an
  // acceptable cost for a simpler step file.
  const durationTarget = [7, 14, 30].includes(durationDays)
    ? `[data-walk="rx-duration-${durationDays}"]`
    : '[data-walk="rx-duration-custom"]';
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
    // A fixed course ("the doctor gave me this for 2 weeks"). Two steps, not
    // one: the presets do not exist in the DOM until the mode is switched, and
    // a step's onEnter can only change screens, not reveal a section. The pair
    // is exactly the shape computeHoldGate's case 2 already handles — a click
    // that opens the surface the next step acts on — so the spotlight moves on
    // by itself instead of parking on a control the new row buried.
    ...(hasDuration
      ? [
          {
            id: "autoRx.durationMode",
            screen: ON_RX,
            selector: '[data-walk="rx-duration"]',
            instructionKey: "walk.autoRx.durationMode",
            act: { kind: "click", selector: '[data-walk="rx-duration-fixed"]' },
          } as WalkthroughStep,
          {
            id: "autoRx.duration",
            screen: ON_RX,
            selector: '[data-walk="rx-duration"]',
            instructionKey: "walk.autoRx.duration",
            act: { kind: "click", selector: durationTarget },
          } as WalkthroughStep,
        ]
      : []),
    {
      // Confirm phase (Item 5, "ConfirmBack-Phase", decision B): a brief recap
      // of what Mei filled in, gated on trust/risk at RUNTIME by
      // Walkthrough.tsx/orchestrate.ts (not here — this step file only marks
      // that a recap belongs here). Neither an `act` nor a `waitFor`:
      // orchestrate.ts's runActStep runs the confirm phase for any step
      // declaring `confirm`, then folds straight into advancing (no separate
      // terminal tap) since this step's ONLY content is the confirm phase.
      // Keeps `selector` on the real Save button (not e.g. the review card)
      // so the spotlight/placement geometry SpotlightVisual-Fix verified for
      // this exact step stays unchanged.
      id: "autoRx.confirm",
      screen: ON_RX,
      selector: '[data-walk="rx-submit"]',
      instructionKey: "walk.confirmSave",
      confirm: { recap: true },
      // Show what Mei actually typed, read live from these exact fields — the
      // SAME selectors the fill acts above used, so the card and the actor can
      // never disagree about which field is which. Tapping Change focuses the
      // first (or first BLANK) one; nothing here can save. A blank field here
      // always forces an explicit tap regardless of trust/risk level
      // (Walkthrough.tsx's clarifying-question sub-state).
      review: [
        { labelKey: "wizard.medicationName", selector: '[data-walk="rx-name"] input' },
        { labelKey: "prescription.dose", selector: '[data-walk="rx-dose"]' },
        { labelKey: "prescription.purposeCondition", selector: '[data-walk="rx-purpose"] input' },
        // Only when there IS a course — otherwise this row points at an element
        // that isn't rendered. The summary is a <p>, which is why readValues
        // falls back to textContent (WalkthroughReview.tsx): a .value-only read
        // would report the single most consequential thing Mei just set as
        // blank and block the Confirm phase on every run.
        ...(hasDuration
          ? [{ labelKey: "prescription.courseLength", selector: '[data-walk="rx-duration-summary"]' }]
          : []),
      ],
    },
    {
      // MANUAL SUBMIT: the person has reviewed the recap above and now taps
      // Save THEMSELVES — nothing is committed on autopilot. A waitFor step
      // (no act, no Next button), so the run pauses here until the real tap.
      // Mirrors the consent pattern in accept_caregiver_link.ts.
      id: "autoRx.submit",
      screen: ON_RX,
      selector: '[data-walk="rx-submit"]',
      instructionKey: "walk.confirmSubmit",
      waitFor: { type: "click", source: "dom" },
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
