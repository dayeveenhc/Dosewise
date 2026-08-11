import { describe, expect, it } from "vitest";
import { buildAlerts, pickPopupAlert, groupForPopup, pickPopupGroup, nextCooldownFor, maxRaisesFor, inQuietHours, destinationFor, canViewAlert, canTellCaregiver, CRITICAL_SUPPLY_DAYS } from "./alerts";
import { t } from "./language";
import type { Alert } from "./alerts";
import type { Medication } from "../types";
import type { NotificationPrefs } from "../accessibility";

const ALL_ON: NotificationPrefs = {
  doseReminders: true, refillAlerts: true, caregiverNotes: true, missedDoseAlerts: true,
};

// Mid-afternoon, so nothing is accidentally inside default quiet hours.
const NOON = new Date(2026, 6, 8, 14, 0);

const med = (over: Partial<Medication>): Medication => ({
  id: 1, name: "Metformin", dose: "500mg", time: "8:00 AM", status: "upcoming",
  purpose: "Diabetes", colour: "#000", medicationId: "m1", ...over,
});

describe("buildAlerts — supply", () => {
  it("tiers a critical medicine's low supply above a standard one's", () => {
    const [a] = buildAlerts({
      medications: [med({ pillsRemaining: CRITICAL_SUPPLY_DAYS, priority: "critical" })],
      now: NOON,
    });
    expect(a.severity).toBe("critical");

    const [b] = buildAlerts({
      medications: [med({ pillsRemaining: CRITICAL_SUPPLY_DAYS, priority: "standard" })],
      now: NOON,
    });
    expect(b.severity).toBe("urgent");
  });

  it("treats being OUT as critical whatever the medicine's priority", () => {
    const [a] = buildAlerts({ medications: [med({ pillsRemaining: 0 })], now: NOON });
    expect(a.severity).toBe("critical");
    expect(a.kind).toBe("out_of_supply");
  });

  it("does not call a FINISHED course 'running low' — it is over, not short", () => {
    const alerts = buildAlerts({
      medications: [med({ pillsRemaining: 1, endDate: "2026-07-01" })],
      now: NOON,
    });
    expect(alerts.some(a => a.kind === "low_supply" || a.kind === "out_of_supply")).toBe(false);
    expect(alerts.map(a => a.kind)).toContain("course_finished");
  });

  it("gives an alert a STABLE id across evaluations — the dedupe depends on it", () => {
    const args = { medications: [med({ pillsRemaining: 2 })], now: NOON };
    expect(buildAlerts(args)[0].id).toBe(buildAlerts({ ...args, now: new Date(2026, 6, 8, 15, 0) })[0].id);
  });
});

describe("buildAlerts — missed doses (both tiers)", () => {
  it("tiers a critical medicine's missed dose above a standard one's", () => {
    const passed = { time: "8:00 AM", status: "upcoming" as const };
    const critical = buildAlerts({ medications: [med({ ...passed, priority: "critical" })], now: NOON });
    expect(critical.map(a => a.kind)).toContain("missed_critical");
    expect(critical.find(a => a.kind === "missed_critical")!.severity).toBe("critical");

    // An ordinary medicine now alerts too (2026-08-09) — at the gentler
    // urgent tier, behind the same missedDoseAlerts toggle.
    const standard = buildAlerts({ medications: [med({ ...passed, priority: "standard" })], now: NOON });
    const ordinary = standard.find(a => a.kind === "missed_dose");
    expect(ordinary).toBeDefined();
    expect(ordinary!.severity).toBe("urgent");
    expect(ordinary!.pref).toBe("missedDoseAlerts");
    expect(standard.map(a => a.kind)).not.toContain("missed_critical");
  });

  it("gives an ordinary miss a grace window; a critical one fires the moment the slot passes", () => {
    // 14:00 now, dose at 13:30 — 30 min late, inside MISSED_DOSE_GRACE_MIN.
    const inGrace = buildAlerts({ medications: [med({ time: "1:30 PM" })], now: NOON });
    expect(inGrace.map(a => a.kind)).not.toContain("missed_dose");
    // 13:00 → exactly 60 min late: the grace boundary fires.
    const pastGrace = buildAlerts({ medications: [med({ time: "1:00 PM" })], now: NOON });
    expect(pastGrace.map(a => a.kind)).toContain("missed_dose");
    // Critical keeps zero grace.
    const critical = buildAlerts({ medications: [med({ time: "1:30 PM", priority: "critical" })], now: NOON });
    expect(critical.map(a => a.kind)).toContain("missed_critical");
  });

  it("skips the ordinary tier for a vague slot — '08:00 fallback' must not nag at a fictional time", () => {
    const alerts = buildAlerts({ medications: [med({ time: "After breakfast" })], now: NOON });
    expect(alerts.map(a => a.kind)).not.toContain("missed_dose");
  });

  it("honours Mei's snooze for BOTH tiers — 'not yet' must not be re-nagged", () => {
    const snoozed = {
      medications: [med({ time: "8:00 AM" })],
      // Slot matched on the 24h form of the med's time; until 13:45 → at 14:00
      // the person is only 15 min past their own chosen time.
      doseSnoozes: [{ medication_id: "m1", slot: "08:00", date: "2026-07-08", until: "13:45" }],
      now: NOON,
    };
    expect(buildAlerts(snoozed).map(a => a.kind)).not.toContain("missed_dose");
    // Critical keeps zero grace, so its snooze suppresses only until `until`
    // itself — a still-future snooze holds it.
    expect(
      buildAlerts({
        ...snoozed,
        medications: [med({ time: "8:00 AM", priority: "critical" })],
        doseSnoozes: [{ medication_id: "m1", slot: "08:00", date: "2026-07-08", until: "14:30" }],
      }).map(a => a.kind),
    ).not.toContain("missed_critical");
    // Once the snooze itself is well past (grace beyond until), it fires again.
    expect(
      buildAlerts({
        ...snoozed,
        doseSnoozes: [{ medication_id: "m1", slot: "08:00", date: "2026-07-08", until: "12:00" }],
      }).map(a => a.kind),
    ).toContain("missed_dose");
  });

  it("keeps a day-scoped stable id, so the popup dedupe works unchanged", () => {
    const args = { medications: [med({ time: "8:00 AM" })], now: NOON };
    expect(buildAlerts(args).find(a => a.kind === "missed_dose")!.id)
      .toBe(buildAlerts({ ...args, now: new Date(2026, 6, 8, 15, 0) }).find(a => a.kind === "missed_dose")!.id);
  });

  it("does not raise one for a dose already taken, or still in the future", () => {
    const taken = buildAlerts({
      medications: [med({ priority: "critical", status: "taken" })], now: NOON,
    });
    expect(taken.map(a => a.kind)).not.toContain("missed_critical");

    const later = buildAlerts({
      medications: [med({ priority: "critical", time: "9:00 PM" })], now: NOON,
    });
    expect(later.map(a => a.kind)).not.toContain("missed_critical");
  });

  it("does not raise one on a day the medicine isn't due", () => {
    // 8 July 2026 is a Wednesday.
    const alerts = buildAlerts({
      medications: [med({ priority: "critical", days: ["mon"] }), med({ days: ["mon"] })], now: NOON,
    });
    expect(alerts.map(a => a.kind)).not.toContain("missed_critical");
    expect(alerts.map(a => a.kind)).not.toContain("missed_dose");
  });
});

describe("buildAlerts — ordering", () => {
  it("sorts most severe first, so the popup and the list agree on what matters", () => {
    const alerts = buildAlerts({
      medications: [
        // Evening slots, so the supply tiers are the only alerts in play.
        med({ id: 1, medicationId: "m1", name: "A", pillsRemaining: 12, time: "9:00 PM" }), // notice
        med({ id: 2, medicationId: "m2", name: "B", pillsRemaining: 0, time: "9:00 PM" }),  // critical
        med({ id: 3, medicationId: "m3", name: "C", pillsRemaining: 5, time: "9:00 PM" }),  // urgent
      ],
      now: NOON,
    });
    expect(alerts.map(a => a.severity)).toEqual(["critical", "urgent", "notice"]);
  });
});

describe("pickPopupAlert — every rule is a reason NOT to interrupt", () => {
  const alert = (over: Partial<Alert> = {}): Alert => ({
    id: "supply:m1", kind: "low_supply", severity: "urgent",
    titleKey: "t", bodyKey: "b", params: {}, pref: "refillAlerts", ...over,
  });
  const base = { popped: new Set<string>(), prefs: ALL_ON, now: 1_000_000 };

  it("returns the most severe eligible alert", () => {
    expect(pickPopupAlert([alert()], base)?.id).toBe("supply:m1");
  });

  it("never interrupts for a notice — that belongs in the list", () => {
    expect(pickPopupAlert([alert({ severity: "notice" })], base)).toBeNull();
  });

  it("respects the person's own notification toggle", () => {
    const prefs = { ...ALL_ON, refillAlerts: false };
    expect(pickPopupAlert([alert()], { ...base, prefs })).toBeNull();
  });

  it("never repeats an alert already popped", () => {
    expect(pickPopupAlert([alert()], { ...base, popped: new Set(["supply:m1"]) })).toBeNull();
  });

  it("stays quiet behind another modal, and during the cooldown", () => {
    expect(pickPopupAlert([alert()], { ...base, suppressed: true })).toBeNull();
    expect(pickPopupAlert([alert()], { ...base, cooldownUntil: base.now + 1 })).toBeNull();
  });

  it("holds an urgent alert during quiet hours but lets a CRITICAL one through", () => {
    expect(pickPopupAlert([alert()], { ...base, quiet: true })).toBeNull();
    expect(pickPopupAlert([alert({ severity: "critical" })], { ...base, quiet: true })).not.toBeNull();
  });

  it("treats an ordinary missed dose as urgent: pops once, held in quiet hours, gated on its toggle", () => {
    const missed = alert({ id: "missed:m1|8:00 AM|2026-07-08", kind: "missed_dose", pref: "missedDoseAlerts" });
    expect(pickPopupAlert([missed], base)?.kind).toBe("missed_dose");
    expect(pickPopupAlert([missed], { ...base, quiet: true })).toBeNull();
    expect(pickPopupAlert([missed], { ...base, prefs: { ...ALL_ON, missedDoseAlerts: false } })).toBeNull();
  });
});

describe("inQuietHours", () => {
  it("handles a wrap-around window, matching dosing.py::in_quiet_hours", () => {
    const quiet = { start: "22:00", end: "07:00" };
    expect(inQuietHours(new Date(2026, 6, 8, 23, 0), quiet)).toBe(true);
    expect(inQuietHours(new Date(2026, 6, 8, 3, 0), quiet)).toBe(true);
    expect(inQuietHours(new Date(2026, 6, 8, 14, 0), quiet)).toBe(false);
    // The end bound is exclusive, the start inclusive.
    expect(inQuietHours(new Date(2026, 6, 8, 7, 0), quiet)).toBe(false);
    expect(inQuietHours(new Date(2026, 6, 8, 22, 0), quiet)).toBe(true);
  });

  it("handles a same-day window", () => {
    expect(inQuietHours(new Date(2026, 6, 8, 14, 0), { start: "13:00", end: "15:00" })).toBe(true);
    expect(inQuietHours(new Date(2026, 6, 8, 16, 0), { start: "13:00", end: "15:00" })).toBe(false);
  });

  it("falls back to a sane default rather than never being quiet", () => {
    expect(inQuietHours(new Date(2026, 6, 8, 23, 30), undefined)).toBe(true);
    expect(inQuietHours(new Date(2026, 6, 8, 12, 0), undefined)).toBe(false);
  });
});

// Trigger class 4: Mei raises an alert from a chat turn. Unlike every other
// kind, its title/body are FREE PROSE the model already wrote in the reader's
// own language — not translation keys. The host stores that prose in the
// titleKey/bodyKey fields and the popup renders it through t() like any other
// alert, which only works because t() ends in `?? key` and echoes anything it
// doesn't recognise. That is load-bearing and untested elsewhere: if t() ever
// returned "" or a key-shaped string for a miss, an agent alert would render a
// blank modal.
describe("an agent-raised alert renders its own prose", () => {
  it("echoes an unrecognised key instead of blanking or falling back", () => {
    const title = "Metformin and ibuprofen can clash";
    expect(t("en", title, {})).toBe(title);
    // …in every language, since the model writes it in the reader's own.
    expect(t("ms", title, {})).toBe(title);
  });

  it("leaves prose containing braces alone when there are no params", () => {
    const body = "Check with your doctor about {this} combination.";
    expect(t("en", body, {})).toBe(body);
  });
});

// The elder shell seeds `patient` from data/patients.ts, whose demo medicines
// carry refillDaysLeft 4 and 3 — under both supply thresholds. Before the
// medsLoaded gate in ElderlyApp, every session opened with a full-screen alert
// about medicines the person does not take, which is exactly what CONTEXT.md's
// "real medical facts have NO mock fallback" rule forbids. buildAlerts itself
// is pure, so the gate lives at the call site; these lock in the two halves of
// the contract it depends on.
describe("supply alerts come from real data only", () => {
  it("raises nothing at all for an empty medication list", () => {
    expect(buildAlerts({ medications: [], now: NOON })).toEqual([]);
  });

  it("would otherwise alert on fixture-shaped data — which is why the caller gates on medsLoaded", () => {
    // data/patients.ts's own numbers. This SHOULD produce alerts when the data
    // is real; the point is that the engine cannot tell fixture from real, so
    // the host must not call it until the fetch has landed.
    const fixture = buildAlerts({
      medications: [med({ name: "Metformin", refillDaysLeft: 4 })],
      now: NOON,
    });
    expect(fixture.length).toBeGreaterThan(0);
  });
});

// destinationFor is the single source of "where does this alert send you", shared
// by the popup's Show-me button and the Reminders card's. The two used to disagree
// by construction: only the popup routed at all, via an inline ternary.
describe("destinationFor — one map, every consumer", () => {
  it("sends a supply alert to the medicine list, carrying the medicine", () => {
    const [a] = buildAlerts({ medications: [med({ pillsRemaining: 2 })], now: NOON });
    expect(destinationFor(a)).toEqual({
      tab: "prescriptions", focusMedicationId: "m1", focusMedName: "Metformin",
    });
  });

  it("sends a finished course to the medicine list too — it is archived there", () => {
    const alerts = buildAlerts({
      medications: [med({ pillsRemaining: 1, endDate: "2026-07-01" })],
      now: NOON,
    });
    const finished = alerts.find(a => a.kind === "course_finished")!;
    expect(destinationFor(finished).tab).toBe("prescriptions");
  });

  it("sends a missed dose to Home, where it is ticked off", () => {
    const alerts = buildAlerts({
      medications: [med({ time: "8:00 AM", status: "upcoming", priority: "critical" })],
      now: NOON,
    });
    const missed = alerts.find(a => a.kind === "missed_critical")!;
    expect(destinationFor(missed)).toEqual({
      tab: "home", focusMedicationId: "m1", focusMedName: "Metformin",
    });
  });

  it("falls back to the NAME when a demo/local row has no medicationId", () => {
    const [a] = buildAlerts({
      medications: [med({ medicationId: undefined, pillsRemaining: 2 })],
      now: NOON,
    });
    expect(destinationFor(a).focusMedicationId).toBeUndefined();
    expect(destinationFor(a).focusMedName).toBe("Metformin");
    // Still routable, and still worth telling a caregiver about.
    expect(canViewAlert(a)).toBe(true);
    expect(canTellCaregiver(a)).toBe(true);
  });

  it("offers NOTHING for an agent alert with no backing entity", () => {
    // Shaped exactly as ElderlyApp's handleAgentAlert builds one: prose, no
    // medicationId, ever. This is the case UrgentAlertPopup's "absent when the
    // alert has nowhere specific to go" contract was written for, and which was
    // dead code while onView was passed unconditionally.
    const agent: Alert = {
      id: "agent:x", kind: "agent", severity: "urgent",
      titleKey: "Metformin and ibuprofen can clash", bodyKey: "Ask your doctor.",
      params: {}, pref: "doseReminders",
    };
    expect(destinationFor(agent)).toEqual({ tab: "notifications" });
    expect(canViewAlert(agent)).toBe(false);
    expect(canTellCaregiver(agent)).toBe(false);
  });

  it("keeps a care message and a link request on the tab they already live on", () => {
    const alerts = buildAlerts({
      medications: [],
      careMessages: [{ id: 9, author: "Wei Ming", role: "Son", body: "hi", time: "10:30 AM", isMe: false }],
      linkRequests: [{ id: "r1", caregiverName: "Shu Fen", relationship: "Daughter", requestedAt: "" }],
      now: NOON,
    });
    for (const a of alerts) {
      expect(destinationFor(a).tab).toBe("notifications");
      expect(canViewAlert(a)).toBe(false);
      expect(canTellCaregiver(a)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// One interruption per situation, escalating in prominence and backing off in
// frequency. The pickPopupAlert suite above is the regression proof that every
// pre-existing rule survives the grouping: it now runs THROUGH groupForPopup.
// ---------------------------------------------------------------------------
describe("groupForPopup", () => {
  const a = (over: Partial<Alert>): Alert => ({
    id: "x", kind: "missed_dose", severity: "urgent",
    titleKey: "t", bodyKey: "b", params: {}, pref: "missedDoseAlerts", ...over,
  });

  it("folds every missed dose into ONE popup, led by the most severe", () => {
    const group = groupForPopup([
      a({ id: "missed:m1|8:00 AM|d", kind: "missed_critical", severity: "critical" }),
      a({ id: "missed:m2|9:00 AM|d" }),
      a({ id: "missed:m3|1:00 PM|d" }),
    ]);
    expect(group).toHaveLength(1);
    expect(group[0].id).toBe("group:missed");
    expect(group[0].members).toHaveLength(3);
    // A critical member makes the whole interruption critical — the tier the
    // popup shows, and the one that overrides quiet hours.
    expect(group[0].lead.severity).toBe("critical");
  });

  it("folds out-of-stock and low-supply together, but not with missed doses", () => {
    const groups = groupForPopup([
      a({ id: "supply:m1", kind: "out_of_supply", severity: "critical", pref: "refillAlerts" }),
      a({ id: "supply:m2", kind: "low_supply", pref: "refillAlerts" }),
      a({ id: "missed:m3|8:00 AM|d" }),
    ]);
    expect(groups.map(g => g.id)).toEqual(["group:supply", "group:missed"]);
    expect(groups[0].members).toHaveLength(2);
  });

  it("NEVER aggregates consent requests — one popup must name one person", () => {
    const groups = groupForPopup([
      a({ id: "link:1", kind: "care_link_request", pref: "caregiverNotes" }),
      a({ id: "link:2", kind: "care_link_request", pref: "caregiverNotes" }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe("the two ladders — prominence up, frequency down", () => {
  it("stretches the cooldown with each raise, then returns null at the ceiling", () => {
    expect(nextCooldownFor("urgent", 1)).toBe(30 * 60_000);
    expect(nextCooldownFor("urgent", 2)).toBe(2 * 3_600_000);
    // Third is the last one an ordinary alert gets: no fourth interrupt today.
    expect(nextCooldownFor("urgent", 3)).toBeNull();
    expect(maxRaisesFor("urgent")).toBe(3);

    // A critical alert gets more, and sooner — but still a hard ceiling.
    expect(nextCooldownFor("critical", 1)).toBe(20 * 60_000);
    expect(nextCooldownFor("critical", maxRaisesFor("critical"))).toBeNull();
    expect(maxRaisesFor("critical")).toBe(5);
  });
});

describe("pickPopupGroup", () => {
  const a = (over: Partial<Alert> = {}): Alert => ({
    id: "missed:m1|8:00 AM|d", kind: "missed_dose", severity: "urgent",
    titleKey: "t", bodyKey: "b", params: {}, pref: "missedDoseAlerts", ...over,
  });
  const base = { popped: new Set<string>(), prefs: ALL_ON, now: 1_000_000 };
  const groups = (...alerts: Alert[]) => groupForPopup(alerts);

  it("counts from 1 on the first interrupt and reports the tier's ceiling", () => {
    const picked = pickPopupGroup(groups(a()), base);
    expect(picked?.raiseCount).toBe(1);
    expect(picked?.raiseMax).toBe(3);
  });

  it("escalates the meter with the stored raise count", () => {
    const picked = pickPopupGroup(groups(a()), { ...base, raises: { "group:missed": 2 } });
    expect(picked?.raiseCount).toBe(3);
  });

  it("stops interrupting once the ladder is spent", () => {
    expect(pickPopupGroup(groups(a()), { ...base, raises: { "group:missed": 3 } })).toBeNull();
  });

  it("stays quiet when every member has already interrupted", () => {
    const one = a();
    expect(pickPopupGroup(groups(one), { ...base, popped: new Set([one.id]) })).toBeNull();
  });

  it("re-opens for a NEW member the person has not seen yet", () => {
    // A fourth dose missed after the first three were dismissed is genuinely
    // new information, and must not be swallowed by the earlier dismissal.
    const seen = a({ id: "missed:m1|8:00 AM|d" });
    const fresh = a({ id: "missed:m2|1:00 PM|d" });
    const picked = pickPopupGroup(groups(seen, fresh), { ...base, popped: new Set([seen.id]) });
    expect(picked?.members).toHaveLength(2);
  });

  it("is done for the day once the group id itself is popped", () => {
    expect(pickPopupGroup(groups(a()), { ...base, popped: new Set(["group:missed"]) })).toBeNull();
  });
});

describe("the popup drops Tell-my-caregiver; the Reminders inbox keeps it", () => {
  const a = (over: Partial<Alert>): Alert => ({
    id: "x", kind: "missed_dose", severity: "urgent",
    titleKey: "t", bodyKey: "b", params: {}, pref: "missedDoseAlerts", ...over,
  });

  // The predicate itself is UNCHANGED — ElderlyNotificationsScreen still calls
  // it, and an inbox somebody chose to open can afford more options than an
  // interruption. What changed is that UrgentAlertPopup no longer has the
  // button at all. These two assertions are the pair that documents why
  // removing it was a removal and not a narrowing: the only kinds the
  // predicate is true for are exactly the medicine-backed ones the person
  // answers themselves.
  it("is true only for medicine-backed alerts", () => {
    for (const kind of ["missed_dose", "missed_critical", "low_supply", "out_of_supply"] as const) {
      expect(canTellCaregiver(a({ kind, medName: "Metformin", medicationId: "m1" }))).toBe(true);
    }
  });

  it("was already false for everything else that can interrupt", () => {
    // An agent alert has no destination and therefore no focusMedication, so
    // the popup never offered it one — which is why dropping the button loses
    // nothing beyond the self-serve cases.
    expect(canTellCaregiver(a({ kind: "agent", medName: "Warfarin", pref: "doseReminders" }))).toBe(false);
    expect(canTellCaregiver(a({ kind: "care_link_request", pref: "caregiverNotes" }))).toBe(false);
    expect(canTellCaregiver(a({ kind: "care_message", pref: "caregiverNotes" }))).toBe(false);
  });
});
