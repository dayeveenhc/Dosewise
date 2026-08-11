import type { Screen } from "../../types";
import type { ElderlyTab } from "../../screens/elderly/types";

// Task names Hermes's start_walkthrough tool can queue — keep in sync with
// services/hermes/src/hermes/tools/walkthrough.py::TASK_NAMES.
export type WalkthroughTaskName =
  | "onboarding"
  | "travel_mode_setup"
  | "request_refill"
  | "link_caregiver"
  // Guided Auto-Navigation (autonomous — Mei fills & submits, then verifies).
  | "add_prescription_auto"
  | "add_condition_auto"
  | "travel_mode_auto"
  | "edit_profile_auto"
  | "add_doctor_question_auto"
  // Consent flow: Mei navigates, the elder taps Accept themselves, then verify.
  | "accept_caregiver_link"
  // Spotlight-and-narrate only: the elder performs every step. These cover
  // settings and everyday actions rather than data entry, so they carry no
  // `act` and nothing to verify.
  | "check_schedule"
  | "log_dose"
  | "undo_dose"
  | "reminder_settings"
  | "text_size"
  // Spotlight tours (2026-07-26): highlight-and-narrate only — the user taps
  // every step themselves, nothing autonomous. First three are elder-mode,
  // the last three caregiver-shell. NOTE: never put a semicolon inside this
  // union's comments — the backend parity test captures the union body up to
  // the first semicolon character.
  | "language_voice_tour"
  | "notifications_tour"
  | "emergency_contact_tour"
  | "caregiver_view_toggle_tour"
  | "patient_schedule_tour"
  | "weekly_summary_tour";

// Where a step lives, so the Walkthrough overlay can ask the host to switch
// there (onEnter) before it starts spotlighting. "onboarding" isn't a real
// Screen/ElderlyTab — the wizard is its own multi-step surface — so it's
// carried as a plain marker; the wizard doesn't need switching to, only its
// own internal step advanced.
export type WalkthroughScreen =
  | { mode: "caregiver"; screen: Screen }
  | { mode: "elderly"; tab: ElderlyTab }
  | { mode: "onboarding" };

// The condition that ends a step — always a REAL action the user performs,
// never the bubble's own button (see components/Walkthrough.tsx). `source:
// "dom"` conditions are detected generically via a native listener on
// `step.selector` (or `waitFor.selector` when the real anchor differs from
// what's spotlighted); `source: "app-event"` conditions are emitted
// explicitly by instrumented app code via lib/walkthrough/bus.ts, for cases
// a generic DOM listener can't tell apart (a custom stepper with no DOM
// signal for "value truly changed"; an async write's real success, not the
// click that started it; a camera decode; a chat turn's committed action).
export type WaitFor =
  | { type: "click"; source: "dom"; selector?: string }
  // `selector` narrows the LISTENER to the real control when the step
  // spotlights a labelled wrapper around it (the text-size slider).
  | { type: "input"; source: "dom"; selector?: string; on: "change" | "blur"; validate?: "nonEmpty" | { pattern: string } }
  | { type: "select-change"; source: "dom" }
  | { type: "toggle"; source: "dom"; expected?: boolean }
  | { type: "value-change"; source: "app-event"; event: string }
  | { type: "step-transition"; source: "app-event"; event: string; toStep: string }
  | { type: "automatic-detection"; source: "app-event"; event: string }
  | { type: "agent-action-committed"; source: "app-event"; tool: string }
  | { type: "write-committed"; source: "app-event"; event: string }
  // `selector` widens the LISTENER when the spotlight narrows to a landmark
  // inside a bigger surface (the schedule's "now" line) — the tap still counts
  // anywhere on the surface itself.
  | { type: "acknowledge"; source: "dom"; selector?: string };

// Real VALUES (never selectors) passed from Mei's start_walkthrough tool into an
// autonomous walkthrough's fill/verify steps — e.g. {name, dose, purpose} for
// add_prescription_auto, {condition} for add_condition_auto.
export type WalkthroughParams = Record<string, string>;

// --- Guided Auto-Navigation (Phase 1) -------------------------------------
// In the app's default walkthrough, the USER performs every action (waitFor).
// In autonomous mode, Mei performs it herself — but always VISIBLY animated,
// never instant (lib/walkthrough/actor.ts) — so the elder can watch and learn.
// A step carries EITHER a `waitFor` (user-driven) OR an `act` (Mei-driven).

// The action Mei performs, animated. `fill`/`select`/`upload` are DOM-driven
// (a React-safe value setter so controlled inputs actually update); `click`
// taps a real control (incl. TimesPicker's quick chips, which are buttons).
// Arbitrary custom-widget values (e.g. a specific stepper time that isn't a
// quick chip) will need a bus-driven adapter kind — deferred until a scenario
// needs one; the common case is covered by clicking the chip.
// Deliberately NO timing fields here: all pacing lives in lib/walkthrough/
// pacing.ts and flows through the PaceController — a step cannot set its own.
export type ActDirective =
  | { kind: "fill"; selector: string; value: string }
  | { kind: "select"; selector: string; value: string }
  | { kind: "click"; selector: string }
  | { kind: "upload"; selector: string; asset: string };

// The Verify phase: re-query REAL state to confirm the write landed before the
// walkthrough claims success — mirrors the Hermes verify_* tools
// (services/hermes/src/hermes/tools/verify.py), same "never trust the write
// call's own return" rule. The runtime checks live in ONE place —
// lib/walkthrough/verify.ts's buildVerifyRunner — with the host's data
// fetchers injected; the shape is defined here so steps can declare it.
export type VerifyDirective =
  | { kind: "medication-exists"; name: string }
  | { kind: "travel-plan-saved" }
  | { kind: "profile-field"; field: string; value: string }
  | { kind: "profile-list-includes"; field: string; value: string }
  | { kind: "doctor-question-exists"; question: string }
  | { kind: "care-link-active" }
  | { kind: "dose-status"; medicationId: string; status: string }
  | { kind: "medication-archived"; name: string }
  // Dot-path into the profiles.accessibility jsonb (e.g. "travelPlan.timezone").
  | { kind: "accessibility-path-equals"; path: string; value: string }
  // The medication's schedule times (HH:MM, 24h) must match exactly, any order.
  | { kind: "reminder-times"; name: string; times: string[] };

// The Reveal phase: where the proof now lives and how to animate it in.
export interface RevealDirective {
  screen: WalkthroughScreen;
  selector: string;
  pulse?: boolean; // default true — pulse-highlight the new/updated element
  // The "what changed" caption shown attached to the pulsed element, matching
  // ChangeHighlight's proof style. Usually derived from the step's VerifyDirective
  // (real values) at orchestration time, so no per-step copy is needed.
  caption?: { verb: string; text: string };
}

// The Confirm phase (cross-cutting decision B, "ConfirmBack-Phase"): a brief
// recap of what Mei is about to submit, run between Act/Verify and the real
// Submit `waitFor` step (orchestrate.ts::runActStep). Gated on trust/risk at
// RUNTIME, not here — this directive only marks that a step carries the
// confirm phase; WHAT to recap is the existing `review` field below, reused
// rather than duplicated (WalkthroughReview renders it either way). An
// object, not a bare boolean, so a future per-step override has somewhere to
// go without a breaking type change.
export interface ConfirmDirective {
  recap: true;
}

// One row of the "check these details" summary shown inside the callout before
// a manual Save. Declared as label + SELECTOR, never as a captured value: the
// card reads the LIVE form, so it always shows what is actually there —
// including anything the person retyped after tapping Change. A value snapshot
// taken when the steps were built would go stale on the first edit and assert
// something the form no longer contains, which is precisely the mistake this
// review step exists to catch.
export interface ReviewField {
  labelKey: string; // through t() — reuse the form's own label key
  selector: string; // the same selector the fill act used
}

export interface WalkthroughStep {
  id: string;
  screen: WalkthroughScreen;
  // Declarative analogue of GuidedTour's TourStep.onEnter — switch screen/tab
  // before this step's target exists. Plain data (a WalkthroughScreen), not a
  // callback, since step content is a data file, not code.
  onEnter?: WalkthroughScreen;
  selector: string;
  navSelector?: string;
  instructionKey: string; // through t() — no raw strings, this app has an i18n parity gate
  // NOTE: no `voiceKey` here. It existed as a TTS override for the idle popup's
  // "Explain this step again" button, which was that field's only consumer ever
  // and was removed 2026-08-07 — leaving it declared would be the same
  // declared-and-read-by-nothing shape as `skippable` and
  // WALKTHROUGH_TASK_LABELS, both of which this repo has already paid for once.
  // Re-add it (and a consumer) together if walkthrough narration is ever wired
  // to real speech.
  // A step ends EITHER when the user does `waitFor` OR after Mei performs `act`
  // (which then auto-advances). Exactly one should be set; `waitFor` stays for
  // every existing highlight-only step and the consent flows' human-tap Submit.
  waitFor?: WaitFor;
  act?: ActDirective;
  verify?: VerifyDirective;
  // Confirm phase (decision B) — see ConfirmDirective above. Paired with
  // `review` below; a step carrying `confirm` typically has no `verify`/
  // `reveal` of its own (those live on the tail step after the real Submit).
  confirm?: ConfirmDirective;
  reveal?: RevealDirective;
  // Show the live values of these fields in the callout so the person can
  // actually CHECK what Mei filled in before committing it.
  review?: ReviewField[];
  timeoutMs?: number;
}

/**
 * The autonomous family: Mei fills the real form and the patient taps Save.
 * These are NOT one-time introductions — they are HOW the write is performed —
 * so they must never be recorded as "already shown". Recording
 * add_prescription_auto as done is what made adding a SECOND medicine skip the
 * walkthrough entirely and become a silent direct write.
 *
 * Mirrors services/hermes/src/hermes/tools/walkthrough.py::AUTONOMOUS_TASKS,
 * which is the load-bearing owner (it subtracts these from the
 * completed_walkthroughs the client forwards). This copy only stops the client
 * writing entries that would mean nothing.
 */
export const AUTONOMOUS_TASKS: ReadonlySet<WalkthroughTaskName> = new Set([
  "add_prescription_auto",
  "add_condition_auto",
  "travel_mode_auto",
  "edit_profile_auto",
  "add_doctor_question_auto",
  "accept_caregiver_link",
] as const);

export const WALKTHROUGH_TASK_LABELS: Record<WalkthroughTaskName, string> = {
  onboarding: "walk.taskLabel.onboarding",
  travel_mode_setup: "walk.taskLabel.travelModeSetup",
  request_refill: "walk.taskLabel.requestRefill",
  link_caregiver: "walk.taskLabel.linkCaregiver",
  add_prescription_auto: "walk.taskLabel.addPrescriptionAuto",
  add_condition_auto: "walk.taskLabel.addConditionAuto",
  travel_mode_auto: "walk.taskLabel.travelModeAuto",
  edit_profile_auto: "walk.taskLabel.editProfileAuto",
  add_doctor_question_auto: "walk.taskLabel.addDoctorQuestionAuto",
  accept_caregiver_link: "walk.taskLabel.acceptCaregiverLink",
  check_schedule: "walk.taskLabel.checkSchedule",
  log_dose: "walk.taskLabel.logDose",
  undo_dose: "walk.taskLabel.undoDose",
  reminder_settings: "walk.taskLabel.reminderSettings",
  text_size: "walk.taskLabel.textSize",
  language_voice_tour: "walk.taskLabel.languageVoiceTour",
  notifications_tour: "walk.taskLabel.notificationsTour",
  emergency_contact_tour: "walk.taskLabel.emergencyContactTour",
  caregiver_view_toggle_tour: "walk.taskLabel.caregiverViewToggleTour",
  patient_schedule_tour: "walk.taskLabel.patientScheduleTour",
  weekly_summary_tour: "walk.taskLabel.weeklySummaryTour",
};
