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
  done: string; // short confirmation shown in chat, e.g. "Added to your schedule"
  label: string; // page name used in "opening your {label}…"
}

export const ACTION_TARGETS: Record<string, ActionTarget> = {
  add_prescription:        { elderly: "prescriptions", caregiver: "patient",  done: "Added to your schedule", label: "medications" },
  log_dose:                { elderly: "home",          caregiver: "timeline", done: "Marked as taken",        label: "schedule" },
  update_medical_profile:  { elderly: "settings",      caregiver: "patient",  done: "Profile updated",        label: "profile" },
  set_medication_reminder: { elderly: "prescriptions", caregiver: "patient",  done: "Reminder set",           label: "medications" },
  log_refill:              { elderly: "prescriptions", caregiver: "patient",  done: "Refill logged",          label: "medications" },
};

// First committed action that has a known destination, if any.
export function firstRoutableAction(actions: AgentAction[]): { action: AgentAction; target: ActionTarget } | null {
  for (const action of actions) {
    const target = ACTION_TARGETS[action.tool];
    if (target) return { action, target };
  }
  return null;
}
