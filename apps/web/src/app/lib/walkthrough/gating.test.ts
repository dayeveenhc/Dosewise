import { describe, it, expect } from "vitest";
import { addPrescriptionAutoSteps } from "./steps/add_prescription_auto";
import { canGoBack, computeHoldGate } from "./gating";
import type { WalkthroughStep } from "./types";

// Built from the REAL flagship flow rather than hand-rolled fixtures: these two
// decisions exist to be correct about the shipped step files, so a change to
// add_prescription_auto that breaks them should break this test.
const RX = addPrescriptionAutoSteps();
const idx = (id: string) => RX.findIndex(s => s.id === id);

const step = (over: Partial<WalkthroughStep>): WalkthroughStep => ({
  id: over.id ?? "s",
  screen: { mode: "elderly", tab: "home" },
  selector: "#x",
  instructionKey: "k",
  ...over,
});

describe("computeHoldGate", () => {
  it("lets the opening click flow into the field it revealed", () => {
    // The bug this fixes: holding here left the spotlight on the "+ Add" pill
    // that the freshly-opened sheet had already covered.
    expect(computeHoldGate(RX, idx("autoRx.open"))).toBe(false);
  });

  it("collapses a run of consecutive field fills", () => {
    expect(computeHoldGate(RX, idx("autoRx.name"))).toBe(false);
    expect(computeHoldGate(RX, idx("autoRx.dose"))).toBe(false);
  });

  it("still gates the last field before the recap", () => {
    // autoRx.purpose is followed by the Confirm step, which fills nothing.
    expect(computeHoldGate(RX, idx("autoRx.purpose"))).toBe(true);
  });

  it("always gates a checkpoint, whatever its act was", () => {
    expect(computeHoldGate(RX, idx("autoRx.confirm"))).toBe(true);
    expect(computeHoldGate(RX, idx("autoRx.verify"))).toBe(true);
    expect(computeHoldGate([
      step({ id: "a", act: { kind: "fill", selector: "#a", value: "1" }, reveal: { screen: { mode: "elderly", tab: "home" }, selector: "#r" } }),
      step({ id: "b", act: { kind: "fill", selector: "#b", value: "2" } }),
    ], 0)).toBe(true);
  });

  it("gates when the next step navigates elsewhere", () => {
    const steps = [
      step({ id: "a", act: { kind: "click", selector: "#a" } }),
      step({ id: "b", onEnter: { mode: "elderly", tab: "settings" }, act: { kind: "fill", selector: "#b", value: "2" } }),
    ];
    expect(computeHoldGate(steps, 0)).toBe(true);
  });

  // Case 2 used to require the NEXT step to FILL, and this asserted the gate
  // held for click→click. Burial does not care what the next act is:
  // travel_mode_auto step 2 clicks the Travel Mode tile, the sheet slides up
  // over it, and step 3 clicks the sheet's own toggle — so the run parked with
  // its spotlight on a tile behind the sheet's backdrop, measured by the
  // geometry sweep as `travel_mode_auto#2 target-occluded`. Deliberate contract
  // change, 2026-08-08.
  it("does NOT gate a click followed by another act — the click opened a surface the next step works in", () => {
    const steps = [
      step({ id: "a", act: { kind: "click", selector: "#a" } }),
      step({ id: "b", act: { kind: "click", selector: "#b" } }),
    ];
    expect(computeHoldGate(steps, 0)).toBe(false);
  });

  it("still gates a click followed by a step with NO act — nothing has moved on", () => {
    // A bare reveal/waitFor after a click: the spotlight is still describing
    // this step, so holding is right.
    const steps = [
      step({ id: "a", act: { kind: "click", selector: "#a" } }),
      step({ id: "b" }),
    ];
    expect(computeHoldGate(steps, 0)).toBe(true);
  });

  // The fast-forward toggle (Auto / Step by step) has to actually change what
  // happens, not just its own label. Measured live before this split: with Auto
  // OFF the run still walked Step 1 -> Step 4 on its own, because the field-run
  // collapse ignored the toggle entirely.
  it("stops collapsing a field run once the person asks for step by step", () => {
    expect(computeHoldGate(RX, idx("autoRx.name"), false)).toBe(true);
    expect(computeHoldGate(RX, idx("autoRx.dose"), false)).toBe(true);
  });

  it("still lets the opening click flow into its field with Auto off", () => {
    // Case 2 is a correctness fix, not a tap-saving one: holding here leaves
    // the spotlight on a control the newly-opened sheet has already buried,
    // which is just as wrong in step-by-step mode.
    expect(computeHoldGate(RX, idx("autoRx.open"), false)).toBe(false);
  });

  it("defaults to Auto when the caller says nothing", () => {
    expect(computeHoldGate(RX, idx("autoRx.name"))).toBe(computeHoldGate(RX, idx("autoRx.name"), true));
  });

  it("never lets Auto weaken a checkpoint", () => {
    // The Confirm recap and the real Save gate for everyone, in both modes —
    // this is the line nothing commits without a tap depends on.
    expect(computeHoldGate(RX, idx("autoRx.confirm"), true)).toBe(true);
    expect(computeHoldGate(RX, idx("autoRx.confirm"), false)).toBe(true);
  });

  it("gates the last step, which has no next", () => {
    expect(computeHoldGate(RX, RX.length - 1)).toBe(true);
  });
});

describe("canGoBack", () => {
  it("refuses at the first step", () => {
    expect(canGoBack(RX, 0)).toBe(false);
  });

  it("refuses back into a click act, which would re-fire it", () => {
    // autoRx.name's predecessor is the "+ Add" click — re-running it would
    // open a second sheet.
    expect(canGoBack(RX, idx("autoRx.name"))).toBe(false);
  });

  it("allows back across field fills and into the recap", () => {
    expect(canGoBack(RX, idx("autoRx.dose"))).toBe(true);
    expect(canGoBack(RX, idx("autoRx.purpose"))).toBe(true);
    expect(canGoBack(RX, idx("autoRx.confirm"))).toBe(true);
    expect(canGoBack(RX, idx("autoRx.submit"))).toBe(true);
  });

  it("refuses once the real Save has committed", () => {
    // autoRx.submit is a waitFor followed by a verify tail — that pair is the
    // commit boundary, and nothing here can undo the row it wrote.
    expect(canGoBack(RX, idx("autoRx.verify"))).toBe(false);
  });

  it("refuses anywhere after a step that verified", () => {
    const steps = [
      step({ id: "a", act: { kind: "fill", selector: "#a", value: "1" }, verify: { kind: "travel-plan-saved" } }),
      step({ id: "b", act: { kind: "fill", selector: "#b", value: "2" } }),
      step({ id: "c", act: { kind: "fill", selector: "#c", value: "3" } }),
    ];
    expect(canGoBack(steps, 1)).toBe(false);
    expect(canGoBack(steps, 2)).toBe(false);
  });

  it("refuses an out-of-range index", () => {
    expect(canGoBack(RX, RX.length)).toBe(false);
    expect(canGoBack(RX, -1)).toBe(false);
  });
});
