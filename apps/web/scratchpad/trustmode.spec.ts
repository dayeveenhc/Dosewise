import { test, expect } from "@playwright/test";
import {
  createThrowawayElder, signIn, startWalkthrough, tapWalkthroughNext,
  advanceWalkthroughUntil, finishWalkthrough, readPhaseLog, resetPhaseLog, walkthroughStep,
} from "../e2e/helpers";

// Item 2 (TrustMode) required verification, per for-the-ask-mei-iterative-wall.md:
// 3 tap-gated completions, then a 4th that auto-advances, then the manual-mode
// toggle forcing the gate again even past threshold, then the toggle OFF again
// resuming auto-advance — plus the risk-overrides-trust interaction on a
// veteran account. NOT part of the e2e gate (scratch config), same as
// confirmphase.spec.ts / spotlightfix.spec.ts.
//
// Split into two independent tests (each a full real drive of
// add_prescription_auto is 60-100s, so one monolithic test kept blowing its
// own timeout budget): test 1 proves the counter earns veteran status
// naturally from 3 real completions then auto-advances on the 4th; test 2
// seeds localStorage straight to veteran status (a legitimate shortcut —
// test 1 already proves the counter itself increments correctly from real
// completions; this test's job is the TOGGLE/RISK behavior, not re-proving
// counting) and covers the manual-mode override + risk-overrides-trust.
//
// The phase log is the non-flaky discriminator (per orchestrate.ts): the
// terminal "ready" gate logs minMs:0 when tap-gated (awaitNext) and
// minMs:READY_AUTO_MS (900) when it auto-elapsed (paced) — see pacing.ts.
// resetPhaseLog is always called BEFORE startWalkthrough (mirrors
// e2e/scenarios/s02's ordering) so there's no race against the walkthrough's
// own first-step effect logging before the log is cleared.
const READY_AUTO_MS = 900;
const TRUST_MODE_THRESHOLD = 3;

const RX_PARAMS = { name: "Lisinopril", dose: "10mg", purpose: "blood pressure" };

async function accessibilityState(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("dosewise:accessibility");
    return raw ? JSON.parse(raw) : null;
  });
}

// This spec predates Item 6 (IdleTimeout), which this same verification pass
// also independently confirmed live: a genuine tap-gated wait (exactly what
// this file drives, repeatedly, across 3-4 full completions) left alone for
// IDLE_TIMEOUT_MS (20s) correctly raises a "still there?" popup — but that
// popup is a full-screen pointer-events-auto layer (MEMORY.md's own
// documented, accepted tradeoff: "a real tap on the actual Save/Accept button
// underneath lands on the popup's backdrop instead — standard modal
// behavior"). A slow CI box genuinely idling past 20s between this test's own
// asserts/logging and its next tap hit exactly that, breaking every
// `.click()` on Next with "walk-idle-popup subtree intercepts pointer
// events". This is real product behavior working as designed, not a stale
// selector — the fix belongs in this test harness (do what a real person
// would: dismiss it first), not in the app. A background watcher, not a
// pre-click check, because the popup can appear at any point during the long
// unattended waits inside completeTapGated/advanceWalkthroughUntil that this
// file doesn't control tap-by-tap.
function autoDismissIdlePopup(page: import("@playwright/test").Page): () => void {
  let stop = false;
  void (async () => {
    while (!stop) {
      const popup = page.locator('[data-walk="walk-idle-popup"]');
      if (await popup.isVisible().catch(() => false)) {
        console.log("[TRUSTMODE] idle popup appeared mid-drive — dismissing (\"I'm still here, continue\")");
        await popup.getByRole("button", { name: /continue/i }).click({ timeout: 2_000 }).catch(() => {});
      }
      await page.waitForTimeout(500).catch(() => {}); // page may be mid-navigation between polls
    }
  })();
  return () => { stop = true; };
}

function readyEntries(log: Awaited<ReturnType<typeof readPhaseLog>>) {
  return log.filter(e => e.phase === "ready");
}

async function waitForOverlayGone(page: import("@playwright/test").Page, timeout = 30_000) {
  await page.waitForFunction(
    () => ![...document.querySelectorAll("p")].some(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? "")),
    null,
    { timeout },
  );
}

// Wait for the walkthrough to have advanced (with ZERO taps from this
// helper's caller) all the way to the real Submit waitFor step. NOTE:
// `[data-walk="rx-submit"]` is a bad discriminator on its own — it's the
// same "Add medication" button targeted by the Confirm step too, and it's
// present (just disabled) in the DOM from step 1 onward since it's part of
// the sheet, not the walkthrough. The reliable signal is the ABSENCE of any
// Next/Done button — every autonomous/Confirm step has one, the Submit
// waitFor step has none (mirrors e2e/scenarios/s01's own assertion).
async function waitForVeteranSubmitReached(page: import("@playwright/test").Page, timeout = 30_000): Promise<void> {
  // Real bug found live-driving this pass: `toHaveCount(0)` alone races the
  // walkthrough's own FIRST mount — called immediately after startWalkthrough
  // (or right after a settings-page toggle), there's a genuine window before
  // <Walkthrough> has painted at all, during which NO Next/Done button exists
  // for the correct-looking but WRONG reason (nothing has rendered yet, not
  // "we reached Submit"). Confirmed by inspecting a failure's own captured
  // state: "Step 1 of 7" with zero phase-log entries, i.e. the assertion
  // resolved before the overlay had done any real work. Anchor first on the
  // overlay genuinely being up (its own step counter existing) so the
  // subsequent absence check can only mean what it claims to mean.
  await page.waitForFunction(
    () => [...document.querySelectorAll("p")].some(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? "")),
    null,
    { timeout },
  );
  await expect(
    page.getByRole("button", { name: /^(Next|Done)$/ }),
    "veteran: auto-advanced past every fill/confirm step with zero taps, down to the real Submit waitFor",
  ).toHaveCount(0, { timeout });
}

// A full add_prescription_auto completion when the terminal/confirm gates are
// TAP-REQUIRED: steps 1-4 (open/name/dose/purpose) each need a Next tap, then
// the Confirm recap ALSO needs one (mirrors e2e/scenarios/s01's proven drive —
// finishWalkthrough alone can't cross the real Submit waitFor step in the
// middle, since it only ever taps a Next/Done button and that step has none).
async function completeTapGated(page: import("@playwright/test").Page): Promise<void> {
  // "Please check these details" (the review card's own header) is UNIQUE to
  // the Confirm step — unlike its instructionKey text ("...tap Save yourself
  // to finish"), which the FOLLOWING Submit waitFor step's copy also contains
  // a substring of, so anchoring on that risked an extra tap sailing straight
  // past Confirm into Submit before this helper ever got to assert on it.
  await advanceWalkthroughUntil(page, () => page.getByText("Please check these details").isVisible());
  await expect(page.getByText("Please check these details"), "Confirm recap holds for a tap (first-timer/manual)").toBeVisible();
  await tapWalkthroughNext(page); // the Confirm step's own required tap
  const submitBtn = page.locator('[data-walk="rx-submit"]');
  await expect(submitBtn).toBeVisible({ timeout: 15_000 });
  await submitBtn.click(); // the real, sanctioned Save tap
  await finishWalkthrough(page); // taps through the terminal verify/reveal step
}

test("TrustMode 1/2: 3 tap-gated completions on a fresh account, then the 4th auto-advances", async ({ page }) => {
  test.setTimeout(300_000);

  const creds = await createThrowawayElder();
  await signIn(page, creds);
  const stopIdleWatcher = autoDismissIdlePopup(page);

  // Fresh account, fresh browser context (no prior localStorage) — the counter
  // is device-local, so this IS "fresh" in the sense that matters.
  let state = await accessibilityState(page);
  console.log("initial accessibility state:", JSON.stringify(state));
  expect(state?.walkthroughCompletionCount ?? 0).toBe(0);
  expect(state?.walkthroughManualMode ?? false).toBe(false);

  // ── Completions 1-3: requireExplicitAdvance must still be true (0,1,2 < 3) ──
  for (let i = 1; i <= 3; i++) {
    await resetPhaseLog(page);
    await startWalkthrough(page, "add_prescription_auto", RX_PARAMS);

    // Item 2 Phase C evidence: screenshot the terminal gate actually holding
    // (Next visible+enabled, requiring a real tap) on step 1 of each of the 3
    // completions — the phase-log minMs:0 assertion below proves the SAME
    // thing mechanically, this is the visual proof the plan also asks for.
    const gateBtn = page.getByRole("button", { name: /^(Next|Done)$/ });
    await expect(gateBtn, `run ${i}: terminal gate button visible on step 1`).toBeVisible({ timeout: 15_000 });
    await expect(gateBtn, `run ${i}: terminal gate button enabled, requiring a real tap`).toBeEnabled();
    await page.screenshot({ path: `scratchpad/shots/item2-tap-gated-completion-${i}.png`, fullPage: true });

    await completeTapGated(page);

    const log = await readPhaseLog(page);
    const readies = readyEntries(log);
    expect(readies.length, `run ${i}: at least one terminal ready phase logged`).toBeGreaterThan(0);
    for (const r of readies) {
      expect(r.minMs, `run ${i}: every ready gate is tap-gated (minMs 0), not auto`).toBe(0);
    }

    state = await accessibilityState(page);
    console.log(`after completion ${i}: walkthroughCompletionCount =`, state?.walkthroughCompletionCount);
    expect(state?.walkthroughCompletionCount).toBe(i);
  }

  // ── Completion 4: now a veteran (count=3 >= TRUST_MODE_THRESHOLD) — the
  // terminal gate must auto-advance with ZERO taps once its floor elapses. ──
  await resetPhaseLog(page);
  await startWalkthrough(page, "add_prescription_auto", RX_PARAMS);

  // Do NOT tap anything — wait for the real Submit waitFor step to become
  // reachable purely from auto-advance through every preceding autonomous
  // fill/confirm step.
  const submitBtn = page.locator('[data-walk="rx-submit"]');
  await waitForVeteranSubmitReached(page);
  await expect(submitBtn, "Submit itself is visible+enabled once reached").toBeEnabled();

  const logBeforeSubmit = await readPhaseLog(page);
  const readiesBeforeSubmit = readyEntries(logBeforeSubmit);
  expect(readiesBeforeSubmit.length, "veteran run: at least one ready phase auto-elapsed before Submit").toBeGreaterThan(0);
  for (const r of readiesBeforeSubmit) {
    expect(r.minMs, "veteran run: every ready gate before Submit auto-elapsed at READY_AUTO_MS, no tap").toBe(READY_AUTO_MS);
  }
  await page.screenshot({ path: "scratchpad/shots/item2-veteran-zero-taps-to-submit.png", fullPage: true });

  // Submit IS a real waitFor tap (untouched by TrustMode) — perform it, then
  // the act-less verify/reveal tail should ALSO auto-advance with no taps.
  await submitBtn.click();
  await waitForOverlayGone(page);
  state = await accessibilityState(page);
  console.log("after completion 4 (veteran, auto-advance):", state?.walkthroughCompletionCount);
  expect(state?.walkthroughCompletionCount).toBe(4);
  stopIdleWatcher();
});

test("TrustMode 2/2: manual-mode toggle overrides both ways past threshold, and risk still forces a tap on a veteran", async ({ page }) => {
  test.setTimeout(240_000);

  // Seeds straight to veteran status (walkthroughCompletionCount already past
  // TRUST_MODE_THRESHOLD) — test 1 already proves the counter itself earns
  // this from real completions; this test's job is what happens ONCE you're
  // there, so grinding through 3 more real completions first would just be
  // slow duplication, not stronger evidence. Set BEFORE the app's first
  // script runs (addInitScript), so AccessibilityProvider's own loadInitial()
  // read sees it on first mount rather than racing a later external write.
  const creds = await createThrowawayElder();
  await page.addInitScript((count: number) => {
    window.localStorage.setItem("dosewise:accessibility", JSON.stringify({
      fontSize: "large", contrast: "normal", colourVision: "off", timeFormat: "12h", voiceOutput: true,
      notifications: { doseReminders: true, refillAlerts: true, caregiverNotes: true, missedDoseAlerts: true },
      walkthroughManualMode: false, walkthroughCompletionCount: count,
    }));
  }, TRUST_MODE_THRESHOLD);
  await signIn(page, creds);
  const stopIdleWatcher = autoDismissIdlePopup(page);

  let state = await accessibilityState(page);
  console.log("seeded veteran state:", JSON.stringify(state));
  expect(state?.walkthroughCompletionCount).toBe(TRUST_MODE_THRESHOLD);
  expect(state?.walkthroughManualMode).toBe(false);

  const submitBtn = page.locator('[data-walk="rx-submit"]');

  // Sanity: confirm this account really is a veteran before touching the
  // toggle at all — auto-advance with zero taps, same discriminator as test 1.
  await resetPhaseLog(page);
  await startWalkthrough(page, "add_prescription_auto", RX_PARAMS);
  await waitForVeteranSubmitReached(page);
  const readiesSeeded = readyEntries(await readPhaseLog(page));
  expect(readiesSeeded.length, "seeded veteran: auto-elapsed before Submit").toBeGreaterThan(0);
  for (const r of readiesSeeded) expect(r.minMs).toBe(READY_AUTO_MS);
  await submitBtn.click();
  await waitForOverlayGone(page);
  state = await accessibilityState(page);
  expect(state?.walkthroughCompletionCount).toBe(TRUST_MODE_THRESHOLD + 1);

  // ── walkthroughManualMode ON via the REAL Settings toggle — the gate must
  // become mandatory again even though the count is still past threshold. ──
  await page.locator('[data-tour="nav-settings"]').click();
  const manualToggle = page.locator('[data-walk="elder-walkthroughmanual-toggle"]');
  await manualToggle.waitFor({ state: "visible", timeout: 15_000 });
  await expect(manualToggle, "starts off").toHaveAttribute("aria-pressed", "false");
  await manualToggle.click();
  await expect(manualToggle, "now on").toHaveAttribute("aria-pressed", "true");
  state = await accessibilityState(page);
  expect(state?.walkthroughManualMode).toBe(true);
  await page.screenshot({ path: "scratchpad/shots/item2-manual-mode-toggle-on.png", fullPage: true });

  await resetPhaseLog(page);
  await startWalkthrough(page, "add_prescription_auto", RX_PARAMS);
  // Manual mode forces the tap gate — drive it the ordinary tap way; if the
  // gate had silently stayed auto, completeTapGated's advanceWalkthroughUntil
  // would time out waiting for a Next tap that was never needed.
  await completeTapGated(page);
  const readiesManual = readyEntries(await readPhaseLog(page));
  expect(readiesManual.length, "manual-mode run: ready phases logged").toBeGreaterThan(0);
  for (const r of readiesManual) {
    expect(r.minMs, "manual-mode run: tap-gated again (minMs 0) despite being past threshold").toBe(0);
  }
  state = await accessibilityState(page);
  expect(state?.walkthroughCompletionCount).toBe(TRUST_MODE_THRESHOLD + 2);

  // ── walkthroughManualMode OFF again, count still past threshold — auto-
  // advance must resume. ── completeTapGated's final reveal step navigates to
  // Home (add_prescription_auto's own reveal target), so the Settings screen
  // (and this toggle) is no longer mounted — go back to it first.
  await page.locator('[data-tour="nav-settings"]').click();
  await manualToggle.waitFor({ state: "visible", timeout: 15_000 });
  await manualToggle.click();
  await expect(manualToggle, "off again").toHaveAttribute("aria-pressed", "false");
  state = await accessibilityState(page);
  expect(state?.walkthroughManualMode).toBe(false);

  await resetPhaseLog(page);
  await startWalkthrough(page, "add_prescription_auto", RX_PARAMS);
  await waitForVeteranSubmitReached(page);
  const readiesResumed = readyEntries(await readPhaseLog(page));
  expect(readiesResumed.length).toBeGreaterThan(0);
  for (const r of readiesResumed) {
    expect(r.minMs, "auto-advance resumed (minMs READY_AUTO_MS again)").toBe(READY_AUTO_MS);
  }
  await submitBtn.click();
  await waitForOverlayGone(page);
  state = await accessibilityState(page);
  expect(state?.walkthroughCompletionCount).toBe(TRUST_MODE_THRESHOLD + 3);

  // ── Risk overrides trust: a veteran account (well past threshold) driving a
  // risk-flagged instance must still get an explicit tap at Confirm. Forces
  // risk via the dev hook's 3rd arg (client-wiring proof, independent of
  // whether a live Hermes turn would classify these exact params as risky —
  // that's RiskClassifier's own, separately-verified concern; e2e/scenarios/
  // s01's real Hermes turn DID flag this exact medication as "unknown", so
  // this exact interaction also fires for real, not just via this override). ──
  await resetPhaseLog(page);
  await startWalkthrough(page, "add_prescription_auto", RX_PARAMS, {
    flagged: true, signals: ["dosage_jump"], reasons: ["Test-forced risk flag for TrustMode verification"],
  });

  // Drive the fill steps — these auto-advance (veteran), so just wait for the
  // review/Confirm step to appear, i.e. for the walkthrough to stop advancing
  // on its own.
  await expect(page.getByText("Please check these details"), "reached the risk-flagged Confirm/review step").toBeVisible({ timeout: 30_000 });
  const nextBtn = page.getByRole("button", { name: /^(Next|Done)$/ });
  await expect(nextBtn, "risk-flagged Confirm: the plain gate button IS shown (a real tap is required)").toBeVisible({ timeout: 10_000 });

  // Confirm it does NOT resolve on the paced floor alone, well past CONFIRM_MIN_MS.
  await page.waitForTimeout(4_000);
  await expect(page.getByText("Please check these details"), "still on Confirm after CONFIRM_MIN_MS — risk held it").toBeVisible();
  await page.screenshot({ path: "scratchpad/shots/item2-risk-overrides-trust-veteran.png", fullPage: true });

  const stepBeforeTap = await walkthroughStep(page);
  await nextBtn.click();
  await page.waitForFunction(
    (prev) => {
      const el = [...document.querySelectorAll("p")].find(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? ""));
      if (!el) return true;
      const m = el.textContent!.trim().match(/^Step (\d+) of (\d+)$/)!;
      return Number(m[1]) !== prev;
    },
    stepBeforeTap?.current ?? null,
    { timeout: 10_000 },
  );
  const logRisk = await readPhaseLog(page);
  const confirmEntry = logRisk.filter(e => e.phase === "confirm").pop();
  expect(confirmEntry, "a confirm phase entry was logged").toBeTruthy();
  expect(confirmEntry?.minMs, "confirm entry recorded minMs 0 — it was the tap that resolved it, not a floor").toBe(0);
  stopIdleWatcher();
});
