import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  readPhaseLog, recheckAccessibility, resetPhaseLog, saveTurnArtifact, signIn, startWalkthrough,
  advanceWalkthroughUntil, advanceWalkthroughToStep, finishWalkthrough,
} from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s14 travel-mode (AUDIT) — "set up travel mode" routes start_walkthrough
// {task_name:"travel_mode_auto"}, then the autonomous 7-step walkthrough fills
// the dates + timezone, saves, and VERIFIES the plan persisted. This is the one
// Wave-A scenario that also exercises the Replay control: during the reveal
// phase we press Replay once and prove the reveal dwell restarts (a 2nd reveal
// phase entry in the log).
const ARTIFACTS = "e2e/artifacts/s14";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s14"; // durable, NOT wiped

// Sensible values for "flying to Tokyo next Monday for two weeks" — these match
// the step builder's contract (travelModeAutoSteps reads p.start_date /
// p.end_date / p.timezone; the timezone MUST be a verbatim TravelModeSheet
// <option>, i.e. "Japan (UTC+9)", for the select act to land).
const START_DATE = "2026-08-03"; // next Monday
const END_DATE = "2026-08-17";   // two weeks later
const TIMEZONE = "Japan (UTC+9)";

const revealCount = (log: { surface: string; phase: string }[]) =>
  log.filter(e => e.surface === "walkthrough" && e.phase === "reveal").length;

test("s14 travel-mode: 'set up travel mode' -> travel_mode_auto walkthrough saves the plan (with Replay)", async ({ page }) => {
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
  // One active med so the sheet's packing list renders (realistic reveal shot).
  const { error: mErr } = await supa
    .from("medications")
    .insert({ elder_id: creds.userId, name: "Metformin", dosage: "500mg",
              purpose: "blood sugar", schedule: { times: ["08:00"], frequency: "daily" } });
  expect(mErr, mErr?.message).toBeNull();

  // ── 2 TRIGGER ─────────────────────────────────────────────────────────────
  // Verbatim realistic phrase; ≤3 recorded attempts for LLM-routing variance.
  const PHRASE = "I'm flying to Tokyo next Monday for two weeks — can you set up travel mode?";
  const routed = (t: Awaited<ReturnType<typeof agentTurn8901>>) =>
    t.tools_used.includes("start_walkthrough") && t.walkthrough?.task_name === "travel_mode_auto";
  let turn = await agentTurn8901(jwt, PHRASE);
  saveTurnArtifact(ARTIFACTS, "turn-attempt-1", turn);
  for (let attempt = 2; attempt <= 3 && !routed(turn); attempt++) {
    console.log(`[TRIGGER] attempt ${attempt} (previous tools_used=${JSON.stringify(turn.tools_used)}, walkthrough=${JSON.stringify(turn.walkthrough)})`);
    turn = await agentTurn8901(jwt, PHRASE);
    saveTurnArtifact(ARTIFACTS, `turn-attempt-${attempt}`, turn);
  }
  expect(turn.http, "agent/turn HTTP status").toBe(200);
  expect(turn.tools_used, "expected start_walkthrough routed").toContain("start_walkthrough");
  expect(turn.walkthrough?.task_name, "walkthrough task_name").toBe("travel_mode_auto");
  // AUDIT observation (not a hard gate on exact values): record the params the
  // model chose for {start_date, end_date, timezone} and whether they're sensible.
  const modelParams = turn.walkthrough?.params ?? {};
  console.log(`[TRIGGER] model-chosen params = ${JSON.stringify(modelParams)}`);
  expect(Object.keys(modelParams).length, "model passed some travel params").toBeGreaterThan(0);

  // ── 3 RE-CHECK (post-trigger: nothing written) ─────────────────────────────
  // start_walkthrough only QUEUES the walkthrough — no DB write. The plan lands
  // later, when Mei taps Save in the UI. Prove the trigger wrote nothing yet.
  expect(await recheckAccessibility(supa, creds.userId, "travelPlan"), "no travelPlan before the UI drive").toBeUndefined();

  // ── 4 UI + PACING (drive the real walkthrough + Replay) ─────────────────────
  await signIn(page, creds); // baseURL :5173
  await resetPhaseLog(page); // clear BEFORE the phase under test
  // Drive via the dev hook with params matching the builder contract (the drive
  // must not depend on the LLM's param choices).
  await startWalkthrough(page, "travel_mode_auto", { start_date: START_DATE, end_date: END_DATE, timezone: TIMEZONE });

  // Steps 1-3 (open the category, the Travel Mode tile, the enable toggle) each
  // hold at their commit gate until the person taps Next, so tap through to the
  // start-date fill before waiting on its animation.
  await advanceWalkthroughToStep(page, 4);

  // Screenshot 1 — date mid-fill: the start-date field is spotlighted + being
  // filled (its pre-highlight ring is present through the whole fill window).
  await page.waitForSelector('[data-walk="travel-start-date"].walk-field-prehighlight', { state: "attached", timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/1-date-mid-fill.png`, fullPage: true });

  // Fills + timezone select done → the run PAUSES at the manual-Save confirm step
  // (waitFor on the real "travel-plan-saved" write event, no Next) — nothing
  // commits on autopilot (2026-07-28 contract). The person taps Save THEMSELVES;
  // that save emits the event and advances to Verify. Wait for the confirm
  // callout, then tap Save.
  // Each autonomous step now holds at its commit gate until the person taps
  // Next, so tap through the fills + timezone select to reach the confirm step.
  await advanceWalkthroughUntil(page, () => page.getByText("tap Save yourself", { exact: false }).isVisible());
  await expect(page.getByText("tap Save yourself", { exact: false }), "manual-Save confirm step reached").toBeVisible({ timeout: 40_000 });

  // The timezone really landed on a real option — a value matching no <option>
  // used to blank the field, and the old Verify (startDate only) called that a
  // success. performAct now refuses such a value outright.
  await expect(page.locator('[data-walk="travel-timezone-select"]'), "timezone resolved to a real option").toHaveValue(TIMEZONE);

  await page.locator('[data-walk="travel-save-button"]').click();

  // The reveal phase begins when the save Verify passes; the Replay control is
  // shown only then. Screenshot the (pre-replay) reveal, then press Replay ONCE
  // — well before the reveal's paced floor elapses, so consumeReplay() re-runs
  // the reveal loop and a SECOND "reveal" phase entry is recorded.
  const replayBtn = page.getByRole("button", { name: "Replay", exact: true });
  await replayBtn.waitFor({ state: "visible", timeout: 60_000 });
  await page.screenshot({ path: `${SHOTS}/2-reveal.png`, fullPage: true });
  await replayBtn.click();

  // The first reveal entry is recorded the instant phase-1 ends and the replay
  // loop restarts — wait for that, so shot 3 captures the RE-run reveal (its
  // pulse settles after one navigate beat).
  await page.waitForFunction(() => {
    const log = (window as unknown as { __dwPhaseLog?: { surface: string; phase: string }[] }).__dwPhaseLog ?? [];
    return log.filter(e => e.surface === "walkthrough" && e.phase === "reveal").length >= 1;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(PACING.NAVIGATE_MS); // let the re-fired reveal pulse render
  await page.screenshot({ path: `${SHOTS}/3-post-replay.png`, fullPage: true });

  // Let the replayed reveal dwell run to completion (2nd reveal entry recorded).
  await page.waitForFunction(() => {
    const log = (window as unknown as { __dwPhaseLog?: { surface: string; phase: string }[] }).__dwPhaseLog ?? [];
    return log.filter(e => e.surface === "walkthrough" && e.phase === "reveal").length >= 2;
  }, null, { timeout: 30_000 });

  const log = await readPhaseLog(page);
  assertPhaseMins(log, [
    { surface: "walkthrough", phase: "field", min: PACING.FIELD_MIN_MS },
    { surface: "walkthrough", phase: "click", min: PACING.PRE_CLICK_MS },
    { surface: "walkthrough", phase: "verify", min: PACING.VERIFY_MIN_MS },
    { surface: "walkthrough", phase: "reveal", min: PACING.REVEAL_PULSE_MS },
  ]);
  // REPLAY EVIDENCE: exactly one Replay press ⇒ the reveal loop ran twice.
  const reveals = revealCount(log);
  console.log(`[REPLAY] reveal phase entries in log = ${reveals} (expected 2: original + one replay)`);
  expect(reveals, "reveal dwell restarted after Replay (2nd reveal entry)").toBe(2);

  // ── RE-CHECK (post-save: the plan really persisted) ─────────────────────────
  const plan = await recheckAccessibility(supa, creds.userId, "travelPlan") as
    { startDate?: string; endDate?: string; timezone?: string } | undefined;
  expect(plan, "travelPlan saved").toBeTruthy();
  expect(plan!.startDate, "saved startDate").toBe(START_DATE);
  expect(plan!.endDate, "saved endDate").toBe(END_DATE);
  expect(plan!.timezone, "saved timezone").toBe(TIMEZONE);

  // ── 5 SCREENSHOT — see shots 1-3 above (date mid-fill, reveal, post-replay). ─
  // ── 6 NO scenario-local ms literals — all timing via PACING; the only literal
  //      allowed is the settle wait, unused here (waitForFunction gates instead).
});
