// THE single source of timing truth for guided walkthroughs + change
// highlights. These values are MINIMUMS — every timed wait in the engine flows
// through a PaceController's paced() (lib/walkthrough/pace.ts), which floors
// each phase at its minimum; no scenario/step may define its own timing
// (ActDirective deliberately has no pace field). Retune the experience here,
// nowhere else.
// Retuned ~1.4x slower across the board (2026-08-09): the auto runs read as
// rushed for the elderly audience. TARGET_LIFT_MS (an animation duration) and
// IDLE_TIMEOUT_MS (a ceiling, not a floor) deliberately kept as they were.
export const PACING = {
  NAVIGATE_MS: 1250,           // screen transition settle
  FIELD_PREHIGHLIGHT_MS: 850,  // pause + highlight a field before it starts filling
  FILL_MS_PER_CHAR: 125,       // visible typing speed
  // Floor for ANY step that sets a field's value — typing, a select, an upload.
  // One constant on purpose: a timezone <select> that flipped in 700ms while the
  // date fields either side took 2800 read as a glitch, not a step.
  FIELD_MIN_MS: 2500,          // floor: pre-highlight start → value set, even 1-char fills
  PRE_CLICK_MS: 1100,          // highlight before a click/submit fires
  VERIFY_MIN_MS: 850,          // min "checking…" display even if the re-query is instant
  REVEAL_PULSE_MS: 2800,       // total reveal/highlight pulse animation duration
  HIGHLIGHT_DWELL_MIN_MS: 5300,// min highlight+caption dwell before auto-dismiss
  // Brief settle between GROUPED consecutive field steps (see orchestrate.ts's
  // `holdGate`) — long enough to read as its own moment, short enough that a
  // run of fills doesn't stop and wait for a tap after every single one. Only
  // the terminal gate (awaitNext) has no timer; this one always resolves.
  GROUPED_STEP_PAUSE_MS: 700,
  // Duration of the target-repositioning nudge (placement.ts::targetLiftPx) —
  // an animation-only duration, not a phase floor, so it lives here beside its
  // siblings rather than inside a paced() call.
  TARGET_LIFT_MS: 320,
  // Confirm-phase floor (Item 5, ConfirmBack-Phase) when NO explicit tap is
  // required (orchestrate.ts::runActStep) — deliberately far longer than
  // every floor above: those are field animations to NOTICE, this is a
  // recap sentence someone has to actually READ before the real Save tap
  // that still follows on its own step.
  CONFIRM_MIN_MS: 4200,
  // Terminal "ready" gate floor (Item 2, TrustMode) for a VETERAN user only
  // (requireExplicitAdvance === false — orchestrate.ts::runActStep) — the
  // step auto-advances once this elapses instead of waiting for a Next tap.
  // Short, unlike CONFIRM_MIN_MS: by the time a step reaches "ready" it has
  // already dwelled through its own Reveal (HIGHLIGHT_DWELL_MIN_MS) or
  // Confirm recap, so this is just enough of a beat for the terminal state
  // to register before moving on, not a second reading pause.
  READY_AUTO_MS: 1250,
  // Final-step "ready" gate: the walkthrough closes ITSELF after this window
  // (Done still closes it immediately, and Replay re-runs the reveal). This
  // deliberately reverses the same-day 2026-08-09 "final Done is always the
  // person's" hold, at the user's explicit request — walkthroughs must return
  // to the normal app on their own once the finale has been shown. Long
  // enough (vs READY_AUTO_MS) that tapping Done first is comfortable, since
  // this is the one timer that ENDS the run rather than moving within it.
  FINAL_AUTOCLOSE_MS: 4000,
} as const;

// TrustMode (Item 2): after this many completed walkthroughs (any task, not
// per-task — decision C), the terminal "ready" gate above stops requiring an
// explicit Next tap for a veteran user (see accessibility.tsx's
// walkthroughCompletionCount / walkthroughManualMode). 3 matches the plan's
// own example: one walkthrough isn't enough to show the pattern has been
// learned, but three repeats of the same tap-to-advance rhythm is enough that
// a fourth tap-for-tap's-sake wait starts to read as friction, not safety.
export const TRUST_MODE_THRESHOLD = 3;

// IdleTimeout (Item 6, decision D): how long `waitingOnUser` (Walkthrough.tsx)
// must hold continuously, with zero interaction, before the "still there?"
// popup fires. A sibling constant, not a PACING field — PACING entries are
// FLOORS on how fast a phase may look; this is a ceiling on how long a real
// wait may go unacknowledged before Mei checks in. 20s: long enough that
// reading a Confirm recap (CONFIRM_MIN_MS is only 3s, but a person may linger
// well past it) or slowly typing an answer to a clarifying question never
// gets interrupted mid-thought, short enough that someone genuinely stuck on
// a Submit/consent tap or a blocked question isn't left alone for a full
// minute wondering what to do.
export const IDLE_TIMEOUT_MS = 20_000;

// Mirror the JS pacing into CSS so keyframe durations (theme.css's
// walk-reveal-pulse and change-highlight-glow use var(--dw-pulse-ms)) can never
// drift from the JS teardown timers that reference PACING.REVEAL_PULSE_MS.
// Called once at app mount (src/main.tsx).
export function applyPacingCssVars(): void {
  document.documentElement.style.setProperty("--dw-pulse-ms", `${PACING.REVEAL_PULSE_MS}ms`);
}
