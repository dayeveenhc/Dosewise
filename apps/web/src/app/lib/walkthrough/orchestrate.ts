// Five-phase orchestration for one autonomous step: Act → (Verify) → (Reveal) →
// advance. Extracted from the overlay so the sequencing — especially "a failed
// Verify STOPS and never advances, so success is never implied" — is unit
// testable without a DOM or React tree (orchestrate.test.ts).
//
// Verify is done by the HOST (onVerify) via a real client re-query of Supabase
// (fetchElderMedications / fetchProfile / fetchPendingLinkRequests), mirroring
// the Hermes verify_* tools: never trust the write call's own return. Reveal is
// also host-owned (navigate + pulse-highlight the real new/updated element).

import { performAct } from "./actor";
import { humanizeField, hhmmTo12h } from "../changeHighlight";
import type { RevealDirective, VerifyDirective, WalkthroughScreen, WalkthroughStep } from "./types";

// Deliberate pacing so an elderly user can follow each step rather than watch it
// flash by. Retune here. READ_DWELL: let the callout be read before Mei acts;
// POST_ACT: a beat after acting before we re-query; REVEAL_DWELL: hold on the
// pulsed result (+ its caption) before moving to the next step.
const READ_DWELL_MS = 900;
const POST_ACT_MS = 450;
const REVEAL_DWELL_MS = 1500;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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
  onVerify?: (verify: VerifyDirective) => Promise<boolean>;
  onReveal?: (reveal: RevealDirective) => void;
  onNavigate: (screen: WalkthroughScreen) => void;
  onAdvance: () => void;
  shouldCancel: () => boolean;
}

export type ActStepOutcome = "advanced" | "verify-failed" | "cancelled";

export async function runActStep(step: WalkthroughStep, h: PhaseHandlers): Promise<ActStepOutcome> {
  // Act only when present. An act-less step that carries verify/reveal (e.g. the
  // post-consent verify step of the caregiver-link flow) still runs the tail
  // below — the actor just doesn't touch anything.
  if (step.act) {
    // Let the elder read the instruction callout before Mei starts acting.
    await sleep(READ_DWELL_MS);
    if (h.shouldCancel()) return "cancelled";
    await performAct(step.act, { shouldCancel: h.shouldCancel });
    if (h.shouldCancel()) return "cancelled";
    await sleep(POST_ACT_MS);
    if (h.shouldCancel()) return "cancelled";
  }

  // Verify: re-query real state. A failure STOPS the run here — we do NOT
  // reveal and do NOT advance, so the walkthrough can never claim a success it
  // couldn't prove (no dwell on failure — the honest error shows immediately).
  if (step.verify && h.onVerify) {
    const passed = await h.onVerify(step.verify);
    if (h.shouldCancel()) return "cancelled";
    if (!passed) return "verify-failed";
  }

  // Reveal: show the proof. Host-owned when provided (navigate + pulse); else at
  // least navigate to where the result lives. Attach a changed-fields-style
  // caption derived from the step's Verify (real values) unless the step set one.
  // Hold on the result so the pulse + caption register before the next step.
  if (step.reveal) {
    if (h.onReveal) h.onReveal({ ...step.reveal, caption: step.reveal.caption ?? captionFromVerify(step.verify) });
    else h.onNavigate(step.reveal.screen);
    await sleep(REVEAL_DWELL_MS);
    if (h.shouldCancel()) return "cancelled";
  }

  h.onAdvance();
  return "advanced";
}
