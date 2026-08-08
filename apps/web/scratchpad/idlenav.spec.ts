import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createThrowawayElder, dismissIdlePopupIfOpen, signIn } from "../e2e/helpers";

/**
 * Live checks for the three reports whose fixes are stateful/visual — the unit
 * tests establish the mechanism, only a real browser establishes the result.
 *
 *   item 2 — the idle popup's actions. "Explain this step again" and "Skip this
 *            step" are gone; "Talk to Mei" must reach the CONVERSATION.
 *   item 3 — leaving Ask Mei and coming back must land in the conversation,
 *            not on the "Frequently used" tiles.
 *   item 5 — auto mode must be one obvious toggle in the overlay's top right,
 *            and it must actually change the gating.
 *
 * Deliberately does NOT use helpers' startWalkthrough: that forces
 * step-by-step, and item 5's whole point is the default being Auto.
 *
 *   npx playwright test --config=scratchpad/pw.config.ts scratchpad/idlenav.spec.ts
 */
const SHOTS = "scratchpad/shots/idlenav";
const IDLE_MS = 20_000; // IDLE_TIMEOUT_MS, lib/walkthrough/pacing.ts
const AUTONAV = '[data-walk="walk-autonav"]';
const POPUP = '[data-walk="walk-idle-popup"]';

// dismissIdlePopupIfOpen comes from e2e/helpers rather than a local copy: the
// idle popup is a full-screen pointer-events-auto layer, so while it is up any
// tap aimed at a control underneath lands on its backdrop instead — and this
// exact helper was copy-pasted into three specs once already before being
// centralised.

test("item 3: a tab round-trip returns to the conversation, not the tiles", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });

  const creds = await createThrowawayElder();
  await signIn(page, creds);

  await page.locator('[data-tour="nav-ai"]').click();
  const composer = page.locator('[data-walk="elder-ai-composer"]');
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  await composer.fill("hello Mei");
  await page.locator('[data-walk="elder-ai-send-button"]').click();
  // The person's own bubble is enough — this is about view restoration, not
  // about waiting on a model round trip.
  await expect(page.getByText("hello Mei")).toBeVisible({ timeout: 30_000 });

  // Away and back.
  await page.locator('[data-tour="nav-home"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-tour="nav-ai"]').click();
  await page.waitForTimeout(900);

  await expect(page.getByText("hello Mei"), "the conversation came back").toBeVisible({ timeout: 15_000 });
  // The pill reads "Frequently used" only while the conversation is showing —
  // if we had landed on the tiles it would read "Back to chat" instead.
  await expect(
    page.getByRole("button", { name: /Frequently used/i }),
    "landed in the conversation, so the pill offers the tiles",
  ).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}/item3-roundtrip.png` });
});

test("items 2 + 5: the fast-forward toggle, and Talk to Mei reaching the chat", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });

  const creds = await createThrowawayElder();
  await signIn(page, creds);

  // Launch from the HELP TILES with no prior conversation — the exact case
  // that used to make "Talk to Mei" land on the tiles, because the mode seed
  // had no restored thread to find.
  await page.locator('[data-tour="nav-ai"]').click();
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    (window as unknown as { __dwStartWalkthrough: (t: string, p?: Record<string, string>) => void })
      .__dwStartWalkthrough("add_prescription_auto", {
        name: "Lisinopril", dose: "10mg", purpose: "blood pressure",
      });
  });

  // --- item 5 -------------------------------------------------------------
  const toggle = page.locator(AUTONAV);
  await expect(toggle, "the fast-forward toggle is on screen").toBeVisible({ timeout: 20_000 });
  await expect(toggle, "auto is ON by default").toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Auto", { exact: true })).toBeVisible();

  // Top RIGHT of the overlay, not buried in the callout.
  const root = page.locator('[data-walk-callout-cleared]');
  const rootBox = (await root.boundingBox())!;
  const tBox = (await toggle.boundingBox())!;
  const fromRight = rootBox.x + rootBox.width - (tBox.x + tBox.width);
  const fromTop = tBox.y - rootBox.y;
  console.log(`[ITEM 5] toggle inset: ${Math.round(fromRight)}px from right, ${Math.round(fromTop)}px from top`);
  expect(fromRight, "pinned to the right edge").toBeLessThan(40);
  expect(fromTop, "pinned to the top").toBeLessThan(40);
  await page.screenshot({ path: `${SHOTS}/item5-autonav-on.png` });

  await toggle.click();
  await expect(toggle, "toggles off").toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("Step by step", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/item5-autonav-off.png` });

  // With Auto off the run must COME TO REST at a gate — the toggle doing real
  // work rather than just relabelling itself.
  //
  // Deliberately NOT "the counter is unchanged from before the tap". Two
  // documented behaviours make that the wrong assertion: flipping the toggle
  // applies from the NEXT step (re-deriving it mid-step would re-run the step's
  // act), and gating.ts::computeHoldGate independently auto-continues a click
  // act into a fill on the same screen regardless of AutoNav. So the run is
  // expected to travel a few steps after the tap. What Step-by-step promises is
  // that it then STOPS, so that is what gets asserted: two reads a long way
  // apart, both equal.
  const counter = page.getByText(/^Step \d+ of \d+$/);
  await page.waitForTimeout(6_000); // let any in-flight step finish on the old setting
  const settled = await counter.textContent();
  await page.waitForTimeout(8_000); // far past READY_AUTO_MS (900ms) and every PACING floor
  const stillThere = await counter.textContent();
  console.log(`[ITEM 5] step-by-step came to rest: ${settled} -> ${stillThere}`);
  expect(stillThere, "step-by-step really gates the run").toBe(settled);

  // And Auto genuinely releases it again — the same gate, both directions.
  //
  // Clear the idle popup first if it is up: 14s of deliberate stillness gets
  // close to IDLE_TIMEOUT_MS, and its backdrop is a full-screen
  // pointer-events-auto layer, so a tap aimed at the toggle would land on the
  // backdrop instead and read as "the click did nothing". That is the product
  // working as designed (MEMORY's 2026-08-04 note), not a regression.
  await dismissIdlePopupIfOpen(page);
  await page.screenshot({ path: `${SHOTS}/item5-before-reenable.png` });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(6_000);
  // The overlay unmounting IS the strongest form of "auto resumed" — it ran to
  // the end. Otherwise compare the counter.
  const stillRunning = await toggle.count() > 0;
  const afterAuto = stillRunning ? await counter.textContent() : "(finished)";
  console.log(`[ITEM 5] auto resumed: ${stillThere} -> ${afterAuto}`);
  expect(afterAuto, "auto releases the gate the toggle was holding").not.toBe(stillThere);
  if (!stillRunning) return; // ran to completion; the item-2 popup needs a live run
  // Back to step-by-step so the idle popup below has a real wait to fire on.
  await dismissIdlePopupIfOpen(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // --- item 2 -------------------------------------------------------------
  // Sit still past IDLE_TIMEOUT_MS. Zero interaction: any pointer/key/scroll
  // resets the timer.
  await page.waitForTimeout(IDLE_MS + 3_000);
  const popup = page.locator(POPUP);
  await expect(popup, "the still-there popup appeared").toBeVisible({ timeout: 20_000 });

  const labels = await popup.getByRole("button").allTextContents();
  console.log(`[ITEM 2] popup actions: ${JSON.stringify(labels.map(l => l.trim()).filter(Boolean))}`);
  expect(labels.join("|"), "no Explain action").not.toContain("Explain");
  expect(labels.join("|"), "no Skip action").not.toContain("Skip");
  await page.screenshot({ path: `${SHOTS}/item2-popup.png` });

  // Talk to Mei must land in the CONVERSATION with a usable composer, not on
  // the category tiles — and the walkthrough must be gone, not underneath.
  await popup.getByRole("button", { name: /Talk to Mei/i }).click();
  await expect(page.locator('[data-walk="elder-ai-composer"]'), "the composer is there to type in")
    .toBeVisible({ timeout: 20_000 });
  await expect(page.locator(AUTONAV), "the walkthrough really exited").toHaveCount(0);
  // The tiles' own switch would read "Frequently used"; in the conversation
  // view with an empty thread neither pill shows, so assert the tiles are NOT
  // what we are looking at.
  await expect(page.getByRole("button", { name: /^Frequently used$/i }), "not on the tiles")
    .toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/item2-talktomei.png` });
});
