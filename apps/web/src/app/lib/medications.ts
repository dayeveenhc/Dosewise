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

/**
 * Render any stored clock string in the format the reader asked for. Times are
 * STORED as 12h display strings ("8:00 AM") or 24h ("08:00") depending on the
 * surface; this is the single place that decides how one is shown, so the 24h
 * accessibility setting cannot half-apply to some screens and not others.
 */
export function formatClock(value: string, format: "12h" | "24h" = "12h"): string {
  const trimmed = value.trim();
  const hhmm = /^\d{1,2}:\d{2}$/.test(trimmed)
    ? `${trimmed.split(":")[0].padStart(2, "0")}:${trimmed.split(":")[1]}`
    : to24h(trimmed);
  return format === "24h" ? hhmm : to12h(hhmm);
}

/** The same rendering, for a Date or an hour-of-day — the live clock surfaces. */
export function formatClockAt(when: Date | number, format: "12h" | "24h" = "12h"): string {
  const [h, m] = typeof when === "number" ? [when, 0] : [when.getHours(), when.getMinutes()];
  return formatClock(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, format);
}

/**
 * Weekday tokens in the ORDER THE BACKEND USES — `services/hermes/src/hermes/
 * dosing.py::WEEKDAYS` is indexed by Python's `date.weekday()`, i.e. Monday=0.
 * JS `Date.getDay()` is Sunday=0, hence the rotation in `weekdayToken`. Getting
 * this wrong shifts every weekly schedule by a day, silently.
 */
export const WEEKDAY_TOKENS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekdayToken = (typeof WEEKDAY_TOKENS)[number];

export const weekdayToken = (d: Date): WeekdayToken => WEEKDAY_TOKENS[(d.getDay() + 6) % 7];

// Exported so callers building a lookup key (fetchDoseHistory's Set) and
// callers reading a specific day's status use the exact same key shape.
export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Whether a medication is due on a given calendar day.
 *
 * Three cadences, matching what `schedule` can hold:
 *   - no `days`, no `intervalDays`  → every day (the default, and what every
 *     medication created before this existed reads back as)
 *   - `days: ["mon","thu"]`         → only those weekdays. This is the shape
 *     Hermes already understands (`dosing.py::scheduled_today`), so the app and
 *     the reminder scheduler agree.
 *   - `intervalDays: 2`             → every other day, counted from `startDate`.
 *     NOTE: `scheduled_today` does NOT understand this — it treats a schedule
 *     with no `days` as daily — so an interval medication currently shows the
 *     right cadence everywhere in the app but would still be reminded daily by
 *     the Hermes scheduler. Closing that needs a change in `services/hermes`,
 *     which is outside apps/web's ownership.
 */
export function isDueOn(
  med: { days?: string[]; intervalDays?: number; startDate?: string },
  day: Date,
): boolean {
  if (med.days?.length) {
    const tokens = new Set(med.days.map(d => String(d).trim().toLowerCase().slice(0, 3)));
    return tokens.has(weekdayToken(day));
  }
  const every = med.intervalDays ?? 1;
  if (every <= 1) return true;
  // Compare calendar days, not timestamps, so a dose time either side of
  // midnight can't shift which day an interval lands on.
  const start = med.startDate ? new Date(`${med.startDate}T00:00:00`) : null;
  if (!start || Number.isNaN(start.getTime())) return true;
  const target = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const anchor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const diff = Math.round((target.getTime() - anchor.getTime()) / 86_400_000);
  return ((diff % every) + every) % every === 0;
}

// Human-readable cadence ("Mon, Thu" / "Every 2 days"), or undefined for a plain
// daily medication — the caller then shows nothing rather than the noise of
// "Every day" on every single card.
export function cadenceLabel(
  med: { days?: string[]; intervalDays?: number },
  dayNames: Record<string, string>,
  everyNDays: (n: number) => string,
): string | undefined {
  if (med.days?.length) {
    const set = new Set(med.days.map(d => String(d).trim().toLowerCase().slice(0, 3)));
    return WEEKDAY_TOKENS.filter(t => set.has(t)).map(t => dayNames[t] ?? t).join(", ");
  }
  if ((med.intervalDays ?? 1) > 1) return everyNDays(med.intervalDays!);
  return undefined;
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
    supabase.from("refills").select("medication_id,run_out_forecast,pills_remaining").eq("elder_id", elderId),
  ]);
  if (medsRes.error) throw medsRes.error;
  const doses = dosesRes.data ?? [];
  const refills = refillsRes.data ?? [];

  const out: Medication[] = [];
  for (const med of medsRes.data ?? []) {
    const sched = (med.schedule ?? null) as
      | { times?: string[]; days?: string[]; interval_days?: number; start_date?: string }
      | null;
    const times: string[] = sched?.times ?? [];
    // Only a genuinely non-daily cadence is carried forward — a `days` list of
    // all seven, or an interval of 1, IS daily, and treating it as a special
    // case would make every screen render a pointless "Mon, Tue, Wed…" line.
    const days = sched?.days?.length && sched.days.length < 7 ? sched.days : undefined;
    const intervalDays = (sched?.interval_days ?? 1) > 1 ? sched!.interval_days : undefined;
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
        pillsRemaining: refill?.pills_remaining ?? undefined,
        purpose: med.purpose ?? "",
        colour: FALLBACK_COLOUR,
        days,
        intervalDays,
        startDate: sched?.start_date,
      });
    }
  }
  return out;
}

// Which (medication, calendar day) pairs have an actually-logged taken dose,
// for a date range — the PAST-day counterpart to fetchElderMedications' today-
// only taken lookup. A day with no row here and no future date is read as
// "missed", the same inference-from-absence the today-only status already
// uses (doses are never pre-materialised for a day nobody has acted on —
// see services/hermes/tools/doses.py's "doses aren't materialised" comment).
// Keyed as `${medicationId}|${isoDate}` so callers get an O(1) Set lookup
// per card without re-deriving the date string themselves.
export async function fetchDoseHistory(elderId: string, fromDate: Date, toDate: Date): Promise<Set<string>> {
  const from = new Date(fromDate); from.setHours(0, 0, 0, 0);
  const to = new Date(toDate); to.setHours(23, 59, 59, 999);
  const { data, error } = await supabase
    .from("doses").select("medication_id,scheduled_at")
    .eq("elder_id", elderId).eq("status", "taken")
    .gte("scheduled_at", from.toISOString()).lte("scheduled_at", to.toISOString());
  if (error) throw error;
  return new Set((data ?? []).map(d => `${d.medication_id}|${isoDate(new Date(d.scheduled_at))}`));
}

// Days of supply left, from the pills actually remaining and how many are taken
// per day — 30 pills taken twice daily is 15 days, not 30. Falls back to the
// refill row's own run-out forecast when the pill count is unknown, and returns
// undefined when we know neither: better to show nothing than to invent a
// number on a medication screen.
export function supplyDaysLeft(
  med: { pillsRemaining?: number; refillDaysLeft?: number },
  dosesPerDay: number,
): number | undefined {
  if (med.pillsRemaining != null && dosesPerDay > 0) return Math.floor(med.pillsRemaining / dosesPerDay);
  return med.refillDaysLeft;
}

// Below this the days-left figure turns red.
export const LOW_SUPPLY_DAYS = 10;
// Below this the card offers Request refill — deliberately earlier than the red
// warning, so the action is available before it becomes urgent.
export const REFILL_PROMPT_DAYS = 15;

/**
 * Medications running low, ONE ENTRY PER MEDICINE, soonest first.
 *
 * The single source of truth for "needs a refill", so Home's banner, the
 * Reminders tab and the Medications page can never disagree about which
 * medicines are on the list. Two things it has to get right, and which every
 * ad-hoc version of this got wrong: `Medication[]` holds one row per (medicine,
 * time-slot), so it must group first — both to avoid listing a twice-daily
 * medicine twice, and because doses-per-day is exactly what days-left divides
 * by.
 */
export function lowSupplyMedications(
  meds: Medication[],
  thresholdDays = LOW_SUPPLY_DAYS,
): { name: string; daysLeft: number }[] {
  const byMed = new Map<string, Medication[]>();
  for (const m of meds) {
    const key = m.medicationId ?? m.name;
    (byMed.get(key) ?? byMed.set(key, []).get(key)!).push(m);
  }
  const out: { name: string; daysLeft: number }[] = [];
  for (const slots of byMed.values()) {
    const days = supplyDaysLeft(slots[0], slots.length);
    if (days != null && days < thresholdDays) out.push({ name: slots[0].name, daysLeft: days });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

// Whether ANY medication is low enough to be worth a refill. Ask Mei uses this
// to decide whether the refill walkthrough has a button to point at. Same
// grouping as above, one step earlier on the scale: offered before it's urgent.
export function anyMedicationRunningLow(meds: Medication[]): boolean {
  return lowSupplyMedications(meds, REFILL_PROMPT_DAYS).length > 0;
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
//
// `forDay` logs a PAST calendar day's missed dose (the elder Home screen's
// day-navigation view), not "now" — without it, a dose row eventually gets
// inserted at today's timestamp, showing up under today instead of the day
// actually being viewed (doses are never pre-materialised for a day nobody's
// acted on, so a missed past day usually has no pending row to flip at all).
// Left undefined (or today), behaviour is unchanged from before this existed.
export async function logDoseTaken(medicationId: string, elderId: string, slotHHMM?: string, forDay?: Date): Promise<void> {
  const nowIso = new Date().toISOString();
  const isPastDay = !!forDay && isoDate(forDay) !== isoDate(new Date());

  let pendingQuery = supabase.from("doses").select("id,scheduled_at")
    .eq("medication_id", medicationId).eq("status", "pending");
  if (isPastDay) {
    const dayStart = new Date(forDay!); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(forDay!); dayEnd.setHours(23, 59, 59, 999);
    pendingQuery = pendingQuery.gte("scheduled_at", dayStart.toISOString()).lte("scheduled_at", dayEnd.toISOString());
  }
  const { data: allPending } = await pendingQuery;
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
  let scheduledAt = nowIso;
  if (isPastDay) {
    const d = new Date(forDay!);
    if (slotHHMM) { const [h, m] = slotHHMM.split(":").map(Number); d.setHours(h, m, 0, 0); } else { d.setHours(0, 0, 0, 0); }
    scheduledAt = d.toISOString();
  }
  const { error } = await supabase.from("doses").insert({
    medication_id: medicationId, elder_id: elderId,
    scheduled_at: scheduledAt, status: "taken", logged_at: nowIso, logged_by: elderId,
  });
  if (error) throw error;
  await shiftSupply(medicationId, -1);
}

// Inverse of logDoseTaken: someone tapped "I took it" by mistake. Flips today's
// most recently logged `taken` dose back to `pending` rather than deleting the
// row, so the schedule slot survives and the dose simply becomes due again.
// Scoped to today (the same window fetchElderMedications reads) so an undo can
// never reach back and rewrite an earlier day's history.
export async function unlogDoseTaken(medicationId: string, elderId: string): Promise<void> {
  const { data } = await supabase
    .from("doses").select("id")
    .eq("medication_id", medicationId).eq("elder_id", elderId).eq("status", "taken")
    .gte("scheduled_at", startOfLocalDayIso())
    .order("logged_at", { ascending: false }).limit(1);
  const row = data?.[0];
  if (!row) return;
  const { error } = await supabase.from("doses")
    .update({ status: "pending", logged_at: null, logged_by: null })
    .eq("id", row.id);
  if (error) throw error;
  await shiftSupply(medicationId, +1);
}

// Logging a dose taken uses up a day of supply — pull the refill forecast one
// day closer so "days remaining" reflects actual consumption; undoing pushes it
// back out by the same day. No-op if this medication has no refill row (refill
// tracking is optional).
async function shiftSupply(medicationId: string, days: number): Promise<void> {
  const { data } = await supabase.from("refills")
    .select("id,run_out_forecast").eq("medication_id", medicationId).limit(1);
  const refill = data?.[0];
  if (!refill?.run_out_forecast) return;
  const forecast = new Date(refill.run_out_forecast);
  forecast.setDate(forecast.getDate() + days);
  await supabase.from("refills").update({
    run_out_forecast: forecast.toISOString().slice(0, 10),
  }).eq("id", refill.id);
}

interface MedicationInput {
  name: string; dosage: string; purpose: string; timeHHMM?: string; timeHHMMs?: string[]; refillDays?: number;
  // Cadence. `days` is the shape Hermes already reads (dosing.py::scheduled_today);
  // `intervalDays` is app-side only for now — see isDueOn's note.
  days?: string[]; intervalDays?: number;
}

// Mirrors what tools/medications.py writes, so a medication added here and one
// added by Mei read back identically.
function buildSchedule(input: MedicationInput): Record<string, unknown> {
  const times = (input.timeHHMMs && input.timeHHMMs.length ? input.timeHHMMs : input.timeHHMM ? [input.timeHHMM] : ["08:00"]).filter(Boolean);
  const schedule: Record<string, unknown> = { times, frequency: "daily" };
  if (input.days?.length && input.days.length < 7) {
    schedule.days = input.days;
    schedule.frequency = "weekly";
  } else if ((input.intervalDays ?? 1) > 1) {
    schedule.interval_days = input.intervalDays;
    schedule.frequency = "interval";
    schedule.start_date = isoDate(new Date()); // the anchor isDueOn counts from
  }
  return schedule;
}

export async function addMedication(elderId: string, input: MedicationInput): Promise<string> {
  const { data, error } = await supabase
    .from("medications")
    .insert({
      elder_id: elderId, name: input.name, purpose: input.purpose,
      dosage: input.dosage, schedule: buildSchedule(input),
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

// Edits an existing medication in place (name/dose/purpose/schedule) — used by
// the elder's "Edit" flow on a medication card. Deliberately does not touch
// `refills`: the person is correcting the prescription's details, not
// re-reporting how much supply they currently have on hand.
export async function updateMedication(medicationId: string, input: MedicationInput): Promise<void> {
  const { error } = await supabase
    .from("medications")
    .update({ name: input.name, purpose: input.purpose, dosage: input.dosage, schedule: buildSchedule(input) })
    .eq("id", medicationId);
  if (error) throw error;
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
