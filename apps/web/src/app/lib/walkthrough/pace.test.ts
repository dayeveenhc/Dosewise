import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaceController } from "./pace";
import { onWalkthroughEvent, WALK_PHASE_EVENT } from "./bus";
import { readPhaseLog, resetPhaseLog } from "./phaseLog";

// The pacing contract every walkthrough wait depends on: paced() floors each
// phase at its minimum, Next can only shorten what lies beyond a minimum, real
// work (a verify re-query) is never cut short, and awaitNext() holds the step
// indefinitely until the person taps — so the engine can neither rush an
// elderly user, advance without them, nor fake a result.

beforeEach(() => {
  vi.useFakeTimers();
  resetPhaseLog();
});

afterEach(() => {
  vi.useRealTimers();
});

// Track a promise's settlement without awaiting it (fake timers drive it).
function settledFlag<T>(p: Promise<T>): { done: boolean; value?: T } {
  const state: { done: boolean; value?: T } = { done: false };
  void p.then(v => {
    state.done = true;
    state.value = v;
  });
  return state;
}

describe("createPaceController — paced()", () => {
  it("never resolves before the minimum, even when the work is instant", async () => {
    const c = createPaceController();
    const s = settledFlag(c.paced("field", 500, async () => "done"));
    await vi.advanceTimersByTimeAsync(499);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(s.done).toBe(true);
    expect(s.value).toBe("done");
  });

  it("with no work, a phase auto-resolves exactly at its minimum", async () => {
    const c = createPaceController();
    const s = settledFlag(c.paced("between-fields", 500));
    await vi.advanceTimersByTimeAsync(499);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(s.done).toBe(true);
  });

  it("requestNext before the minimum is a no-op; after it, ends the dwell", async () => {
    const c = createPaceController();
    const s = settledFlag(c.paced("reveal", 300, () => c.dwell(2000)));
    await vi.advanceTimersByTimeAsync(100);
    c.requestNext(); // before min — ignored entirely
    expect(c.shouldFastForward()).toBe(false);
    await vi.advanceTimersByTimeAsync(300); // t=400: min passed, dwell still holding
    expect(s.done).toBe(false);
    c.requestNext(); // after min — ends the remaining dwell immediately
    await vi.advanceTimersByTimeAsync(1);
    expect(s.done).toBe(true);
  });

  it("NEVER resolves a still-running (non-cooperative) work promise early", async () => {
    const c = createPaceController();
    const s = settledFlag(
      c.paced("verify", 100, () => new Promise<boolean>(res => { setTimeout(() => res(true), 1500); })),
    );
    await vi.advanceTimersByTimeAsync(200);
    c.requestNext(); // min passed, but the verify keeps running to its real result
    await vi.advanceTimersByTimeAsync(1000); // t=1200
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(400); // t=1600 ≥ work's own 1500
    expect(s.done).toBe(true);
    expect(s.value).toBe(true);
  });

  it("publishes phase + canAdvance transitions (onPhase and the bus)", async () => {
    const c = createPaceController();
    const seen: { phase: string | null; canAdvance: boolean }[] = [];
    const offLocal = c.onPhase(st => seen.push(st));
    const busSeen: unknown[] = [];
    const offBus = onWalkthroughEvent(WALK_PHASE_EVENT, d => busSeen.push(d));

    const p = c.paced("field", 300);
    expect(c.state()).toEqual({ phase: "field", canAdvance: false });
    await vi.advanceTimersByTimeAsync(301);
    await p;
    expect(c.state()).toEqual({ phase: "field", canAdvance: true });
    expect(seen).toEqual([
      { phase: "field", canAdvance: false },
      { phase: "field", canAdvance: true },
    ]);
    expect(busSeen).toEqual(seen);
    offLocal();
    offBus();
  });

  it("records a phase-log entry for EVERY paced call, with the right minMs", async () => {
    const c = createPaceController({ task: "add_prescription_auto", stepId: "rx.name" });
    const p1 = c.paced("field", 900);
    await vi.advanceTimersByTimeAsync(901);
    await p1;
    const p2 = c.paced("between-fields", 500);
    await vi.advanceTimersByTimeAsync(501);
    await p2;

    const log = readPhaseLog();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({
      surface: "walkthrough", task: "add_prescription_auto", stepId: "rx.name",
      phase: "field", minMs: 900,
    });
    expect(log[1]).toMatchObject({ phase: "between-fields", minMs: 500 });
    for (const entry of log) expect(entry.endedAt).toBeGreaterThanOrEqual(entry.startedAt);
  });

  it("cancel() ends a pending minimum wait promptly", async () => {
    const c = createPaceController();
    const s = settledFlag(c.paced("reveal", 5000));
    await vi.advanceTimersByTimeAsync(100);
    c.cancel();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.done).toBe(true);
    expect(c.state()).toEqual({ phase: null, canAdvance: false });
  });
});

describe("createPaceController — replay", () => {
  it("requestReplay wakes the reveal dwell and is consumed exactly once", async () => {
    const c = createPaceController();
    const s = settledFlag(c.paced("reveal", 300, () => c.dwell(2000)));
    await vi.advanceTimersByTimeAsync(400);
    c.requestReplay();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.done).toBe(true); // dwell ended so the reveal can restart
    expect(c.consumeReplay()).toBe(true);
    expect(c.consumeReplay()).toBe(false); // one-shot
  });

  it("requestReplay outside the reveal phase is ignored", async () => {
    const c = createPaceController();
    const p = c.paced("field", 100);
    c.requestReplay();
    await vi.advanceTimersByTimeAsync(101);
    await p;
    expect(c.consumeReplay()).toBe(false);
  });
});

// The terminal commit gate. Autonomous walkthrough steps no longer advance on
// their own; awaitNext() is what holds them until the person is ready.
describe("createPaceController — awaitNext() (terminal commit gate)", () => {
  it("opens with canAdvance immediately so Next is tappable, and publishes the phase", async () => {
    const c = createPaceController();
    const seen: unknown[] = [];
    const off = onWalkthroughEvent(WALK_PHASE_EVENT, d => seen.push(d));
    settledFlag(c.awaitNext("ready"));
    expect(c.state()).toEqual({ phase: "ready", canAdvance: true });
    expect(seen).toContainEqual({ phase: "ready", canAdvance: true });
    off();
    c.cancel();
  });

  // Guards the setTimeout-clamp trap: browsers clamp delays above 2^31-1 ms to
  // ~1ms, so implementing the gate as a very long sleep would resolve at once.
  it("NEVER resolves on its own, no matter how much time passes", async () => {
    const c = createPaceController();
    const s = settledFlag(c.awaitNext("ready"));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(s.done).toBe(false);
    c.cancel();
  });

  it("resolves on requestNext()", async () => {
    const c = createPaceController();
    const s = settledFlag(c.awaitNext("ready"));
    await vi.advanceTimersByTimeAsync(10);
    expect(s.done).toBe(false);
    c.requestNext();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.done).toBe(true);
  });

  // The load-bearing separation: a Next that merely fast-forwarded the PREVIOUS
  // phase must not also satisfy the gate, or the whole gate vanishes on one tap.
  it("is NOT satisfied by a Next that fast-forwarded an earlier phase", async () => {
    const c = createPaceController();
    const paced = settledFlag(c.paced("reveal", 100, () => c.dwell(5_000)));
    await vi.advanceTimersByTimeAsync(150);
    c.requestNext(); // ends the dwell early
    await vi.advanceTimersByTimeAsync(5);
    expect(paced.done).toBe(true);

    const gate = settledFlag(c.awaitNext("ready"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gate.done).toBe(false);

    c.requestNext(); // the real commit tap
    await vi.advanceTimersByTimeAsync(1);
    expect(gate.done).toBe(true);
  });

  it("cancel() resolves the gate and leaves no phase", async () => {
    const c = createPaceController();
    const s = settledFlag(c.awaitNext("ready"));
    c.cancel();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.done).toBe(true);
    expect(c.state()).toEqual({ phase: null, canAdvance: false });
  });

  it("records a phase-log entry with minMs 0 — the wait is the person's", async () => {
    const c = createPaceController({ stepId: "t.step" });
    settledFlag(c.awaitNext("ready"));
    await vi.advanceTimersByTimeAsync(500);
    c.requestNext();
    await vi.advanceTimersByTimeAsync(1);
    const entry = readPhaseLog().find(e => e.phase === "ready");
    expect(entry).toBeDefined();
    expect(entry!.minMs).toBe(0);
    expect(entry!.stepId).toBe("t.step");
  });

  it("accepts requestReplay() at the open gate — it wakes the gate for the orchestrator to consume", async () => {
    const c = createPaceController();
    const gate = settledFlag(c.awaitNext("ready"));
    c.requestReplay(); // a Replay tap landing just after reveal→ready used to be dropped
    await vi.advanceTimersByTimeAsync(1);
    expect(gate.done).toBe(true);
    expect(c.consumeReplay()).toBe(true); // consumed by the loop → re-runs reveal, never advances
  });

  it("still ignores requestReplay() outside reveal/ready (e.g. confirm)", async () => {
    const c = createPaceController();
    const gate = settledFlag(c.awaitNext("confirm"));
    c.requestReplay();
    await vi.advanceTimersByTimeAsync(1);
    expect(gate.done).toBe(false);
    expect(c.consumeReplay()).toBe(false);
    c.cancel();
  });
});

// The FINAL step's timed gate (Item 5, 2026-08-09): open immediately like
// awaitNext, but self-resolving — the run closes itself once the window
// elapses, and Done/Replay/cancel all still work inside it.
describe("awaitNextOrTimeout", () => {
  it("self-resolves once the window elapses, with minMs 0 in the phase log", async () => {
    const c = createPaceController({ stepId: "t.final" });
    const gate = settledFlag(c.awaitNextOrTimeout("ready", 4_000));
    expect(c.state()).toEqual({ phase: "ready", canAdvance: true });
    await vi.advanceTimersByTimeAsync(3_900);
    expect(gate.done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(gate.done).toBe(true);
    const entry = readPhaseLog().find(e => e.phase === "ready");
    expect(entry!.minMs).toBe(0);
    expect(entry!.stepId).toBe("t.final");
  });

  it("requestNext() resolves it early — Done works from t=0", async () => {
    const c = createPaceController();
    const gate = settledFlag(c.awaitNextOrTimeout("ready", 60_000));
    c.requestNext();
    await vi.advanceTimersByTimeAsync(1);
    expect(gate.done).toBe(true);
  });

  it("requestReplay() wakes it, leaving the flag for the orchestrator", async () => {
    const c = createPaceController();
    const gate = settledFlag(c.awaitNextOrTimeout("ready", 60_000));
    c.requestReplay();
    await vi.advanceTimersByTimeAsync(1);
    expect(gate.done).toBe(true);
    expect(c.consumeReplay()).toBe(true);
  });

  it("cancel() resolves it", async () => {
    const c = createPaceController();
    const gate = settledFlag(c.awaitNextOrTimeout("ready", 60_000));
    c.cancel();
    await vi.advanceTimersByTimeAsync(1);
    expect(gate.done).toBe(true);
  });
});
