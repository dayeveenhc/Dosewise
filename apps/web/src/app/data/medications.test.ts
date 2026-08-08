import { describe, expect, it } from "vitest";
import { catalogLabelKey, localizeCatalogValue } from "./medications";

// The alias layer exists because what is STORED did not match what the catalog
// KEYS: 5 of 6 seeded conditions ("Type 2 Diabetes" vs "Diabetes",
// "Hypertension" vs "Blood Pressure", …) rendered raw English even on screens
// that called localizeCatalogValue correctly. These tests pin the two halves
// that pull against each other — reach the translation, but don't rewrite the
// person's words to get there.

// Stand-ins for t(): EN returns the canonical English labels (which is what the
// real en map holds); TA returns something visibly different.
const EN: Record<string, string> = {
  "catalog.condition.bloodPressure": "Blood Pressure",
  "catalog.condition.diabetes": "Diabetes",
  "catalog.condition.jointPain": "Joint Pain",
};
const TA: Record<string, string> = {
  "catalog.condition.bloodPressure": "இரத்த அழுத்தம்",
  "catalog.condition.diabetes": "நீரிழிவு",
  "catalog.condition.jointPain": "மூட்டு வலி",
};
const en = (k: string) => EN[k] ?? k;
const ta = (k: string) => TA[k] ?? k;

describe("catalogLabelKey", () => {
  it("resolves canonical values, synonyms, casing, spacing and a trailing qualifier", () => {
    expect(catalogLabelKey("Blood Pressure")).toBe("catalog.condition.bloodPressure");
    expect(catalogLabelKey("Hypertension")).toBe("catalog.condition.bloodPressure");
    expect(catalogLabelKey("  hIgH   bLoOd  pReSsUrE ")).toBe("catalog.condition.bloodPressure");
    expect(catalogLabelKey("Chronic Kidney Disease (Stage 3)"))
      .toBe(catalogLabelKey("Chronic Kidney Disease"));
  });

  it("returns null for anything the person typed freehand", () => {
    expect(catalogLabelKey("Ah Ma's mystery ache")).toBeNull();
    expect(catalogLabelKey("")).toBeNull();
  });
});

describe("localizeCatalogValue", () => {
  it("translates a synonym — the whole reason the alias table exists", () => {
    expect(localizeCatalogValue("Type 2 Diabetes", ta)).toBe("நீரிழிவு");
    expect(localizeCatalogValue("Hypertension", ta)).toBe("இரத்த அழுத்தம்");
    expect(localizeCatalogValue("Osteoarthritis", ta)).toBe("மூட்டு வலி");
  });

  it("leaves a synonym ALONE in English rather than rewriting it to the canonical label", () => {
    // The regression this guards: an alias is only a route to a translation.
    // In English there is no translation to reach, so resolving it just swaps
    // the person's own words for the catalog's preferred phrasing — which is
    // what broke e2e/scenarios/s02, where a walkthrough types "High blood
    // pressure" and the chip came back reading "Blood Pressure".
    expect(localizeCatalogValue("High blood pressure", en)).toBe("High blood pressure");
    expect(localizeCatalogValue("Type 2 Diabetes", en)).toBe("Type 2 Diabetes");
  });

  it("still renders a CANONICAL value in English (it is already the label)", () => {
    expect(localizeCatalogValue("Blood Pressure", en)).toBe("Blood Pressure");
    expect(localizeCatalogValue("Diabetes", en)).toBe("Diabetes");
  });

  it("falls back to the stored string for free text, in every language", () => {
    expect(localizeCatalogValue("Ah Ma's mystery ache", en)).toBe("Ah Ma's mystery ache");
    expect(localizeCatalogValue("Ah Ma's mystery ache", ta)).toBe("Ah Ma's mystery ache");
  });

  it("never shows a raw key when a language is missing the entry", () => {
    // t() returns the key itself on a miss; showing
    // "catalog.condition.diabetes" to a patient is worse than English.
    expect(localizeCatalogValue("Type 2 Diabetes", (k: string) => k)).toBe("Type 2 Diabetes");
  });
});
