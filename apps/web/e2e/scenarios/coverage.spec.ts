import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { SCENARIOS } from "./manifest";

// Node-only coverage gate for the Phase-3 scenario specs — no page/browser
// fixture, so no browser is launched. Runs with cwd = apps/web (the same
// assumption helpers.env() makes for its ".env" read):
//
//   npx playwright test e2e/scenarios/coverage.spec.ts --output=e2e/artifacts/coverage
//
// (--output keeps Playwright's start-of-run outputDir wipe away from the
// sibling per-scenario artifact dirs.)

const TAGS = ["AUDIT", "FIXED-P1", "NEW-FE", "NEW-BE-FE", "VIEW", "CONSENT", "TRIGGER"];
const TYPES_TS = "src/app/lib/walkthrough/types.ts";
const SCENARIOS_DIR = "e2e/scenarios";

test.describe("scenario manifest coverage", () => {
  test("32 entries with unique, sequential ids s01..s32", () => {
    expect(SCENARIOS, "manifest row count").toHaveLength(32);
    const ids = SCENARIOS.map(s => s.id);
    expect(new Set(ids).size, "ids unique").toBe(32);
    ids.forEach((id, i) => {
      expect(id, `entry ${i} sequential id`).toBe(`s${String(i + 1).padStart(2, "0")}`);
    });
  });

  test("slugs are unique kebab-case", () => {
    const slugs = SCENARIOS.map(s => s.slug);
    expect(new Set(slugs).size, "slugs unique").toBe(32);
    for (const slug of slugs) {
      expect(slug, `slug "${slug}" is kebab-case`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  test("tags are valid", () => {
    for (const s of SCENARIOS) {
      expect(TAGS, `${s.id} tag "${s.tag}"`).toContain(s.tag);
    }
  });

  test("every manifest taskName is a WalkthroughTaskName string literal", () => {
    // Read + regex on purpose (never import types.ts: this spec must stay
    // node-only and independent of src's runtime imports). Strip // comments
    // BEFORE slicing at the terminating ";" — union prose may legally contain
    // a semicolon or a quoted word, and neither may end the slice early nor
    // count as a literal.
    const src = readFileSync(TYPES_TS, "utf8");
    const decommented = src.split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");
    const union = decommented.match(/export type WalkthroughTaskName\s*=([\s\S]*?);/)?.[1];
    expect(union, `WalkthroughTaskName union found in ${TYPES_TS}`).toBeTruthy();
    const literals = new Set([...union!.matchAll(/"([A-Za-z0-9_]+)"/g)].map(m => m[1]));

    const wanted = SCENARIOS.filter(s => s.taskName).map(s => ({ id: s.id, taskName: s.taskName as string }));
    const missing = wanted.filter(w => !literals.has(w.taskName));
    const msg = missing.length > 0
      ? `manifest taskNames missing from the WalkthroughTaskName union: ${missing.map(m => `${m.id}=${m.taskName}`).join(", ")}`
      : "all manifest taskNames present in union";
    expect(missing, msg).toHaveLength(0);
  });

  test("every sNN-*.spec.ts file matches a manifest {id, slug}; missing specs only counted", () => {
    const files = readdirSync(SCENARIOS_DIR).filter(f => /^s\d{2}-.*\.spec\.ts$/.test(f)).sort();
    const byId = new Map(SCENARIOS.map(s => [s.id, s]));
    const seen = new Set<string>();
    for (const f of files) {
      const [, id, slug] = f.match(/^(s\d{2})-(.+)\.spec\.ts$/)!;
      expect(seen.has(id), `duplicate spec files for ${id} (second: "${f}")`).toBe(false);
      seen.add(id);
      const entry = byId.get(id);
      expect(entry, `orphan spec file "${f}": no manifest entry with id ${id}`).toBeTruthy();
      expect(slug, `spec file "${f}" slug matches manifest ${id}`).toBe(entry!.slug);
    }
    // Missing spec files are OK for now — they arrive one per agent in Phase 3.
    console.log(`[coverage] ${seen.size}/${SCENARIOS.length} scenario specs present, ${SCENARIOS.length - seen.size} pending (Phase 3).`);
  });
});
