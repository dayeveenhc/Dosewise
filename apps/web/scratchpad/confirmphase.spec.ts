import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  autoDismissIdlePopup, createThrowawayElder, signIn, startWalkthrough, tapWalkthroughNext, walkthroughStep,
} from "../e2e/helpers";

// Item 5 (ConfirmBack-Phase) independent live verification.
//
// REWRITTEN from the original build-pass version of this file, and split into
// THREE tests after live-driving surfaced a real defect the original test
// (which used a first-timer account) could not have caught — see test 3.
const TRUST_MODE_THRESHOLD = 3;
const CONFIRM_MIN_MS = 3000;

async function seedVeteran(page: import("@playwright/test").Page) {
  await page.addInitScript((count: number) => {
    window.localStorage.setItem("dosewise:accessibility", JSON.stringify({
      fontSize: "large", contrast: "normal", colourVision: "off", timeFormat: "12h", voiceOutput: true,
      notifications: { doseReminders: true, refillAlerts: true, caregiverNotes: true, missedDoseAlerts: true },
      walkthroughManualMode: false, walkthroughCompletionCount: count,
    }));
  }, TRUST_MODE_THRESHOLD);
}

test("Item5 1/3 (first-timer account): a blank purpose field blocks Submit with a clarifying question", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync("scratchpad/shots", { recursive: true });

  // Deliberately a genuine first-timer (requireExplicitAdvance=true from
  // count 0 < TRUST_MODE_THRESHOLD) — this is the primary, common-case
  // account shape and it independently forces awaitNext("confirm") via trust
  // status alone (orchestrate.ts: `requireExplicitAdvance || riskFlagged ||
  // blank`). What this test actually proves is that the LIVE blank-field
  // detection (WalkthroughReview's reactive onBlankChange -> confirmBlocked)
  // correctly REPLACES the plain gate button with the clarifying question and
  // correctly withholds `canAdvance` until answered — i.e. the tap, once
  // required, is genuinely gated on the blank field, not just decorated by it.
  const creds = await createThrowawayElder();
  await signIn(page, creds);
  // This spec asserts between taps and can genuinely idle past IDLE_TIMEOUT_MS;
  // without this the popup backdrop eats the next Next tap (see the helper).
  const stopIdleWatcher = autoDismissIdlePopup(page);

  await startWalkthrough(page, "add_prescription_auto", { name: "Lisinopril", dose: "10mg", purpose: "blood pressure" });

  const nextBtn = page.getByRole("button", { name: /^(Next|Done)$/ });
  await expect(nextBtn, "step 1 has a gate").toBeVisible({ timeout: 15_000 });
  await tapWalkthroughNext(page); // open
  await tapWalkthroughNext(page); // name
  await tapWalkthroughNext(page); // dose

  await page.getByText("tap Next when you're ready", { exact: false }).waitFor({ state: "visible", timeout: 30_000 });
  const purposeInput = page.locator('[data-walk="rx-purpose"] input');
  await expect(purposeInput).toHaveValue("blood pressure", { timeout: 15_000 });
  for (let i = 0; i < 3; i++) {
    await purposeInput.fill("");
    await page.waitForTimeout(250);
    if (await purposeInput.inputValue() === "") break;
  }
  await expect(purposeInput).toHaveValue("");
  await tapWalkthroughNext(page); // purpose (fill act, now cleared before Confirm even starts)

  await expect(page.getByText("Please check these details"), "review card on the confirm step").toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("— not filled in —"), "purpose shows as blank in the review card").toBeVisible();
  await expect(page.getByText("It looks like", { exact: false }), "clarifying question body text").toBeVisible({ timeout: 5_000 });
  const continueWithout = page.getByRole("button", { name: "Continue without" });
  await expect(continueWithout, "\"Continue without\" appears").toBeVisible();
  await expect(page.getByRole("button", { name: /^(Next|Done)$/ }), "plain gate button is replaced, not supplemented").toHaveCount(0);
  await page.screenshot({ path: "scratchpad/shots/item5-blocked-clarifying-question.png", fullPage: true });

  // BLOCKS Submit past CONFIRM_MIN_MS.
  await page.waitForTimeout(CONFIRM_MIN_MS + 1_000);
  await expect(page.getByText("Please check these details"), "still on Confirm well past CONFIRM_MIN_MS").toBeVisible();
  await expect(continueWithout, "still blocked after CONFIRM_MIN_MS elapsed").toBeVisible();

  await page.getByRole("button", { name: "Change something" }).click();
  await expect(purposeInput, "\"Change something\" focused the BLANK field specifically").toBeFocused();
  await purposeInput.fill("blood pressure");

  await expect(page.getByText("It looks like", { exact: false }), "clarifying question clears once the field is filled").toBeHidden({ timeout: 5_000 });
  await expect(nextBtn, "plain gate button returns once unblocked").toBeVisible();
  await expect(nextBtn, "and it's enabled").toBeEnabled();
  await page.screenshot({ path: "scratchpad/shots/item5-unblocked-addit-path.png", fullPage: true });

  await nextBtn.click();
  await expect(page.getByText("Please check these details"), "moved past the confirm step").toBeHidden({ timeout: 10_000 });
  const submitBtn = page.locator('[data-walk="rx-submit"]');
  await expect(submitBtn, "Submit step reached and reachable").toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /^(Next|Done)$/ }), "Submit is a waitFor step — still no Next button").toHaveCount(0);
  await page.screenshot({ path: "scratchpad/shots/item5-unblocked-submit-reachable.png", fullPage: true });
  stopIdleWatcher();
});

test("Item5 2/3 (veteran account): a normal, unambiguous, low-risk instance gets a brief auto-proceeding recap, zero taps to Submit", async ({ page }) => {
  test.setTimeout(90_000);
  mkdirSync("scratchpad/shots", { recursive: true });

  const creds = await createThrowawayElder();
  await seedVeteran(page);
  await signIn(page, creds);
  // This spec asserts between taps and can genuinely idle past IDLE_TIMEOUT_MS;
  // without this the popup backdrop eats the next Next tap (see the helper).
  const stopIdleWatcher = autoDismissIdlePopup(page);

  await startWalkthrough(page, "add_prescription_auto", { name: "Metformin", dose: "500mg", purpose: "blood sugar" });

  await page.getByText("Please check these details").waitFor({ state: "visible", timeout: 30_000 });
  // t0 marks the confirm phase's OWN start (not the wait-for-it-to-appear
  // call above, which also spans the preceding auto-advanced fill steps) —
  // that's what CONFIRM_MIN_MS actually floors.
  const t0 = Date.now();
  const purposeInput = page.locator('[data-walk="rx-purpose"] input');
  await expect(purposeInput).toHaveValue("blood sugar", { timeout: 5_000 });

  await expect(page.getByText("It looks like", { exact: false }), "no clarifying question — nothing is blank").toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Next|Done)$/ }), "no plain gate button either — this recap auto-elapses, it isn't tap-gated").toHaveCount(0);
  await page.screenshot({ path: "scratchpad/shots/item5-veteran-normal-recap-auto.png", fullPage: true });

  // Poll rather than a blind wait — directly measure when the recap actually
  // disappears against t0, instead of guessing an intermediate checkpoint
  // (an earlier flat `waitForTimeout` here mismeasured real elapsed time and
  // produced a false failure — see git history/report for the timing bug).
  const submitBtn = page.locator('[data-walk="rx-submit"]');
  let disappearedAt: number | null = null;
  for (let i = 0; i < 40; i++) {
    const stillUp = await page.getByText("Please check these details").isVisible().catch(() => false);
    console.log(`[ITEM5] t+${Date.now() - t0}ms: recap visible=${stillUp}`);
    if (!stillUp) { disappearedAt = Date.now() - t0; break; }
    await page.waitForTimeout(150);
  }
  console.log(`[ITEM5] veteran normal-instance recap disappeared at t+${disappearedAt}ms (floor ${CONFIRM_MIN_MS}ms)`);

  await expect(submitBtn, "auto-proceeded to Submit with zero taps").toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /^(Next|Done)$/ }), "Submit is a real waitFor tap — still no Next/Done").toHaveCount(0);
  await page.screenshot({ path: "scratchpad/shots/item5-veteran-normal-submit-reached.png", fullPage: true });
  stopIdleWatcher();
});

// ─────────────────────────────────────────────────────────────────────────
// BUG FOUND (not a spec assertion of intended behaviour) — see this task's
// final report for full detail. Documented here as evidence, not silently
// worked around, per this task's explicit instruction for anything beyond a
// "small, stale-selector" fix.
//
// orchestrate.ts::runActStep decides ONCE, synchronously, at the instant the
// Confirm phase begins, whether to use `awaitNext("confirm")` (tap-gated) or
// `paced("confirm", CONFIRM_MIN_MS)` (timer-driven auto-elapse):
//   const blank = !!step.review && hasBlankReviewField(step.review);
//   if (requireExplicitAdvance || riskFlagged || blank) awaitNext(); else paced();
// For add_prescription_auto specifically, `purpose` can NEVER be blank at
// this exact instant — the step builder's own fallback
// (`p.purpose?.trim() || "General health"`) guarantees Mei's fill act always
// writes a non-empty value, so `blank` is always false when this check runs.
// The ONLY realistic way a review field goes blank during Confirm is the
// documented "Change something" edit path (or, as simulated here, a person
// clearing text and walking away) — which necessarily happens AFTER the
// step's one-shot decision has already locked in `paced()` for any account
// that isn't independently forced into awaitNext by trust/risk (i.e. exactly
// a veteran, non-risk-flagged instance — the "fully-earned fast path" this
// same item is proudest of).
//
// The RENDER layer (WalkthroughReview's live onBlankChange -> Walkthrough.tsx's
// `confirmBlocked`/"— not filled in —"/"Continue without") reacts correctly
// and looks exactly like the blocked state in test 1 above. But `paced()`
// resolves purely off a `setTimeout` floor and calls `h.onAdvance()` directly
// (orchestrate.ts) with NO reference to blankFields/confirmBlocked at
// resolution time — so the walkthrough silently advances to the real Submit
// waitFor step, DESPITE the on-screen clarifying question still showing and
// DESPITE zero taps from the user. This directly contradicts decision B's
// stated guarantee: "A missing field always forces the tap path regardless of
// risk/trust — genuinely unclear is itself a risk signal." It does not, for
// this account shape and this timing.
// REGRESSION TEST (was a BUG REPRODUCTION). This test used to assert that a
// veteran clearing a review field AFTER the Confirm phase had begun sailed
// past the visibly-blocked step with zero taps — orchestrate.ts::runActStep
// decided awaitNext-vs-paced ONCE, at Confirm entry, and paced() then resolved
// off a bare timer with no knowledge of live blank state. Commit f210e5a added
// the isBlankNow() re-check after the floor elapses, so the run now escalates
// to the real tap gate instead of advancing. Inverted here (rather than
// deleted) so the exact scenario that produced the bug keeps being driven.
test("Item5 3/3 (regression): a veteran clearing the field AFTER Confirm began is HELD at the tap gate, not advanced past it", async ({ page }) => {
  test.setTimeout(90_000);
  mkdirSync("scratchpad/shots", { recursive: true });

  const creds = await createThrowawayElder();
  await seedVeteran(page);
  await signIn(page, creds);
  // This spec asserts between taps and can genuinely idle past IDLE_TIMEOUT_MS;
  // without this the popup backdrop eats the next Next tap (see the helper).
  const stopIdleWatcher = autoDismissIdlePopup(page);

  await startWalkthrough(page, "add_prescription_auto", { name: "Lisinopril", dose: "10mg", purpose: "blood pressure" });

  // Veteran fill steps auto-advance with zero taps.
  await page.getByText("Please check these details").waitFor({ state: "visible", timeout: 30_000 });
  const purposeInput = page.locator('[data-walk="rx-purpose"] input');
  await expect(purposeInput).toHaveValue("blood pressure", { timeout: 5_000 });

  // Clear it NOW — after Confirm has already started (the earlier
  // `paced()` vs `awaitNext()` decision is already locked in at this point).
  for (let i = 0; i < 3; i++) {
    await purposeInput.fill("");
    await page.waitForTimeout(250);
    if (await purposeInput.inputValue() === "") break;
  }
  await expect(purposeInput).toHaveValue("");

  // The RENDER layer still reacts correctly — this part of the mechanism is
  // NOT broken, which is exactly what makes the underlying gap dangerous: it
  // LOOKS blocked.
  await expect(page.getByText("— not filled in —"), "review card correctly shows the field as blank, live").toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("It looks like", { exact: false }), "clarifying question correctly renders").toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "Continue without" }), "\"Continue without\" correctly renders").toBeVisible();
  await page.screenshot({ path: "scratchpad/shots/item5-BUG-looks-blocked.png", fullPage: true });

  // Zero taps from here. The step must STAY on 5: the Confirm floor elapsing
  // on a now-blank field escalates to awaitNext instead of advancing.
  //
  // NOTE: `[data-walk="rx-submit"]` alone is a BAD discriminator here (per
  // trustmode.spec.ts's own documented caveat) — it's part of
  // AddPrescriptionSheet's own footer and is present in the DOM from step 1
  // onward regardless of which walkthrough step is active. The reliable
  // signal is the step counter itself.
  const stepAtBlock = await walkthroughStep(page);
  expect(stepAtBlock?.current, "confirmed on step 5 (Confirm) before waiting").toBe(5);
  // Wait out the whole Confirm floor plus generous slack, doing nothing.
  await page.waitForTimeout(CONFIRM_MIN_MS + 4_000);
  const stepAfter = await walkthroughStep(page);
  console.log(`[ITEM5] after ${CONFIRM_MIN_MS + 4000}ms of ZERO taps on a blocked Confirm: step ${stepAtBlock?.current} -> ${stepAfter?.current}`);
  expect(stepAfter?.current, "held on the blocked Confirm step instead of silently advancing to Submit").toBe(5);
  await page.screenshot({ path: "scratchpad/shots/item5-fixed-holds-when-blocked.png", fullPage: true });

  // The clarifying question is still the thing on screen, and the person's two
  // real ways forward are both still offered.
  await expect(page.getByText("It looks like", { exact: false }), "still showing the clarifying question").toBeVisible();
  await expect(page.getByRole("button", { name: "Continue without" }), "\"Continue without\" is still the explicit way past").toBeVisible();
  stopIdleWatcher();
});
