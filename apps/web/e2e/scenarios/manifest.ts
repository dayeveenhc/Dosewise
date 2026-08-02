// The single source of truth for the 32 Phase-3 scenario specs. Each row maps
// to exactly one spec file `e2e/scenarios/{id}-{slug}.spec.ts`; coverage.spec.ts
// enforces the mapping (ids sequential, slugs kebab-case, taskNames real
// WalkthroughTaskName literals, no orphan spec files).
//
// COORDINATOR-OWNED — scenario agents must never edit this file (it is on the
// banned list in README.md). A change here rewrites every agent's contract.

export interface ScenarioEntry {
  id: string;
  slug: string;
  tag: "AUDIT" | "FIXED-P1" | "NEW-FE" | "NEW-BE-FE" | "VIEW" | "CONSENT" | "TRIGGER";
  // The WalkthroughTaskName this scenario queues/asserts, when it has one.
  taskName?: string;
  // Hermes tools the TRIGGER turn is expected to route to ([] = no tool call).
  tools: string[];
}

export const SCENARIOS: ScenarioEntry[] = [
  { id: "s01", slug: "add-medicine", tag: "AUDIT", taskName: "add_prescription_auto", tools: ["add_prescription", "start_walkthrough"] },
  { id: "s02", slug: "add-condition", tag: "AUDIT", taskName: "add_condition_auto", tools: ["start_walkthrough"] },
  { id: "s03", slug: "named-dose-taken", tag: "FIXED-P1", tools: ["log_dose"] },
  { id: "s04", slug: "generic-dose-taken", tag: "NEW-FE", tools: ["log_dose"] },
  { id: "s05", slug: "undo-dose", tag: "NEW-BE-FE", tools: ["undo_dose"] },
  { id: "s06", slug: "bulk-missed", tag: "AUDIT", tools: ["resolve_missed_doses"] },
  { id: "s07", slug: "multi-named-doses", tag: "NEW-BE-FE", tools: ["log_doses"] },
  { id: "s08", slug: "discontinue-med", tag: "NEW-BE-FE", tools: ["discontinue_medication"] },
  { id: "s09", slug: "dosage-update", tag: "AUDIT", tools: ["update_medication_dosage"] },
  { id: "s10", slug: "refill-request", tag: "AUDIT", taskName: "request_refill", tools: ["request_refill"] },
  { id: "s11", slug: "change-dose-time", tag: "NEW-FE", tools: ["set_medication_reminder"] },
  { id: "s12", slug: "snooze-today", tag: "NEW-BE-FE", tools: ["snooze_dose"] },
  { id: "s13", slug: "weekday-pattern", tag: "NEW-FE", tools: ["set_medication_reminder"] },
  { id: "s14", slug: "travel-mode", tag: "AUDIT", taskName: "travel_mode_auto", tools: ["start_walkthrough"] },
  { id: "s15", slug: "edit-profile", tag: "AUDIT", taskName: "edit_profile_auto", tools: ["start_walkthrough"] },
  { id: "s16", slug: "allergy-severity", tag: "NEW-BE-FE", tools: ["set_allergy_severity"] },
  { id: "s17", slug: "symptom-report", tag: "NEW-BE-FE", tools: ["add_symptom"] },
  { id: "s18", slug: "interaction-flag", tag: "TRIGGER", tools: ["check_drug_interactions"] },
  { id: "s19", slug: "low-stock-reorder", tag: "VIEW", taskName: "notifications_tour", tools: ["log_refill"] },
  { id: "s20", slug: "language-voice", tag: "VIEW", taskName: "language_voice_tour", tools: [] },
  { id: "s21", slug: "doctor-question", tag: "AUDIT", tools: ["add_doctor_question"] },
  { id: "s22", slug: "emergency-contact", tag: "CONSENT", taskName: "emergency_contact_tour", tools: [] },
  { id: "s23", slug: "caregiver-care-note", tag: "NEW-BE-FE", tools: ["add_care_note"] },
  { id: "s24", slug: "caregiver-link-new", tag: "AUDIT", taskName: "link_caregiver", tools: [] },
  { id: "s25", slug: "caregiver-own-profile", tag: "NEW-FE", tools: ["update_medical_profile"] },
  { id: "s26", slug: "caregiver-elder-consent", tag: "CONSENT", taskName: "accept_caregiver_link", tools: [] },
  { id: "s27", slug: "caregiver-view-toggle", tag: "VIEW", taskName: "caregiver_view_toggle_tour", tools: [] },
  { id: "s28", slug: "patient-schedule-review", tag: "VIEW", taskName: "patient_schedule_tour", tools: ["show_schedule"] },
  { id: "s29", slug: "weekly-summary", tag: "VIEW", taskName: "weekly_summary_tour", tools: [] },
  { id: "s30", slug: "onboarding-resume", tag: "NEW-FE", taskName: "onboarding", tools: ["start_walkthrough"] },
  { id: "s31", slug: "handoff-trigger", tag: "TRIGGER", tools: [] },
  { id: "s32", slug: "feature-intro-nudge", tag: "TRIGGER", tools: ["start_walkthrough"] },
  // s33 closes two structural blind spots in the 32 above: none of them ever
  // ran a walkthrough TWICE on one elder (which is how a completed *_auto
  // silently stopped being offered), and every one of them enters through the
  // DEV hook from the home tab rather than through a real chat reply.
  { id: "s33", slug: "walkthrough-rerun", tag: "AUDIT", taskName: "add_prescription_auto", tools: ["start_walkthrough"] },
];
