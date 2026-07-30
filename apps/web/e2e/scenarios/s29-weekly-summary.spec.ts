import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  agentTurn8901, anonClient, readPhaseLog, recheckDb, resetPhaseLog,
  saveTurnArtifact, signIn, startWalkthrough,
} from "../helpers";

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
const STEP1_TEXT = "Tap Ask Mei.";                                    // walk.weeklySummaryTour.step1
const STEP2_TEXT = "Tap Quick help to see what Mei can do.";          // walk.weeklySummaryTour.step2
const STEP3_TEXT = "Tap Weekly Summary to see how the week went.";    // walk.weeklySummaryTour.step3

// The view-only-class invariant (identical to s20/s10/s19): a waitFor step is
// NEVER paced, so the callout shows Exit but MUST NOT render a Next button
// (Walkthrough.tsx gates the whole Next/Replay block on `autonomous`, false
// for every waitFor step). Assert the callout IS present (Exit visible) so the
// absence of Next is meaningful, not just an unmounted overlay.
async function assertWaitForStep(page: import("@playwright/test").Page, bodyText: string, label: string) {
  await expect(page.getByText(bodyText, { exact: false }), `${label}: callout body`).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), `${label}: Exit present`).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true }), `${label}: NO Next button (view-only tour)`).toHaveCount(0);
}

test("s29 weekly-summary: caregiver-driven Weekly Summary tour (no Next) -> 100% mock summary sheet, no write, no highlight", async ({ page }) => {
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

  // resetPhaseLog first so the log holds only this interaction. All 3 steps
  // are waitFor (user-driven) -> NO PaceController is ever instantiated for
  // them (Walkthrough.tsx: `autonomous = !!(step.act || ...)`, false here) ->
  // the tour records NO walkthrough phase-log entries at all (asserted below;
  // same honest zero shape as s20 — the field/click/act/navigate phases only
  // exist inside the autonomous act path in orchestrate.ts, never taken).
  await resetPhaseLog(page);
  await startWalkthrough(page, "weekly_summary_tour");

  // Step 1: spotlight the always-mounted AI nav tab; Next absent. The person
  // taps it themselves to travel there.
  await assertWaitForStep(page, STEP1_TEXT, "step 1 go-to-askmei");
  await page.locator(NAV_AI).click();

  // Step 2: spotlight the Quick help row; Next absent. The row also wraps a
  // "Clear chat" button (clicking THAT would also bubble-satisfy the ancestor
  // waitFor, but wouldn't open the popup) — so drive the real, instructed
  // action specifically: the "Quick help" button itself.
  await expect(page.locator(QUICKHELP_ROW), "step 2 quick-help row target").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, STEP2_TEXT, "step 2 open-quickhelp");
  await page.getByRole("button", { name: "Quick help" }).click();

  // Step 3: spotlight the Weekly Summary tile; Next absent. Screenshot here
  // per the deliverable (a tour step spotlighting the summary tile) BEFORE
  // acting, so the shot shows the spotlight, not the after-state.
  await expect(page.locator(SUMMARY_TILE), "step 3 weekly-summary tile target").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, STEP3_TEXT, "step 3 tap-tile");
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  await page.screenshot({ path: `${SHOTS}/walkthrough-step3-summary-tile.png`, fullPage: true });

  // Real user tap: opens the mock Weekly Summary sheet AND — this being the
  // tour's LAST step — satisfies the walkthrough's final waitFor in the same
  // click (the native listener on this exact node fires during the same
  // synchronous dispatch, before React's re-render removes the popup).
  await page.locator(SUMMARY_TILE).click();

  // Tour complete: overlay gone (no Exit) — the SAME click that opened the
  // sheet also completed the tour.
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), "walkthrough overlay dismissed").toHaveCount(0, { timeout: 15_000 });

  // The sheet + its 100% mock content (AIScreen.tsx, fed by data/patients.ts's
  // PATIENTS[0]/WEEKLY_DATA — no fetch, no Supabase read of any kind).
  await expect(page.getByText("Weekly Summary", { exact: true }).first(), "summary sheet title rendered").toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Ah Ma", { exact: false }).first(), "mock patient nickname rendered").toBeVisible();
  await expect(page.getByText("82%", { exact: false }).first(), "mock adherence figure rendered").toBeVisible();
  await expect(page.getByText("Celecoxib frequently missed at noon", { exact: false }).first(), "mock AI insight rendered").toBeVisible();

  // Phase-log shape for a fully user-driven tour: honestly ZERO walkthrough
  // phases — no navigate/field/click/act entries either, since none of this
  // tour's steps carry `act` (or a waitFor-less verify/reveal), so
  // Walkthrough.tsx's autonomous flag is false for all 3 and orchestrate.ts's
  // runActStep (the only place that ever calls PaceController.paced(), the
  // sole producer of "walkthrough" phase-log entries) never runs.
  const walkLog = await readPhaseLog(page);
  const walkPhases = walkLog.filter(e => e.surface === "walkthrough");
  console.log(`[PHASELOG] walkthrough entries=${JSON.stringify(walkPhases.map(e => `${e.surface}/${e.phase}`))}`);
  expect(walkPhases, "user-driven tour records NO paced walkthrough phases").toHaveLength(0);

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
