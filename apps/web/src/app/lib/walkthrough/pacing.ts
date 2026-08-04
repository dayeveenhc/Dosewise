// THE single source of timing truth for guided walkthroughs + change
// highlights. These values are MINIMUMS — every timed wait in the engine flows
// through a PaceController's paced() (lib/walkthrough/pace.ts), which floors
// each phase at its minimum; no scenario/step may define its own timing
// (ActDirective deliberately has no pace field). Retune the experience here,
// nowhere else.
export const PACING = {
  NAVIGATE_MS: 900,            // screen transition settle
  FIELD_PREHIGHLIGHT_MS: 600,  // pause + highlight a field before it starts filling
  FILL_MS_PER_CHAR: 90,        // visible typing speed
  // Floor for ANY step that sets a field's value — typing, a select, an upload.
  // One constant on purpose: a timezone <select> that flipped in 700ms while the
  // date fields either side took 2800 read as a glitch, not a step.
  FIELD_MIN_MS: 1800,          // floor: pre-highlight start → value set, even 1-char fills
  PRE_CLICK_MS: 800,           // highlight before a click/submit fires
  VERIFY_MIN_MS: 600,          // min "checking…" display even if the re-query is instant
  REVEAL_PULSE_MS: 2000,       // total reveal/highlight pulse animation duration
  HIGHLIGHT_DWELL_MIN_MS: 3800,// min highlight+caption dwell before auto-dismiss
  // Brief settle between GROUPED consecutive field steps (see orchestrate.ts's
  // `holdGate`) — long enough to read as its own moment, short enough that a
  // run of fills doesn't stop and wait for a tap after every single one. Only
  // the terminal gate (awaitNext) has no timer; this one always resolves.
  GROUPED_STEP_PAUSE_MS: 500,
} as const;

// Mirror the JS pacing into CSS so keyframe durations (theme.css's
// walk-reveal-pulse and change-highlight-glow use var(--dw-pulse-ms)) can never
// drift from the JS teardown timers that reference PACING.REVEAL_PULSE_MS.
// Called once at app mount (src/main.tsx).
export function applyPacingCssVars(): void {
  document.documentElement.style.setProperty("--dw-pulse-ms", `${PACING.REVEAL_PULSE_MS}ms`);
}
