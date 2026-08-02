import { describe, expect, it } from "vitest";
import { resolveTimezone, TIMEZONES } from "./constants";

// The travel-mode <select>'s options carry no value attribute, so an option's
// value IS its exact label. Assigning anything else doesn't "miss" — it sets
// selectedIndex = -1 and BLANKS the field, and the blank then persists. The
// timezone arrives as free text from Hermes, so everything an LLM might
// plausibly send has to land on a real option or be refused outright.

describe("resolveTimezone", () => {
  it("returns a string that is genuinely one of the select's options", () => {
    for (const input of ["Asia/Tokyo", "tokyo", "japan", "UTC+9", "Japan (UTC+9)"]) {
      const resolved = resolveTimezone(input);
      expect(TIMEZONES, `${input} -> ${resolved}`).toContain(resolved);
    }
  });

  it("passes an exact label through unchanged", () => {
    for (const label of TIMEZONES) expect(resolveTimezone(label)).toBe(label);
  });

  it("resolves IANA zone ids", () => {
    expect(resolveTimezone("Asia/Tokyo")).toBe("Japan (UTC+9)");
    expect(resolveTimezone("Asia/Hong_Kong")).toBe("Hong Kong (UTC+8)");
    expect(resolveTimezone("America/New_York")).toBe("USA — New York (UTC-5)");
    expect(resolveTimezone("Europe/London")).toBe("United Kingdom (UTC+0)");
  });

  it("resolves bare city and country names, and abbreviations", () => {
    expect(resolveTimezone("Tokyo")).toBe("Japan (UTC+9)");
    expect(resolveTimezone("japan")).toBe("Japan (UTC+9)");
    expect(resolveTimezone("JST")).toBe("Japan (UTC+9)");
    expect(resolveTimezone("Sydney")).toBe("Australia — Sydney (UTC+11)");
    expect(resolveTimezone("Jakarta")).toBe("Indonesia — Jakarta (UTC+7)");
    expect(resolveTimezone("KL")).toBe("Malaysia (UTC+8)");
  });

  it("tolerates case, padding, and a plain hyphen where the label has an em-dash", () => {
    expect(resolveTimezone("  JAPAN (utc+9)  ")).toBe("Japan (UTC+9)");
    expect(resolveTimezone("Indonesia - Jakarta (UTC+7)")).toBe("Indonesia — Jakarta (UTC+7)");
    expect(resolveTimezone("usa - new york (utc-5)")).toBe("USA — New York (UTC-5)");
  });

  it("falls back to a bare offset, including half-hour offsets", () => {
    expect(resolveTimezone("UTC+9")).toBe("Japan (UTC+9)");
    expect(resolveTimezone("+09:00")).toBe("Japan (UTC+9)");
    expect(resolveTimezone("UTC+5:30")).toBe("India (UTC+5:30)");
    // UTC+8 is genuinely ambiguous (five options) — take the first listed.
    expect(resolveTimezone("UTC+8")).toBe("Singapore (UTC+8)");
  });

  it("returns null rather than guessing at something unrecognisable", () => {
    for (const input of ["", "   ", "Mars", "somewhere warm", "Atlantis/Lost", undefined, null]) {
      expect(resolveTimezone(input as string | null | undefined)).toBeNull();
    }
  });
});
