// Orchestration for one autonomous step: (Navigate) → Act → (Verify) →
// (Confirm) → (Reveal) → ready → advance. Extracted from the overlay so the
// sequencing — especially "a failed Act or Verify STOPS and never advances,
// so success is never implied" — is unit testable without a DOM or React tree
// (orchestrate.test.ts).
//
// `ready` is the terminal commit gate: every phase's work is done, and the step
// then waits for the person's Next tap — UNLESS one of two independent
// relaxations applies: holdGate === false (a step mid-way through a grouped
// run of field fills — applies to every user), or TrustMode's
// requireExplicitAdvance is false (a veteran user, Item 2) — in which case it
// auto-advances after GROUPED_STEP_PAUSE_MS / READY_AUTO_MS respectively (see
// the gate's own comment for the exact precedence). Autonomous steps
// otherwise do NOT auto-advance on the PACING minimums — those minimums are
// floors on how fast each phase may LOOK, not a self-driving clock.
//
// Confirm (Item 5, "ConfirmBack-Phase") is the one exception to "every step
// ends at a tap": a step whose ONLY content is the confirm phase folds its own
// resolution (an explicit tap OR its paced floor elapsing) straight into
// advancement rather than also holding the `ready` gate below — see the
// confirm block's own comment for why, and PhaseHandlers for the trust/risk
// signals that decide which of the two it uses.
//
// Verify is done by the HOST (onVerify) via a real client re-query of Supabase
// (lib/walkthrough/verify.ts's buildVerifyRunner with the host's fetchers
// injected), mirroring the Hermes verify_* tools: never trust the write call's
// own return. Reveal is also host-owned (navigate + pulse-highlight the real
// new/updated element).
//
// ALL timing flows through the step's PaceController (h.pace) against the
// PACING minimums — this file defines no durations of its own. The controller
// also carries the user's Next (fast-forward after a phase minimum) and Replay
// (re-run the reveal) requests.

import { performAct } from "./actor";
import { PACING } from "./pacing";
import { humanizeField, hhmmTo12h, readerCaption } from "../changeHighlight";
import type { ActOutcome } from "./actor";
import type { PaceController } from "./pace";
import type { ReviewField, RevealDirective, VerifyDirective, WalkthroughScreen, WalkthroughStep } from "./types";

// Derive a ChangeHighlight-style caption from a step's Verify directive, so a
// client-driven walkthrough (travel, profile edit, condition/allergy add) proves
// WHAT changed the same way — using the real re-queried values, no per-step copy.
// Kept SHORT (no redundant field prefix for list adds — the pill sits on the
// field, so "Added: High blood pressure" reads cleaner than "…condition: …" and
// won't truncate).
export function captionFromVerify(verify?: VerifyDirective): { verb: string; text: string } | undefined {
  if (!verify) return undefined;
  // Localized HERE, at the producer: HighlightCaption receives finished text, so
  // an English verb built at this point would stay English on every screen.
  // readerCaption() resolves the reader's language and 12h/24h setting from the
  // same storage the providers write — this module deliberately has no React.
  const c = readerCaption();
  switch (verify.kind) {
    case "medication-exists": return { verb: c.verb("added"), text: verify.name };
    // A condition/allergy that IS in the catalog reads in the person's language;
    // free text they typed falls through unchanged (data/medications.ts).
    case "profile-list-includes": return { verb: c.verb("added"), text: c.value(verify.value) };
    case "profile-field": return { verb: c.verb("updated"), text: `${humanizeField(verify.field, c.options)} ${hhmmTo12h(verify.value, c.options)}` };
    case "travel-plan-saved": return { verb: c.verb("saved"), text: c.phrase("caption.travelPlan") };
    case "care-link-active": return { verb: c.verb("linked"), text: c.phrase("caption.caregiver") };
    default: return undefined;
  }
}

export interface PhaseHandlers {
  pace: PaceController;
  onVerify?: (verify: VerifyDirective) => Promise<boolean>;
  onReveal?: (reveal: RevealDirective) => void;
  onNavigate: (screen: WalkthroughScreen) => void;
  onAdvance: () => void;
  shouldCancel: () => boolean;
  // False for a step in the middle of a run of consecutive field fills (the
  // caller decides this by looking at the next step — see Walkthrough.tsx's
  // `computeHoldGate`): skips the terminal tap-wait and auto-continues after a
  // brief settle instead. A first-time walkthrough still gates at real
  // checkpoints (opening the form, the last field before Save, the final
  // verify/reveal) — it just stops making someone tap Next after every
  // individual field. Defaults to true (always gate) when omitted. Orthogonal
  // to requireExplicitAdvance below (step-shape vs. user-history) — the
  // terminal gate checks this FIRST, since a grouped mid-field step gets the
  // short pause regardless of trust level.
  holdGate?: boolean;
  // Confirm phase (decision B, Item 5) AND the terminal "ready" gate below
  // (decision C, Item 2, TrustMode): true for first-timers/manual-mode,
  // false for a veteran (walkthroughCompletionCount >= TRUST_MODE_THRESHOLD
  // and walkthroughManualMode off — accessibility.tsx). Computed by the host
  // from the real per-user setting and threaded down exactly like
  // onVerifyFailed elsewhere in this codebase — this file stays ignorant of
  // WHERE the signal comes from, only what to do with it.
  requireExplicitAdvance?: boolean;
  // The RiskClassifier result for this walkthrough instance (services/hermes
  // tools/risk.py, threaded from the Hermes response) — risk always overrides
  // trust, so a flagged instance forces the explicit tap regardless of
  // requireExplicitAdvance.
  riskFlagged?: boolean;
  // AutoNav (the per-walkthrough-session Auto/Step-by-step switch in the
  // callout — Walkthrough.tsx owns the state). True relaxes ONLY the terminal
  // `ready` gate below into an auto-continue; it deliberately does not touch
  // the Confirm block above, which keeps deciding from trust/risk/blank-field.
  // The host folds "Auto is off" into requireExplicitAdvance before it gets
  // here, so a veteran who switches Auto off still gets their tap gates back.
  autoAdvance?: boolean;
  // A blank ReviewField ALWAYS forces the tap path (decision B) — "genuinely
  // unclear" is itself a risk signal. Injected rather than read directly so
  // this file stays DOM-free/unit-testable (orchestrate.test.ts); the host
  // supplies the real live-DOM read (Walkthrough.tsx, mirroring how
  // WalkthroughReview already reads these same selectors).
  hasBlankReviewField?: (fields: ReviewField[]) => boolean;
}

export type ActStepOutcome = "advanced" | "verify-failed" | "act-failed" | "cancelled";

export async function runActStep(step: WalkthroughStep, h: PhaseHandlers): Promise<ActStepOutcome> {
  // The overlay already asked the host to switch screens for a step with
  // onEnter; give the transition a paced settle so the elder sees where they
  // landed before anything starts moving.
  if (step.onEnter) {
    await h.pace.paced("navigate", PACING.NAVIGATE_MS);
    if (h.shouldCancel()) return "cancelled";
  }

  // Act only when present. An act-less step that carries verify/reveal (e.g. the
  // post-consent verify step of the caregiver-link flow) still runs the tail
  // below — the actor just doesn't touch anything.
  if (step.act) {
    const act = step.act;
    const ctx = { shouldCancel: h.shouldCancel, shouldFastForward: () => h.pace.shouldFastForward() };
    const run = () => performAct(act, ctx);
    let outcome: ActOutcome | undefined;
    if (act.kind === "fill") {
      // Pre-highlight + visible typing, floored at FIELD_MIN_MS total so even a
      // one-character fill registers as its own moment.
      outcome = await h.pace.paced("field", PACING.FIELD_MIN_MS, run);
    } else if (act.kind === "click") {
      // The PRE_CLICK highlight window runs inside the actor; the paced minimum
      // matches it so the phase can never end before the highlight had its beat.
      outcome = await h.pace.paced("click", PACING.PRE_CLICK_MS, run);
    } else {
      // select/upload are single visible state flips. Same floor as a fill and
      // the same pre-highlight (actor.ts), because they ARE fills as far as the
      // person is concerned — the timezone select used to flip 4x faster than
      // the date fields either side of it, which read as a glitch.
      outcome = await h.pace.paced("field", PACING.FIELD_MIN_MS, run);
    }
    if (h.shouldCancel()) return "cancelled";
    // An act that could not be performed AT ALL — target absent, wrong element
    // type, or a select value matching no option — STOPS the run. Advancing
    // would silently skip the very action the step exists to perform, which is
    // how a tour used to "guide halfway and then do something wrong". Note this
    // is about whether the act could run, never about whether the click had a
    // visible effect: deliberate clicks on handler-less containers report "done".
    if (outcome && outcome !== "done" && outcome !== "cancelled") return "act-failed";
    // (There used to be a 1s "between-fields" pause here so consecutive fills
    // read as separate actions. That made sense when steps auto-advanced; now
    // every step ends at the commit gate below, so it only delayed the moment
    // Next became tappable — a second of nothing happening, on every field.)
  }

  // Verify: re-query real state, showing "checking…" for at least VERIFY_MIN_MS
  // (the phase broadcast lets the callout swap its label). A failure STOPS the
  // run here — we do NOT reveal and do NOT advance, so the walkthrough can never
  // claim a success it couldn't prove; the honest error shows with no extra
  // dwell. Next can never cut the re-query short — a running verify keeps
  // "checking…" until its real result.
  if (step.verify && h.onVerify) {
    const verify = step.verify;
    const passed = await h.pace.paced("verify", PACING.VERIFY_MIN_MS, () => h.onVerify!(verify));
    if (h.shouldCancel()) return "cancelled";
    if (!passed) return "verify-failed";
  }

  // Confirm (Item 5, decision B): reuses the SAME two pacing primitives Act/
  // Verify already use above — not a third mechanism. requireExplicitAdvance
  // OR risk.flagged OR a blank review field forces an explicit tap
  // (awaitNext) — risk and "genuinely unclear" both override trust level.
  // Otherwise a brief, auto-elapsing recap (paced) — the only path where a
  // trusted, low-risk user gets zero taps before the real Submit tap that
  // still follows on its own waitFor step; nothing here ever performs that
  // Submit itself.
  if (step.confirm) {
    const isBlankNow = () =>
      !!step.review && !!h.hasBlankReviewField && h.hasBlankReviewField(step.review);
    if (h.requireExplicitAdvance || h.riskFlagged || isBlankNow()) {
      await h.pace.awaitNext("confirm");
    } else {
      await h.pace.paced("confirm", PACING.CONFIRM_MIN_MS);
      if (h.shouldCancel()) return "cancelled";
      // The floor above elapses on a timer with no knowledge of live field
      // state. If the person used the review panel's own "Change" affordance
      // to clear a field WHILE the auto-elapsing recap was running, the timer
      // still resolves on schedule — without this re-check it would then
      // silently advance straight to Submit despite the UI visibly showing
      // the clarifying-question block (found live: the walkthrough advanced
      // with zero taps while looking blocked). Escalate to the real tap gate
      // instead of advancing when the floor elapses on a now-blank field.
      if (isBlankNow()) {
        await h.pace.awaitNext("confirm");
      }
    }
    if (h.shouldCancel()) return "cancelled";
    // A step whose ONLY content is the confirm phase must not ALSO separately
    // hold the terminal "ready" gate below — that would force two consecutive
    // taps for one recap. Resolving confirm (by tap or by its floor) already
    // satisfies advancement. A step that also carries its own reveal (none do
    // today) falls through into the normal reveal + terminal-gate tail below
    // instead, since THAT gate is then guarding real proof, not a re-ask.
    if (!step.reveal) {
      h.onAdvance();
      return "advanced";
    }
  }

  // Reveal: show the proof. Host-owned when provided (navigate + pulse); else at
  // least navigate to where the result lives. Attach a changed-fields-style
  // caption derived from the step's Verify (real values) unless the step set one.
  // The paced floor is one full pulse animation (REVEAL_PULSE_MS — Next may
  // shorten the dwell but never cut the pulse); left alone, the dwell holds for
  // HIGHLIGHT_DWELL_MIN_MS before the commit gate below opens. Replay re-fires
  // the host reveal and restarts the dwell.
  if (step.reveal) {
    const reveal = { ...step.reveal, caption: step.reveal.caption ?? captionFromVerify(step.verify) };
    do {
      if (h.onReveal) h.onReveal(reveal);
      else h.onNavigate(reveal.screen);
      await h.pace.paced("reveal", PACING.REVEAL_PULSE_MS, () => h.pace.dwell(PACING.HIGHLIGHT_DWELL_MIN_MS));
      if (h.shouldCancel()) return "cancelled";
    } while (h.pace.consumeReplay());
  }

  // Terminal commit gate: the step's work is finished, but the walkthrough does
  // NOT move on by itself by default — the person taps Next (or Done, on the
  // last step) when ready, so nothing is ever rushed past someone still
  // reading it. Deliberately placed AFTER the replay loop, so a Replay request
  // is consumed by the reveal rather than swallowed by the gate. Two
  // INDEPENDENT relaxations can shorten this to an auto-continue, checked in
  // this order:
  //
  // 1. holdGate === false — a step in the middle of a grouped field run (the
  //    caller looks ahead to the next step; see Walkthrough.tsx's
  //    computeHoldGate). Applies to EVERY user, first-timers included — the
  //    real checkpoints (opening the form, the last field before Save, the
  //    final verify/reveal) still gate, this just stops making someone tap
  //    Next after every individual field. A structural, step-SHAPE relaxation,
  //    so it's checked first regardless of trust level.
  // 2. requireExplicitAdvance === false — a VETERAN user (Item 2, TrustMode:
  //    walkthroughCompletionCount past TRUST_MODE_THRESHOLD and manual mode
  //    off) instead auto-advances once READY_AUTO_MS elapses. A user-HISTORY
  //    relaxation, so it only applies once holdGate hasn't already decided.
  //    Never applies to waitFor-typed steps (those never call runActStep at
  //    all — see Walkthrough.tsx's `autonomous` check), and a risk-flagged
  //    Confirm phase above already forced its own explicit tap before
  //    reaching here regardless of trust level — risk overrides trust, but
  //    only Confirm needs to make that call since this gate is reached only
  //    after Confirm already resolved (or wasn't present).
  // 3. autoAdvance === true — the person has Auto navigation switched on for
  //    this walkthrough (the callout's own toggle). Same auto-continue as the
  //    veteran path below, chosen explicitly rather than earned; it never
  //    reaches a waitFor step, so the real Save/consent taps are untouched.
  if (h.holdGate === false) {
    await h.pace.paced("grouped", PACING.GROUPED_STEP_PAUSE_MS);
  } else if (h.autoAdvance || h.requireExplicitAdvance === false) {
    await h.pace.paced("ready", PACING.READY_AUTO_MS);
  } else {
    await h.pace.awaitNext("ready");
  }
  // cancel() wakes the gate's waiter, so Exit mid-gate must not fall through
  // into onAdvance() — that would advance a walkthrough the user just left.
  if (h.shouldCancel()) return "cancelled";

  h.onAdvance();
  return "advanced";
}
