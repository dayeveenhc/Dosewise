import type { Screen } from "../types";
import type { ElderlyTab } from "../screens/elderly/types";
import type { AgentAction } from "./hermes";

// Where a committed change lives, per interface. ChangeHighlight navigates here,
// then finds the exact record on-screen by data-testid="{entity_type}-{entity_id}".
// Keyed by entity_type (what changed), NOT by tool name — several tools can write
// the same kind of record. Replaces the old tool-name→screen ACTION_TARGETS map
// as the canonical "where did this land" source for the flows it covers.
interface EntityTarget {
  elderly: ElderlyTab;
  caregiver: Screen;
}

export const ENTITY_TARGETS: Record<string, EntityTarget> = {
  medication:        { elderly: "prescriptions", caregiver: "patient" },
  schedule_entry:    { elderly: "prescriptions", caregiver: "patient" },
  refill_request:    { elderly: "prescriptions", caregiver: "patient" },
  dose:              { elderly: "home",          caregiver: "timeline" },
  profile_field:     { elderly: "settings",      caregiver: "patient" },
  travel_plan:       { elderly: "home",          caregiver: "patient" },
  doctor_message:    { elderly: "ai",            caregiver: "messages" },
  caregiver_message: { elderly: "notifications", caregiver: "messages" },
  caregiver_invite:  { elderly: "notifications", caregiver: "patient" },
  escalation:        { elderly: "ai",            caregiver: "notifications" },
};

// A committed action that carries enough to highlight the exact record.
export function isHighlightable(a: AgentAction): boolean {
  return !!a.entity_type && !!a.entity_id && a.entity_type in ENTITY_TARGETS;
}

// First committed action this turn that we can navigate-to and highlight, if any.
export function firstHighlightable(actions: AgentAction[]): AgentAction | null {
  return actions.find(isHighlightable) ?? null;
}

export function targetFor(a: AgentAction): EntityTarget | null {
  return a.entity_type ? ENTITY_TARGETS[a.entity_type] ?? null : null;
}

export function testIdFor(a: AgentAction): string {
  return `${a.entity_type}-${a.entity_id}`;
}

// Resolve the DOM element for a change. Prefer the exact
// data-testid="{entity_type}-{entity_id}"; fall back to any element whose testid
// ENDS WITH "-{entity_id}" — because one visible record (e.g. a medication card
// tagged `medication-<uuid>`) is the highlight target for several entity_types
// that share that id (a `schedule_entry` or `refill_request` change to the same
// medication). entity_ids are DB uuids / stable field keys, so the suffix is
// unambiguous.
function cssEscape(value: string): string {
  // CSS.escape isn't present in every environment (e.g. jsdom); fall back to a
  // conservative manual escape. entity_ids are DB uuids / simple field keys.
  const esc = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape;
  return esc ? esc(value) : value.replace(/["\\\]]/g, "\\$&");
}

export function findEntityElement(a: AgentAction): HTMLElement | null {
  const exact = document.querySelector<HTMLElement>(`[data-testid="${testIdFor(a)}"]`);
  if (exact) return exact;
  const id = a.entity_id;
  if (!id) return null;
  const candidates = document.querySelectorAll<HTMLElement>(`[data-testid$="-${cssEscape(id)}"]`);
  return candidates.length ? candidates[0] : null;
}

const FIELD_LABELS: Record<string, string> = {
  times: "dose time",
  days: "days",
  pills_remaining: "supply",
  medical_profile: "medical profile",
  schedule: "schedule",
  question: "question",
  message: "message",
  reason: "reason",
  status: "status",
  name: "name",
  dosage: "dose",
  frequency: "frequency",
};

function fmt(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(fmt).join(", ");
  return String(v);
}

// Build the highlight caption FROM changed_fields, so it's accurate to what
// actually changed — never a generic "success". Returns a verb + detail, e.g.
// {verb: "Added", text: "Metformin 500mg — 08:00 (daily)"} or
// {verb: "Updated", text: "dose time 6:00 PM → 8:00 PM"}.
export function describeChange(a: AgentAction): { verb: string; text: string } {
  const entries = Object.entries(a.changed_fields ?? {});
  const allNew = entries.length > 0 && entries.every(([, f]) => f.before == null);
  if (allNew || a.tool === "add_prescription") {
    return { verb: "Added", text: a.summary || a.name || "new item" };
  }
  const changed = entries.filter(([, f]) => JSON.stringify(f.before) !== JSON.stringify(f.after));
  if (changed.length === 0) return { verb: "Updated", text: a.summary || "" };
  const parts = changed.map(([field, f]) => {
    const label = FIELD_LABELS[field] ?? field;
    const before = fmt(f.before);
    const after = fmt(f.after);
    // Long free-text (e.g. the medical-profile blob) reads badly as "a → b";
    // show just the field label — the caption still says WHICH field changed.
    if (before.length > 40 || after.length > 40) return label;
    if (before && after) return `${label} ${before} → ${after}`;
    if (after) return `${label} ${after}`;
    return label;
  });
  return { verb: "Updated", text: parts.join("; ") };
}
