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
  // Consent flow: Mei navigates, the elder taps Accept themselves, then verify.
  | "accept_caregiver_link"
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
  | { type: "input"; source: "dom"; on: "change" | "blur"; validate?: "nonEmpty" | { pattern: string } }
  | { type: "select-change"; source: "dom" }
  | { type: "toggle"; source: "dom"; expected?: boolean }
  | { type: "value-change"; source: "app-event"; event: string }
  | { type: "navigation"; source: "dom"; to: WalkthroughScreen }
  | { type: "step-transition"; source: "app-event"; event: string; toStep: string }
  | { type: "automatic-detection"; source: "app-event"; event: string }
  | { type: "agent-action-committed"; source: "app-event"; tool: string }
  | { type: "write-committed"; source: "app-event"; event: string }
  | { type: "acknowledge"; source: "dom" };

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
  voiceKey?: string; // falls back to instructionKey for TTS
  // A step ends EITHER when the user does `waitFor` OR after Mei performs `act`
  // (which then auto-advances). Exactly one should be set; `waitFor` stays for
  // every existing highlight-only step and the consent flows' human-tap Submit.
  waitFor?: WaitFor;
  act?: ActDirective;
  verify?: VerifyDirective;
  reveal?: RevealDirective;
  skippable?: boolean; // default true; false for the caregiver-link consent/accept step
  timeoutMs?: number;
}

export const WALKTHROUGH_TASK_LABELS: Record<WalkthroughTaskName, string> = {
  onboarding: "walk.taskLabel.onboarding",
  travel_mode_setup: "walk.taskLabel.travelModeSetup",
  request_refill: "walk.taskLabel.requestRefill",
  link_caregiver: "walk.taskLabel.linkCaregiver",
  add_prescription_auto: "walk.taskLabel.addPrescriptionAuto",
  add_condition_auto: "walk.taskLabel.addConditionAuto",
  travel_mode_auto: "walk.taskLabel.travelModeAuto",
  edit_profile_auto: "walk.taskLabel.editProfileAuto",
  accept_caregiver_link: "walk.taskLabel.acceptCaregiverLink",
  language_voice_tour: "walk.taskLabel.languageVoiceTour",
  notifications_tour: "walk.taskLabel.notificationsTour",
  emergency_contact_tour: "walk.taskLabel.emergencyContactTour",
  caregiver_view_toggle_tour: "walk.taskLabel.caregiverViewToggleTour",
  patient_schedule_tour: "walk.taskLabel.patientScheduleTour",
  weekly_summary_tour: "walk.taskLabel.weeklySummaryTour",
};
