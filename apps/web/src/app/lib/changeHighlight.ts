import type { Screen } from "../types";
import type { ElderlyTab } from "../screens/elderly/types";
import type { AgentAction, ChangedField } from "./hermes";

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
  allergy:           { elderly: "settings",      caregiver: "patient" },
  symptom:           { elderly: "settings",      caregiver: "patient" },
  care_note:         { elderly: "home",          caregiver: "messages" },
};

// Stable DOM id for an allergy entry — mirrors services/hermes/src/hermes/tools/
// profile.py::_allergy_slug EXACTLY (never change one side alone): lowercase,
// keep [a-z0-9], every run of any other characters becomes a single "-", then
// trim leading/trailing "-". "Penicillin G" → "penicillin-g". Used to build
// data-testid="allergy-{slug}" so set_allergy_severity highlights resolve.
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// profiles.accessibility.allergies entries come in TWO shapes: legacy plain
// strings, and {name, severity} objects once the backend's set_allergy_severity
// promoted the list (tools/profile.py::_promote_allergies). Normalize both so
// render/save code has one shape to deal with.
export type AllergyEntry = string | { name?: unknown; severity?: unknown };

export function normalizeAllergies(raw: unknown): { name: string; severity: string | null }[] {
  if (!Array.isArray(raw)) return [];
  return (raw as AllergyEntry[]).map(e => {
    if (e !== null && typeof e === "object") {
      const severity = (e as { severity?: unknown }).severity;
      return {
        name: String((e as { name?: unknown }).name ?? ""),
        severity: typeof severity === "string" && severity ? severity : null,
      };
    }
    return { name: String(e ?? ""), severity: null };
  });
}

// One resolvable "point at this record" unit. A single action is its own
// 1-element case; a BULK action (entities[] on the wire, no top-level
// entity_type/entity_id) yields one per affected entity. Extra per-entity
// payload (dose_id, slot, name, …) rides along untyped.
export interface HighlightEntity {
  entity_type: string;
  entity_id: string;
  changed_fields?: Record<string, ChangedField>;
  [k: string]: unknown;
}

// What testIdFor/findEntityElement actually need — satisfied by both a whole
// AgentAction and a single HighlightEntity, so element resolution is one code
// path for single and bulk.
type EntityRef = { entity_type?: string; entity_id?: string };

function resolvable(e: EntityRef): boolean {
  return !!e.entity_type && !!e.entity_id && e.entity_type in ENTITY_TARGETS;
}

// The resolvable entities of an action, in wire order. Single action → a
// 1-element array built from its own fields; bulk → its entities filtered to
// the ones we can actually point at. Lets ChangeHighlight treat both shapes
// uniformly.
export function highlightableEntities(a: AgentAction): HighlightEntity[] {
  if (a.entities?.length) return a.entities.filter(resolvable);
  if (resolvable(a)) {
    return [{ entity_type: a.entity_type!, entity_id: a.entity_id!, changed_fields: a.changed_fields }];
  }
  return [];
}

// A committed action that carries enough to highlight the exact record(s).
export function isHighlightable(a: AgentAction): boolean {
  return highlightableEntities(a).length > 0;
}

// First committed action this turn that we can navigate-to and highlight, if any.
// A bulk action counts as ONE action here.
export function firstHighlightable(actions: AgentAction[]): AgentAction | null {
  return actions.find(isHighlightable) ?? null;
}

export function targetFor(a: AgentAction): EntityTarget | null {
  const first = highlightableEntities(a)[0];
  if (first) return ENTITY_TARGETS[first.entity_type] ?? null;
  return a.entity_type ? ENTITY_TARGETS[a.entity_type] ?? null : null;
}

export function testIdFor(e: EntityRef): string {
  return `${e.entity_type}-${e.entity_id}`;
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

export function findEntityElement(a: EntityRef): HTMLElement | null {
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
  reminder_at: "reminder time",
  travel_start: "travel start",
  travel_end: "travel end",
  purpose: "purpose",
};

// Count fields that read better with a unit than a bare number. Kept tiny — most
// fields are self-describing via their label.
const FIELD_UNITS: Record<string, string> = {
  pills_remaining: "pill",
};

// Turn a raw backend key (snake_case OR camelCase) into a human phrase so a
// field that isn't in FIELD_LABELS can NEVER surface its raw key in the caption
// (e.g. "reminder_at" → "Reminder at", "weightKg" → "Weight kg"). Exported so the
// client walkthrough caption (orchestrate.captionFromVerify) shares one rule.
export function humanizeField(field: string): string {
  const words = field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → words
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field;
}

// Format an HH:MM (24h) string as a 12h clock ("18:00" → "6:00 PM"). SAFELY
// no-ops on anything that isn't a valid HH:MM in range, so free text / already-
// formatted values pass through untouched. Local (not medications.to12h) because
// that module pulls in the Supabase client at import time and would break here.
export function hhmmTo12h(s: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return s;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return s;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${period}`;
}

function fmt(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(fmt).join(", ");
  if (typeof v === "string") return hhmmTo12h(v);
  return String(v);
}

// Render a changed value with its field's unit (+ pluralization) when it has one,
// e.g. pills_remaining 1 → "1 pill", 30 → "30 pills". Falls back to plain fmt.
function fmtValue(field: string, v: unknown): string {
  const unit = FIELD_UNITS[field];
  if (unit && typeof v === "number") return `${v} ${v === 1 ? unit : `${unit}s`}`;
  return fmt(v);
}

// Cap on how many changed fields we spell out before collapsing the tail to
// "+k more" — keeps a multi-field caption from overflowing the pill at 900/1280px.
const MAX_FIELDS = 3;

// Build the highlight caption FROM changed_fields, so it's accurate to what
// actually changed — never a generic "success". Returns a verb + detail, e.g.
// {verb: "Added", text: "Metformin 500mg — 08:00 (daily)"} or
// {verb: "Updated", text: "dose time 6:00 PM → 8:00 PM"}.
export function describeChange(a: AgentAction): { verb: string; text: string } {
  const entries = Object.entries(a.changed_fields ?? {});
  // A logged dose reads as "Taken: Metformin", not the raw "status pending → taken"
  // field diff — the verb IS the change.
  if (a.tool === "log_dose" || a.changed_fields?.status?.after === "taken") {
    return { verb: "Taken", text: a.summary || a.name || "dose" };
  }
  // Undo: a mistaken tick flipped back — the verb IS the change.
  if (a.changed_fields?.status?.before === "taken" && a.changed_fields?.status?.after === "pending") {
    return { verb: "Unmarked", text: a.name || a.summary || "dose" };
  }
  // Discontinue: archived, never deleted — reads as "Stopped: <name>".
  if (a.changed_fields?.status?.after === "discontinued") {
    return { verb: "Stopped", text: a.name || a.summary || "medication" };
  }
  // Snooze: today's reminder moved (schedule unchanged). Before the all-new
  // branch — a first snooze has before == null and must not read as "Added".
  const snoozed = a.changed_fields?.snoozed_until;
  if (snoozed) {
    return { verb: "Snoozed", text: `reminder to ${hhmmTo12h(String(snoozed.after ?? ""))} today` };
  }
  // Allergy severity grade — "Updated: Penicillin allergy — unset → severe".
  const severity = a.changed_fields?.severity;
  if (severity) {
    const name = a.name?.trim();
    const before = severity.before == null ? "unset" : String(severity.before);
    return {
      verb: "Updated",
      text: `${name ? `${name} allergy` : "allergy"} — ${before} → ${String(severity.after ?? "")}`,
    };
  }
  // Symptom report — "Noted: dizzy after lunch"; also before the all-new branch
  // (a new report is all-new by shape but must not read as a bare "Added").
  const symptom = a.changed_fields?.symptom;
  if (symptom || a.tool === "add_symptom") {
    return { verb: "Noted", text: String(symptom?.after ?? "") || a.summary || "symptom" };
  }
  const allNew = entries.length > 0 && entries.every(([, f]) => f.before == null);
  if (allNew || a.tool === "add_prescription") {
    return { verb: "Added", text: a.summary || a.name || "new item" };
  }
  const changed = entries.filter(([, f]) => JSON.stringify(f.before) !== JSON.stringify(f.after));
  // Nothing visibly changed: use the summary (or name) — never a dangling
  // "Updated:" with empty text.
  if (changed.length === 0) {
    return { verb: "Updated", text: a.summary?.trim() || a.name?.trim() || "no changes" };
  }
  const lone = changed.length === 1;
  const shown = changed.slice(0, MAX_FIELDS);
  const overflow = changed.length - shown.length;
  const parts = shown.map(([field, f]) => {
    const label = FIELD_LABELS[field] ?? humanizeField(field);
    const before = fmtValue(field, f.before);
    const after = fmtValue(field, f.after);
    // Long free-text (e.g. the medical-profile blob) reads badly as "a → b";
    // show just the field label — the caption still says WHICH field changed.
    if (before.length > 40 || after.length > 40) return label;
    // A lone dosage change reads cleanest without the "dose" prefix: the values
    // already carry the unit ("500mg → 1000mg").
    const prefix = lone && field === "dosage" ? "" : `${label} `;
    if (before && after) return `${prefix}${before} → ${after}`;
    if (after) return `${prefix}${after}`;
    return label;
  });
  const text = overflow > 0 ? `${parts.join("; ")}; +${overflow} more` : parts.join("; ");
  return { verb: "Updated", text };
}

// Caption for an action that may be BULK. Non-bulk actions (and a 1-entity bulk,
// which reads exactly like a single change built from that entity's fields) go
// through describeChange; a real batch gets ONE count-style caption — the verb
// classified the same way describeChange does (taken / all-new / updated), the
// text preferring the backend summary (already human, e.g. "3 missed doses
// marked taken"). Never leaks raw field names: the fallback texts are counts,
// and the single path reuses describeChange's humanize/format helpers.
export function describeBatch(a: AgentAction): { verb: string; text: string } {
  const ents = highlightableEntities(a);
  if (!a.entities || ents.length === 0) return describeChange(a);
  if (ents.length === 1) {
    const e = ents[0];
    return describeChange({
      ...a,
      entity_type: e.entity_type,
      entity_id: e.entity_id,
      changed_fields: e.changed_fields ?? a.changed_fields,
      name: typeof e.name === "string" ? e.name : a.name,
    });
  }
  const n = ents.length;
  const summary = a.summary?.trim();
  const allTaken = ents.every(e => e.changed_fields?.status?.after === "taken");
  if (a.tool === "resolve_missed_doses" || allTaken) {
    return { verb: "Taken", text: summary || `${n} doses marked taken` };
  }
  const allNew = ents.every(e => {
    const fields = Object.values(e.changed_fields ?? {});
    return fields.length > 0 && fields.every(f => f.before == null);
  });
  if (allNew) return { verb: "Added", text: summary || `${n} items added` };
  return { verb: "Updated", text: summary || `${n} items updated` };
}
