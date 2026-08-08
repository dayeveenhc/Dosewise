import type { Screen } from "../types";
import type { ElderlyTab } from "../screens/elderly/types";
import type { AgentAction, ChangedField } from "./hermes";
import { localizeCatalogValue } from "../data/medications";
import { t } from "./language";
import type { AppLanguage } from "./language";

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
  doctor_message:    { elderly: "notifications", caregiver: "messages" },
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

// How a caption is rendered FOR A PARTICULAR READER: their app language plus
// the 12h/24h clock preference (accessibility.tsx's `timeFormat`). Threaded in
// rather than read here, because this module is React-free and its React caller
// (ChangeHighlight.tsx) already holds both. Omitting it yields the English, 12h
// strings this module has always produced — which is what the unit tests and any
// non-UI caller expect.
export interface CaptionOptions {
  language?: AppLanguage;
  timeFormat?: "12h" | "24h";
}

function phrase(opts: CaptionOptions | undefined, key: string, params?: Record<string, string | number>): string {
  return t(opts?.language ?? "en", key, params);
}

// The caption's own vocabulary lives in language.ts like every other piece of
// user-facing copy; these maps only say WHICH key a backend field/unit uses.
const FIELD_LABEL_KEYS: Record<string, string> = {
  times: "caption.field.times",
  days: "caption.field.days",
  pills_remaining: "caption.field.pillsRemaining",
  medical_profile: "caption.field.medicalProfile",
  schedule: "caption.field.schedule",
  question: "caption.field.question",
  message: "caption.field.message",
  reason: "caption.field.reason",
  status: "caption.field.status",
  name: "caption.field.name",
  dosage: "caption.field.dosage",
  frequency: "caption.field.frequency",
  reminder_at: "caption.field.reminderAt",
  travel_start: "caption.field.travelStart",
  travel_end: "caption.field.travelEnd",
  purpose: "caption.field.purpose",
  // Client-walkthrough profile fields (orchestrate.captionFromVerify).
  weightKg: "caption.field.weight",
  heightCm: "caption.field.height",
  dob: "caption.field.dob",
  gender: "caption.field.gender",
};

// Count fields that read better with a unit than a bare number. Kept tiny — most
// fields are self-describing via their label. The `.one`/`.other` suffix is
// appended to the key, so a language pluralizes (or doesn't) in its own map.
const FIELD_UNIT_KEYS: Record<string, string> = {
  pills_remaining: "caption.unit.pill",
};

// The label for a changed field: a translated phrase when we know the field, and
// otherwise a human-readable rendering of the raw backend key (snake_case OR
// camelCase) so it can NEVER surface as "snooze_minutes" in a caption. That
// fallback stays ENGLISH on purpose — the key is arbitrary backend vocabulary,
// and guessing a translation for it is the same mistake as guessing a catalog
// match for free text. Exported so the client walkthrough caption
// (orchestrate.captionFromVerify) shares one rule.
export function humanizeField(field: string, opts?: CaptionOptions): string {
  const key = FIELD_LABEL_KEYS[field];
  if (key) return phrase(opts, key);
  const words = field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → words
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field;
}

// Format an HH:MM (24h) string as a clock the reader can read: their 12h/24h
// setting, and — in 12h — the AM/PM word and its position from their language
// ("18:00" → "6:00 PM" / "下午6:00"). SAFELY no-ops on anything that isn't a
// valid HH:MM in range, so free text / already-formatted values pass through
// untouched. Local (not medications.to12h) because that module pulls in the
// Supabase client at import time and would break here.
//
// NEVER call this point-free inside `Array.map` — map hands a callback the
// index, which would land in `opts`. Use `xs.map(x => hhmmTo12h(x))`, and pass
// options only where a PERSON reads the result: comparisons against the app's
// own stored 12h labels (walkthrough/verify.ts) must stay unlocalized.
export function hhmmTo12h(s: string, opts?: CaptionOptions): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return s;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return s;
  if (opts?.timeFormat === "24h") return `${String(h).padStart(2, "0")}:${m[2]}`;
  const period = phrase(opts, h >= 12 ? "caption.pm" : "caption.am");
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return phrase(opts, "caption.clock12h", { time: `${h12}:${m[2]}`, period });
}

function fmt(v: unknown, opts?: CaptionOptions): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(x => fmt(x, opts)).join(", ");
  if (typeof v === "string") return hhmmTo12h(v, opts);
  return String(v);
}

// Render a changed value with its field's unit (+ pluralization) when it has one,
// e.g. pills_remaining 1 → "1 pill", 30 → "30 pills". Falls back to plain fmt.
function fmtValue(field: string, v: unknown, opts?: CaptionOptions): string {
  const unit = FIELD_UNIT_KEYS[field];
  if (unit && typeof v === "number") return phrase(opts, `${unit}.${v === 1 ? "one" : "other"}`, { count: v });
  return fmt(v, opts);
}

// Cap on how many changed fields we spell out before collapsing the tail to
// "+k more" — keeps a multi-field caption from overflowing the pill at 900/1280px.
const MAX_FIELDS = 3;

// Build the highlight caption FROM changed_fields, so it's accurate to what
// actually changed — never a generic "success". Returns a verb + detail, e.g.
// {verb: "Added", text: "Metformin 500mg — 08:00 (daily)"} or
// {verb: "Updated", text: "dose time 6:00 PM → 8:00 PM"}.
export function describeChange(a: AgentAction, opts?: CaptionOptions): { verb: string; text: string } {
  const p = (key: string, params?: Record<string, string | number>) => phrase(opts, key, params);
  const verb = (name: string) => p(`caption.verb.${name}`);
  const entries = Object.entries(a.changed_fields ?? {});
  // A logged dose reads as "Taken: Metformin", not the raw "status pending → taken"
  // field diff — the verb IS the change.
  if (a.tool === "log_dose" || a.changed_fields?.status?.after === "taken") {
    return { verb: verb("taken"), text: a.summary || a.name || p("caption.dose") };
  }
  // Undo: a mistaken tick flipped back — the verb IS the change.
  if (a.changed_fields?.status?.before === "taken" && a.changed_fields?.status?.after === "pending") {
    return { verb: verb("unmarked"), text: a.name || a.summary || p("caption.dose") };
  }
  // Discontinue: archived, never deleted — reads as "Stopped: <name>".
  if (a.changed_fields?.status?.after === "discontinued") {
    return { verb: verb("stopped"), text: a.name || a.summary || p("caption.medication") };
  }
  // Snooze: today's reminder moved (schedule unchanged). Before the all-new
  // branch — a first snooze has before == null and must not read as "Added".
  const snoozed = a.changed_fields?.snoozed_until;
  if (snoozed) {
    return { verb: verb("snoozed"), text: p("caption.snoozedTo", { time: hhmmTo12h(String(snoozed.after ?? ""), opts) }) };
  }
  // Allergy severity grade — "Updated: Penicillin allergy — unset → severe".
  // The grade words themselves are backend vocabulary and pass through as sent.
  const severity = a.changed_fields?.severity;
  if (severity) {
    const name = a.name?.trim();
    const before = severity.before == null ? p("caption.severityUnset") : String(severity.before);
    return {
      verb: verb("updated"),
      text: `${name ? p("caption.allergyOf", { name }) : p("caption.allergy")} — ${before} → ${String(severity.after ?? "")}`,
    };
  }
  // Symptom report — "Noted: dizzy after lunch"; also before the all-new branch
  // (a new report is all-new by shape but must not read as a bare "Added").
  const symptom = a.changed_fields?.symptom;
  if (symptom || a.tool === "add_symptom") {
    return { verb: verb("noted"), text: String(symptom?.after ?? "") || a.summary || p("caption.symptom") };
  }
  const allNew = entries.length > 0 && entries.every(([, f]) => f.before == null);
  if (allNew || a.tool === "add_prescription") {
    return { verb: verb("added"), text: a.summary || a.name || p("caption.newItem") };
  }
  const changed = entries.filter(([, f]) => JSON.stringify(f.before) !== JSON.stringify(f.after));
  // Nothing visibly changed: use the summary (or name) — never a dangling
  // "Updated:" with empty text.
  if (changed.length === 0) {
    return { verb: verb("updated"), text: a.summary?.trim() || a.name?.trim() || p("caption.noChanges") };
  }
  const lone = changed.length === 1;
  const shown = changed.slice(0, MAX_FIELDS);
  const overflow = changed.length - shown.length;
  const parts = shown.map(([field, f]) => {
    const label = humanizeField(field, opts);
    const before = fmtValue(field, f.before, opts);
    const after = fmtValue(field, f.after, opts);
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
  const text = overflow > 0 ? `${parts.join("; ")}; ${p("caption.andMore", { count: overflow })}` : parts.join("; ");
  return { verb: verb("updated"), text };
}

// Caption for an action that may be BULK. Non-bulk actions (and a 1-entity bulk,
// which reads exactly like a single change built from that entity's fields) go
// through describeChange; a real batch gets ONE count-style caption — the verb
// classified the same way describeChange does (taken / all-new / updated), the
// text preferring the backend summary (already human, e.g. "3 missed doses
// marked taken"). Never leaks raw field names: the fallback texts are counts,
// and the single path reuses describeChange's humanize/format helpers.
export function describeBatch(a: AgentAction, opts?: CaptionOptions): { verb: string; text: string } {
  const p = (key: string, params?: Record<string, string | number>) => phrase(opts, key, params);
  const verb = (name: string) => p(`caption.verb.${name}`);
  const ents = highlightableEntities(a);
  if (!a.entities || ents.length === 0) return describeChange(a, opts);
  if (ents.length === 1) {
    const e = ents[0];
    return describeChange({
      ...a,
      entity_type: e.entity_type,
      entity_id: e.entity_id,
      changed_fields: e.changed_fields ?? a.changed_fields,
      name: typeof e.name === "string" ? e.name : a.name,
    }, opts);
  }
  const n = ents.length;
  const summary = a.summary?.trim();
  const allTaken = ents.every(e => e.changed_fields?.status?.after === "taken");
  if (a.tool === "resolve_missed_doses" || allTaken) {
    return { verb: verb("taken"), text: summary || p("caption.dosesTaken", { count: n }) };
  }
  const allNew = ents.every(e => {
    const fields = Object.values(e.changed_fields ?? {});
    return fields.length > 0 && fields.every(f => f.before == null);
  });
  if (allNew) return { verb: verb("added"), text: summary || p("caption.itemsAdded", { count: n }) };
  return { verb: verb("updated"), text: summary || p("caption.itemsUpdated", { count: n }) };
}

// The caption vocabulary a NON-REACT caption producer needs: the client
// walkthrough's `orchestrate.captionFromVerify` builds its captions outside any
// provider, so it resolves the reader's settings from the very keys
// LanguageProvider (lib/languageContext.tsx) and AccessibilityProvider
// (app/accessibility.tsx) persist on every change. React callers never use this
// — they pass their own CaptionOptions (see components/ChangeHighlight.tsx).
const LANGUAGE_STORAGE_KEY = "dosewise-language";
const ACCESSIBILITY_STORAGE_KEY = "dosewise:accessibility";

function storedCaptionOptions(): CaptionOptions {
  if (typeof window === "undefined") return {};
  const read = (key: string) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const language = read(LANGUAGE_STORAGE_KEY) as AppLanguage | null;
  let timeFormat: CaptionOptions["timeFormat"];
  try {
    timeFormat = JSON.parse(read(ACCESSIBILITY_STORAGE_KEY) ?? "{}")?.timeFormat;
  } catch {
    timeFormat = undefined;
  }
  return { language: language ?? undefined, timeFormat: timeFormat === "24h" ? "24h" : "12h" };
}

export interface ReaderCaption {
  options: CaptionOptions;
  verb: (name: string) => string;
  phrase: (key: string, params?: Record<string, string | number>) => string;
  /** A stored catalog value (condition/allergy/purpose) in the reader's language. */
  value: (value: string) => string;
}

export function readerCaption(): ReaderCaption {
  const options = storedCaptionOptions();
  const say = (key: string, params?: Record<string, string | number>) => phrase(options, key, params);
  return {
    options,
    phrase: say,
    verb: name => say(`caption.verb.${name}`),
    value: value => localizeCatalogValue(value, key => say(key)),
  };
}
