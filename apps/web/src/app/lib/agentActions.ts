import type { Screen } from "../types";
import type { ElderlyTab } from "../screens/elderly/types";
import type { AgentAction } from "./hermes";

// When the agent actually commits a write in chat, we confirm it and redirect to
// the page that shows the change — so Mei guides the user there instead of
// leaving them to check manually. This maps each committed tool to its
// destination (per interface) and the confirmation copy.
interface ActionTarget {
  elderly: ElderlyTab;
  caregiver: Screen;
  doneKey: string; // t() key for the short confirmation shown in chat, e.g. "Added to your schedule"
  labelKey: string; // t() key for the page name used in "opening your {label}…"
  // Whether this tool takes a `confirmed` param (propose→confirm) — the model
  // calls it once to propose (writing nothing) and again to commit. A live
  // `tool_end` SSE event fires for BOTH calls with no signal of which; only a
  // tool with no confirm step (this false) can be trusted to have written on
  // tool_end alone. Propose→confirm tools must wait for the turn's final
  // `actions[]` (real committed_actions), or a propose turn falsely navigates
  // as if it saved. Ground truth: grep each handler's signature for `confirmed`.
  confirmFirst?: boolean;
}

export const ACTION_TARGETS: Record<string, ActionTarget> = {
  add_prescription:        { elderly: "home",          caregiver: "patient",  doneKey: "ai.doneAddPrescription", labelKey: "ai.labelMedications", confirmFirst: true },
  log_dose:                { elderly: "home",          caregiver: "timeline", doneKey: "ai.doneLogDose",         labelKey: "ai.labelSchedule" },
  update_medical_profile:  { elderly: "settings",      caregiver: "patient",  doneKey: "ai.doneUpdateProfile",   labelKey: "ai.labelProfile", confirmFirst: true },
  set_medication_reminder: { elderly: "prescriptions", caregiver: "patient",  doneKey: "ai.doneSetReminder",     labelKey: "ai.labelMedications", confirmFirst: true },
  log_refill:              { elderly: "prescriptions", caregiver: "patient",  doneKey: "ai.doneLogRefill",       labelKey: "ai.labelMedications" },
  update_medication_dosage:{ elderly: "prescriptions", caregiver: "patient",  doneKey: "ai.doneUpdateDosage",    labelKey: "ai.labelMedications", confirmFirst: true },
  log_doses:               { elderly: "home",          caregiver: "timeline", doneKey: "ai.doneLogDose",         labelKey: "ai.labelSchedule", confirmFirst: true },
  undo_dose:               { elderly: "home",          caregiver: "timeline", doneKey: "ai.doneUndoDose",        labelKey: "ai.labelSchedule" },
  snooze_dose:             { elderly: "home",          caregiver: "timeline", doneKey: "ai.doneSnoozeDose",      labelKey: "ai.labelSchedule" },
  discontinue_medication:  { elderly: "prescriptions", caregiver: "patient",  doneKey: "ai.doneDiscontinue",     labelKey: "ai.labelMedications", confirmFirst: true },
  set_allergy_severity:    { elderly: "settings",      caregiver: "patient",  doneKey: "ai.doneAllergySeverity", labelKey: "ai.labelProfile", confirmFirst: true },
  add_symptom:             { elderly: "settings",      caregiver: "patient",  doneKey: "ai.doneAddSymptom",      labelKey: "ai.labelProfile" },
  add_care_note:           { elderly: "home",          caregiver: "messages", doneKey: "ai.doneAddCareNote",     labelKey: "ai.labelMessages" },
};

// First committed action that has a known destination, if any.
export function firstRoutableAction(actions: AgentAction[]): { action: AgentAction; target: ActionTarget } | null {
  for (const action of actions) {
    const target = ACTION_TARGETS[action.tool];
    if (target) return { action, target };
  }
  return null;
}
