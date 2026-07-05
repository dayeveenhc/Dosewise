// Real data layer — replaces the mock arrays in patients.ts.
//
// Schema note (see supabase/migrations/): `medications` is the drug record;
// `doses` is one row per *logged* instance. Per
// services/hermes/src/hermes/dosing.py: "the full dose calendar (materializing
// `doses` rows for a UI) is deferred until the frontend lands" — Hermes only
// ever computes due slots on the fly from `medications.schedule.times` and
// writes a `doses` row at the moment something is actually logged taken. So
// today's schedule doesn't pre-exist as rows; we materialize it here from
// `schedule.times`, then overlay any `doses` rows already logged today.
import { supabase, createScopedClient } from "../lib/supabase";
import type { Patient, Medication, Contact, Message } from "../types";

export interface Profile {
  id: string;
  role: "elder" | "caregiver";
  full_name: string | null;
  dialect: string | null;
}

const MED_COLOURS = ["#0D5C8A", "#2E7D32", "#7B3F9E", "#C05621", "#B91C1C", "#0E7490"];

function colourFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return MED_COLOURS[Math.abs(hash) % MED_COLOURS.length];
}

function to12Hour(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

function startOfTodayISO(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// --- profile -----------------------------------------------------------

export async function fetchMyProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id,role,full_name,dialect")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// --- patients (elder profile + meds, from a caregiver's or the elder's own view) ---

async function fetchElderIds(profile: Profile): Promise<string[]> {
  if (profile.role === "elder") return [profile.id];
  const { data, error } = await supabase
    .from("care_links")
    .select("elder_id")
    .eq("caregiver_id", profile.id)
    .eq("status", "active");
  if (error) throw error;
  return (data ?? []).map(row => row.elder_id as string);
}

async function fetchMyRelationTo(elderId: string, viewerId: string): Promise<string> {
  if (elderId === viewerId) return "";
  const { data, error } = await supabase
    .from("care_links")
    .select("relationship")
    .eq("elder_id", elderId)
    .eq("caregiver_id", viewerId)
    .maybeSingle();
  if (error) throw error;
  return data?.relationship ?? "";
}

async function fetchPatientFor(elderId: string, viewerId: string): Promise<Patient> {
  const [{ data: elderProfile, error: profileError }, medications, contacts, relation] = await Promise.all([
    supabase.from("profiles").select("id,full_name").eq("id", elderId).maybeSingle(),
    fetchMedicationsForElder(elderId),
    fetchContactsForElder(elderId),
    fetchMyRelationTo(elderId, viewerId),
  ]);
  if (profileError) throw profileError;

  const total = medications.length;
  const taken = medications.filter(m => m.status === "taken").length;
  const adherenceToday = total > 0 ? Math.round((taken / total) * 100) : 100;

  return {
    id: elderId,
    name: elderProfile?.full_name ?? "Unnamed patient",
    nickname: elderProfile?.full_name?.split(" ")[0] ?? "",
    age: 0,
    relation,
    photo: "https://images.unsplash.com/photo-1566616213894-2d4e1baee5d8?w=80&h=80&fit=crop&auto=format",
    bloodType: "",
    conditions: [],
    allergies: [],
    medications,
    contacts,
    adherenceToday,
    adherenceWeek: adherenceToday,
    lastChecked: "just now",
  };
}

export async function fetchPatients(profile: Profile): Promise<Patient[]> {
  const elderIds = await fetchElderIds(profile);
  return Promise.all(elderIds.map(elderId => fetchPatientFor(elderId, profile.id)));
}

// A caregiver creating a care recipient from scratch (no separate elder
// signup). The elder needs their own auth.users row (profiles.id references
// it), but the anon-key client can't create one for someone else without
// either hijacking the caller's own session (supabase.auth.signUp always
// signs the *current* browser into the new account) or a service-role key
// (which must never reach the browser — see docs/architecture.md). The fix:
// sign up the elder on a throwaway, non-persisting client instance so the
// caregiver's own session in the main client is never touched. The elder gets
// a random password; nobody needs it today since Mei/the caregiver manage
// this profile — a real invite/login flow is a follow-up, not this fix.
export async function createLinkedElder(caregiverId: string, fullName: string, relationship: string): Promise<string> {
  const scoped = createScopedClient();
  const email = `elder-${crypto.randomUUID()}@dosewise.local`;
  const password = crypto.randomUUID();

  const { data: signUpData, error: signUpError } = await scoped.auth.signUp({ email, password });
  if (signUpError) throw signUpError;
  const elderId = signUpData.user?.id;
  if (!elderId) throw new Error("Could not create the care recipient's account.");

  const { error: profileError } = await scoped.from("profiles").insert({ id: elderId, role: "elder", full_name: fullName });
  if (profileError) throw profileError;
  await scoped.auth.signOut();

  const { error: linkError } = await supabase
    .from("care_links")
    .insert({ elder_id: elderId, caregiver_id: caregiverId, relationship, status: "active" });
  if (linkError) throw linkError;

  return elderId;
}

// Caregiver-linked contacts for an elder (other active caregivers on the same care_links).
async function fetchContactsForElder(elderId: string): Promise<Contact[]> {
  const { data, error } = await supabase
    .from("care_links")
    .select("relationship, profiles!care_links_caregiver_id_fkey(full_name)")
    .eq("elder_id", elderId)
    .eq("status", "active");
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    name: row.profiles?.full_name ?? "Caregiver",
    role: row.relationship ?? "Caregiver",
    phone: "",
  }));
}

// --- medications + today's doses + refills, reshaped into the UI's flat Medication[] ---

export async function fetchMedicationsForElder(elderId: string): Promise<Medication[]> {
  const [{ data: meds, error: medsError }, { data: doses, error: dosesError }, { data: refills, error: refillsError }] =
    await Promise.all([
      supabase.from("medications").select("id,name,purpose,dosage,schedule,priority").eq("elder_id", elderId).eq("archived", false),
      supabase.from("doses").select("id,medication_id,scheduled_at,status,logged_at").eq("elder_id", elderId).gte("scheduled_at", startOfTodayISO()).order("logged_at", { ascending: true }),
      supabase.from("refills").select("medication_id,pills_remaining,threshold,run_out_forecast").eq("elder_id", elderId),
    ]);
  if (medsError) throw medsError;
  if (dosesError) throw dosesError;
  if (refillsError) throw refillsError;

  const now = new Date();
  const out: Medication[] = [];

  for (const med of meds ?? []) {
    const times: string[] = (med.schedule as any)?.times ?? [];
    const todaysLoggedDoses = (doses ?? []).filter(d => d.medication_id === med.id);
    const refill = (refills ?? []).find(r => r.medication_id === med.id);
    const refillDaysLeft = refill?.run_out_forecast
      ? Math.max(0, Math.ceil((new Date(refill.run_out_forecast).getTime() - now.getTime()) / 86_400_000))
      : undefined;

    const slots = times.length > 0 ? times : ["as directed"];
    slots.forEach((hhmm, i) => {
      const loggedDose = todaysLoggedDoses[i];
      const [h, m] = hhmm.includes(":") ? hhmm.split(":").map(Number) : [0, 0];
      const scheduledToday = new Date(now);
      scheduledToday.setHours(h, m, 0, 0);

      const status: Medication["status"] = loggedDose
        ? (loggedDose.status as Medication["status"])
        : scheduledToday.getTime() < now.getTime()
          ? "missed"
          : "upcoming";

      out.push({
        id: loggedDose?.id ?? `${med.id}:${hhmm}`,
        medicationId: med.id,
        name: med.name,
        dose: med.dosage ?? "",
        time: hhmm === "as directed" ? "as directed" : to12Hour(hhmm),
        status,
        takenAt: loggedDose?.logged_at
          ? new Date(loggedDose.logged_at).toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit" })
          : undefined,
        refillDaysLeft,
        purpose: med.purpose ?? "",
        colour: colourFor(med.id),
      });
    });
  }
  return out;
}

// --- mutations -----------------------------------------------------------

// Mirrors services/hermes/src/hermes/tools/doses.py's log_dose: reuse a
// pending dose row if one exists for this medication, else insert a new
// taken row logged right now.
export async function logDose(medicationId: string, loggedBy: string): Promise<void> {
  const now = new Date().toISOString();
  const { data: pending, error: pendingError } = await supabase
    .from("doses")
    .select("id")
    .eq("medication_id", medicationId)
    .eq("status", "pending")
    .order("scheduled_at", { ascending: false })
    .limit(1);
  if (pendingError) throw pendingError;

  if (pending && pending.length > 0) {
    const { error } = await supabase
      .from("doses")
      .update({ status: "taken", logged_at: now, logged_by: loggedBy })
      .eq("id", pending[0].id);
    if (error) throw error;
    return;
  }

  const { data: med, error: medError } = await supabase.from("medications").select("elder_id").eq("id", medicationId).single();
  if (medError) throw medError;

  const { error } = await supabase.from("doses").insert({
    medication_id: medicationId,
    elder_id: med.elder_id,
    scheduled_at: now,
    status: "taken",
    logged_at: now,
    logged_by: loggedBy,
  });
  if (error) throw error;
}

export async function addPrescription(elderId: string, med: {
  name: string; dose: string; purpose: string; time: string; refillDaysLeft?: number;
}): Promise<void> {
  // UI passes "7:00 AM"-style time; store schedule as 24h HH:MM like Hermes does.
  const [time, period] = med.time.split(" ");
  const [hStr, mStr] = time.split(":");
  let h = parseInt(hStr, 10);
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  const hhmm = `${String(h).padStart(2, "0")}:${mStr}`;

  const { data: inserted, error } = await supabase
    .from("medications")
    .insert({
      elder_id: elderId,
      name: med.name,
      purpose: med.purpose,
      dosage: med.dose,
      schedule: { times: [hhmm], frequency: "daily" },
    })
    .select("id")
    .single();
  if (error) throw error;

  if (med.refillDaysLeft !== undefined) {
    const runOutForecast = new Date(Date.now() + med.refillDaysLeft * 86_400_000).toISOString().slice(0, 10);
    const { error: refillError } = await supabase.from("refills").insert({
      medication_id: inserted.id,
      elder_id: elderId,
      run_out_forecast: runOutForecast,
    });
    if (refillError) throw refillError;
  }
}

export async function archiveMedication(medicationId: string): Promise<void> {
  const { error } = await supabase.from("medications").update({ archived: true }).eq("id", medicationId);
  if (error) throw error;
}

// --- doctor questions ------------------------------------------------------

export interface DoctorQuestionRow {
  id: string;
  question: string;
  source: "agent" | "elder" | "caregiver";
  status: "open" | "answered" | "dismissed";
  created_at: string;
}

export async function fetchDoctorQuestions(elderId: string): Promise<DoctorQuestionRow[]> {
  const { data, error } = await supabase
    .from("doctor_questions")
    .select("id,question,source,status,created_at")
    .eq("elder_id", elderId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function addDoctorQuestion(elderId: string, question: string, source: "elder" | "caregiver" = "elder"): Promise<void> {
  const { error } = await supabase.from("doctor_questions").insert({ elder_id: elderId, question, source });
  if (error) throw error;
}

export async function markDoctorQuestionAnswered(id: string): Promise<void> {
  const { error } = await supabase.from("doctor_questions").update({ status: "answered" }).eq("id", id);
  if (error) throw error;
}

export async function deleteDoctorQuestion(id: string): Promise<void> {
  const { error } = await supabase.from("doctor_questions").delete().eq("id", id);
  if (error) throw error;
}

// --- caregiver messages ("Care Team Notes") ---------------------------------

export async function fetchCaregiverMessages(elderId: string, currentUserId: string): Promise<Message[]> {
  const { data, error } = await supabase
    .from("caregiver_messages")
    .select("id,body,created_at,author_id,profiles!caregiver_messages_author_id_fkey(full_name,role)")
    .eq("elder_id", elderId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    author: row.author_id === currentUserId ? "You" : row.profiles?.full_name ?? "Care team",
    role: row.profiles?.role === "elder" ? "Patient" : "Caregiver",
    body: row.body,
    time: new Date(row.created_at).toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit" }),
    isMe: row.author_id === currentUserId,
  }));
}

export async function sendCaregiverMessage(elderId: string, authorId: string, body: string): Promise<void> {
  const { error } = await supabase.from("caregiver_messages").insert({ elder_id: elderId, author_id: authorId, body });
  if (error) throw error;
}
