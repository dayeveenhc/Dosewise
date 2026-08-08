/**
 * What is urgent right now — one evaluation, three consumers.
 *
 * The Reminders tab, the bottom-nav badge and the proactive popup all read the
 * SAME array, so the three can never disagree about what is outstanding or
 * report the same thing three times. Pure and React-free (like changeHighlight
 * / chatChoices), so the tiering is directly unit-testable without a DOM.
 *
 * Severity is derived from signals that already exist rather than a new field
 * nobody writes:
 *   - `medications.priority` (the med_priority enum the Hermes scheduler
 *     already escalates on)
 *   - real supply data (`refills.pills_remaining` / `run_out_forecast`, which
 *     fetchElderMedications already reads onto Medication)
 *   - the four NotificationPrefs toggles the person already has in Settings
 */
import type { Medication, Message } from "../types";
import type { NotificationPrefs } from "../accessibility";
import type { PendingLinkRequest } from "./careLinks";
import { isDueOn, isoDate, to24h, courseDaysLeft, lowSupplyMedications, supplyDaysLeft, LOW_SUPPLY_DAYS, REFILL_PROMPT_DAYS } from "./medications";

// Below this a refill is not "soon", it is an emergency: a critical medicine
// with three days left needs acting on today. Sits under the two thresholds
// lib/medications.ts already exports rather than adding a fourth scale —
// REFILL_PROMPT_DAYS (15) offers the action, LOW_SUPPLY_DAYS (10) turns it red,
// this one interrupts.
export const CRITICAL_SUPPLY_DAYS = 3;

// Quiet hours when the person's own routine doesn't say otherwise. Matches the
// shape dosing.py::in_quiet_hours reads from care_links.permissions.
const DEFAULT_QUIET = { start: "22:00", end: "07:00" };

export type AlertSeverity = "critical" | "urgent" | "notice";

export type AlertKind =
  | "out_of_supply"
  | "low_supply"
  | "missed_critical"
  | "care_link_request"
  | "care_message"
  | "course_finished"
  | "agent";

export interface Alert {
  /** Stable across polls — this IS the dedupe key for both the popup and the
   *  acknowledged set, so it must not contain a timestamp or an array index. */
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  titleKey: string;
  bodyKey: string;
  params: Record<string, string | number>;
  medicationId?: string;
  medName?: string;
  /** Which NotificationPrefs toggle governs this alert. The person already has
   *  these four switches; an alert whose switch is off is still LISTED on the
   *  Reminders tab (an inbox they chose to open) but never interrupts them. */
  pref: keyof NotificationPrefs;
}

const RANK: Record<AlertSeverity, number> = { critical: 0, urgent: 1, notice: 2 };

const minutesOf = (clock12: string): number => {
  const [h, m] = to24h(clock12).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/**
 * True inside a `{start, end}` window, handling wrap-around (22:00 → 07:00).
 *
 * A direct transcription of `services/hermes/src/hermes/dosing.py
 * ::in_quiet_hours`, including the wrap branch, so the two engines provably
 * agree about when it is too late to disturb someone.
 */
export function inQuietHours(now: Date, quiet?: { start?: string; end?: string }): boolean {
  const window = { ...DEFAULT_QUIET, ...(quiet ?? {}) };
  const parse = (v: string) => {
    const [h, m] = String(v).split(":").map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  };
  const start = parse(window.start);
  const end = parse(window.end);
  if (start === null || end === null) return false;
  const nowM = now.getHours() * 60 + now.getMinutes();
  return start <= end ? nowM >= start && nowM < end : nowM >= start || nowM < end;
}

/**
 * Everything outstanding, most severe first.
 *
 * Deliberately does no I/O: the caller passes what it already has on screen, so
 * this can run on the existing 30s poll tick without adding a query.
 */
export function buildAlerts({
  medications,
  careMessages = [],
  linkRequests = [],
  now = new Date(),
}: {
  medications: Medication[];
  careMessages?: Message[];
  linkRequests?: PendingLinkRequest[];
  now?: Date;
}): Alert[] {
  const out: Alert[] = [];

  // --- supply, from real refill data (one entry per medicine, not per slot) ---
  // lowSupplyMedications groups first, which is what makes "10 days" mean the
  // same thing for a once-daily and a twice-daily medicine.
  const byName = new Map<string, Medication[]>();
  for (const m of medications) {
    const key = m.medicationId ?? m.name;
    (byName.get(key) ?? byName.set(key, []).get(key)!).push(m);
  }
  for (const { name } of lowSupplyMedications(medications, REFILL_PROMPT_DAYS)) {
    const slots = [...byName.values()].find(s => s[0].name === name);
    if (!slots) continue;
    const med = slots[0];
    // A finished course isn't running low — it's over. Saying "running low"
    // about a medicine nobody is taking any more is noise.
    if ((courseDaysLeft(med, now) ?? 0) < 0) continue;
    const daysLeft = supplyDaysLeft(med, slots.length) ?? 0;
    const critical = med.priority === "critical";
    // Out (or nearly) always interrupts; on a critical medicine the bar is
    // higher up the scale still.
    const severity: AlertSeverity =
      daysLeft <= 0 || (critical && daysLeft <= CRITICAL_SUPPLY_DAYS) ? "critical"
        : daysLeft < LOW_SUPPLY_DAYS ? "urgent"
          : "notice";
    out.push({
      id: `supply:${med.medicationId ?? med.name}`,
      kind: daysLeft <= 0 ? "out_of_supply" : "low_supply",
      severity,
      titleKey: daysLeft <= 0 ? "alerts.outOfStockTitle" : "notifications.lowStockTitle",
      bodyKey: daysLeft <= 0 ? "alerts.outOfStockBody" : "notifications.lowStockBody",
      params: { med: med.dose ? `${med.name} ${med.dose}` : med.name, days: daysLeft },
      medicationId: med.medicationId,
      medName: med.name,
      pref: "refillAlerts",
    });
  }

  // --- a missed dose of a CRITICAL medicine -------------------------------
  // Only critical, deliberately: this is the tier that may interrupt, and the
  // Hermes scheduler already escalates on exactly this signal
  // (channels/scheduler.py). Ordinary missed doses stay on the Home timeline.
  const today = isoDate(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  for (const med of medications) {
    if (med.priority !== "critical") continue;
    if (med.status === "taken" || med.status === "skipped") continue;
    if (!isDueOn(med, now)) continue;
    if (minutesOf(med.time) >= nowMinutes) continue;
    out.push({
      id: `missed:${med.medicationId ?? med.name}|${med.time}|${today}`,
      kind: "missed_critical",
      severity: "critical",
      titleKey: "alerts.missedCriticalTitle",
      bodyKey: "alerts.missedCriticalBody",
      params: { med: med.name, time: med.time },
      medicationId: med.medicationId,
      medName: med.name,
      pref: "missedDoseAlerts",
    });
  }

  // --- a finished course still sitting in the active list ------------------
  const seenCourse = new Set<string>();
  for (const med of medications) {
    const key = med.medicationId ?? med.name;
    if (seenCourse.has(key)) continue;
    if ((courseDaysLeft(med, now) ?? 0) >= 0) continue;
    seenCourse.add(key);
    out.push({
      id: `course:${key}`,
      kind: "course_finished",
      severity: "notice",
      titleKey: "alerts.courseFinishedTitle",
      bodyKey: "alerts.courseFinishedBody",
      params: { med: med.name },
      medicationId: med.medicationId,
      medName: med.name,
      pref: "doseReminders",
    });
  }

  // --- consent and people --------------------------------------------------
  // Granting someone access to your medications is the most consequential thing
  // on the Reminders screen — the screen's own comment says so, and it already
  // renders these above the tab strip for that reason.
  for (const req of linkRequests) {
    out.push({
      id: `link:${req.id}`,
      kind: "care_link_request",
      severity: "urgent",
      titleKey: "alerts.linkRequestTitle",
      bodyKey: "alerts.linkRequestBody",
      params: { name: req.caregiverName },
      pref: "caregiverNotes",
    });
  }
  for (const msg of careMessages.filter(m => !m.isMe)) {
    out.push({
      id: `message:${msg.id}`,
      kind: "care_message",
      severity: "notice",
      titleKey: "alerts.messageTitle",
      bodyKey: "alerts.messageBody",
      params: { name: msg.author },
      pref: "caregiverNotes",
    });
  }

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/**
 * The ONE alert allowed to interrupt with a full-screen popup, or null.
 *
 * An elder app that pops a modal too often is worse than one that never does,
 * so every rule here is a reason NOT to fire. Nothing outside this function
 * decides whether the popup appears.
 */
export function pickPopupAlert(
  alerts: Alert[],
  {
    popped,
    prefs,
    suppressed = false,
    quiet = false,
    cooldownUntil = 0,
    now = Date.now(),
  }: {
    /** Alert ids already popped today, persisted across remounts. */
    popped: Set<string>;
    prefs: NotificationPrefs;
    /** A walkthrough, tour, or sheet is on screen — never stack modals. */
    suppressed?: boolean;
    quiet?: boolean;
    cooldownUntil?: number;
    now?: number;
  },
): Alert | null {
  if (suppressed || now < cooldownUntil) return null;
  for (const alert of alerts) {
    // Only the top two tiers ever interrupt. A notice belongs in the list.
    if (alert.severity === "notice") continue;
    if (!prefs[alert.pref]) continue;
    if (popped.has(alert.id)) continue;
    // Quiet hours are overridden ONLY by the two things that are actually
    // dangerous to sit on overnight — mirroring channels/scheduler.py, which
    // never quiet-suppresses a missed critical dose.
    if (quiet && !(alert.severity === "critical")) continue;
    return alert;
  }
  return null;
}
