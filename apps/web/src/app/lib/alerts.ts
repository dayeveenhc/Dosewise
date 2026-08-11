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
import type { ElderlyTab } from "../screens/elderly/types";
import type { PendingLinkRequest } from "./careLinks";
import { isDueOn, isoDate, to24h, courseDaysLeft, lowSupplyMedications, supplyDaysLeft, LOW_SUPPLY_DAYS, REFILL_PROMPT_DAYS } from "./medications";

// Below this a refill is not "soon", it is an emergency: a critical medicine
// with three days left needs acting on today. Sits under the two thresholds
// lib/medications.ts already exports rather than adding a fourth scale —
// REFILL_PROMPT_DAYS (15) offers the action, LOW_SUPPLY_DAYS (10) turns it red,
// this one interrupts.
export const CRITICAL_SUPPLY_DAYS = 3;

// How long past its slot an ORDINARY (non-critical) dose must be before it
// becomes an alert. Matches ElderlyHomeScreen's DUE_WINDOW_MIN (60): while the
// Home timeline still calls a dose "due now / a bit late", an interrupt
// calling it "missed" would contradict the screen it routes to. Critical
// medicines keep their zero-grace behaviour — the scheduler escalates on
// exactly that signal.
export const MISSED_DOSE_GRACE_MIN = 60;

// Quiet hours when the person's own routine doesn't say otherwise. Matches the
// shape dosing.py::in_quiet_hours reads from care_links.permissions.
const DEFAULT_QUIET = { start: "22:00", end: "07:00" };

export type AlertSeverity = "critical" | "urgent" | "notice";

export type AlertKind =
  | "out_of_supply"
  | "low_supply"
  | "missed_critical"
  | "missed_dose"
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
  doseSnoozes = [],
  now = new Date(),
}: {
  medications: Medication[];
  careMessages?: Message[];
  linkRequests?: PendingLinkRequest[];
  /** Mei's snooze_dose entries (patient.doseSnoozes) — a snoozed slot's due
   *  time shifts to its `until`, so an alert can never nag someone who just
   *  told Mei "not yet". */
  doseSnoozes?: { medication_id: string; slot: string; date: string; until: string }[];
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

  // --- missed doses ---------------------------------------------------------
  // Two tiers off one loop. CRITICAL medicines interrupt the moment the slot
  // passes (severity "critical" — the Hermes scheduler escalates to the
  // caregiver on exactly this signal, channels/scheduler.py). ORDINARY
  // medicines (2026-08-09) get the gentler "urgent" tier — bell popup once a
  // day, Reminders card, badge — and only after MISSED_DOSE_GRACE_MIN, so the
  // Home timeline's "due now" window and this alert can't contradict each
  // other. Both share the missedDoseAlerts toggle and the day-scoped id shape
  // (the sessionStorage dedupe key).
  const today = isoDate(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  for (const med of medications) {
    if (med.status === "taken" || med.status === "skipped") continue;
    if (!isDueOn(med, now)) continue;
    const critical = med.priority === "critical";
    // A vague slot ("after breakfast") has no real clock: to24h's "08:00"
    // fallback would nag at a fictional time, so the ordinary tier skips it.
    // Critical keeps its long-standing fallback behaviour — a known
    // limitation, kept rather than silently changing the escalation tier.
    if (!critical && !/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(med.time.trim())) continue;
    // A snooze for this exact (med, slot, today) moves the due time to its
    // `until` — for BOTH tiers; Mei's snooze_dose is the person's own "not
    // yet", and an alert that ignores it re-nags them for complying.
    const snooze = doseSnoozes.find(
      s => s.medication_id === med.medicationId && s.date === today && s.slot === to24h(med.time),
    );
    const dueMinutes = snooze
      ? (([h, m]) => (h || 0) * 60 + (m || 0))(snooze.until.split(":").map(Number))
      : minutesOf(med.time);
    const lateBy = nowMinutes - dueMinutes;
    if (critical ? lateBy <= 0 : lateBy < MISSED_DOSE_GRACE_MIN) continue;
    out.push({
      id: `missed:${med.medicationId ?? med.name}|${med.time}|${today}`,
      kind: critical ? "missed_critical" : "missed_dose",
      severity: critical ? "critical" : "urgent",
      titleKey: critical ? "alerts.missedCriticalTitle" : "alerts.missedDoseTitle",
      bodyKey: critical ? "alerts.missedCriticalBody" : "alerts.missedDoseBody",
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
 * Which alerts share ONE popup.
 *
 * Three missed doses are one situation, not three interruptions — the popup
 * used to show the first, then the second half an hour later, then the third,
 * each looking identical and none of them saying "three".
 *
 * Two kinds are deliberately absent, and must stay absent:
 *   - `care_link_request` — "2 people want access" behind one Show me is a
 *     consent prompt that hides who is asking, and care_links is this app's
 *     consent anchor.
 *   - `agent` — its title and body are PROSE the model wrote (see ElderlyApp's
 *     handleAgentAlert), so there is nothing the client could summarise them
 *     into without inventing text.
 */
const POPUP_FAMILY: Partial<Record<AlertKind, string>> = {
  missed_critical: "missed",
  missed_dose: "missed",
  out_of_supply: "supply",
  low_supply: "supply",
};

/** One interruption's worth of alerts. */
export interface AlertGroup {
  /** Stable per family per day — the dedupe handle AND the escalation key. */
  id: string;
  /** The most severe member: drives the tier, the destination and the actions. */
  lead: Alert;
  /** Everything folded into this popup, `lead` included, most severe first. */
  members: Alert[];
  /** Which interrupt this is, counting from 1 — what the popup's meter shows. */
  raiseCount: number;
  /** How many this group gets at all, so the meter can render "n of max". */
  raiseMax: number;
}

/**
 * How long before a group may interrupt AGAIN, indexed by how many times it
 * already has. Frequency backs off as prominence escalates: the situation is
 * getting more insistent to look at and less frequent to be hit by.
 *
 * The LENGTH of each ladder is the anti-nag guarantee — past its end a group
 * never interrupts again that day and lives on the Reminders tab and the nav
 * badge instead. Without a ceiling, an unresolved situation interrupts forever,
 * which is how a modal becomes wallpaper.
 */
const COOLDOWN_LADDER_MS: Record<"urgent" | "critical", number[]> = {
  urgent: [30 * 60_000, 2 * 3_600_000, 4 * 3_600_000],
  critical: [20 * 60_000, 45 * 60_000, 90 * 60_000, 3 * 3_600_000, 6 * 3_600_000],
};

const ladderFor = (severity: AlertSeverity) =>
  COOLDOWN_LADDER_MS[severity === "critical" ? "critical" : "urgent"];

/** How many times this tier may interrupt in one sitting. */
export const maxRaisesFor = (severity: AlertSeverity): number => ladderFor(severity).length;

/**
 * The cooldown to set after an interrupt. `raiseCount` counts from 1.
 * Returns null once the ladder is exhausted — the caller's signal to mark the
 * group done for the day rather than schedule another.
 */
export function nextCooldownFor(severity: AlertSeverity, raiseCount: number): number | null {
  const ladder = ladderFor(severity);
  return raiseCount >= ladder.length ? null : ladder[raiseCount - 1] ?? ladder[0];
}

/**
 * Fold a flat alert list into the interruptions it is worth making.
 *
 * Order is preserved rather than re-sorted: `buildAlerts` already sorts most
 * severe first, and the caller prepends agent alerts on purpose, so the first
 * family encountered is the one holding the most severe alert — and each
 * group's first member is therefore its lead.
 */
export function groupForPopup(alerts: Alert[]): AlertGroup[] {
  const byFamily = new Map<string, Alert[]>();
  const order: string[] = [];
  for (const alert of alerts) {
    const family = POPUP_FAMILY[alert.kind];
    const id = family ? `group:${family}` : `group:${alert.id}`;
    if (!byFamily.has(id)) { byFamily.set(id, []); order.push(id); }
    byFamily.get(id)!.push(alert);
  }
  return order.map(id => {
    const members = byFamily.get(id)!;
    return { id, lead: members[0], members, raiseCount: 1, raiseMax: maxRaisesFor(members[0].severity) };
  });
}

/**
 * The ONE group allowed to interrupt with a full-screen popup, or null.
 *
 * An elder app that pops a modal too often is worse than one that never does,
 * so every rule here is a reason NOT to fire. Nothing outside this function
 * decides whether the popup appears.
 */
export function pickPopupGroup(
  groups: AlertGroup[],
  {
    popped,
    raises = {},
    prefs,
    suppressed = false,
    quiet = false,
    cooldownUntil = 0,
    now = Date.now(),
  }: {
    /** Alert AND group ids already popped today, persisted across remounts. */
    popped: Set<string>;
    /** Group id -> how many times it has interrupted this sitting. */
    raises?: Record<string, number>;
    prefs: NotificationPrefs;
    /** A walkthrough, tour, or sheet is on screen — never stack modals. */
    suppressed?: boolean;
    quiet?: boolean;
    cooldownUntil?: number;
    now?: number;
  },
): AlertGroup | null {
  if (suppressed || now < cooldownUntil) return null;
  for (const group of groups) {
    const { lead } = group;
    // Only the top two tiers ever interrupt. A notice belongs in the list.
    if (lead.severity === "notice") continue;
    if (!prefs[lead.pref]) continue;
    // The group id is written once its ladder runs out — done for the day.
    if (popped.has(group.id)) continue;
    // Nothing in it is new: every member has already had its interrupt. A
    // fresh member (a fourth dose missed after the first three were dismissed)
    // re-opens the group, subject to the ladder below.
    if (group.members.every(m => popped.has(m.id))) continue;
    // Quiet hours are overridden ONLY by the two things that are actually
    // dangerous to sit on overnight — mirroring channels/scheduler.py, which
    // never quiet-suppresses a missed critical dose.
    if (quiet && !(lead.severity === "critical")) continue;
    const already = raises[group.id] ?? 0;
    if (already >= maxRaisesFor(lead.severity)) continue;
    return { ...group, raiseCount: already + 1 };
  }
  return null;
}

/**
 * The single alert that would interrupt — `pickPopupGroup`'s lead.
 *
 * Kept as the thin wrapper it now is because its test suite is the regression
 * proof for every rule above (tier, preference toggle, dedupe, cooldown, quiet
 * hours, suppression); those cases pass unchanged through the grouping.
 */
export function pickPopupAlert(
  alerts: Alert[],
  opts: Parameters<typeof pickPopupGroup>[1],
): Alert | null {
  return pickPopupGroup(groupForPopup(alerts), opts)?.lead ?? null;
}

/** Where an alert is actually actionable, and on what. */
export interface AlertDestination {
  tab: ElderlyTab;
  /** The medicine to open (Medications) or scroll to (Home) once there.
   *  Both are carried because `medicationId` is absent on demo/local rows —
   *  buildAlerts falls back to the name in the alert id for the same reason —
   *  so consumers match on the id first and the name second. Undefined on
   *  alerts with no backing medicine (care messages, link requests, agent
   *  notices), which is also what makes `canTellCaregiver` below decidable. */
  focusMedicationId?: string;
  focusMedName?: string;
}

/**
 * Alert kind → where to land, so "something is wrong" and "here is the thing
 * that is wrong" are never two different answers.
 *
 * Same job as lib/changeHighlight.ts's ENTITY_TARGETS and lib/agentActions.ts's
 * ACTION_TARGETS — a table in lib/, not a ternary at a call site. It lived as an
 * inline ternary inside ElderlyApp's popup until 2026-08-09, which is why only
 * the popup could route at all and the Reminders cards were inert.
 *
 * Elder-only, deliberately: the caregiver shell has its own unrelated
 * `Notification` type and its own screens.
 */
export function destinationFor(alert: Alert): AlertDestination {
  const med = { focusMedicationId: alert.medicationId, focusMedName: alert.medName };
  switch (alert.kind) {
    // Supply and a finished course are both answered on the medicine itself.
    case "out_of_supply":
    case "low_supply":
    case "course_finished":
      return { tab: "prescriptions", ...med };
    // A missed dose is ticked off on the Home timeline, not in the med list.
    case "missed_critical":
    case "missed_dose":
      return { tab: "home", ...med };
    // Link requests and care messages are answered where they already are, and
    // an agent notice has no backing entity at all — see UrgentAlertPopup's
    // "absent when the alert has nowhere specific to go" contract, which the
    // `tab === "notifications"` test below is what finally makes real.
    default:
      return { tab: "notifications" };
  }
}

/** True when there is somewhere else to travel to — the person is already
 *  looking at the card when an alert's destination is the Reminders tab. */
export function canViewAlert(alert: Alert): boolean {
  return destinationFor(alert).tab !== "notifications";
}

/** True when the alert is about a MEDICINE, i.e. there is something concrete to
 *  tell a caregiver about. Never offered on a care message — that one already
 *  came FROM them. */
export function canTellCaregiver(alert: Alert): boolean {
  const dest = destinationFor(alert);
  return !!(dest.focusMedicationId || dest.focusMedName);
}

/**
 * WHY THE POPUP NO LONGER OFFERS "Tell my caregiver" (2026-08-11).
 *
 * `canTellCaregiver` is still live — the Reminders cards
 * (ElderlyNotificationsScreen) call it, and an inbox somebody chose to open can
 * afford more options than an interruption. But the POPUP's copy of it is gone,
 * and it turns out that removes the button entirely rather than narrowing it:
 * the only kinds it was ever true for are the medicine-backed ones (missed
 * doses, low/out of supply), which are precisely the ones a person answers
 * themselves on a screen one tap away. Every other kind that can interrupt —
 * a link request, a care message, an `agent` alert — already got `false` here,
 * because destinationFor gives none of them a focusMedication.
 *
 * So there is deliberately no `popupActionsFor` table: it would have exactly
 * one live field. UrgentAlertPopup simply has no onTellCaregiver prop now.
 */
