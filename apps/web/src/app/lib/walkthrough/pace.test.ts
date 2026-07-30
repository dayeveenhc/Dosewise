import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaceController } from "./pace";
import { onWalkthroughEvent, WALK_PHASE_EVENT } from "./bus";
import { readPhaseLog, resetPhaseLog } from "./phaseLog";

// The pacing contract every walkthrough wait depends on: paced() floors each
// phase at its minimum (the minimums ARE the auto pace), Next can only shorten
// what lies beyond a minimum, and real work (a verify re-query) is never cut
// short — so the engine can neither rush an elderly user nor fake a result.

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
