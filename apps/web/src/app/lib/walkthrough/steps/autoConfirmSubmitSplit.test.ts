import { describe, expect, it } from "vitest";
import { addConditionAutoSteps } from "./add_condition_auto";
import { addDoctorQuestionAutoSteps } from "./add_doctor_question_auto";
import { addPrescriptionAutoSteps } from "./add_prescription_auto";
import { editProfileAutoSteps } from "./edit_profile_auto";
import { travelModeAutoSteps } from "./travel_mode_auto";
import type { WalkthroughStep } from "../types";

// Phase B sweep (Item 5, "ConfirmBack-Phase"): every *_auto builder must now
// split what used to be one overloaded step into a true Confirm recap step
// (autonomous — confirm:{recap:true}, no waitFor) immediately followed by a
// plain Submit waitFor step targeting the SAME real control. This is the one
// invariant orchestrate.test.ts's mechanism-level tests (baseStep() objects)
// can't catch: whether each actual builder file wired the object correctly,
// not whether orchestrate.ts handles the shape correctly (that's already
// covered there — this file only proves the step DATA, not the engine).
const BUILDERS: Record<string, () => WalkthroughStep[]> = {
  add_prescription_auto: () => addPrescriptionAutoSteps(),
  add_condition_auto: () => addConditionAutoSteps(),
  travel_mode_auto: () => travelModeAutoSteps(),
  edit_profile_auto: () => editProfileAutoSteps(),
  add_doctor_question_auto: () => addDoctorQuestionAutoSteps(),
};

describe("*_auto step builders — Confirm/Submit split (Phase B, all 5 tasks)", () => {
  for (const [task, build] of Object.entries(BUILDERS)) {
    it(`${task}: a confirm step is immediately followed by a plain waitFor submit step on the SAME selector`, () => {
      const steps = build();
      const confirmIdx = steps.findIndex(s => s.confirm);
      expect(confirmIdx, `${task} has a confirm step`).toBeGreaterThanOrEqual(0);

      const confirmStep = steps[confirmIdx];
      const submitStep = steps[confirmIdx + 1];

      // The Confirm step itself must be autonomous (no waitFor of its own) —
      // it resolves via orchestrate.ts's awaitNext/paced, never a real DOM tap.
      expect(confirmStep.waitFor, `${task} confirm step has no waitFor`).toBeUndefined();
      expect(confirmStep.act, `${task} confirm step has no act`).toBeUndefined();

      // The very next step is the real, plain Submit — a waitFor with no
      // confirm/act of its own — on the SAME control the confirm step named.
      expect(submitStep, `${task} has a step immediately after confirm`).toBeDefined();
      expect(submitStep.waitFor, `${task} submit step is a waitFor`).toBeDefined();
      expect(submitStep.confirm, `${task} submit step carries no confirm of its own`).toBeUndefined();
      expect(submitStep.selector, `${task} submit targets the same control confirm named`)
        .toBe(confirmStep.selector);
    });

    it(`${task}: no step carries both act and waitFor (exactly one drives each step)`, () => {
      for (const step of build()) {
        expect(step.act && step.waitFor, `step "${step.id}" has both act and waitFor`).toBeFalsy();
      }
    });
  }

  it("add_condition_auto's confirm step deliberately carries NO review — TagList clears its input on Add, so a live-read ReviewField would always read blank", () => {
    const steps = addConditionAutoSteps();
    const confirmStep = steps.find(s => s.confirm)!;
    expect(confirmStep.review).toBeUndefined();
  });

  // A fixed course ("for 2 weeks") is optional — most prescriptions are ongoing.
  // The steps that set it must therefore be absent unless Mei actually has a
  // duration, or the run spotlights a control it has no value for.
  it("add_prescription_auto omits the duration steps when no course was given", () => {
    const ids = addPrescriptionAutoSteps({ name: "Metformin" }).map(s => s.id);
    expect(ids.some(id => id.startsWith("autoRx.duration"))).toBe(false);
  });

  it("add_prescription_auto adds both duration steps, before confirm, when a course was given", () => {
    const steps = addPrescriptionAutoSteps({ name: "Amoxicillin", duration_days: "14" });
    const ids = steps.map(s => s.id);
    const confirmAt = steps.findIndex(s => s.confirm);

    // Two steps, not one: the presets do not exist until the mode is switched.
    expect(ids.indexOf("autoRx.durationMode")).toBeGreaterThan(-1);
    expect(ids.indexOf("autoRx.duration")).toBe(ids.indexOf("autoRx.durationMode") + 1);
    expect(ids.indexOf("autoRx.duration")).toBeLessThan(confirmAt);

    // Both are Mei-driven, so neither may carry a waitFor.
    for (const id of ["autoRx.durationMode", "autoRx.duration"]) {
      const step = steps.find(s => s.id === id)!;
      expect(step.act, `${id} is driven by an act`).toBeDefined();
      expect(step.waitFor, `${id} is not a user-driven wait`).toBeUndefined();
    }
  });

  it("add_prescription_auto clicks an EXACT-value preset for a non-standard course, never the nearest one", () => {
    const five = addPrescriptionAutoSteps({ duration_days: "5" }).find(s => s.id === "autoRx.duration")!;
    // Snapping 5 -> 7 would silently rewrite what the doctor prescribed.
    expect(five.act).toEqual({ kind: "click", selector: '[data-walk="rx-duration-custom"]' });

    const fortnight = addPrescriptionAutoSteps({ duration_days: "14" }).find(s => s.id === "autoRx.duration")!;
    expect(fortnight.act).toEqual({ kind: "click", selector: '[data-walk="rx-duration-14"]' });
  });

  it("add_prescription_auto's review shows the course only when there is one", () => {
    const withCourse = addPrescriptionAutoSteps({ duration_days: "14" }).find(s => s.confirm)!;
    const without = addPrescriptionAutoSteps({}).find(s => s.confirm)!;
    const selectors = (step: typeof withCourse) => (step.review ?? []).map(r => r.selector);

    expect(selectors(withCourse)).toContain('[data-walk="rx-duration-summary"]');
    // Without a course that element is never rendered, so a row naming it would
    // read blank and block the Confirm phase on every ordinary run.
    expect(selectors(without)).not.toContain('[data-walk="rx-duration-summary"]');
  });

  // 2026-08-10: the Save step waits on the WRITE, not the click that starts it.
  // A click-driven wait ended the step while handleAdd was still awaiting the
  // insert (so the next step's Verify re-queried too early and stopped the run
  // at "I couldn't confirm that saved"), and never fired at all when the
  // dose-safety dialog made handleAdd return early — leaving a step that is
  // neither autonomous nor stalled, i.e. a callout with no Done at all.
  it("add_prescription_auto's submit step waits on the medication-saved write, with a timeout", () => {
    const submit = addPrescriptionAutoSteps().find(s => s.id === "autoRx.submit")!;
    expect(submit.waitFor).toEqual({
      type: "write-committed", source: "app-event", event: "medication-saved",
    });
    // A bus signal that never arrives (a save that THREW emits nothing) has to
    // resolve to a stalled state, or the run hangs with no way forward.
    expect(submit.timeoutMs, "the bus wait cannot hang forever").toBeGreaterThan(0);
  });

  it("add_prescription_auto's review shows the dose time only when Mei was given one", () => {
    const timed = addPrescriptionAutoSteps({ times: "12:00" }).find(s => s.confirm)!;
    const untimed = addPrescriptionAutoSteps({}).find(s => s.confirm)!;
    const selectors = (step: typeof timed) => (step.review ?? []).map(r => r.selector);

    expect(selectors(timed)).toContain('[data-walk="rx-time-value"]');
    // Without a time, that row would recap the sheet's own breakfast default
    // as though it were the person's answer.
    expect(selectors(untimed)).not.toContain('[data-walk="rx-time-value"]');
  });

  it("the other four *_auto confirm steps DO carry a review of what Mei filled in", () => {
    for (const task of ["add_prescription_auto", "travel_mode_auto", "edit_profile_auto", "add_doctor_question_auto"]) {
      const confirmStep = BUILDERS[task]().find(s => s.confirm)!;
      expect(confirmStep.review?.length, `${task} confirm step has a non-empty review`).toBeGreaterThan(0);
    }
  });
});
