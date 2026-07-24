import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createThrowawayElder, signIn, startWalkthrough } from "./helpers";

// The walkthrough Reveal (client-driven writes: profile/allergy, travel — tasks
// 7 & 8) now shows the SAME changed-fields caption ChangeHighlight uses, derived
// from the step's Verify directive (real value). Proven by driving the autonomous
// edit_profile_auto walkthrough and asserting the caption appears with the real
// value ("weight 62"). Armed before the walkthrough reaches Reveal so the ~2.6s
// transient caption is caught on its transition to visible.
const SHOTS = "e2e/artifacts/reveal-caption";

test("walkthrough Reveal shows a changed-fields caption (weight 62)", async ({ page }) => {
  test.setTimeout(60_000);
  mkdirSync(SHOTS, { recursive: true });
  const creds = await createThrowawayElder();

  await signIn(page, creds);
  await startWalkthrough(page, "edit_profile_auto");

  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption).toBeVisible({ timeout: 25_000 });
  await expect(caption).toContainText("Updated");
  await expect(caption).toContainText("weight 62");
  await page.screenshot({ path: `${SHOTS}/reveal-caption.png` });
});
