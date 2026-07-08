import { supabase } from "./supabase";
import type { ExtractedProfile } from "./hermes";

export type Role = "elder" | "caregiver";

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
  allergies?: string[];
  drugAllergies?: string[];
  mealTimes?: { breakfast?: string; lunch?: string; dinner?: string };
  sleepTime?: string;
  travelPlan?: { startDate: string; endDate: string; timezone: string };
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
  return {
    ...existing,
    dob: existing.dob ?? incoming.dob,
    weightKg: existing.weightKg ?? incoming.weightKg,
    heightCm: existing.heightCm ?? incoming.heightCm,
    gender: existing.gender ?? incoming.gender,
    conditions: unionList(existing.conditions, incoming.conditions),
    allergies: unionList(existing.allergies, incoming.allergies),
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

export async function fetchProfileRole(userId: string): Promise<Role | null> {
  const { data } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
  return (data?.role as Role | undefined) ?? null;
}

export async function fetchProfile(userId: string): Promise<{ fullName: string | null; details: ProfileDetails } | null> {
  const { data } = await supabase.from("profiles").select("full_name,accessibility").eq("id", userId).maybeSingle();
  if (!data) return null;
  return { fullName: data.full_name ?? null, details: (data.accessibility as ProfileDetails) ?? {} };
}
