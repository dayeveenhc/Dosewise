import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

// Request refill must appear only for medicines under half supply — and the
// request_refill walkthrough spotlights that same button, so this also checks
// what happens to it when nothing qualifies.
function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

test("refill button follows the half-supply rule", async ({ page }) => {
  const e = env();
  const supa = createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY);
  const email = `tw-elder-${Date.now()}@dosewise.test`;
  const { data } = await supa.auth.signUp({ email, password: "Throwaway!2026" });
  const uid = data!.user!.id;
  await supa.from("profiles").insert({ id: uid, role: "elder", full_name: "Tan Ah Ma" });

  const mk = async (name: string, days: number | null) => {
    const { data: med } = await supa.from("medications")
      .insert({ elder_id: uid, name, dosage: "1 tablet", purpose: "Test", schedule: { times: ["08:00"] }, archived: false })
      .select("id").single();
    if (days !== null) {
      const f = new Date(); f.setDate(f.getDate() + days);
      await supa.from("refills").insert({ medication_id: med!.id, elder_id: uid, run_out_forecast: f.toISOString().slice(0, 10) });
    }
    return med!.id as string;
  };
  const lowId = await mk("Lowsupply", 9);    // 9/30 = 30% -> should show
  const fullId = await mk("Fullsupply", 27); // 27/30 = 90% -> should not

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

  const low = page.locator(`[data-testid="medication-${lowId}"]`);
  const full = page.locator(`[data-testid="medication-${fullId}"]`);
  await expect(low).toBeVisible({ timeout: 15_000 });
  await expect(low.locator('[data-walk="med-request-refill-btn"]')).toBeVisible();
  await expect(full.locator('[data-walk="med-request-refill-btn"]')).toHaveCount(0);
  await page.screenshot({ path: "scratchpad/shots/refill-rule.png" });
  console.log("RULE OK");
});

test("request_refill walkthrough when NO medicine is low", async ({ page }) => {
  const e = env();
  const supa = createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY);
  const email = `tw-elder-${Date.now()}-b@dosewise.test`;
  const { data } = await supa.auth.signUp({ email, password: "Throwaway!2026" });
  const uid = data!.user!.id;
  await supa.from("profiles").insert({ id: uid, role: "elder", full_name: "Tan Ah Ma" });
  await supa.from("medications").insert({ elder_id: uid, name: "Fullsupply", dosage: "1 tablet", purpose: "Test", schedule: { times: ["08:00"] }, archived: false });

  await page.goto("/");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill("Throwaway!2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(
    () => typeof (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough === "function",
    null, { timeout: 40_000 },
  );
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as unknown as { __dwStartWalkthrough: (t: string) => void }).__dwStartWalkthrough("request_refill"));
  await page.waitForTimeout(6000);
  await page.screenshot({ path: "scratchpad/shots/refill-walkthrough-nolow.png" });
  console.log("WALKTHROUGH STATE CAPTURED");
});
