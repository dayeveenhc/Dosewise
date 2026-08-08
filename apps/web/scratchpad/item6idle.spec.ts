import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createThrowawayElder, signIn, startWalkthrough, tapWalkthroughNext, walkthroughStep } from "../e2e/helpers";

// Item 6 (IdleTimeout) independent live verification. MEMORY.md's own build-pass
// entry explicitly says this was "Not live-driven in a real browser this pass"
// (deterministic vitest with fake timers only) — this file is the first live
// drive, with REAL wall-clock waits (not fake timers), per this task's brief.
//
// waitingOnUser (Walkthrough.tsx, decision D) is one computed signal:
//   !!step.waitFor || (phase==="ready" && requireExplicitAdvance) ||
//   (phase==="confirm" && confirmTapRequiredRef.current) || confirmBlocked
// A first-timer's terminal "ready" gate on step 1 (autoRx.open, an act:click
// step with no verify/confirm/reveal) is reached in ~1s and is ALREADY a
// tap-gated wait for a fresh account (requireExplicitAdvance defaults true
// below TRUST_MODE_THRESHOLD) — i.e. exactly the "manual-mode Next-wait" case
// the task names, reached fast enough to keep these tests' runtime bounded
// without needing a full ~90s *_auto completion for the fire/reset cases. The
// separate "does not fire during autonomous phases" case genuinely needs a
// full autonomous run (a veteran account, so nothing along the way tap-gates),
// so that one test alone carries the ~90s runtime cost.
const IDLE_TIMEOUT_MS = 20_000;
const SHOTS = "scratchpad/shots";
const POPUP = '[data-walk="walk-idle-popup"]';

test("Item6 1/3: idle popup DOES fire after IDLE_TIMEOUT_MS during a genuine tap-gated wait, zero interaction", async ({ page }) => {
  test.setTimeout(60_000);
  mkdirSync(SHOTS, { recursive: true });

  const creds = await createThrowawayElder();
  await signIn(page, creds);

  const t0 = Date.now();
  await startWalkthrough(page, "add_prescription_auto", { name: "Lisinopril", dose: "10mg", purpose: "blood pressure" });

  // Reach step 1's own terminal ready gate (a genuine tap-wait for a
  // first-timer — requireExplicitAdvance defaults true, count 0 < threshold).
  await page.getByText("tap Next when you're ready", { exact: false }).waitFor({ state: "visible", timeout: 15_000 });
  console.log(`[ITEM6] reached tap-gated ready state at t+${Date.now() - t0}ms`);

  // Zero interaction from here. Popup must be absent well before the timeout...
  await page.waitForTimeout(Math.max(0, IDLE_TIMEOUT_MS - 5_000));
  await expect(page.locator(POPUP), "popup absent 5s before the timeout").toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/item6-1-before-timeout-no-popup.png`, fullPage: true });

  // ...and appear once IDLE_TIMEOUT_MS has elapsed with continued zero interaction.
  await expect(page.locator(POPUP), "popup appears once IDLE_TIMEOUT_MS elapses with zero interaction").toBeVisible({ timeout: 10_000 });
  console.log(`[ITEM6] popup appeared at t+${Date.now() - t0}ms (IDLE_TIMEOUT_MS=${IDLE_TIMEOUT_MS}ms)`);
  await page.screenshot({ path: `${SHOTS}/item6-2-fired-after-timeout.png`, fullPage: true });

  // The gate button underneath must NOT have been consumed/advanced by the popup.
  const stepAtPopup = await walkthroughStep(page);
  expect(stepAtPopup?.current, "still on step 1 — the popup did not silently advance anything").toBe(1);
});

test("Item6 2/3: a real interaction before the timeout resets the idle timer — popup does not fire", async ({ page }) => {
  test.setTimeout(60_000);
  mkdirSync(SHOTS, { recursive: true });

  const creds = await createThrowawayElder();
  await signIn(page, creds);

  const t0 = Date.now();
  await startWalkthrough(page, "add_prescription_auto", { name: "Lisinopril", dose: "10mg", purpose: "blood pressure" });
  await page.getByText("tap Next when you're ready", { exact: false }).waitFor({ state: "visible", timeout: 15_000 });

  // A real interaction partway through the window — click the instruction
  // TEXT itself (not the Next button), which has no onClick handler of its
  // own, so this can only ever be read as "still here", never a step advance.
  // The capture-phase idle-reset listener fires on ANY pointerdown regardless
  // of what the target does with it (Walkthrough.tsx's own documented gotcha).
  await page.waitForTimeout(8_000);
  await page.getByText("tap Next when you're ready", { exact: false }).click();
  console.log(`[ITEM6] interacted (reset) at t+${Date.now() - t0}ms`);

  // Wait to just past the ORIGINAL (pre-interaction) deadline — if the reset
  // hadn't happened, the popup would already be up by now.
  await page.waitForTimeout(IDLE_TIMEOUT_MS - 8_000 + 3_000);
  await expect(page.locator(POPUP), "popup did NOT fire — the interaction reset the timer before the original deadline").toHaveCount(0);
  console.log(`[ITEM6] checked absence at t+${Date.now() - t0}ms, still no popup`);
  await page.screenshot({ path: `${SHOTS}/item6-3-interaction-prevented-fire.png`, fullPage: true });

  const step = await walkthroughStep(page);
  expect(step?.current, "still on step 1 — the reset click did not advance the step").toBe(1);
});

test("Item6 3/3: idle popup does NOT fire during a fully autonomous run (veteran, zero interaction, act/verify/confirm/reveal)", async ({ page }) => {
  test.setTimeout(150_000);
  mkdirSync(SHOTS, { recursive: true });

  // Veteran seed (mirrors trustmode.spec.ts test 2): every ready/confirm phase
  // auto-elapses, so nothing along the way is a `waitingOnUser` wait state —
  // the idle timer should never arm at all until the real Submit waitFor step.
  const creds = await createThrowawayElder();
  await page.addInitScript((count: number) => {
    window.localStorage.setItem("dosewise:accessibility", JSON.stringify({
      fontSize: "large", contrast: "normal", colourVision: "off", timeFormat: "12h", voiceOutput: true,
      notifications: { doseReminders: true, refillAlerts: true, caregiverNotes: true, missedDoseAlerts: true },
      walkthroughManualMode: false, walkthroughCompletionCount: count,
    }));
  }, 3);
  await signIn(page, creds);

  const t0 = Date.now();
  await startWalkthrough(page, "add_prescription_auto", { name: "Amlodipine", dose: "5mg", purpose: "blood pressure" });

  // Poll for popup absence continuously while the autonomous run (open -> name
  // -> dose -> purpose -> confirm-auto) plays out with ZERO interaction, until
  // the real Submit waitFor step is reached (no Next/Done button left).
  let sawPopup = false;
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    const [popupCount, hasGateBtn] = await Promise.all([
      page.locator(POPUP).count(),
      page.getByRole("button", { name: /^(Next|Done)$/ }).count(),
    ]);
    if (popupCount > 0) { sawPopup = true; break; }
    if (hasGateBtn === 0) {
      // No Next/Done control left — either the real Submit waitFor step (the
      // walkthrough's structural end of autonomy) or the overlay already
      // finished. Either way, the autonomous portion is over.
      const submitVisible = await page.locator('[data-walk="rx-submit"]').isVisible().catch(() => false);
      if (submitVisible) { console.log(`[ITEM6] autonomous portion complete, Submit reached at t+${Date.now() - t0}ms`); break; }
    }
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: `${SHOTS}/item6-4-autonomous-run-no-popup.png`, fullPage: true });
  expect(sawPopup, "no idle popup ever appeared during the fully autonomous fill/act/confirm/verify path").toBe(false);
  await expect(page.locator(POPUP), "popup absent at the moment Submit is reached").toHaveCount(0);

  const submitBtn = page.locator('[data-walk="rx-submit"]');
  await expect(submitBtn, "reached the real Submit waitFor step with zero taps and zero idle popups along the way").toBeVisible({ timeout: 10_000 });
});
