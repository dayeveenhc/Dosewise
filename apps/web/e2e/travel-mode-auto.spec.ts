import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { anonClient, createThrowawayElder, signIn, startWalkthrough } from "./helpers";

// Phase 2 (B7) — autonomous Travel Mode setup, end to end against REAL Supabase.
// Mei opens Quick Help → Travel Mode, turns it on, fills the dates + timezone,
// saves, then Verify re-queries the profile to confirm the plan persisted.

const SHOTS = "e2e/artifacts/travel-mode-auto";

test("autonomous travel mode: fill dates → save → verify persisted", async ({ page }) => {
  test.setTimeout(60_000);
  mkdirSync(SHOTS, { recursive: true });
  const creds = await createThrowawayElder();

  await signIn(page, creds);
  await startWalkthrough(page, "travel_mode_auto");

  // Act: the sheet opens and Mei turns Travel Mode on → date fields appear.
  await expect(page.locator('[data-walk="travel-start-date"]')).toBeVisible({ timeout: 15_000 });

  // Act (fill): dates land (the char-fill on a date input settles to the value).
  await expect(page.locator('[data-walk="travel-start-date"]')).toHaveValue("2026-08-01", { timeout: 15_000 });
  await expect(page.locator('[data-walk="travel-end-date"]')).toHaveValue("2026-08-07");
  await page.screenshot({ path: `${SHOTS}/1-plan-filled.png` });

  // Submit → Verify: the walkthrough completes only if the profile really saved.
  // The overlay clears (task done) — assert the honest error is NOT shown and the
  // plan is really in the DB.
  await expect(page.getByText("I couldn't confirm that saved", { exact: false })).toHaveCount(0, { timeout: 20_000 });

  const supa = anonClient();
  await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  await expect
    .poll(async () => {
      const { data } = await supa.from("profiles").select("accessibility").eq("id", creds.userId).maybeSingle();
      return (data?.accessibility as { travelPlan?: { startDate?: string } } | null)?.travelPlan?.startDate ?? null;
    }, { timeout: 15_000 })
    .toBe("2026-08-01");
  await page.screenshot({ path: `${SHOTS}/2-saved.png` });
});
