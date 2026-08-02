import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

// Scratch check for the bubble entrance: frames mid-animation + the computed
// animation/origin, so the easing change is verified on the real screen.
test("message bubble entrance", async ({ page }) => {
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
  await page.waitForTimeout(1500);

  const frame = page.locator('div[class*="w-[390px]"]').first();
  await page.locator('[data-tour="nav-ai"]').click();
  await page.waitForTimeout(600);

  await page.locator("textarea").fill("Did I take my morning tablets already?");
  await page.locator('[data-walk="elder-ai-send-button"]').click();

  // Mid-flight frames of the user bubble.
  for (const ms of [90, 180, 300, 560]) {
    await page.waitForTimeout(ms === 90 ? 90 : 90);
    await frame.screenshot({ path: `scratchpad/shots/bubble-${ms}.png` });
  }

  const style = await page.locator(".dw-msg-in").first().evaluate(el => {
    const cs = getComputedStyle(el);
    return { duration: cs.animationDuration, timing: cs.animationTimingFunction, origin: cs.transformOrigin, cls: el.className, box: [el.clientWidth, el.clientHeight] };
  });
  expect(style.duration).toBe("0.52s");
  expect(style.timing).toBe("cubic-bezier(0.16, 1, 0.3, 1)");

  // A long thread, then one more send: the smooth scroll must still LAND at the
  // bottom (a re-targeted smooth scroll that stops short would hide the reply).
  for (const q of ["What do I take at night?", "Am I running low on anything?", "When is my next dose?"]) {
    await page.locator("textarea").fill(q);
    await page.locator('[data-walk="elder-ai-send-button"]').click();
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(1500);
  const atBottom = await page.locator(".dw-view-in").evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  expect(atBottom).toBeLessThan(2);

  await frame.screenshot({ path: "scratchpad/shots/bubble-settled.png" });
  console.log("bubble style:", style);
});
