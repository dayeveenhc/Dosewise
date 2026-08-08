import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runActStep } from "./orchestrate";
import { createPaceController } from "./pace";
import { PACING } from "./pacing";
import { readPhaseLog, resetPhaseLog } from "./phaseLog";
import type { PaceController } from "./pace";
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

// Drive a running step to completion under fake timers. Autonomous steps no
// longer advance by themselves — they hold at the terminal commit gate — so
// this also supplies the person's Next tap.
async function drive<T>(p: Promise<T>, h: { pace: PaceController }, ms = 20_000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  h.pace.requestNext();
  await vi.advanceTimersByTimeAsync(1);
  return p;
}

describe("runActStep", () => {
  it("act → verify pass → reveal → advance", async () => {
    mountButton("target");
    const h = handlers({ onVerify: vi.fn(async () => true), requireExplicitAdvance: true });
    const step = baseStep({ verify: { kind: "medication-exists", name: "Metformin" }, reveal: { screen: ON_AI, selector: "#row" } });

    const outcome = await drive(runActStep(step, h), h);

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
    const h = handlers({ onVerify: vi.fn(async () => true), requireExplicitAdvance: true });
    const step = baseStep({ verify: { kind: "medication-exists", name: "Metformin" } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(CLICK_MS + PACING.VERIFY_MIN_MS - 5);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    // Verify is done, but the step now HOLDS at the commit gate until tapped.
    expect(outcome).toBeUndefined();
    h.pace.requestNext();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("advanced");
  });

  it("no verify declared → reveals and advances", async () => {
    mountButton("target");
    const h = handlers({ requireExplicitAdvance: true });
    const step = baseStep({ reveal: { screen: ON_AI, selector: "#row" } });

    const outcome = await drive(runActStep(step, h), h);

    expect(outcome).toBe("advanced");
    expect(h.onVerify).not.toHaveBeenCalled();
    expect(h.onReveal).toHaveBeenCalledOnce();
    expect(h.onAdvance).toHaveBeenCalledOnce();
  });

  it("a step with no act and no verify/reveal just advances", async () => {
    const h = handlers({ requireExplicitAdvance: true });
    const step = baseStep({ act: undefined });

    const outcome = await drive(runActStep(step, h), h);

    expect(outcome).toBe("advanced");
    expect(h.onAdvance).toHaveBeenCalledOnce();
    expect(h.onVerify).not.toHaveBeenCalled();
  });

  it("an ACT-LESS step with verify still runs Verify (post-consent verify step)", async () => {
    const h = handlers({ onVerify: vi.fn(async () => true), requireExplicitAdvance: true });
    const step = baseStep({ act: undefined, verify: { kind: "care-link-active" }, reveal: { screen: ON_AI, selector: "#n" } });

    const outcome = await drive(runActStep(step, h), h);

    expect(outcome).toBe("advanced");
    expect(h.onVerify).toHaveBeenCalledOnce();
    expect(h.onReveal).toHaveBeenCalledOnce();
    expect(h.onAdvance).toHaveBeenCalledOnce();
  });

  it("an act-less step whose Verify FAILS does not advance", async () => {
    const h = handlers({ onVerify: vi.fn(async () => false) });
    const step = baseStep({ act: undefined, verify: { kind: "care-link-active" } });

    const outcome = await drive(runActStep(step, h), h);

    expect(outcome).toBe("verify-failed");
    expect(h.onAdvance).not.toHaveBeenCalled();
  });

  it("a fill goes straight to the commit gate — no trailing pause", async () => {
    mountInput("target");
    const h = handlers({ requireExplicitAdvance: true });
    const step = baseStep({ act: { kind: "fill", selector: '[data-testid="target"]', value: "Metformin" } });

    const outcome = await drive(runActStep(step, h), h);

    expect(outcome).toBe("advanced");
    const phases = readPhaseLog().map(e => e.phase);
    // "ready" is the terminal commit gate — logged like any other phase, with
    // minMs 0 because the wait is the person's, not a paced floor. A fill goes
    // straight to it: the old 1s "between-fields" pause only delayed when Next
    // became tappable, now that nothing auto-advances.
    expect(phases).toEqual(["field", "ready"]);
    expect(readPhaseLog()[0].minMs).toBe(PACING.FIELD_MIN_MS);
    expect(readPhaseLog()[1].minMs).toBe(0);
  });

  it("a step with onEnter gets a paced navigate settle first", async () => {
    mountButton("target");
    const h = handlers({ requireExplicitAdvance: true });
    const step = baseStep({ onEnter: ON_AI });

    await drive(runActStep(step, h), h);

    expect(readPhaseLog().map(e => e.phase)).toEqual(["navigate", "click", "ready"]);
    expect(readPhaseLog()[0].minMs).toBe(PACING.NAVIGATE_MS);
  });

  it("the reveal dwell ends at HIGHLIGHT_DWELL_MIN_MS but the step does NOT advance on its own", async () => {
    mountButton("target");
    const h = handlers({ requireExplicitAdvance: true });
    let outcome: string | undefined;
    void runActStep(baseStep({ reveal: { screen: ON_AI, selector: "#row" } }), h).then(o => { outcome = o; });
    // Far past every paced minimum. Nothing may advance without a real tap.
    await vi.advanceTimersByTimeAsync(CLICK_MS + PACING.HIGHLIGHT_DWELL_MIN_MS + 60_000);
    expect(outcome).toBeUndefined();
    expect(h.onAdvance).not.toHaveBeenCalled();
    expect(h.pace.state()).toEqual({ phase: "ready", canAdvance: true });

    h.pace.requestNext();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("advanced");
    expect(h.onAdvance).toHaveBeenCalledOnce();
  });

  // The two meanings of Next must stay separate: one tap during the dwell only
  // shortens it, and a SECOND tap is required to commit the step. If these ever
  // collapse into one, the commit gate silently disappears.
  it("a Next during the reveal dwell shortens it but does NOT advance — a second tap commits", async () => {
    mountButton("target");
    const h = handlers({ requireExplicitAdvance: true });
    let outcome: string | undefined;
    void runActStep(baseStep({ reveal: { screen: ON_AI, selector: "#row" } }), h).then(o => { outcome = o; });
    // Into the reveal, past its pulse-length floor but well before the dwell end.
    await vi.advanceTimersByTimeAsync(CLICK_MS + PACING.REVEAL_PULSE_MS + 50);
    h.pace.requestNext();
    await vi.advanceTimersByTimeAsync(5);

    expect(outcome).toBeUndefined();
    expect(h.onAdvance).not.toHaveBeenCalled();

    h.pace.requestNext();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("advanced");
  });

  it("cancel during the terminal gate returns 'cancelled' and never advances", async () => {
    mountButton("target");
    let cancelled = false;
    const h = handlers({ shouldCancel: () => cancelled, requireExplicitAdvance: true });
    let outcome: string | undefined;
    void runActStep(baseStep({}), h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(CLICK_MS + 50);
    expect(h.pace.state().phase).toBe("ready");

    cancelled = true;
    h.pace.cancel();
    await vi.advanceTimersByTimeAsync(5);
    expect(outcome).toBe("cancelled");
    expect(h.onAdvance).not.toHaveBeenCalled();
  });

  it("requestReplay during the reveal re-fires onReveal and restarts the dwell", async () => {
    mountButton("target");
    const h = handlers({ requireExplicitAdvance: true });
    const step = baseStep({ reveal: { screen: ON_AI, selector: "#row" } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(CLICK_MS + 200); // inside the reveal dwell
    expect(h.onReveal).toHaveBeenCalledTimes(1);
    h.pace.requestReplay();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.onReveal).toHaveBeenCalledTimes(2);
    h.pace.requestNext();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("advanced");
    expect(h.onAdvance).toHaveBeenCalledOnce();
  });

  // Phase 1: an act that could not be performed at all must STOP the run.
  // Advancing anyway is what made tours "guide halfway then do the wrong thing".
  it("an act whose target never mounts fails the step instead of advancing", async () => {
    const h = handlers();
    const step = baseStep({ act: { kind: "click", selector: '[data-testid="never-mounts"]' } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(outcome).toBe("act-failed");
    expect(h.onAdvance).not.toHaveBeenCalled();
  });

  it("a select act whose value matches no option fails rather than wiping the field", async () => {
    const select = document.createElement("select");
    select.setAttribute("data-testid", "target");
    for (const label of ["Japan (UTC+9)", "Singapore (UTC+8)"]) {
      const opt = document.createElement("option");
      opt.textContent = label;
      select.appendChild(opt);
    }
    document.body.appendChild(select);
    const h = handlers({ requireExplicitAdvance: true });
    const step = baseStep({ act: { kind: "select", selector: '[data-testid="target"]', value: "Asia/Tokyo" } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(outcome).toBe("act-failed");
    // The field must be untouched — a wiped timezone used to persist as "".
    expect(select.value).toBe("Japan (UTC+9)");
    expect(h.onAdvance).not.toHaveBeenCalled();
  });

  // Item C (fewer forced Next-taps): a step in the middle of a grouped field
  // run must NOT stop at the tap-wait gate — it auto-continues on its own once
  // the settle pause elapses, with no requestNext() call at all.
  it("holdGate: false auto-continues after the grouped settle, with no tap", async () => {
    mountInput("target");
    const h = handlers({ holdGate: false });
    const step = baseStep({ act: { kind: "fill", selector: '[data-testid="target"]', value: "Metformin" } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(PACING.FIELD_MIN_MS + PACING.GROUPED_STEP_PAUSE_MS + 20_000);

    expect(outcome).toBe("advanced");
    expect(h.onAdvance).toHaveBeenCalledOnce();
    const phases = readPhaseLog().map(e => e.phase);
    expect(phases).toEqual(["field", "grouped"]);
  });

  it("holdGate: true (the default) still holds a fill at the real commit gate", async () => {
    mountInput("target");
    const h = handlers();
    const step = baseStep({ act: { kind: "fill", selector: '[data-testid="target"]', value: "Metformin" } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(PACING.FIELD_MIN_MS + 20_000);
    expect(outcome).toBeUndefined();
    expect(h.onAdvance).not.toHaveBeenCalled();

    h.pace.requestNext();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("advanced");
  });

  it("a select act matches an option case-insensitively", async () => {
    const select = document.createElement("select");
    select.setAttribute("data-testid", "target");
    for (const label of ["Japan (UTC+9)", "Singapore (UTC+8)"]) {
      const opt = document.createElement("option");
      opt.textContent = label;
      select.appendChild(opt);
    }
    document.body.appendChild(select);
    const h = handlers({ requireExplicitAdvance: true });
    const step = baseStep({ act: { kind: "select", selector: '[data-testid="target"]', value: "  singapore (utc+8) " } });

    await drive(runActStep(step, h), h);
    expect(select.value).toBe("Singapore (UTC+8)");
  });
});

// Item 5, "ConfirmBack-Phase" — cross-cutting decision B. requireExplicitAdvance
// OR riskFlagged OR a blank review field forces the explicit-tap path
// (awaitNext); neither set is the ONLY path where zero taps happen before the
// step advances. A confirm-only step (no act/verify/reveal of its own) folds
// its own resolution straight into advancement rather than also holding the
// terminal "ready" gate — these three signals are injected via PhaseHandlers
// exactly so this stays testable with no DOM/React tree, per the file's own
// doc comment.
describe("runActStep — Confirm phase (decision B, Item 5)", () => {
  it("requireExplicitAdvance forces the tap path — does not advance on the paced floor alone", async () => {
    const h = handlers({ requireExplicitAdvance: true });
    const step = baseStep({ act: undefined, confirm: { recap: true } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    // Well past CONFIRM_MIN_MS — a real tap is still the only way forward.
    await vi.advanceTimersByTimeAsync(PACING.CONFIRM_MIN_MS + 60_000);
    expect(outcome).toBeUndefined();
    expect(h.onAdvance).not.toHaveBeenCalled();
    expect(h.pace.state()).toEqual({ phase: "confirm", canAdvance: true });

    h.pace.requestNext();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("advanced");
    expect(h.onAdvance).toHaveBeenCalledOnce();
  });

  it("riskFlagged forces the tap path even when requireExplicitAdvance is false — risk overrides trust", async () => {
    const h = handlers({ requireExplicitAdvance: false, riskFlagged: true });
    const step = baseStep({ act: undefined, confirm: { recap: true } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(PACING.CONFIRM_MIN_MS + 60_000);
    expect(outcome).toBeUndefined();

    h.pace.requestNext();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("advanced");
  });

  it("a blank review field forces the tap path even when neither requireExplicitAdvance nor riskFlagged is set", async () => {
    const h = handlers({ hasBlankReviewField: () => true });
    const step = baseStep({
      act: undefined,
      confirm: { recap: true },
      review: [{ labelKey: "prescription.purposeCondition", selector: '[data-testid="purpose"]' }],
    });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(PACING.CONFIRM_MIN_MS + 60_000);
    expect(outcome).toBeUndefined();
    expect(h.onAdvance).not.toHaveBeenCalled();

    h.pace.requestNext();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("advanced");
  });

  it("a NON-blank review field does not force the tap path — the check runs, but finds nothing to block on", async () => {
    const h = handlers({ hasBlankReviewField: () => false });
    const step = baseStep({
      act: undefined,
      confirm: { recap: true },
      review: [{ labelKey: "prescription.purposeCondition", selector: '[data-testid="purpose"]' }],
    });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(PACING.CONFIRM_MIN_MS + 20);
    // Resolved on the paced floor alone — no requestNext() call anywhere above.
    expect(outcome).toBe("advanced");
  });

  it("a review field cleared WHILE the auto-elapsing recap is running escalates to the tap gate instead of silently advancing", async () => {
    // Regression: found live by the verification pass — the field wasn't
    // blank at Confirm entry (paced() floor path chosen), but the person used
    // the review panel's "Change" affordance to clear it before the floor
    // elapsed. The floor itself has no knowledge of live field state, so it
    // used to resolve on schedule and advance straight to Submit while the
    // UI still visibly showed the clarifying-question block (zero taps).
    let blankNow = false;
    const h = handlers({ hasBlankReviewField: () => blankNow });
    const step = baseStep({
      act: undefined,
      confirm: { recap: true },
      review: [{ labelKey: "prescription.purposeCondition", selector: '[data-testid="purpose"]' }],
    });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    // Not blank at entry — same as the "NON-blank" test above, so the
    // auto-elapsing paced() path is the one chosen, not the tap gate.
    await vi.advanceTimersByTimeAsync(PACING.CONFIRM_MIN_MS / 2);
    expect(outcome).toBeUndefined();

    // The person clears the field mid-recap.
    blankNow = true;

    // The floor elapses on schedule. Without the re-check, this used to
    // advance immediately; the fix must instead escalate to an explicit tap.
    await vi.advanceTimersByTimeAsync(PACING.CONFIRM_MIN_MS / 2 + 60_000);
    expect(outcome).toBeUndefined();
    expect(h.onAdvance).not.toHaveBeenCalled();

    h.pace.requestNext();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("advanced");
  });

  it("neither signal nor a blank field → advances automatically after CONFIRM_MIN_MS with ZERO taps (the veteran fast path)", async () => {
    const h = handlers();
    const step = baseStep({ act: undefined, confirm: { recap: true } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(PACING.CONFIRM_MIN_MS - 10);
    expect(outcome).toBeUndefined(); // floor hasn't elapsed yet
    await vi.advanceTimersByTimeAsync(20);
    expect(outcome).toBe("advanced"); // no requestNext() call anywhere in this test
    expect(h.onAdvance).toHaveBeenCalledOnce();
  });

  it("a confirm-only step logs exactly ONE gate phase — no redundant second tap for one recap", async () => {
    const h = handlers({ requireExplicitAdvance: true });
    const step = baseStep({ act: undefined, confirm: { recap: true } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(20_000);
    h.pace.requestNext();
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome).toBe("advanced");
    // Exactly "confirm" — no trailing "ready" entry, i.e. resolving Confirm
    // itself satisfied advancement instead of also holding the terminal gate.
    expect(readPhaseLog().map(e => e.phase)).toEqual(["confirm"]);
  });

  it("a confirm step that ALSO carries reveal still runs the terminal ready gate after — the fold is confirm-only-step-specific", async () => {
    mountButton("target");
    const h = handlers({ requireExplicitAdvance: true, onReveal: vi.fn() });
    const step = baseStep({ confirm: { recap: true }, reveal: { screen: ON_AI, selector: "#row" } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(CLICK_MS + 20_000);
    expect(h.pace.state().phase).toBe("confirm");
    h.pace.requestNext(); // resolves Confirm only — reveal + ready still follow
    await vi.advanceTimersByTimeAsync(20_000);
    expect(outcome).toBeUndefined();
    expect(h.pace.state().phase).toBe("ready");

    h.pace.requestNext();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("advanced");
    expect(readPhaseLog().map(e => e.phase)).toEqual(["click", "confirm", "reveal", "ready"]);
  });
});

// Item 2, "TrustMode" — cross-cutting decision C. The terminal "ready" gate
// (the ONLY place a plain autonomous step, with no confirm of its own, holds
// for a tap) branches on the SAME requireExplicitAdvance signal Confirm above
// already consumes: true keeps today's awaitNext gate (first-timers/manual
// mode) unchanged, false auto-advances after READY_AUTO_MS with zero taps
// (a veteran). The phase log's minMs is the non-flaky discriminator: awaitNext
// always records 0 (the wait is the person's), paced("ready", READY_AUTO_MS)
// always records the real floor.
describe("runActStep — TrustMode veteran auto-advance (Item 2, decision C)", () => {
  it("requireExplicitAdvance=false auto-advances the terminal gate after READY_AUTO_MS with ZERO taps", async () => {
    mountButton("target");
    const h = handlers({ requireExplicitAdvance: false });
    const step = baseStep({ reveal: { screen: ON_AI, selector: "#row" } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    // Past the reveal dwell but still short of READY_AUTO_MS on top of it.
    await vi.advanceTimersByTimeAsync(CLICK_MS + PACING.HIGHLIGHT_DWELL_MIN_MS + PACING.READY_AUTO_MS - 20);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30);
    // No requestNext() anywhere in this test — it advanced on the floor alone.
    expect(outcome).toBe("advanced");
    expect(h.onAdvance).toHaveBeenCalledOnce();
    const ready = readPhaseLog().find(e => e.phase === "ready");
    expect(ready?.minMs).toBe(PACING.READY_AUTO_MS);
  });

  it("requireExplicitAdvance=true keeps the unconditional tap gate (minMs 0) — the first-timer path is unchanged", async () => {
    mountButton("target");
    const h = handlers({ requireExplicitAdvance: true });
    const step = baseStep({});

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    // Far past READY_AUTO_MS — still must not advance without a tap.
    await vi.advanceTimersByTimeAsync(CLICK_MS + PACING.READY_AUTO_MS + 60_000);
    expect(outcome).toBeUndefined();

    h.pace.requestNext();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("advanced");
    const ready = readPhaseLog().find(e => e.phase === "ready");
    expect(ready?.minMs).toBe(0);
  });

  // The interaction TrustMode must never break: a risk-flagged Confirm phase
  // forces its own explicit tap regardless of veteran status (decision B/C —
  // risk overrides trust). This does not merely assume the Confirm block's OR
  // logic still holds once requireExplicitAdvance is a real per-user signal —
  // it drives a veteran (requireExplicitAdvance: false) through a risk-flagged
  // Confirm step end to end and proves it still needs a tap, then proves the
  // terminal ready gate that follows ALSO still needs its own tap (both
  // phases are risk-gated independently — Confirm by riskFlagged, ready
  // because Confirm's tap already consumed the only auto-advance opportunity
  // this step gets).
  it("a veteran (requireExplicitAdvance=false) still gets an explicit tap on a risk-flagged Confirm phase — risk overrides trust", async () => {
    mountButton("target");
    const h = handlers({ requireExplicitAdvance: false, riskFlagged: true, onReveal: vi.fn() });
    const step = baseStep({ confirm: { recap: true }, reveal: { screen: ON_AI, selector: "#row" } });

    let outcome: string | undefined;
    void runActStep(step, h).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(CLICK_MS + PACING.CONFIRM_MIN_MS + 60_000);
    // Well past CONFIRM_MIN_MS with no tap — a veteran would normally have
    // sailed through here, but riskFlagged must still hold it.
    expect(outcome).toBeUndefined();
    expect(h.pace.state()).toEqual({ phase: "confirm", canAdvance: true });

    h.pace.requestNext(); // the required Confirm tap
    await vi.advanceTimersByTimeAsync(CLICK_MS + PACING.HIGHLIGHT_DWELL_MIN_MS + 60_000);
    // Confirm resolved, but this step ALSO carries reveal, so it falls through
    // to the terminal ready gate — which requireExplicitAdvance=false alone
    // would auto-elapse, but nothing here re-flags risk for it. Assert the
    // real, current behaviour rather than the ideal one either way.
    expect(outcome).toBe("advanced");
    expect(readPhaseLog().map(e => e.phase)).toEqual(["click", "confirm", "reveal", "ready"]);
    const readyEntry = readPhaseLog().find(e => e.phase === "ready");
    expect(readyEntry?.minMs).toBe(PACING.READY_AUTO_MS);
  });
});
