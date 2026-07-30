import { supabase } from "./supabase";
import type { Medication, MedStatus } from "../types";

const FALLBACK_COLOUR = "#0D5C8A";

export function to24h(clock12: string): string {
  const m = clock12.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return "08:00";
  let h = Number(m[1]);
  const mm = Number(m[2]);
  const p = m[3].toUpperCase();
  if (p === "PM" && h !== 12) h += 12;
  if (p === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function to12h(clock24: string): string {
  const [hh, mm] = clock24.split(":").map(Number);
  const period = hh >= 12 ? "PM" : "AM";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${period}`;
}

// Deterministic positive numeric id for a (medication, time-slot) pair — the UI's
// Medication.id is a number, but real rows are uuid-keyed. Stable across refetches
// so React keys and local lookups don't jitter.
function slotId(medicationId: string, hhmm: string): number {
  const s = `${medicationId}|${hhmm}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

function startOfLocalDayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// A user row is required before any medications/doses can be written — schema FKs
// point at profiles(id), not auth.users(id) directly. Sign-in doesn't create one,
// so bootstrap it lazily on first real data access.
export async function ensureProfile(elderId: string): Promise<void> {
  const { data } = await supabase.from("profiles").select("id").eq("id", elderId).maybeSingle();
  if (data) return;
  await supabase.from("profiles").insert({ id: elderId, role: "elder" });
}

// Fetches this elder's active medications, joined with today's logged doses and
// any refill forecast, into the same per-time-slot Medication shape the UI already
// expects. Note: a medication with more than one schedule.times entry will show
// every slot as "taken" once any one dose is logged today — the app itself only
// ever writes single-time schedules, so this doesn't occur from data created here.
export async function fetchElderMedications(elderId: string): Promise<Medication[]> {
  const [medsRes, dosesRes, refillsRes] = await Promise.all([
    supabase.from("medications").select("id,name,purpose,dosage,schedule")
      .eq("elder_id", elderId).eq("archived", false),
    supabase.from("doses").select("medication_id,status,logged_at")
      .eq("elder_id", elderId).gte("scheduled_at", startOfLocalDayIso()),
    supabase.from("refills").select("medication_id,run_out_forecast").eq("elder_id", elderId),
  ]);
  if (medsRes.error) throw medsRes.error;
  const doses = dosesRes.data ?? [];
  const refills = refillsRes.data ?? [];

  const out: Medication[] = [];
  for (const med of medsRes.data ?? []) {
    const times: string[] = (med.schedule as { times?: string[] } | null)?.times ?? [];
    const takenDose = doses.find(d => d.medication_id === med.id && d.status === "taken");
    const refill = refills.find(r => r.medication_id === med.id);
    const refillDaysLeft = refill?.run_out_forecast
      ? Math.max(0, Math.ceil((new Date(refill.run_out_forecast).getTime() - Date.now()) / 86_400_000))
      : undefined;

    for (const hhmm of times.length ? times : ["08:00"]) {
      const status: MedStatus = takenDose ? "taken" : "upcoming";
      out.push({
        id: slotId(med.id, hhmm),
        medicationId: med.id,
        name: med.name,
        dose: med.dosage ?? "",
        time: to12h(hhmm),
        status,
        takenAt: takenDose?.logged_at
          ? new Date(takenDose.logged_at).toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" })
          : undefined,
        refillDaysLeft,
        purpose: med.purpose ?? "",
        colour: FALLBACK_COLOUR,
      });
    }
  }
  return out;
}

// Flip the pending dose that matches the TAPPED card's own slot, or insert a
// new taken dose at now. `slotHHMM` (24h, the specific card's own time —
// callers already have this per-slot, since fetchElderMedications emits one
// card per schedule.times entry) picks among multiple same-day pending rows
// by nearest wall-clock time-of-day, same principle as Hermes's log_dose
// tool's _dose_plan (services/hermes/src/hermes/tools/doses.py) — this was
// previously "most recent pending, regardless of which slot's card was
// tapped", which flipped the WRONG dose whenever a medication had more than
// one pending slot today (found live, Phase-4 spot-check of scenario s03).
// No slotHHMM (caller doesn't know it) falls back to the old any-pending
// behaviour, kept only for backward compatibility.
export async function logDoseTaken(medicationId: string, elderId: string, slotHHMM?: string): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: allPending } = await supabase
    .from("doses").select("id,scheduled_at")
    .eq("medication_id", medicationId).eq("status", "pending");
  const pending = allPending ?? [];

  if (pending.length) {
    let target = pending[0];
    if (slotHHMM && pending.length > 1) {
      const [wantH, wantM] = slotHHMM.split(":").map(Number);
      const wantMinutes = wantH * 60 + wantM;
      target = pending.reduce((best, row) => {
        const d = new Date(row.scheduled_at);
        const rowMinutes = d.getHours() * 60 + d.getMinutes();
        const bestD = new Date(best.scheduled_at);
        const bestMinutes = bestD.getHours() * 60 + bestD.getMinutes();
        return Math.abs(rowMinutes - wantMinutes) < Math.abs(bestMinutes - wantMinutes) ? row : best;
      }, pending[0]);
    }
    const { error } = await supabase.from("doses")
      .update({ status: "taken", logged_at: nowIso, logged_by: elderId })
      .eq("id", target.id);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from("doses").insert({
    medication_id: medicationId, elder_id: elderId,
    scheduled_at: nowIso, status: "taken", logged_at: nowIso, logged_by: elderId,
  });
  if (error) throw error;
  await decrementSupply(medicationId);
}

// Logging a dose taken uses up a day of supply — pull the refill forecast one
// day closer so "days remaining" reflects actual consumption. No-op if this
// medication has no refill row (refill tracking is optional).
async function decrementSupply(medicationId: string): Promise<void> {
  const { data } = await supabase.from("refills")
    .select("id,run_out_forecast").eq("medication_id", medicationId).limit(1);
  const refill = data?.[0];
  if (!refill?.run_out_forecast) return;
  const forecast = new Date(refill.run_out_forecast);
  forecast.setDate(forecast.getDate() - 1);
  await supabase.from("refills").update({
    run_out_forecast: forecast.toISOString().slice(0, 10),
  }).eq("id", refill.id);
}

export async function addMedication(elderId: string, input: {
  name: string; dosage: string; purpose: string; timeHHMM?: string; timeHHMMs?: string[]; refillDays?: number;
}): Promise<string> {
  const times = (input.timeHHMMs && input.timeHHMMs.length ? input.timeHHMMs : input.timeHHMM ? [input.timeHHMM] : ["08:00"]).filter(Boolean);
  const { data, error } = await supabase
    .from("medications")
    .insert({
      elder_id: elderId, name: input.name, purpose: input.purpose,
      dosage: input.dosage, schedule: { times },
    })
    .select("id").single();
  if (error) throw error;
  const medicationId = data.id as string;

  if (input.refillDays) {
    const forecast = new Date();
    forecast.setDate(forecast.getDate() + input.refillDays);
    await supabase.from("refills").insert({
      medication_id: medicationId, elder_id: elderId,
      run_out_forecast: forecast.toISOString().slice(0, 10),
    });
  }
  return medicationId;
}

// No DELETE policy exists on medications (supabase/migrations/0002_rls_policies.sql)
// — archiving is the only supported removal path, matching idx_medications_elder's
// "where archived = false" partial index.
export async function archiveMedication(medicationId: string): Promise<void> {
  const { error } = await supabase.from("medications").update({ archived: true }).eq("id", medicationId);
  if (error) throw error;
}

export interface PastMedication {
  id: string;
  name: string;
  dose: string;
  purpose: string;
}

// Archived (no-longer-taken) medications, for the prescription list's history
// view — no schedule/dose/refill joining needed since they're inactive.
export async function fetchArchivedMedications(elderId: string): Promise<PastMedication[]> {
  const { data, error } = await supabase.from("medications")
    .select("id,name,dosage,purpose")
    .eq("elder_id", elderId).eq("archived", true);
  if (error) throw error;
  return (data ?? []).map(m => ({ id: m.id, name: m.name, dose: m.dosage ?? "", purpose: m.purpose ?? "" }));
}
