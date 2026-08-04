// Orchestration for one autonomous step: (Navigate) → Act → (Verify) →
// (Reveal) → ready → advance. Extracted from the overlay so the sequencing —
// especially "a failed Act or Verify STOPS and never advances, so success is
// never implied" — is unit testable without a DOM or React tree
// (orchestrate.test.ts).
//
// `ready` is the terminal commit gate: every phase's work is done, and the step
// then waits indefinitely for the person's Next tap. Autonomous steps do NOT
// auto-advance on the PACING minimums any more — those minimums are now only
// floors on how fast each phase may LOOK, not a self-driving clock.
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
import { humanizeField, hhmmTo12h } from "../changeHighlight";
import type { ActOutcome } from "./actor";
import type { PaceController } from "./pace";
import type { RevealDirective, VerifyDirective, WalkthroughScreen, WalkthroughStep } from "./types";

const FIELD_LABELS: Record<string, string> = {
  weightKg: "weight", heightCm: "height", dob: "date of birth", gender: "gender",
};

// Derive a ChangeHighlight-style caption from a step's Verify directive, so a
// client-driven walkthrough (travel, profile edit, condition/allergy add) proves
// WHAT changed the same way — using the real re-queried values, no per-step copy.
// Kept SHORT (no redundant field prefix for list adds — the pill sits on the
// field, so "Added: High blood pressure" reads cleaner than "…condition: …" and
// won't truncate).
export function captionFromVerify(verify?: VerifyDirective): { verb: string; text: string } | undefined {
  if (!verify) return undefined;
  switch (verify.kind) {
    case "medication-exists": return { verb: "Added", text: verify.name };
    case "profile-list-includes": return { verb: "Added", text: verify.value };
    case "profile-field": return { verb: "Updated", text: `${FIELD_LABELS[verify.field] ?? humanizeField(verify.field)} ${hhmmTo12h(verify.value)}` };
    case "travel-plan-saved": return { verb: "Saved", text: "travel plan" };
    case "care-link-active": return { verb: "Linked", text: "caregiver" };
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
  // individual field. Defaults to true (always gate) when omitted.
  holdGate?: boolean;
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
  // NOT move on by itself — the person taps Next (or Done, on the last step)
  // when they are ready. This is now the ONLY way an autonomous step advances,
  // so nothing is ever rushed past someone still reading it. Deliberately placed
  // AFTER the replay loop, so a Replay request is consumed by the reveal rather
  // than swallowed by the gate.
  //
  // A step in the middle of a grouped field run (holdGate === false) skips the
  // tap-wait and auto-continues after a brief settle instead — the real gates
  // stay at the checkpoints (opening the form, the last field before Save, the
  // final verify/reveal), so a first walkthrough still proves itself at the
  // moments that matter without a tap after every single field.
  if (h.holdGate === false) {
    await h.pace.paced("grouped", PACING.GROUPED_STEP_PAUSE_MS);
  } else {
    await h.pace.awaitNext("ready");
  }
  // cancel() wakes the gate's waiter, so Exit mid-gate must not fall through
  // into onAdvance() — that would advance a walkthrough the user just left.
  if (h.shouldCancel()) return "cancelled";

  h.onAdvance();
  return "advanced";
}
