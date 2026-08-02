import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LANGUAGE_OPTIONS, t } from "./language";
import type { AppLanguage } from "./language";

// Parsed from source rather than from the exported TRANSLATIONS object, which is
// module-private. The point of this file is to guard the SHAPE of that object.
// (import.meta.url is an http: URL under the jsdom environment, so resolve from
// the project root instead.)
const SRC = readFileSync(resolve(process.cwd(), "src/app/lib/language.ts"), "utf8");
const LANGS = LANGUAGE_OPTIONS.map(o => o.id);

function blockFor(lang: AppLanguage): string {
  const start = SRC.search(new RegExp(`^  ${lang}: \\{`, "m"));
  expect(start, `no "${lang}:" block found`).toBeGreaterThan(-1);
  const nexts = LANGS
    .map(l => SRC.search(new RegExp(`^  ${l}: \\{`, "m")))
    .filter(i => i > start);
  return SRC.slice(start, nexts.length ? Math.min(...nexts) : SRC.length);
}

function keysOf(lang: AppLanguage): string[] {
  return [...blockFor(lang).matchAll(/^ {4}"([^"]+)":/gm)].map(m => m[1]);
}

function entriesOf(lang: AppLanguage): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of blockFor(lang).matchAll(/^ {4}"([^"]+)": ("(?:[^"\\]|\\.)*"),?\s*$/gm)) {
    out.set(m[1], JSON.parse(m[2]));
  }
  return out;
}

const PLACEHOLDER = /\{[a-zA-Z][a-zA-Z0-9_]*\}/g;

describe("translations", () => {
  it("every language defines exactly the same keys as English", () => {
    // t() silently falls back to English for a missing key, so a gap here is
    // INVISIBLE at runtime — it just renders English to someone who chose
    // Tamil. 174 keys (the whole walk.* corpus among them) had drifted out of
    // all five non-English maps this way, which is why the walkthroughs ran in
    // English regardless of the language setting.
    const en = new Set(keysOf("en"));
    for (const lang of LANGS.filter(l => l !== "en")) {
      const theirs = new Set(keysOf(lang));
      const missing = [...en].filter(k => !theirs.has(k));
      const extra = [...theirs].filter(k => !en.has(k));
      expect(missing, `${lang} is missing ${missing.length} key(s)`).toEqual([]);
      expect(extra, `${lang} has ${extra.length} key(s) English does not`).toEqual([]);
    }
  });

  it("no language block declares the same key twice", () => {
    // A duplicate silently wins or loses depending on order — and the object
    // literal makes it legal, so nothing else would catch it.
    for (const lang of LANGS) {
      const keys = keysOf(lang);
      const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
      expect([...new Set(dupes)], `${lang} has duplicate keys`).toEqual([]);
    }
  });

  it("carries every English placeholder through to every translation", () => {
    // `{name}` etc. are substituted by t(); a translated or dropped placeholder
    // renders the literal braces to the user, or loses the value entirely.
    const en = entriesOf("en");
    for (const lang of LANGS.filter(l => l !== "en")) {
      const theirs = entriesOf(lang);
      for (const [key, enText] of en) {
        const want = [...(enText.match(PLACEHOLDER) ?? [])].sort();
        if (!want.length) continue;
        const got = [...(theirs.get(key) ?? "").match(PLACEHOLDER) ?? []].sort();
        expect(got, `${lang}/${key}: placeholders must match English`).toEqual(want);
      }
    }
  });

  it("resolves the keys the walkthrough gate and confirm buttons depend on", () => {
    // These specifically: a missing key makes t() return the KEY, so a person
    // would be asked to tap a button labelled "walk.next" to save a medication.
    const critical = [
      "walk.next", "walk.done", "walk.ready", "walk.readyLast",
      "walk.cannotFind", "walk.timedOut", "walk.verifyFailed",
      "walk.refused.wrongShell", "walk.refused.nothingLow",
      "ai.confirmYes", "ai.confirmNo",
      "notifications.lowStockTitle", "notifications.gotIt",
      "settings.emergencyNone", "settings.emergencyNoPhone",
    ];
    for (const lang of LANGS) {
      for (const key of critical) {
        const value = t(lang, key);
        expect(value, `${lang}/${key} resolves to the raw key`).not.toBe(key);
        expect(value.trim().length, `${lang}/${key} is empty`).toBeGreaterThan(0);
      }
    }
  });
});
