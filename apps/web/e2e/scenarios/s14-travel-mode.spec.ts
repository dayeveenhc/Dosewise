import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  readPhaseLog, recheckAccessibility, resetPhaseLog, saveTurnArtifact, signIn, startWalkthrough,
  advanceWalkthroughUntil, advanceWalkthroughToStep, finishWalkthrough, tapWalkthroughNext,
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

  // Steps 1-4 now flow with NO tap at all. computeHoldGate's case 2 was widened
  // on 2026-08-08 from "the next step FILLS" to "the next step ACTS": step 2
  // clicks the Travel Mode tile and the sheet slides up OVER it, so holding
  // there parked the spotlight on a tile behind the sheet's own backdrop — the
  // geometry sweep measured it as `travel_mode_auto#2 target-occluded`. Steps 1
  // and 2 are clicks whose next step also acts, so both now carry themselves.
  //
  // The mid-fill watcher is therefore ARMED FIRST and awaited after: the run
  // reaches the start-date fill unaided, and arming after the advance would look
  // for a pre-highlight ring that has already come and gone.
  const midFill = page.waitForSelector(
    '[data-walk="travel-start-date"].walk-field-prehighlight',
    { state: "attached", timeout: 30_000 },
  );
  // A no-op once the run has already carried itself past 3.
  await advanceWalkthroughToStep(page, 3);

  // Screenshot 1 — date mid-fill: the start-date field is spotlighted + being
  // filled (its pre-highlight ring is present through the whole fill window).
  await midFill;
  await page.screenshot({ path: `${SHOTS}/1-date-mid-fill.png`, fullPage: true });

  // Fills + timezone select done → the run PAUSES at the Confirm recap step
  // (Item 5, "ConfirmBack-Phase" — split into a separate recap step + the real
  // Submit waitFor step below, the exact mechanism proven on
  // add_prescription_auto.ts). A brand-new throwaway account has
  // walkthroughCompletionCount 0, below TRUST_MODE_THRESHOLD (Item 2,
  // TrustMode), so requireExplicitAdvance is true and Confirm holds for an
  // explicit tap rather than auto-elapsing.
  // Each autonomous step now holds at its commit gate until the person taps
  // Next, so tap through the fills + timezone select to reach the Confirm
  // recap step.
  await advanceWalkthroughUntil(page, () => page.getByText("when it looks right, tap Next", { exact: false }).isVisible());
  await expect(page.getByText("when it looks right, tap Next", { exact: false }), "Confirm (recap) step reached").toBeVisible({ timeout: 40_000 });

  // The timezone really landed on a real option — a value matching no <option>
  // used to blank the field, and the old Verify (startDate only) called that a
  // success. performAct now refuses such a value outright.
  await expect(page.locator('[data-walk="travel-timezone-select"]'), "timezone resolved to a real option").toHaveValue(TIMEZONE);

  // Advance onto the real Submit waitFor step — the save that emits
  // "travel-plan-saved" and advances to Verify still happens on the person's
  // OWN tap of the real Save button, unchanged; only the recap now sits in
  // front of it as its own step.
  await tapWalkthroughNext(page);

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
  // "confirm" is deliberately absent here — Item 2 (TrustMode) means a fresh
  // throwaway account (walkthroughCompletionCount 0, below
  // TRUST_MODE_THRESHOLD) takes the TAP-gated path above (awaitNext, logged
  // minMs 0), not the CONFIRM_MIN_MS auto-elapsing floor a veteran gets.
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
