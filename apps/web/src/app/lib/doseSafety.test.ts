import { describe, it, expect } from "vitest";
import { checkDoseSafety, parseDoseCount } from "./doseSafety";

describe("parseDoseCount", () => {
  it("reads plain, decimal and fractional counts", () => {
    expect(parseDoseCount("2 tablets")).toBe(2);
    expect(parseDoseCount("1.5 tablets")).toBe(1.5);
    expect(parseDoseCount("1/2 tablet")).toBe(0.5);
    expect(parseDoseCount("½ tablet")).toBe(0.5);
  });

  it("returns null when there is no leading number", () => {
    expect(parseDoseCount("one tablet")).toBeNull();
    expect(parseDoseCount("")).toBeNull();
  });
});

describe("checkDoseSafety", () => {
  it("flags an implausible number in a single dose", () => {
    const c = checkDoseSafety("10 pills", 1);
    expect(c?.kind).toBe("perDose");
    expect(c?.perDay).toBe(10);
  });

  it("flags a plausible dose that adds up to too much across the day", () => {
    // 3 tablets is fine on its own; four times a day is 12.
    const c = checkDoseSafety("3 tablets", 4);
    expect(c?.kind).toBe("perDay");
    expect(c?.perDay).toBe(12);
  });

  it("stays quiet on ordinary regimens", () => {
    expect(checkDoseSafety("1 tablet", 3)).toBeNull();
    expect(checkDoseSafety("2 tablets", 2)).toBeNull();
    expect(checkDoseSafety("½ tablet", 2)).toBeNull();
  });

  // The whole point of the COUNTABLE gate: strengths and volumes carry big
  // numbers as a matter of course, and warning on them would train people to
  // tap through the warning that matters.
  it("ignores strengths and volumes, however large the number", () => {
    expect(checkDoseSafety("500 mg", 3)).toBeNull();
    expect(checkDoseSafety("10 ml", 4)).toBeNull();
    expect(checkDoseSafety("1000 IU", 2)).toBeNull();
  });

  it("says nothing about doses it cannot read", () => {
    expect(checkDoseSafety("as directed", 4)).toBeNull();
    expect(checkDoseSafety("", 1)).toBeNull();
  });
});
