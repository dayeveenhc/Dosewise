import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runActStep } from "./orchestrate";
import { createPaceController } from "./pace";
import { PACING } from "./pacing";
import { readPhaseLog, resetPhaseLog } from "./phaseLog";
import type { WalkthroughStep } from "./types";

// The safety-critical guarantee: a failed Verify STOPS the step — it must not
// Reveal and must not advance, so the walkthrough can never imply a success it
// couldn't prove against real re-queried state. Plus the pacing sequence: every
// wait flows through the step's PaceController against the PACING minimums.
// Fake timers throughout — a real run of one step takes seconds by design.

const ON_AI = { mode: "elderly", tab: "ai" } as const;

// A click act's duration: the PRE_CLICK pre-highlight window plus the actor's
// engine-local 280+180 press animation.
const CLICK_MS = PACING.PRE_CLICK_MS + 280 + 180;

// A minimal act target so performAct resolves (it clicks a real DOM button).
function mountButton(id: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.setAttribute("data-testid", id);
  document.body.appendChild(btn);
  return btn;
}

function mountInput(id: string): HTMLInputElement {
  const input = document.createElement("input");
  input.setAttribute("data-testid", id);
  document.body.appendChild(input);
  return input;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetPhaseLog();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function baseStep(overrides: Partial<WalkthroughStep>): WalkthroughStep {
  return {
    id: "t.step",
    screen: ON_AI,
    selector: '[data-testid="target"]',
    instructionKey: "walk.exit",
    act: { kind: "click", selector: '[data-testid="target"]' },
    ...overrides,
  };
}

function handlers(over: Partial<Parameters<typeof runActStep>[1]> = {}) {
  return {
    pace: createPaceController({ stepId: "t.step" }),
    onVerify: vi.fn(async () => true),
    onReveal: vi.fn(),
    onNavigate: vi.fn(),
    onAdvance: vi.fn(),
    shouldCancel: () => false,
    ...over,
  };
}

// Drive a running step to completion under fake timers.
async function drive<T>(p: Promise<T>, ms = 20_000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

describe("runActStep", () => {
  it("act → verify pass → reveal → advance", async () => {
    mountButton("target");
    const h = handlers({ onVerify: vi.fn(async () => true) });
    const step = baseStep({ verify: { kind: "medication-exists", name: "Metformin" }, reveal: { screen: ON_AI, selector: "#row" } });

    const outcome = await drive(runActStep(step, h));

    expect(outcome).toBe("advanced");
    expect(h.onVerify).toHaveBeenCalledOnce();
    expect(h.onReveal).toHaveBeenCalledOnce();
    expect(h.onAdvance).toHaveBeenCalledOnce();
  });

  it("act → verify FAIL → does NOT reveal, does NOT advance — and stops with no dwell", async () => {
    mountButton("target");
    const h = handlers({ onVerify: vi.fn(async () => false) });
    const step = baseStep({ verify: { kind: "medication-exists", name: "Ghost" }, reveal: { screen: ON_AI, selector: "#row" } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    // Click act + the verify minimum — the honest error must show right then,
    // with no reveal dwell tacked on after the failure.
    await vi.advanceTimersByTimeAsync(CLICK_MS + PACING.VERIFY_MIN_MS + 5);
    expect(outcome).toBe("verify-failed");
    expect(h.onReveal).not.toHaveBeenCalled();
    expect(h.onAdvance).not.toHaveBeenCalled();
  });

  it("even an instant verify keeps the 'checking…' phase up for VERIFY_MIN_MS", async () => {
    mountButton("target");
    const h = handlers({ onVerify: vi.fn(async () => true) });
    const step = baseStep({ verify: { kind: "medication-exists", name: "Metformin" } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(CLICK_MS + PACING.VERIFY_MIN_MS - 5);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    expect(outcome).toBe("advanced");
  });

  it("no verify declared → reveals and advances", async () => {
    mountButton("target");
    const h = handlers();
    const step = baseStep({ reveal: { screen: ON_AI, selector: "#row" } });

    const outcome = await drive(runActStep(step, h));

    expect(outcome).toBe("advanced");
    expect(h.onVerify).not.toHaveBeenCalled();
    expect(h.onReveal).toHaveBeenCalledOnce();
    expect(h.onAdvance).toHaveBeenCalledOnce();
  });

  it("a step with no act and no verify/reveal just advances", async () => {
    const h = handlers();
    const step = baseStep({ act: undefined });

    const outcome = await drive(runActStep(step, h));

    expect(outcome).toBe("advanced");
    expect(h.onAdvance).toHaveBeenCalledOnce();
    expect(h.onVerify).not.toHaveBeenCalled();
  });

  it("an ACT-LESS step with verify still runs Verify (post-consent verify step)", async () => {
    const h = handlers({ onVerify: vi.fn(async () => true) });
    const step = baseStep({ act: undefined, verify: { kind: "care-link-active" }, reveal: { screen: ON_AI, selector: "#n" } });

    const outcome = await drive(runActStep(step, h));

    expect(outcome).toBe("advanced");
    expect(h.onVerify).toHaveBeenCalledOnce();
    expect(h.onReveal).toHaveBeenCalledOnce();
    expect(h.onAdvance).toHaveBeenCalledOnce();
  });

  it("an act-less step whose Verify FAILS does not advance", async () => {
    const h = handlers({ onVerify: vi.fn(async () => false) });
    const step = baseStep({ act: undefined, verify: { kind: "care-link-active" } });

    const outcome = await drive(runActStep(step, h));

    expect(outcome).toBe("verify-failed");
    expect(h.onAdvance).not.toHaveBeenCalled();
  });

  it("a fill with no verify/reveal gets the between-fields pause (another field follows)", async () => {
    mountInput("target");
    const h = handlers();
    const step = baseStep({ act: { kind: "fill", selector: '[data-testid="target"]', value: "Metformin" } });

    const outcome = await drive(runActStep(step, h));

    expect(outcome).toBe("advanced");
    const phases = readPhaseLog().map(e => e.phase);
    expect(phases).toEqual(["field", "between-fields"]);
    expect(readPhaseLog()[0].minMs).toBe(PACING.FIELD_MIN_MS);
    expect(readPhaseLog()[1].minMs).toBe(PACING.BETWEEN_FIELDS_MS);
  });

  it("a step with onEnter gets a paced navigate settle first", async () => {
    mountButton("target");
    const h = handlers();
    const step = baseStep({ onEnter: ON_AI });

    await drive(runActStep(step, h));

    expect(readPhaseLog().map(e => e.phase)).toEqual(["navigate", "click"]);
    expect(readPhaseLog()[0].minMs).toBe(PACING.NAVIGATE_MS);
  });

  it("reveal dwell auto-advances at HIGHLIGHT_DWELL_MIN_MS; Next (after the pulse floor) cuts it short", async () => {
    mountButton("target");
    const auto = handlers();
    let autoOutcome: string | undefined;
    void runActStep(baseStep({ reveal: { screen: ON_AI, selector: "#row" } }), auto).then(o => { autoOutcome = o; });
    await vi.advanceTimersByTimeAsync(CLICK_MS + PACING.HIGHLIGHT_DWELL_MIN_MS - 5);
    expect(autoOutcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    expect(autoOutcome).toBe("advanced");

    document.body.innerHTML = "";
    mountButton("target");
    const fast = handlers();
    let fastOutcome: string | undefined;
    void runActStep(baseStep({ reveal: { screen: ON_AI, selector: "#row" } }), fast).then(o => { fastOutcome = o; });
    // Into the reveal, past its pulse-length minimum but well before the auto dwell.
    await vi.advanceTimersByTimeAsync(CLICK_MS + PACING.REVEAL_PULSE_MS + 50);
    fast.pace.requestNext();
    await vi.advanceTimersByTimeAsync(5);
    expect(fastOutcome).toBe("advanced");
  });

  it("requestReplay during the reveal re-fires onReveal and restarts the dwell", async () => {
    mountButton("target");
    const h = handlers();
    const step = baseStep({ reveal: { screen: ON_AI, selector: "#row" } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(CLICK_MS + 200); // inside the reveal dwell
    expect(h.onReveal).toHaveBeenCalledTimes(1);
    h.pace.requestReplay();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.onReveal).toHaveBeenCalledTimes(2);
    expect(outcome).toBe("advanced");
    expect(h.onAdvance).toHaveBeenCalledOnce();
  });
});
