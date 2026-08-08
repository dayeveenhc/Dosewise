import { describe, expect, it } from "vitest";
import { buildAlerts, pickPopupAlert, inQuietHours, CRITICAL_SUPPLY_DAYS } from "./alerts";
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

describe("buildAlerts — missed critical doses", () => {
  it("raises a missed dose only for a CRITICAL medicine whose time has passed", () => {
    const passed = { time: "8:00 AM", status: "upcoming" as const };
    const critical = buildAlerts({ medications: [med({ ...passed, priority: "critical" })], now: NOON });
    expect(critical.map(a => a.kind)).toContain("missed_critical");

    // An ordinary missed dose belongs on the Home timeline, not in a modal.
    const standard = buildAlerts({ medications: [med({ ...passed, priority: "standard" })], now: NOON });
    expect(standard.map(a => a.kind)).not.toContain("missed_critical");
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
      medications: [med({ priority: "critical", days: ["mon"] })], now: NOON,
    });
    expect(alerts.map(a => a.kind)).not.toContain("missed_critical");
  });
});

describe("buildAlerts — ordering", () => {
  it("sorts most severe first, so the popup and the list agree on what matters", () => {
    const alerts = buildAlerts({
      medications: [
        med({ id: 1, medicationId: "m1", name: "A", pillsRemaining: 12 }),           // notice
        med({ id: 2, medicationId: "m2", name: "B", pillsRemaining: 0 }),            // critical
        med({ id: 3, medicationId: "m3", name: "C", pillsRemaining: 5 }),            // urgent
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
