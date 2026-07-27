// THE single source of timing truth for guided walkthroughs + change
// highlights. These values are MINIMUMS — every timed wait in the engine flows
// through a PaceController's paced() (lib/walkthrough/pace.ts), which floors
// each phase at its minimum; no scenario/step may define its own timing
// (ActDirective deliberately has no pace field). Retune the experience here,
// nowhere else.
export const PACING = {
  NAVIGATE_MS: 500,            // screen transition settle
  FIELD_PREHIGHLIGHT_MS: 300,  // pause + highlight a field before it starts filling
  FILL_MS_PER_CHAR: 45,        // visible typing speed
  FIELD_MIN_MS: 900,           // floor: pre-highlight start → fill complete, even 1-char fields
  BETWEEN_FIELDS_MS: 500,      // mandatory pause between consecutive field fills
  PRE_CLICK_MS: 400,           // highlight before a click/submit fires
  VERIFY_MIN_MS: 600,          // min "checking…" display even if the re-query is instant
  REVEAL_PULSE_MS: 1400,       // total reveal/highlight pulse animation duration
  HIGHLIGHT_DWELL_MIN_MS: 2500,// min highlight+caption dwell before auto-dismiss
} as const;

// Mirror the JS pacing into CSS so keyframe durations (theme.css's
// walk-reveal-pulse and change-highlight-glow use var(--dw-pulse-ms)) can never
// drift from the JS teardown timers that reference PACING.REVEAL_PULSE_MS.
// Called once at app mount (src/main.tsx).
export function applyPacingCssVars(): void {
  document.documentElement.style.setProperty("--dw-pulse-ms", `${PACING.REVEAL_PULSE_MS}ms`);
}
