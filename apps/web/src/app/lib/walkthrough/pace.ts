// PaceController: the one mechanism every walkthrough wait flows through.
// paced(phase, minMs, work?) starts the optional work immediately and resolves
// at max(minMs, work time) — the PACING minimums ARE the auto pace, so an
// untouched walkthrough advances on them by itself.
//
// requestNext() (the callout's Next button):
//   - before the current phase's minimum: ignored outright.
//   - after it: sets a fastForward flag that ends the remaining dwell
//     immediately and makes in-flight typing complete instantly (the actor
//     checks shouldFastForward() per character) — but a still-running work
//     promise is NEVER resolved early: a running verify keeps "checking…"
//     until its real result. Cooperative work (typing, dwell()) may finish
//     itself early; nothing is ever faked.
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

    requestNext(): void {
      // Ignored before the phase minimum — Next can never rush below the floor.
      if (!canAdvance || cancelled) return;
      fastForward = true;
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
