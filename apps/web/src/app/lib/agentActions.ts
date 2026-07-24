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
}

export const ACTION_TARGETS: Record<string, ActionTarget> = {
  add_prescription:        { elderly: "home",          caregiver: "patient",  doneKey: "ai.doneAddPrescription", labelKey: "ai.labelMedications" },
  log_dose:                { elderly: "home",          caregiver: "timeline", doneKey: "ai.doneLogDose",         labelKey: "ai.labelSchedule" },
  update_medical_profile:  { elderly: "settings",      caregiver: "patient",  doneKey: "ai.doneUpdateProfile",   labelKey: "ai.labelProfile" },
  set_medication_reminder: { elderly: "prescriptions", caregiver: "patient",  doneKey: "ai.doneSetReminder",     labelKey: "ai.labelMedications" },
  log_refill:              { elderly: "prescriptions", caregiver: "patient",  doneKey: "ai.doneLogRefill",       labelKey: "ai.labelMedications" },
};

// First committed action that has a known destination, if any.
export function firstRoutableAction(actions: AgentAction[]): { action: AgentAction; target: ActionTarget } | null {
  for (const action of actions) {
    const target = ACTION_TARGETS[action.tool];
    if (target) return { action, target };
  }
  return null;
}
