import { supabase } from "./supabase";

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
