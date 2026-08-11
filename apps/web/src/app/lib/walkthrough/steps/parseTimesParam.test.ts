import { describe, expect, it, vi } from "vitest";
import { parseTimesParam } from "./add_prescription_auto";

// The dose time Mei was told about used to be dropped entirely at the
// chat->walkthrough handoff, so "one at 12 pm" was filed at 08:00 (the sheet's
// breakfast default). `times` now carries it — as ONE comma-separated string,
// because walkthrough.py coerces every param through str().
//
// The behaviour worth pinning is the FAILURE mode: lib/medications.ts::to24h
// answers "08:00" for anything it can't parse, with no error anywhere, which is
// how a medication once got silently scheduled hours from when it was
// prescribed. This parser must drop instead — loudly.
describe("parseTimesParam", () => {
  it("parses a single 24h time", () => {
    expect(parseTimesParam("12:00")).toEqual(["12:00"]);
  });

  it("parses several, trims, de-duplicates and sorts chronologically", () => {
    expect(parseTimesParam("20:00, 08:00 ,20:00")).toEqual(["08:00", "20:00"]);
  });

  it("accepts 12h clock forms, including a bare hour", () => {
    expect(parseTimesParam("12 pm")).toEqual(["12:00"]);
    expect(parseTimesParam("12:00 AM")).toEqual(["00:00"]);
    expect(parseTimesParam("9:30pm")).toEqual(["21:30"]);
    expect(parseTimesParam("8am")).toEqual(["08:00"]);
  });

  it("is empty for no param at all", () => {
    expect(parseTimesParam()).toEqual([]);
    expect(parseTimesParam("")).toEqual([]);
    expect(parseTimesParam("  ")).toEqual([]);
  });

  it("DROPS junk and out-of-range values loudly — never silently defaults to 08:00", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Includes the shape a model sends when it ignores the "one string" rule.
    expect(parseTimesParam("morning")).toEqual([]);
    expect(parseTimesParam("['12:00']")).toEqual([]);
    expect(parseTimesParam("25:00")).toEqual([]);
    expect(parseTimesParam("12:75")).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps the good values in a partly-bad list", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseTimesParam("08:00,teatime,20:00")).toEqual(["08:00", "20:00"]);
    warn.mockRestore();
  });
});
