import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

// Quick colour check for the now-line badge — no screenshot needed.
test("now-line badge is accent colour (position reverted to original)", async ({ page }) => {
  const e = env();
  const supa = createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY);
  const email = `tw-elder-${Date.now()}@dosewise.test`;
  const { data } = await supa.auth.signUp({ email, password: "Throwaway!2026" });
  await supa.from("profiles").insert({ id: data!.user!.id, role: "elder", full_name: "Tan Ah Ma" });
  await supa.from("medications").insert([
    { elder_id: data!.user!.id, name: "Latanoprost", purpose: "Glaucoma", dosage: "1 drop", schedule: { times: ["14:05"] } },
  ]);

  const frozen = new Date();
  frozen.setHours(14, 5, 0, 0);
  await page.clock.setFixedTime(frozen);

  await page.goto("/");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill("Throwaway!2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(
    () => typeof (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough === "function",
    null, { timeout: 40_000 },
  );
  await page.locator("[data-testid='now-line']").waitFor({ timeout: 20_000 });

  const badgeBg = await page.evaluate(() => {
    const nowLine = document.querySelector('[data-testid="now-line"]')!;
    const badge = nowLine.querySelector("span")!;
    return getComputedStyle(badge).backgroundColor;
  });

  // --accent (pine's deep teal, #0E3B43), not --destructive.
  expect(badgeBg).toBe("rgb(14, 59, 67)");
});
