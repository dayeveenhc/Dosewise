import { supabase } from "./supabase";
import type { ExtractedProfile } from "./hermes";
import { normalizeAllergies } from "./changeHighlight";
import type { AllergyEntry } from "./changeHighlight";
import type { MealTimes } from "../types";

export type Role = "elder" | "caregiver";

// A symptom the elder reported via Mei's add_symptom tool — written by the
// backend (services/hermes tools/symptoms.py) into accessibility.symptom_reports,
// snake_case keys as stored.
export interface SymptomReport {
  id: string;
  symptom: string;
  noted_at: string; // ISO timestamp
  medication_id?: string;
  medication_name?: string;
}

// A one-time reminder snooze written by Mei's snooze_dose tool (services/hermes
// tools/doses.py) into accessibility.dose_snoozes — one entry per
// (medication_id, slot, date), snake_case keys as stored.
export interface DoseSnooze {
  medication_id: string;
  name?: string;
  slot: string;  // HH:MM (24h) — the scheduled slot being snoozed
  date: string;  // YYYY-MM-DD, elder-local
  until: string; // HH:MM (24h)
}

// Fields the guided setup wizard collects that have no dedicated column on
// public.profiles (age/weight/height/gender/allergies/routine) — stored inside
// the existing accessibility jsonb column since adding real columns means a
// Supabase migration, which is out of apps/web's scope. Flagged as a known
// workaround, not a permanent home for this data.
export interface ProfileDetails {
  // Legacy: profiles saved before date-of-birth collection was added only have
  // this. Kept read-only for backward compatibility — new saves write `dob`.
  age?: number;
  dob?: string; // ISO date (YYYY-MM-DD); age is derived from this via calculateAge
  weightKg?: number;
  heightCm?: number;
  gender?: string;
  conditions?: string[];
  // Legacy plain strings, promoted in place to {name, severity} objects the
  // first time the backend's set_allergy_severity grades one — handle BOTH
  // shapes wherever this is read (lib/changeHighlight.ts's normalizeAllergies).
  allergies?: AllergyEntry[];
  drugAllergies?: string[];
  wakeTime?: string;
  mealTimes?: MealTimes;
  sleepTime?: string;
  travelPlan?: { startDate: string; endDate: string; timezone: string };
  // Walkthrough task_names this user has completed (lib/walkthrough/types.ts's
  // WalkthroughTaskName) — needs to survive across devices/sessions since it
  // drives Mei's own proactive-offer behaviour server-side (threaded into
  // /agent/turn as completed_walkthroughs), which a client-only localStorage
  // flag could never do. Written via markWalkthroughCompleted's read-merge-write,
  // never a bare saveProfile() overwrite (see that function's own note).
  completedWalkthroughs?: string[];
  // Backend-written (snake_case, services/hermes tools) — read-only here.
  symptom_reports?: SymptomReport[];
  dose_snoozes?: DoseSnooze[];
}

// A medication draft the guided wizard's MedList edits (name/dose/time). Mirrors
// the wizard's local DraftMed shape without importing from a screen.
export interface PrefillMed { name: string; dose: string; time: string }

// Everything the guided setup wizard can pre-fill from an uploaded record.
export interface WizardPrefill {
  fullName?: string;
  details: ProfileDetails;
  currentMeds: PrefillMed[];
  pastMeds: PrefillMed[];
}

const HHMM = /^\d{1,2}:\d{2}$/;
function normalizeTime(time?: string): string {
  // The wizard's finish() runs to24h(time); keep a clean HH:MM, else a sensible
  // default the user can adjust rather than a free-text time like "morning".
  return time && HHMM.test(time.trim()) ? time.trim() : "08:00";
}
function toPrefillMeds(meds?: ExtractedProfile["current_meds"]): PrefillMed[] {
  return (meds ?? [])
    .filter(m => (m.name ?? "").trim())
    .map(m => ({ name: (m.name ?? "").trim(), dose: (m.dose ?? "").trim(), time: normalizeTime(m.time) }));
}

// Map the backend's snake_case extraction into the camelCase ProfileDetails the
// app stores (profiles.accessibility jsonb), dropping empties.
export function toProfileDetails(fields: ExtractedProfile): ProfileDetails {
  const details: ProfileDetails = {};
  if (fields.dob) details.dob = fields.dob;
  if (typeof fields.weight_kg === "number") details.weightKg = fields.weight_kg;
  if (typeof fields.height_cm === "number") details.heightCm = fields.height_cm;
  if (fields.gender) details.gender = fields.gender;
  if (fields.conditions?.length) details.conditions = fields.conditions;
  if (fields.allergies?.length) details.allergies = fields.allergies;
  if (fields.drug_allergies?.length) details.drugAllergies = fields.drug_allergies;
  return details;
}

// Build the wizard's pre-fill bundle from an extraction result.
export function buildWizardPrefill(fields: ExtractedProfile): WizardPrefill {
  return {
    fullName: fields.full_name?.trim() || undefined,
    details: toProfileDetails(fields),
    currentMeds: toPrefillMeds(fields.current_meds),
    pastMeds: toPrefillMeds(fields.past_meds),
  };
}

// Merge extracted fields into an existing profile for the in-app "Update
// profile" flow: fill missing scalars, union the array fields (no duplicates,
// case-insensitive). Existing values win for scalars so we never silently
// overwrite something the user already set.
export function mergeProfileDetails(existing: ProfileDetails, incoming: ProfileDetails): ProfileDetails {
  const unionList = (a?: string[], b?: string[]): string[] | undefined => {
    const merged = [...(a ?? [])];
    for (const item of b ?? []) {
      if (!merged.some(x => x.toLowerCase() === item.toLowerCase())) merged.push(item);
    }
    return merged.length ? merged : undefined;
  };
  // Allergies can be legacy strings or promoted {name, severity} objects —
  // dedupe by NAME, and never flatten an existing entry (its severity survives).
  const unionAllergies = (a?: AllergyEntry[], b?: AllergyEntry[]): AllergyEntry[] | undefined => {
    const merged = [...(a ?? [])];
    const names = normalizeAllergies(merged).map(x => x.name.toLowerCase());
    for (const item of b ?? []) {
      const name = normalizeAllergies([item])[0]?.name.toLowerCase() ?? "";
      if (name && !names.includes(name)) {
        merged.push(item);
        names.push(name);
      }
    }
    return merged.length ? merged : undefined;
  };
  return {
    ...existing,
    dob: existing.dob ?? incoming.dob,
    weightKg: existing.weightKg ?? incoming.weightKg,
    heightCm: existing.heightCm ?? incoming.heightCm,
    gender: existing.gender ?? incoming.gender,
    conditions: unionList(existing.conditions, incoming.conditions),
    allergies: unionAllergies(existing.allergies, incoming.allergies),
    drugAllergies: unionList(existing.drugAllergies, incoming.drugAllergies),
  };
}

export function calculateAge(dob: string): number {
  const birth = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const hadBirthdayThisYear = now.getMonth() > birth.getMonth()
    || (now.getMonth() === birth.getMonth() && now.getDate() >= birth.getDate());
  if (!hadBirthdayThisYear) age--;
  return age;
}

export async function saveProfile(
  userId: string, role: Role, fullName: string, details: ProfileDetails
): Promise<void> {
  const { error } = await supabase.from("profiles").upsert({
    id: userId,
    role,
    full_name: fullName || null,
    accessibility: details,
  });
  if (error) throw error;
}

// Read-merge-write a single completed walkthrough into profiles.accessibility
// (a jsonb catch-all shared with the medical profile, travel plan, etc. —
// saveProfile() itself does a blind overwrite, so every write into this column
// must fetch-merge-write like this, never call saveProfile with a partial
// details object built from scratch).
export async function markWalkthroughCompleted(userId: string, role: Role, taskName: string): Promise<void> {
  const existing = await fetchProfile(userId);
  const completed = existing?.details.completedWalkthroughs ?? [];
  if (completed.includes(taskName)) return;
  await saveProfile(userId, role, existing?.fullName ?? "", {
    ...(existing?.details ?? {}),
    completedWalkthroughs: [...completed, taskName],
  });
}

export async function fetchProfileRole(userId: string): Promise<Role | null> {
  const { data } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
  return (data?.role as Role | undefined) ?? null;
}

export async function fetchProfile(userId: string): Promise<{ fullName: string | null; details: ProfileDetails } | null> {
  const { data } = await supabase.from("profiles").select("full_name,accessibility").eq("id", userId).maybeSingle();
  if (!data) return null;
  return { fullName: data.full_name ?? null, details: (data.accessibility as ProfileDetails) ?? {} };
}
