import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

// The floating next-dose indicator must track ONE specific card: hidden while
// that card is on screen, pointing down while it is below the fold, and
// flipping to point up (and moving to the top) once you scroll past it.
function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

test("the next-dose pill follows the next dose's card", async ({ page }) => {
  const e = env();
  const supa = createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY);
  const email = `tw-elder-${Date.now()}@dosewise.test`;
  const { data, error } = await supa.auth.signUp({ email, password: "Throwaway!2026" });
  if (error || !data.user) throw new Error(`signUp failed: ${error?.message}`);
  const uid = data.user.id;
  await supa.from("profiles").insert({ id: uid, role: "elder", full_name: "Tan Ah Ma" });

  // The next dose has to land far enough down the timeline to be genuinely
  // below the fold at scroll-top (the 6am-5pm stretch of empty hour rows fits
  // on one screen), with fillers below it so it can also be scrolled PAST.
  const nowHour = new Date().getHours();
  test.skip(nowHour >= 20, "no room left in today's timeline to place a next dose plus fillers");
  const nextHour = Math.max(nowHour + 1, 19);
  const hhmm = `${String(nextHour).padStart(2, "0")}:15`;
  await supa.from("medications").insert({
    elder_id: uid, name: "Atorvastatin", dosage: "20mg", purpose: "Cholesterol",
    schedule: { times: [hhmm] }, archived: false,
  });
  for (let h = nextHour + 1; h <= 23; h++) {
    await supa.from("medications").insert({
      elder_id: uid, name: `Filler ${h}`, dosage: "1 tablet", purpose: "Padding",
      schedule: { times: [`${String(h).padStart(2, "0")}:00`] }, archived: false,
    });
  }

  await page.goto("/");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill("Throwaway!2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(
    () => typeof (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough === "function",
    null, { timeout: 40_000 },
  );
  await page.waitForTimeout(2500);

  const timeline = page.locator('[data-tour="elder-schedule"]');
  const scrollTo = async (top: number) => {
    await timeline.evaluate((el, y) => el.scrollTo({ top: y }), top);
    await page.waitForTimeout(700);
  };

  // Top of the day: the dose is far below -> points down.
  await scrollTo(0);
  await expect(page.getByTestId("next-dose-down")).toBeVisible();
  await expect(page.getByTestId("next-dose-up")).toHaveCount(0);

  // Tapping it brings the card into view -> the indicator gets out of the way.
  await page.getByTestId("next-dose-down").click();
  await page.waitForTimeout(1200);
  await expect(page.getByTestId("next-dose-down")).toHaveCount(0);
  await expect(page.getByTestId("next-dose-up")).toHaveCount(0);

  // Scrolled past it -> flips to point back up.
  await scrollTo(99999);
  await expect(page.getByTestId("next-dose-up")).toBeVisible();
  await expect(page.getByTestId("next-dose-down")).toHaveCount(0);
  console.log("USER:", email);
});
