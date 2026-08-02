// PaceController: the one mechanism every walkthrough wait flows through.
// paced(phase, minMs, work?) starts the optional work immediately and resolves
// at max(minMs, work time) — the PACING minimums are FLOORS on how fast a phase
// may look, not a self-driving clock. A step never advances on its own: after
// its last phase, the orchestrator holds on awaitNext() until the person taps.
//
// requestNext() (the callout's Next button) means two things depending on when
// it lands, and both are honest:
//   - before the current phase's minimum: ignored outright.
//   - during a phase, after its minimum: sets a fastForward flag that ends the
//     remaining dwell immediately and makes in-flight typing complete instantly
//     (the actor checks shouldFastForward() per character) — but a still-running
//     work promise is NEVER resolved early: a running verify keeps "checking…"
//     until its real result. Cooperative work (typing, dwell()) may finish
//     itself early; nothing is ever faked.
//   - at the terminal awaitNext() gate: commits the step and moves on.
// The two are kept separate by `nextRequested`, so one tap can never do both.
//
// Every paced() call records a phase-log entry (phaseLog.ts) automatically, so
// instrumentation cannot drift from behaviour. Phase transitions + canAdvance
// are published on the walkthrough bus (WALK_PHASE_EVENT) for the overlay UI.

import { emitWalkthroughEvent, WALK_PHASE_EVENT } from "./bus";
import { recordPhase } from "./phaseLog";

export interface PacePhaseState {
  phase: string | null;
  canAdvance: boolean;
}

export interface PaceController {
  paced<T>(phase: string, minMs: number, work?: () => Promise<T>): Promise<T | undefined>;
  // A cooperative dwell for use as paced() work: sleeps ms but ends early on
  // fastForward (Next after the phase min), replay, or cancel.
  dwell(ms: number): Promise<void>;
  // The terminal commit gate. Holds on `phase` with canAdvance=true until the
  // person taps Next (or the run is cancelled) — there is NO timer, so an
  // autonomous step can never advance on its own.
  awaitNext(phase: string): Promise<void>;
  requestNext(): void;
  // Replay (reveal phase only): re-run the reveal + its dwell. Consumed by the
  // orchestrator's reveal loop after each paced("reveal", …) completes.
  requestReplay(): void;
  consumeReplay(): boolean;
  shouldFastForward(): boolean;
  onPhase(cb: (state: PacePhaseState) => void): () => void;
  cancel(): void;
  state(): PacePhaseState;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function createPaceController(ctx?: { task?: string; stepId?: string }): PaceController {
  let phase: string | null = null;
  let canAdvance = false;
  let fastForward = false;
  let replayRequested = false;
  let cancelled = false;
  // Distinct from fastForward on purpose: a Next that merely SHORTENED the
  // reveal dwell must not also satisfy the commit gate that follows it, or the
  // step would advance on one tap and the gate would be invisible.
  let nextRequested = false;
  const listeners = new Set<(s: PacePhaseState) => void>();
  // Pending interruptible sleeps, woken on requestNext/requestReplay/cancel so
  // a dwell can end the moment the user acts instead of on its next tick.
  const waiters = new Set<() => void>();

  const state = (): PacePhaseState => ({ phase, canAdvance });

  const publish = () => {
    const s = state();
    for (const cb of listeners) cb(s);
    emitWalkthroughEvent(WALK_PHASE_EVENT, s);
  };

  const wakeAll = () => {
    for (const wake of [...waiters]) wake();
  };

  // Sleep ms, resolving early the moment wakeEarly() turns true (checked on
  // every wakeAll). Cancellation always wakes it.
  const interruptibleSleep = (ms: number, wakeEarly: () => boolean): Promise<void> =>
    new Promise<void>(resolve => {
      if (cancelled || wakeEarly()) return resolve();
      let timer: ReturnType<typeof setTimeout>;
      const waiter = () => {
        if (cancelled || wakeEarly()) done();
      };
      const done = () => {
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve();
      };
      timer = setTimeout(done, ms);
      waiters.add(waiter);
    });

  return {
    async paced<T>(phaseName: string, minMs: number, work?: () => Promise<T>): Promise<T | undefined> {
      if (cancelled) return undefined;
      phase = phaseName;
      canAdvance = false;
      fastForward = false;
      nextRequested = false;
      publish();
      const startedAt = now();
      const workPromise = work?.();
      // The minimum is a hard floor: only cancel can cut it, never Next.
      await interruptibleSleep(minMs, () => false);
      if (!cancelled) {
        canAdvance = true;
        publish();
      }
      let result: T | undefined;
      if (workPromise) result = await workPromise;
      recordPhase({
        surface: "walkthrough",
        task: ctx?.task,
        stepId: ctx?.stepId,
        phase: phaseName,
        minMs,
        startedAt,
        endedAt: now(),
      });
      return result;
    },

    dwell(ms: number): Promise<void> {
      return interruptibleSleep(ms, () => fastForward || replayRequested);
    },

    awaitNext(phaseName: string): Promise<void> {
      if (cancelled) return Promise.resolve();
      phase = phaseName;
      canAdvance = true; // the gate is open the moment it starts — Next enables
      fastForward = false;
      nextRequested = false;
      publish();
      const startedAt = now();
      const record = () =>
        recordPhase({
          surface: "walkthrough",
          task: ctx?.task,
          stepId: ctx?.stepId,
          phase: phaseName,
          minMs: 0, // the wait is the person's, not a paced floor
          startedAt,
          endedAt: now(),
        });
      // Deliberately NOT interruptibleSleep with a huge duration: browsers clamp
      // setTimeout delays above 2^31-1 ms to ~1ms, which would make the gate
      // resolve instantly. A timer-less waiter can only be woken by
      // requestNext()/cancel() via wakeAll().
      return new Promise<void>(resolve => {
        const done = () => {
          waiters.delete(waiter);
          record();
          resolve();
        };
        const waiter = () => {
          if (cancelled || nextRequested) done();
        };
        waiters.add(waiter);
      });
    },

    requestNext(): void {
      // Ignored before the phase minimum — Next can never rush below the floor.
      if (!canAdvance || cancelled) return;
      fastForward = true;
      nextRequested = true;
      wakeAll();
    },

    requestReplay(): void {
      // Only meaningful while the reveal dwell is on screen; extends viewing,
      // so unlike Next it isn't gated on the minimum having elapsed.
      if (phase !== "reveal" || cancelled) return;
      replayRequested = true;
      wakeAll();
    },

    consumeReplay(): boolean {
      if (!replayRequested || cancelled) return false;
      replayRequested = false;
      return true;
    },

    shouldFastForward(): boolean {
      return fastForward;
    },

    onPhase(cb: (s: PacePhaseState) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    cancel(): void {
      cancelled = true;
      phase = null;
      canAdvance = false;
      publish();
      wakeAll();
      listeners.clear();
    },

    state,
  };
}
