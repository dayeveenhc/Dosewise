import { describe, expect, it } from "vitest";
import { assignTakenSlots, courseDaysLeft, daysOfSupply, forecastFromPills, isDueOn, lowSupplyMedications, LOW_SUPPLY_DAYS } from "./medications";
import type { Medication } from "../types";

// A day the tests can anchor on: Wednesday 8 July 2026.
const WED = new Date(2026, 6, 8);
const day = (n: number) => new Date(2026, 6, n);

describe("courseDaysLeft", () => {
  it("returns null for an ongoing prescription — the common case", () => {
    expect(courseDaysLeft({}, WED)).toBeNull();
  });

  it("counts whole calendar days to an INCLUSIVE last day", () => {
    expect(courseDaysLeft({ endDate: "2026-07-10" }, WED)).toBe(2);
    // 0 means today IS the last day, not that the course is over.
    expect(courseDaysLeft({ endDate: "2026-07-08" }, WED)).toBe(0);
    expect(courseDaysLeft({ endDate: "2026-07-07" }, WED)).toBe(-1);
  });

  it("returns null rather than throwing on an unparseable date", () => {
    expect(courseDaysLeft({ endDate: "not-a-date" }, WED)).toBeNull();
  });
});

describe("isDueOn — fixed courses", () => {
  it("is due on the last day and not after it", () => {
    const med = { endDate: "2026-07-10" };
    expect(isDueOn(med, day(10))).toBe(true);
    expect(isDueOn(med, day(11))).toBe(false);
  });

  it("lets the course beat the weekday cadence", () => {
    // A Wednesday medicine, a week past its course end.
    const med = { days: ["wed"], endDate: "2026-07-08" };
    expect(isDueOn(med, day(8))).toBe(true);
    expect(isDueOn(med, day(15))).toBe(false);
  });

  it("lets the course beat the interval cadence", () => {
    const med = { intervalDays: 2, startDate: "2026-07-01", endDate: "2026-07-08" };
    expect(isDueOn(med, day(7))).toBe(true);   // on-cycle, within the course
    expect(isDueOn(med, day(9))).toBe(false);  // on-cycle, past the course
  });

  it("FAILS OPEN on a garbage end date", () => {
    // A medicine that silently stops reminding is worse than one that reminds
    // a day too long.
    expect(isDueOn({ endDate: "" }, WED)).toBe(true);
    expect(isDueOn({ endDate: "31/07/2026" }, WED)).toBe(true);
  });

  it("leaves a medication with no course completely unchanged", () => {
    expect(isDueOn({}, WED)).toBe(true);
    expect(isDueOn({ days: ["wed"] }, WED)).toBe(true);
    expect(isDueOn({ days: ["mon"] }, WED)).toBe(false);
  });
});

// The two halves of "I've refilled it". logRefill itself needs a Supabase
// client and is covered end-to-end by e2e/med-detail-refill.spec.ts — these are
// the pure helpers it and Hermes both compute from.
describe("daysOfSupply / forecastFromPills", () => {
  it("floors, matching log_refill's `pills_remaining // per_day`", () => {
    // Same arithmetic on both sides of the wire, so the app's preview and the
    // forecast Hermes would have written can never disagree.
    expect(daysOfSupply(30, 2)).toBe(15);
    expect(daysOfSupply(31, 2)).toBe(15);
    expect(daysOfSupply(5, 3)).toBe(1);
    expect(daysOfSupply(0, 1)).toBe(0);
  });

  it("treats a medicine with no parsed doses per day as once daily", () => {
    // Rather than dividing by zero and reporting Infinity days of supply.
    expect(daysOfSupply(14, 0)).toBe(14);
  });

  it("returns a LOCAL calendar day, not a UTC one", () => {
    // 28 pills twice daily = 14 days from 8 July -> 22 July. The naive
    // toISOString().slice(0,10) reports the 21st for every evening hour at
    // UTC+8, which is where this app's users are.
    expect(forecastFromPills(28, 2, new Date(2026, 6, 8, 23, 30))).toBe("2026-07-22");
    expect(forecastFromPills(28, 2, new Date(2026, 6, 8, 0, 30))).toBe("2026-07-22");
  });
});

describe("lowSupplyMedications", () => {
  const med = (over: Partial<Medication>): Medication => ({
    id: 1, name: "Metformin", dose: "500mg", time: "8:00 AM", status: "upcoming",
    purpose: "Diabetes", colour: "#000", ...over,
  });

  it("divides pills by DOSES PER DAY, not per time-slot row", () => {
    // 20 pills taken twice a day is 10 days, not 20 — Medication holds one row
    // per (medicine, slot), so it has to group before dividing.
    const meds = [
      med({ id: 1, medicationId: "m1", pillsRemaining: 20, time: "8:00 AM" }),
      med({ id: 2, medicationId: "m1", pillsRemaining: 20, time: "8:00 PM" }),
    ];
    const low = lowSupplyMedications(meds, 11);
    expect(low).toEqual([{ name: "Metformin", daysLeft: 10 }]);
  });

  it("is exclusive at the threshold and sorts soonest-first", () => {
    const meds = [
      med({ id: 1, medicationId: "m1", name: "A", pillsRemaining: LOW_SUPPLY_DAYS }),
      med({ id: 2, medicationId: "m2", name: "B", pillsRemaining: 2 }),
    ];
    // Exactly at the threshold is NOT low; below it is.
    expect(lowSupplyMedications(meds)).toEqual([{ name: "B", daysLeft: 2 }]);
  });

  it("omits a medicine with no supply data rather than inventing a number", () => {
    expect(lowSupplyMedications([med({ medicationId: "m1" })])).toEqual([]);
  });
});

// The per-slot attribution behind fetchElderMedications (2026-08-09): one
// taken row used to mark EVERY slot of a multi-time medication taken, hiding
// a genuinely-missed evening slot — the exact case missed-dose alerts exist
// for. Local timestamps are used so `new Date(...)`'s local reading matches.
describe("assignTakenSlots", () => {
  const takenAt = (h: number, m = 0) => {
    const d = new Date(2026, 6, 8, h, m);
    return { scheduled_at: d.toISOString(), logged_at: d.toISOString() };
  };

  it("attributes a dose to the slot its scheduled_at names", () => {
    const map = assignTakenSlots(["08:00", "20:00"], [takenAt(20)]);
    expect(map.has("20:00")).toBe(true);
    expect(map.has("08:00")).toBe(false);
  });

  it("one taken of two leaves the OTHER slot unclaimed — the alert-feature case", () => {
    const map = assignTakenSlots(["08:00", "20:00"], [takenAt(8)]);
    expect(map.has("08:00")).toBe(true);
    expect(map.has("20:00")).toBe(false);
  });

  it("falls back to earliest-first for a dose matching no slot (doses.py's rule)", () => {
    const map = assignTakenSlots(["08:00", "20:00"], [takenAt(13, 30)]);
    expect(map.has("08:00")).toBe(true);
    expect(map.has("20:00")).toBe(false);
  });

  it("two doses fill both slots regardless of match order", () => {
    const map = assignTakenSlots(["08:00", "20:00"], [takenAt(20), takenAt(11)]);
    expect(map.has("08:00")).toBe(true);
    expect(map.has("20:00")).toBe(true);
  });

  it("single-slot medicines behave exactly as before", () => {
    expect(assignTakenSlots(["08:00"], [takenAt(9, 15)]).has("08:00")).toBe(true);
    expect(assignTakenSlots(["08:00"], []).size).toBe(0);
  });

  it("survives a null scheduled_at (fallback path, no crash)", () => {
    const map = assignTakenSlots(["08:00"], [{ scheduled_at: null, logged_at: null }]);
    expect(map.has("08:00")).toBe(true);
  });
});
