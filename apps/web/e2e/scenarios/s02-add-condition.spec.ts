import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  readPhaseLog, recheckAccessibility, resetPhaseLog, saveTurnArtifact, signIn,
  startWalkthrough, advanceWalkthroughUntil, advanceWalkthroughToStep, finishWalkthrough,
  tapWalkthroughNext, type TurnResult,
} from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s02 add-condition (AUDIT) — the agent must hand the app an autonomous
// walkthrough {task_name:"add_condition_auto", params:{condition}} rather than
// writing the free-text medical_profile blob; the app then types the condition
// into the STRUCTURED conditions[] the profile UI reads, saves, VERIFIES the
// re-queried state, and reveals it. This spec audits that contract end-to-end at
// the current PACING minimums with a real turn against local hermes.
const ARTIFACTS = "e2e/artifacts/s02";           // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s02";  // durable, NOT wiped
const CONDITION = "High blood pressure";
// Same input the walkthrough's fill step targets (steps/add_condition_auto.ts).
const CONDITIONS_INPUT = '[data-walk="elder-conditions"] input:not([type="file"])';

test("s02 add-condition: 'Please add high blood pressure to my conditions' -> add_condition_auto walkthrough writes conditions[]", async ({ page }) => {
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

  // ── 2 TRIGGER ─────────────────────────────────────────────────────────────
  // Verbatim directive; ≤3 recorded attempts. add_condition_auto has no
  // propose-first requirement (unlike add_prescription_auto), so the direct
  // phrase should queue the walkthrough; if Mei confirms conversationally
  // instead, a single affirmative follow-up turn is sent (:8901 keeps per-elder
  // session history, so the confirm carries the request's context).
  const PHRASE = "Please add high blood pressure to my conditions";
  const CONFIRM = "Yes please, go ahead and add high blood pressure to my conditions.";
  const queued = (r: TurnResult) => r.walkthrough?.task_name === "add_condition_auto";

  let turn = await agentTurn8901(jwt, PHRASE);
  saveTurnArtifact(ARTIFACTS, "turn-attempt-1", turn);
  let firedOn = queued(turn) ? "attempt-1 (direct phrase)" : "";
  for (let attempt = 2; attempt <= 3 && !queued(turn); attempt++) {
    console.log(`[TRIGGER] attempt ${attempt}: prev walkthrough=${turn.walkthrough?.task_name ?? "none"}, tools=${JSON.stringify(turn.tools_used)}, reply="${turn.reply.slice(0, 120)}"`);
    turn = await agentTurn8901(jwt, CONFIRM);
    saveTurnArtifact(ARTIFACTS, `turn-attempt-${attempt}`, turn);
    if (queued(turn)) firedOn = `attempt-${attempt} (confirm follow-up)`;
  }

  expect(turn.http, "agent/turn HTTP status").toBe(200);
  expect(turn.tools_used, "start_walkthrough routed").toContain("start_walkthrough");
  expect(turn.walkthrough?.task_name, "walkthrough queued").toBe("add_condition_auto");
  expect(turn.walkthrough?.params?.condition, "condition param present in walkthrough handoff").toBeTruthy();
  console.log(`[TRIGGER] add_condition_auto queued on ${firedOn}; params=${JSON.stringify(turn.walkthrough?.params)}`);

  // ── 3 UI + PACING ───────────────────────────────────────────────────────────
  // Drive the autonomous walkthrough with a fixed param so the write is
  // deterministic regardless of the LLM's extracted value. The trigger above
  // proved routing; this proves the app-side execution + pacing.
  await signIn(page, creds); // baseURL :5173
  await resetPhaseLog(page);

  await startWalkthrough(page, "add_condition_auto", { condition: CONDITION });

  // Steps 1-3 now flow with NO tap at all. computeHoldGate's case 2 (a click
  // that opens the surface the next step works in) was widened on 2026-08-08
  // from "next step FILLS" to "next step ACTS", because burial doesn't care
  // which: step 1 opens Your Profile, step 2 taps Edit inside it, step 3 fills
  // the conditions field. Holding on step 1 left the spotlight on a control the
  // newly-revealed section had already moved past.
  //
  // So the mid-type watcher is ARMED FIRST and awaited after — the run carries
  // itself into the fill on its own, and arming after the advance would miss a
  // window that has already opened and closed.
  const midType = page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      return !!el && el.value.length >= 4 && el.value.length <= 12;
    },
    CONDITIONS_INPUT,
    { timeout: 20_000, polling: 16 },
  );
  // A no-op once the run has already carried itself past 2; kept so the spec
  // still works if the gate ever tightens again.
  await advanceWalkthroughToStep(page, 2);

  // SCREENSHOT (mid-type): a clearly-partial value in the conditions TagList
  // while Mei types (chars 4..12 of 19 — a wide window at FILL_MS_PER_CHAR).
  await midType;
  await page.screenshot({ path: `${SHOTS}/1-mid-type.png`, fullPage: true });

  // Step 4 is the "Add" tap that turns the typed text into a chip — commit
  // step 3 first, or the chip the assertion below looks for never exists.
  await advanceWalkthroughToStep(page, 4);

  // Act proof: the chip lands in the conditions TagList (the field the UI reads).
  const condField = page.locator('[data-walk="elder-conditions"]');
  await expect(condField.getByText(CONDITION, { exact: false })).toBeVisible({ timeout: 20_000 });

  // Fills + chip done → the run PAUSES at the Confirm recap step (Item 5,
  // "ConfirmBack-Phase" — split into a separate recap step + the real Submit
  // waitFor step below, the exact mechanism proven on add_prescription_auto.ts;
  // add_condition_auto's own recap carries no review card — the TagList input
  // it would read clears itself the instant the "Add" step commits the chip,
  // so a live-read ReviewField would always show blank and wrongly force the
  // clarifying-question path on every run). startWalkthrough() puts the
  // callout's AutoNav switch on "Step by step" and the throwaway account is
  // below TRUST_MODE_THRESHOLD anyway, so Confirm holds for an explicit tap
  // rather than auto-elapsing.
  // Each autonomous step now holds at its commit gate until the person taps
  // Next, so tap through the fills to reach the Confirm recap step.
  // The recap's copy is walk.confirmCheck ("…when it looks right, tap Next") —
  // "tap Save yourself" belongs to the Submit waitFor step AFTER it.
  await advanceWalkthroughUntil(page, () => page.getByText("when it looks right, tap Next", { exact: false }).isVisible());
  await expect(page.getByText("when it looks right, tap Next", { exact: false }), "Confirm (recap) step reached").toBeVisible({ timeout: 20_000 });
  await tapWalkthroughNext(page); // onto the real Submit waitFor step
  await expect(page.getByText("tap Save yourself", { exact: false }), "Submit step reached").toBeVisible({ timeout: 20_000 });

  // Arm the verify-callout waiter immediately BEFORE the save, so it can't miss
  // the transient "Checking…" window (VERIFY_MIN_MS floor, ~600ms) between save
  // and reveal. Armed here rather than before the walkthrough starts: with every
  // step now waiting for the person's Next, "time from start to verify" is
  // unbounded and a fixed budget from the start would just be a flake.
  const checkingSeen = page
    .getByText("Checking it really saved", { exact: false })
    .waitFor({ state: "visible", timeout: 40_000 })
    .then(() => true)
    .catch(() => false);

  await page.locator('[data-walk="elder-profile-save"]').click();

  // Reveal: wait for the changed-fields caption pill, let the smooth scroll
  // settle, then capture the pulse.
  await page.getByTestId("change-highlight-caption").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  await page.screenshot({ path: `${SHOTS}/2-reveal.png`, fullPage: true });

  // The walk.checking callout was observable during verify.
  expect(await checkingSeen, "walk.checking callout shown during verify phase").toBe(true);

  // Wait until the reveal phase is recorded (its paced() resolves only after the
  // dwell) — this guarantees field/click/verify are all in the log too.
  await page.waitForFunction(
    () => ((window as unknown as { __dwPhaseLog?: { surface: string; phase: string }[] }).__dwPhaseLog ?? [])
      .some(e => e.surface === "walkthrough" && e.phase === "reveal"),
    null,
    { timeout: 30_000 },
  );

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

  // ── 4 RE-CHECK ──────────────────────────────────────────────────────────────
  // Independent Supabase re-read — the write happens in the UI phase above (the
  // trigger turn only queues the walkthrough), so this necessarily follows it.
  // Never trust the walkthrough's own "Saved": prove conditions[] really holds it.
  const conditions = await recheckAccessibility(supa, creds.userId, "conditions");
  expect(Array.isArray(conditions), `accessibility.conditions is an array (got ${JSON.stringify(conditions)})`).toBe(true);
  const lower = (conditions as string[]).map(c => String(c).toLowerCase());
  expect(lower, "conditions[] contains the added condition").toContain(CONDITION.toLowerCase());
});
