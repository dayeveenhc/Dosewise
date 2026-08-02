import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  agentTurn8901, anonClient, assertPhaseMins, readPhaseLog, recheckDb,
  resetPhaseLog, saveTurnArtifact, signIn, startWalkthrough, advanceWalkthroughToStep, finishWalkthrough,
} from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s29 weekly-summary (VIEW) — a PURE spotlight tour of the caregiver's Weekly
// Summary (AskMeiScreen.tsx's Quick help launcher -> weekly-summary tile ->
// WeeklySummarySheet -> AIScreen.tsx). Manifest tools: [] is literal: the
// entire summary — adherence %, missed-dose count, AI insights, discussion
// points — is 100% MOCK/STATIC demo data straight out of data/patients.ts's
// PATIENTS[0]/WEEKLY_DATA, with NO backing table, NO fetch, and NO Hermes tool
// call (App.tsx only overwrites `patients` from real Supabase data in
// "elderly" mode; "caregiver" mode keeps the mock array untouched for the
// whole session). services/hermes/.../tools/walkthrough.py's TASK_NAMES DOES
// list "weekly_summary_tour" (start_walkthrough COULD queue it), but soul.md
// carries zero mentions of "weekly" anywhere -> no routing guidance tells the
// LLM when to reach for it via chat, unlike e.g. request_refill/travel_mode.
// So section 2 below is a genuine, OPTIONAL exploratory attempt, not a
// mandatory TRIGGER; the walkthrough-tour UI proof (section 2/4) is the
// primary deliverable, exactly like s20's language_voice_tour precedent.
// Owns: this spec + steps/weekly_summary_tour.ts.
const ARTIFACTS = "e2e/artifacts/s29";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s29"; // durable, NOT wiped

interface CaregiverCreds { email: string; password: string; userId: string }

// helpers.ts has no standalone "just a caregiver, no elder link" signup —
// createCaregiverWithPendingLink always ties one to an elder via a care_links
// insert, which this scenario doesn't need (the weekly summary is 100% mock,
// drawn from the static PATIENTS array regardless of role or any real
// care_link). Mirrors s23-caregiver-care-note's createThrowawayCaregiver
// exactly, with role: "caregiver".
async function createThrowawayCaregiver(): Promise<CaregiverCreds> {
  const supa = anonClient();
  const email = `tw-cg-${Date.now()}-${Math.floor(performance.now())}@dosewise.test`;
  const password = "Throwaway!2026";
  const { data, error } = await supa.auth.signUp({ email, password });
  if (error || !data.user) throw new Error(`caregiver signUp failed: ${error?.message}`);
  const { error: pErr } = await supa.from("profiles").insert({ id: data.user.id, role: "caregiver", full_name: "Tan Wei (test)" });
  if (pErr) throw new Error(`caregiver profile seed failed: ${pErr.message}`);
  return { email, password, userId: data.user.id };
}

// App.tsx's handleWalkthroughAdvance calls `void markWalkthroughCompleted(...)`
// on tour completion — fire-and-forget, never awaited by the UI, and itself a
// fetch-then-upsert round trip to the (hosted, not local) Supabase project.
// A single immediate recheckDb can race it and read the row before the write
// lands (observed empirically). This is NOT a UI-pacing wait — nothing in the
// walkthrough experience is slower than PACING says — so it deliberately does
// NOT go through PACING; it is test-infrastructure polling for an
// already-fired-in-the-background write to become visible, bounded and
// short-interval like any other "wait for eventual consistency" retry.
async function waitForCompletedWalkthrough(
  supa: SupabaseClient, userId: string, taskName: string,
): Promise<Record<string, unknown>[]> {
  const attempts = 10;
  const intervalMs = 300;
  let rows = await recheckDb(supa, "profiles", { id: userId });
  for (let i = 0; i < attempts; i++) {
    const completed = (rows[0]?.accessibility as { completedWalkthroughs?: string[] } | undefined)?.completedWalkthroughs ?? [];
    if (completed.includes(taskName)) return rows;
    await sleep(intervalMs);
    rows = await recheckDb(supa, "profiles", { id: userId });
  }
  return rows; // exhausted — return the last read and let the assertion below fail honestly
}

// weekly_summary_tour anchors (steps/weekly_summary_tour.ts) + per-step copy.
const NAV_AI = '[data-tour="nav-ai"]';
const QUICKHELP_ROW = '[data-tour="cg-askmei"]';
const SUMMARY_TILE = '[data-walk="cg-weeklysummary-tile"]';

test("s29 weekly-summary: AI-auto-advanced Weekly Summary tour -> 100% mock summary sheet, no write, no highlight", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // A throwaway CAREGIVER account — no elder, no care_links row, no
  // medications. The weekly summary is 100% mock, so nothing else needs
  // seeding (per this scenario's task brief).
  const creds = await createThrowawayCaregiver();
  const supa = anonClient();
  const { data: signInData, error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  const jwt = signInData!.session!.access_token;
  console.log(`[SEED] caregiver=${creds.userId} (no elder/care_link/medications needed — weekly summary is 100% mock)`);

  // Baseline Supabase snapshot, taken BEFORE any UI interaction, so the later
  // no-write proof is a real before/after diff, not just a post-hoc read.
  const profileBefore = await recheckDb(supa, "profiles", { id: creds.userId });
  expect(profileBefore, "exactly the one seeded profiles row").toHaveLength(1);

  // ── 2 TRIGGER (optional, exploratory — see file header) ───────────────────
  // ONE realistic phrase, recorded honestly either way. start_walkthrough is
  // explicitly documented as NOT a write regardless of whether it fires
  // (services/hermes/.../tools/walkthrough.py: "Not a write — deliberately not
  // appended to ctx.committed_actions"), so actions is asserted empty either
  // way; this is not gated on any specific tool routing (manifest tools: []).
  const PHRASE = "Show me my patient's weekly summary";
  const turn = await agentTurn8901(jwt, PHRASE);
  saveTurnArtifact(ARTIFACTS, "turn-attempt-1", turn);
  console.log(`[TRIGGER] tools_used=${JSON.stringify(turn.tools_used)} walkthrough=${JSON.stringify(turn.walkthrough)} actions=${JSON.stringify(turn.actions)}`);
  expect(turn.http, "agent/turn HTTP status").toBe(200);
  expect(turn.actions, "start_walkthrough (if routed at all) is NEVER a committed write").toHaveLength(0);

  // ── 2/4 WALKTHROUGH UI ─────────────────────────────────────────────────────
  await signIn(page, creds); // baseURL :5173, lands on caregiver Dashboard — __dwStartWalkthrough is now registered in App.tsx's caregiver branch too
  await expect(page.locator(NAV_AI), "caregiver bottom nav mounted").toBeVisible({ timeout: 15_000 });

  // No ChangeHighlight ring exists before the tour either (baseline half of
  // the no-highlight proof).
  await expect(page.locator(".change-highlight"), "no highlight ring before the tour").toHaveCount(0);
  await expect(page.locator('[data-testid="change-highlight-caption"]'), "no highlight caption before the tour").toHaveCount(0);

  // resetPhaseLog first so the log holds only this interaction. All 3 steps are
  // act:click now (2026-07-28) → autonomous → the tour SELF-DRIVES: it opens Ask
  // Mei, taps Quick help, then taps the Weekly Summary tile, opening the mock
  // sheet. We do NOT tap — the person just watches.
  await resetPhaseLog(page);
  await startWalkthrough(page, "weekly_summary_tour");

  // It travels to the AI tab and spotlights the Quick help launcher on the way.
  await advanceWalkthroughToStep(page, 2);

  // It reaches and spotlights the Weekly Summary tile; screenshot the spotlight
  // (the deliverable) before the final tap.
  await advanceWalkthroughToStep(page, 3);
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  await page.screenshot({ path: `${SHOTS}/walkthrough-step3-summary-tile.png`, fullPage: true });

  // Tapping through the rest completes it: Mei's final tap opens the mock Weekly
  // Summary sheet and the overlay unmounts.
  await finishWalkthrough(page);
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), "tour completes once tapped through").toHaveCount(0, { timeout: 20_000 });

  // The sheet + its 100% mock content (AIScreen.tsx, fed by data/patients.ts's
  // PATIENTS[0]/WEEKLY_DATA — no fetch, no Supabase read of any kind).
  await expect(page.getByText("Weekly Summary", { exact: true }).first(), "summary sheet title rendered").toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Ah Ma", { exact: false }).first(), "mock patient nickname rendered").toBeVisible();
  await expect(page.getByText("82%", { exact: false }).first(), "mock adherence figure rendered").toBeVisible();
  await expect(page.getByText("Celecoxib frequently missed at noon", { exact: false }).first(), "mock AI insight rendered").toBeVisible();

  // Phase-log shape for an autonomous tour: PACED walkthrough phases (the inverse
  // of the old user-driven zero). Three act:click steps (steps 2-3 carry onEnter →
  // a navigate settle), so click + navigate phases are present, each floored.
  const walkLog = await readPhaseLog(page);
  const walkPhases = walkLog.filter(e => e.surface === "walkthrough");
  console.log(`[PHASELOG] walkthrough entries=${JSON.stringify(walkPhases.map(e => `${e.surface}/${e.phase}`))}`);
  expect(walkPhases.length, "autonomous tour records paced walkthrough phases").toBeGreaterThan(0);
  assertPhaseMins(walkLog, [
    { surface: "walkthrough", phase: "click", min: PACING.PRE_CLICK_MS },
    { surface: "walkthrough", phase: "navigate", min: PACING.NAVIGATE_MS },
  ]);

  // ── 3 NO-WRITE / NO-HIGHLIGHT PROOF (replaces a DB re-check) ──────────────
  // The point of a 100% mock scenario: viewing it commits nothing, rings
  // nothing, and touches no real backend table except the SAME generic
  // completedWalkthroughs bookkeeping marker every walkthrough writes on
  // completion (mirrors s20's identical, documented caveat) — never a
  // weekly-summary-specific key, never a committed agent action (no
  // medications/doses/care_links row, no entity_type/entity_id/changed_fields
  // — CONTEXT.md's propose-vs-commit distinction).
  await expect(page.locator(".change-highlight"), "no highlight ring after viewing the summary").toHaveCount(0);
  await expect(page.locator('[data-testid="change-highlight-caption"]'), "no highlight caption after viewing the summary").toHaveCount(0);

  // Polled, not single-shot — see waitForCompletedWalkthrough's comment: the
  // completion write is fire-and-forget from the UI's perspective.
  const profileAfter = await waitForCompletedWalkthrough(supa, creds.userId, "weekly_summary_tour");
  expect(profileAfter, "still exactly one profiles row").toHaveLength(1);
  const before0 = profileBefore[0] as Record<string, unknown>;
  const after0 = profileAfter[0] as Record<string, unknown>;
  for (const key of ["id", "role", "full_name", "dialect", "created_at"]) {
    expect(after0[key], `profiles.${key} unchanged`).toEqual(before0[key]);
  }
  expect(after0.accessibility, "accessibility gained ONLY the walkthrough-completion marker — no weekly-summary/medical keys")
    .toEqual({ ...(before0.accessibility as Record<string, unknown>), completedWalkthroughs: ["weekly_summary_tour"] });

  // Defensive: no medication/care_link rows exist under this id either —
  // nothing was seeded, and viewing a mock summary can't have created any.
  const medsAfter = await recheckDb(supa, "medications", { elder_id: creds.userId });
  expect(medsAfter, "no medications ever existed or were created").toHaveLength(0);
  const linksAfter = await recheckDb(supa, "care_links", { caregiver_id: creds.userId });
  expect(linksAfter, "no care_links row ever existed or was created").toHaveLength(0);

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  await page.screenshot({ path: `${SHOTS}/weekly-summary-sheet-content.png`, fullPage: true });

  // ── 6 NO scenario-local ms literals ───────────────────────────────────────
  // Same honest shape as s20: every one of this tour's 3 steps is waitFor (no
  // act/verify/reveal), so no PaceController minimum ever applies and there is
  // no PACING constant to import/assert against for UI experience timing. Two
  // raw literals remain, both non-UI test infrastructure, not app pacing: the
  // required 500ms scrollIntoView settle above, and waitForCompletedWalkthrough's
  // poll (10 attempts x 300ms) for the fire-and-forget completion write —
  // explained where it's defined, not app behavior this suite is asserting on.
});
