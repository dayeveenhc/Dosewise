import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

// The four narrated settings walkthroughs lost their "open the section" step
// (there are no sections to open any more). Each must now spotlight its control
// directly on the one-page Settings, scrolled into view.
const CASES: { task: string; target: string; shot: string }[] = [
  { task: "language_voice",     target: '[data-walk="elder-language-select"]', shot: "walk-language" },
  { task: "reminder_settings",  target: '[data-walk="elder-reminder-meds"]',   shot: "walk-reminders" },
  { task: "emergency_contact",  target: '[data-walk="elder-emergency-call"]',  shot: "walk-emergency" },
  { task: "text_size",          target: '[data-tour="elder-fontsize"]',        shot: "walk-textsize" },
];

test("narrated settings walkthroughs land on their control", async ({ page }) => {
  const e = env();
  const supa = createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY);
  const email = `tw-elder-${Date.now()}@dosewise.test`;
  const { data } = await supa.auth.signUp({ email, password: "Throwaway!2026" });
  await supa.from("profiles").insert({ id: data!.user!.id, role: "elder", full_name: "Tan Ah Ma" });

  await page.goto("/");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill("Throwaway!2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(
    () => typeof (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough === "function",
    null, { timeout: 40_000 },
  );
  await page.waitForTimeout(1200);

  const frame = page.locator('div[class*="w-[390px]"]').first();

  for (const c of CASES) {
    await page.evaluate(task => (window as any).__dwStartWalkthrough(task), c.task);
    await page.waitForTimeout(700);
    // Step 1 is always "tap Settings in the nav" — do it, then the next step
    // must be the control itself.
    await page.locator('[data-tour="nav-settings"]').click();
    await page.waitForTimeout(1600);

    // The spotlit target must be on screen (the walkthrough scrolls to it).
    const onScreen = await page.locator(c.target).first().evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0;
    });
    expect(onScreen, `${c.task}: ${c.target} spotlit and in view`).toBe(true);
    await frame.screenshot({ path: `scratchpad/shots/${c.shot}.png` });

    // Bail out of the walkthrough before the next case.
    const quit = page.getByRole("button", { name: /exit|quit|close|stop/i }).first();
    if (await quit.count()) await quit.click({ timeout: 2000 }).catch(() => {});
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  }
});
