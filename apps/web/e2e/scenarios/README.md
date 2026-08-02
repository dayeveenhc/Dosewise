# e2e/scenarios — per-scenario verification specs (Phase 3)

One spec file per row of `manifest.ts`, named exactly `sNN-<slug>.spec.ts`
(e.g. `s07-multi-named-doses.spec.ts`). `coverage.spec.ts` is the gate: it
fails on orphan filenames, slug mismatches, duplicate ids, and manifest
taskNames that are not real `WalkthroughTaskName` literals. Shared helpers
live in `../helpers.ts` — extend nothing there yourself (coordinator-owned).

## The six mandatory sections

Every `sNN` spec MUST contain all six, in this order:

1. **FIXTURE** — fresh throwaway elder (and caregiver where the scenario needs
   one) via `createThrowawayElder` / `createCaregiverWithPendingLink`, then the
   per-scenario seed rows (medications/doses/care_links…) inserted directly via
   supabase-js as that user. Never reuse accounts across scenarios.

2. **TRIGGER** — a verbatim realistic phrase (what an elder would actually
   say) sent through `agentTurn8901(jwt, phrase)` against the local hermes on
   `:8901`. Assert the turn shape against your manifest row: `turn.http`,
   `turn.tools_used`, the committed `turn.actions` entry (or, for walkthrough
   scenarios, `turn.walkthrough.task_name`). `saveTurnArtifact` the raw JSON of
   EVERY attempt (see the ≤3-attempts rule below).

3. **RE-CHECK** — the independent Supabase re-read: `recheckDb` /
   `recheckAccessibility` + `expectRow`. **Never trust the turn's own
   response** — the DB is the truth. VIEW-ONLY and TRIGGER scenarios assert the
   opposite: prove NOTHING was written (empty `recheckDb` result / unchanged
   accessibility path).

4. **UI + PACING** — drive the real UI on baseURL `:5173` (`signIn(page,
   creds)` etc.). Call `resetPhaseLog(page)` immediately BEFORE the phase under
   test, perform the interaction, then `readPhaseLog(page)` +
   `assertPhaseMins(log, …)` against the imported `PACING` constants. Real
   phase names written to the log: surface `"walkthrough"` → `navigate`,
   `field`, `click`, `act`, `between-fields`, `verify`, `reveal`; surface
   `"highlight"` → `dwell` (min `PACING.HIGHLIGHT_DWELL_MIN_MS`).
   `assertPhaseMins` checks minimums only — add your own generous upper-bound
   checks case-by-case if the scenario needs them.

5. **SCREENSHOT(s)** — durable evidence to `e2e/design-shots/scenarios/sNN/`
   (`mkdirSync(..., { recursive: true })`). Deliberately OUTSIDE
   `e2e/artifacts/`, which Playwright wipes at the start of every run.

6. **NO scenario-local ms literals** — every timing reference goes through the
   imported `PACING` object (`import { PACING } from
   "../../src/app/lib/walkthrough/pacing"`). The single allowed literal is a
   fixed settle wait for scroll geometry, written exactly as
   `await page.waitForTimeout(500); // let smooth scrollIntoView settle`.

## Skeleton

```ts
import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  expectRow, readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// sNN <slug> — one-line scenario statement (tag from manifest.ts).
const ARTIFACTS = "e2e/artifacts/sNN";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/sNN"; // durable, NOT wiped

test("sNN <slug>: '<trigger phrase>' -> <expected outcome>", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { data: signInData, error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  const jwt = signInData!.session!.access_token;
  const { data: med, error: mErr } = await supa
    .from("medications")
    .insert({ elder_id: creds.userId, name: "Metformin", dosage: "500mg",
              purpose: "blood sugar", schedule: { times: ["08:00"], frequency: "daily" } })
    .select("id")
    .single();
  expect(mErr, mErr?.message).toBeNull();
  const medId: string = med!.id;
  // ...plus whatever doses/care_links rows THIS scenario depends on...

  // ── 2 TRIGGER ─────────────────────────────────────────────────────────────
  // Verbatim realistic phrase; ≤3 recorded attempts for LLM-routing variance.
  const PHRASE = "I just took my metformin";
  let turn = await agentTurn8901(jwt, PHRASE);
  saveTurnArtifact(ARTIFACTS, "turn-attempt-1", turn);
  for (let attempt = 2; attempt <= 3 && !turn.tools_used.includes("log_dose"); attempt++) {
    console.log(`[TRIGGER] attempt ${attempt} (previous tools_used=${JSON.stringify(turn.tools_used)})`);
    turn = await agentTurn8901(jwt, PHRASE);
    saveTurnArtifact(ARTIFACTS, `turn-attempt-${attempt}`, turn);
  }
  expect(turn.http, "agent/turn HTTP status").toBe(200);
  expect(turn.tools_used, "expected tool routed").toContain("log_dose");
  const action = turn.actions.find(a => a.tool === "log_dose");
  expect(action, "committed action present").toBeTruthy();
  // Walkthrough scenarios instead assert:
  //   expect(turn.walkthrough?.task_name).toBe("<taskName from manifest.ts>");

  // ── 3 RE-CHECK ────────────────────────────────────────────────────────────
  const rows = await recheckDb(supa, "doses", { elder_id: creds.userId, medication_id: medId });
  expectRow(rows, { status: "taken" });
  // Accessibility writes: await recheckAccessibility(supa, creds.userId, "dose_snoozes.0.med_id")
  // VIEW-ONLY / TRIGGER scenarios assert the opposite — nothing written:
  //   expect(await recheckDb(supa, "doses", { elder_id: creds.userId })).toHaveLength(0);

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  await signIn(page, creds); // baseURL :5173
  await resetPhaseLog(page); // clear BEFORE the phase under test
  // ...drive the scenario's UI proof (fire the real action / walkthrough)...
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  const log = await readPhaseLog(page);
  assertPhaseMins(log, [
    { surface: "highlight", phase: "dwell", min: PACING.HIGHLIGHT_DWELL_MIN_MS },
    // e.g. { surface: "walkthrough", phase: "verify", min: PACING.VERIFY_MIN_MS },
  ]);

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  await page.screenshot({ path: `${SHOTS}/proof.png`, fullPage: true });

  // ── 6 NO scenario-local ms literals ───────────────────────────────────────
  // (enforced by review, not code): all timing via PACING above; the only
  // allowed literal is the 500ms settle wait, with its comment.
});
```

## RULES (binding for every scenario agent)

- **Run only your own spec**, always with a scenario-scoped output dir:
  `npx playwright test e2e/scenarios/sNN-<slug>.spec.ts --output=e2e/artifacts/sNN`.
  Never run the full e2e suite (the app is mid-restructure, and a bare run
  wipes the shared `e2e/artifacts/`).
- **Never edit files outside** your scenario's own spec file plus, only where
  the scenario owns one, your scenario's own walkthrough steps file.
- **Banned files** (read-only for scenario agents):
  `src/app/lib/language.ts`, `src/app/lib/walkthrough/types.ts`,
  `src/app/lib/walkthrough/steps/index.ts`, `e2e/scenarios/manifest.ts`,
  `services/hermes/src/hermes/agent/soul.md`, and anything under
  `services/hermes/`.
- **Shared-file needs** (helpers.ts, manifest.ts, steps/index.ts registration,
  translations, soul.md, hermes tools) go to the coordinator — describe the
  need in your report instead of making the edit.
- **A local hermes for real turns is ALREADY running on `:8901`**, and Vite on
  `:5173`. Never start, stop, or restart hermes or Vite (no pm2, no
  `scripts/post.sh`, no dev servers).
- **≤3 recorded trigger attempts** for LLM-routing variance. Every attempt is
  saved via `saveTurnArtifact` and reported honestly — a pass on attempt 3 is
  reported as exactly that, never as a first-try pass.
