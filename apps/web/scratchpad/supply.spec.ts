import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

// Days left must divide pills remaining by doses per day: 30 pills taken twice
// daily is 15 days, not 30. Red below 10.
function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

test("days left = pills / doses per day, red under 10", async ({ page }) => {
  const e = env();
  const supa = createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY);
  const email = `tw-elder-${Date.now()}@dosewise.test`;
  const { data } = await supa.auth.signUp({ email, password: "Throwaway!2026" });
  const uid = data!.user!.id;
  await supa.from("profiles").insert({ id: uid, role: "elder", full_name: "Tan Ah Ma" });

  const mk = async (name: string, times: string[], pills: number | null) => {
    const { data: med } = await supa.from("medications")
      .insert({ elder_id: uid, name, dosage: "1 tablet", purpose: "Test", schedule: { times }, archived: false })
      .select("id").single();
    if (pills !== null) {
      await supa.from("refills").insert({ medication_id: med!.id, elder_id: uid, pills_remaining: pills });
    }
    return med!.id as string;
  };
  const twiceId = await mk("Twicedaily", ["08:00", "20:00"], 30); // 30 / 2 = 15 days
  const onceId  = await mk("Oncedaily",  ["08:00"], 30);          // 30 / 1 = 30 days
  const lowId   = await mk("Lowsupply",  ["08:00", "20:00"], 12); // 12 / 2 = 6  days -> red
  const noneId  = await mk("Nodata",     ["08:00"], null);        // unknown -> hidden

  await page.goto("/");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill("Throwaway!2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(
    () => typeof (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough === "function",
    null, { timeout: 40_000 },
  );
  await page.locator('[data-tour="nav-prescriptions"]').click();
  await page.waitForTimeout(2500);

  await expect(page.locator(`[data-testid="medication-${twiceId}"]`)).toContainText("15 days left");
  await expect(page.locator(`[data-testid="medication-${onceId}"]`)).toContainText("30 days left");
  await expect(page.locator(`[data-testid="medication-${lowId}"]`)).toContainText("6 days left");
  // No refill data at all -> no invented figure.
  await expect(page.locator(`[data-testid="medication-${noneId}"]`)).not.toContainText("days left");

  // Under 10 days is red; above it is not.
  const lowColour = await page.locator(`[data-testid="medication-${lowId}"]`).getByText("6 days left")
    .evaluate(el => getComputedStyle(el).color);
  const okColour = await page.locator(`[data-testid="medication-${onceId}"]`).getByText("30 days left")
    .evaluate(el => getComputedStyle(el).color);
  expect(lowColour).not.toBe(okColour);
  console.log("low:", lowColour, "| ok:", okColour);

  // Request refill follows the earlier 15-day threshold.
  await expect(page.locator(`[data-testid="medication-${lowId}"]`).locator('[data-walk="med-request-refill-btn"]')).toBeVisible();
  await expect(page.locator(`[data-testid="medication-${onceId}"]`).locator('[data-walk="med-request-refill-btn"]')).toHaveCount(0);
  await page.screenshot({ path: "scratchpad/shots/supply.png" });
});
