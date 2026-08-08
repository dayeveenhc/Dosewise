// The two step-SHAPE decisions the walkthrough overlay makes about a step
// before it runs: may this step auto-continue instead of holding the terminal
// Next gate (computeHoldGate), and may the person step BACK from it
// (canGoBack). Pure and unit tested (gating.test.ts) — the same reason
// lib/chatChoices.ts factors its decision out of both chat screens, and why
// orchestrate.ts keeps its own phase sequencing DOM-free.
//
// Both are computed from the step LIST, never from a per-step flag: a
// `skippable`-style field existed once, was declared-and-read-by-nothing on 15
// steps, and was deleted (2026-08-02). Hand-tagging 116 steps across 21 files
// is exactly the maintenance burden these two functions avoid.

import type { WalkthroughStep } from "./types";

// A step that SETS a value (fill/select/upload) rather than tapping something.
const isFieldAct = (s: WalkthroughStep | undefined): boolean =>
  !!s?.act && s.act.kind !== "click";

const isClickAct = (s: WalkthroughStep | undefined): boolean =>
  !!s?.act && s.act.kind === "click";

// A step is a CHECKPOINT when it proves something (verify), shows proof
// (reveal), or asks the person to check what was filled in (confirm) — those
// always hold the gate, whatever their act was.
const isCheckpoint = (s: WalkthroughStep): boolean =>
  !!s.verify || !!s.reveal || !!s.confirm;

/**
 * False when this step may auto-continue after PACING.GROUPED_STEP_PAUSE_MS
 * instead of waiting for a real Next tap (orchestrate.ts's `holdGate`). Two
 * shapes qualify, both requiring the NEXT step to fill a field on the SAME
 * screen (no onEnter) and this step to be no checkpoint of its own:
 *
 *  1. a run of consecutive field fills — collapses name→dose→purpose into one
 *     tap instead of three. A CONVENIENCE.
 *  2. a `click` that OPENS the surface the next step ACTS on — whether that
 *     next act fills a field or taps another control. Holding here left the
 *     spotlight sitting on a control the newly-opened sheet had just buried —
 *     the highlight looked stuck to the wrong thing because the step it
 *     belonged to had already finished. Continuing moves the spotlight into
 *     the new surface instead. A CORRECTNESS fix.
 *
 *     It used to require the next step to FILL, and burial does not care:
 *     travel_mode_auto step 2 clicks the Travel Mode tile, the sheet slides up
 *     over it, and the next step clicks the sheet's own toggle — so the run
 *     parked with its spotlight on a tile behind the sheet's backdrop. Measured
 *     by the geometry sweep as `travel_mode_auto#2 target-occluded`.
 *
 * `autoNav` is the person's own Auto/Step-by-step toggle (the fast-forward
 * button in the overlay's top right). It suppresses case 1 ONLY. Someone who
 * has explicitly asked to be walked through step by step means it — collapsing
 * three field steps into one tap for them is the toggle not doing what it says,
 * and was measured doing exactly that (Step 1 → Step 4 with Auto off). Case 2
 * still applies in both modes because it is not a tap-saving shortcut: holding
 * there leaves the spotlight on a control that is no longer visible, which is a
 * defect in either mode.
 *
 * The real checkpoints (the Confirm recap, the manual Save waitFor) gate for
 * every user regardless, so nothing commits without a tap either way.
 * Orthogonal to TrustMode's requireExplicitAdvance, which is a user-HISTORY
 * relaxation rather than a step-SHAPE one.
 */
export function computeHoldGate(steps: WalkthroughStep[], index: number, autoNav = true): boolean {
  const step = steps[index];
  if (!step || isCheckpoint(step)) return true;
  const next = steps[index + 1];
  if (!next || next.onEnter) return true;
  // Case 2 — correctness, both modes. Any act in the newly-opened surface
  // counts; a step with no act at all (a bare reveal/waitFor) does not, because
  // then nothing has moved on and the spotlight is still describing this step.
  if (isClickAct(step) && !!next.act) return false;
  if (!isFieldAct(next)) return true;
  // Case 1 — convenience, Auto only.
  return !(autoNav && isFieldAct(step));
}

/**
 * True when the person may step back from `index` to the step before it.
 *
 * Three refusals, in order of how badly they'd go wrong:
 *
 *  1. index 0 — there is nothing behind it.
 *  2. a COMMIT BOUNDARY lies strictly before `index`: a step carrying
 *     `verify`, or a `waitFor` step immediately followed by one that does
 *     (that pair IS the real Save — the tap, then the proof it landed).
 *     A committed write must never be "un-stepped": going back would re-run
 *     the run against state that already changed, and nothing here can undo a
 *     row in Supabase.
 *  3. the PREVIOUS step's act is a `click`. Walkthrough.tsx's driver effect is
 *     keyed on stepIndex, so re-entering a step re-runs its act — and
 *     re-clicking a toggle collapses what it opened (edit_profile_auto's
 *     profile section) or opens a second copy of a sheet. Re-running a `fill`
 *     is idempotent, which is precisely the "that field went wrong, let me
 *     redo it" case Back exists for.
 */
export function canGoBack(steps: WalkthroughStep[], index: number): boolean {
  if (index <= 0 || index >= steps.length) return false;
  for (let i = 0; i < index; i++) {
    const s = steps[i];
    if (s.verify) return false;
    if (s.waitFor && steps[i + 1]?.verify) return false;
  }
  return !isClickAct(steps[index - 1]);
}
