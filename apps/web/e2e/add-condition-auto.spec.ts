import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { anonClient, createThrowawayElder, signIn, startWalkthrough } from "./helpers";

// Guided Auto-Navigation — autonomous "add a medical condition", end to end
// against REAL Supabase. This is the fix for the reported bug: the condition
// must land in the STRUCTURED conditions[] the profile UI actually reads (not the
// free-text medical_profile blob), be visible on the profile, and get a reveal
// pulse. Driven with a real value via params.

const SHOTS = "e2e/artifacts/add-condition-auto";

test("autonomous add-condition: type → add → save → verify in conditions[] + shown", async ({ page }) => {
  test.setTimeout(60_000);
  mkdirSync(SHOTS, { recursive: true });
  const creds = await createThrowawayElder();

  await signIn(page, creds);
  await startWalkthrough(page, "add_condition_auto", { condition: "High blood pressure" });

  // Act: the profile expander opens, Mei types the condition and adds it as a
  // chip (asserting the chip, not the transient input value the Add step clears).
  const condField = page.locator('[data-walk="elder-conditions"]');
  await expect(condField.getByText("High blood pressure", { exact: false })).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/1-added-chip.png` });

  // Submit → Verify: the walkthrough completes only if it really persisted.
  await expect(page.getByText("I couldn't confirm that saved", { exact: false })).toHaveCount(0, { timeout: 20_000 });

  // It is REALLY in the structured conditions[] (the field the UI reads).
  const supa = anonClient();
  await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  await expect
    .poll(async () => {
      const { data } = await supa.from("profiles").select("accessibility").eq("id", creds.userId).maybeSingle();
      const conds = (data?.accessibility as { conditions?: string[] } | null)?.conditions ?? [];
      return conds.map(c => c.toLowerCase());
    }, { timeout: 15_000 })
    .toContain("high blood pressure");

  // And it's actually RENDERED on the profile (the chip is visible) — the exact
  // "no indication it was added" complaint.
  await expect(page.locator('[data-walk="elder-conditions"]').getByText("High blood pressure", { exact: false })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/2-shown-on-profile.png` });
});
