import { test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

// Close-up of the bottom nav so alignment and spacing can actually be judged.
function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

test("nav close-up", async ({ page }) => {
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
  await page.waitForTimeout(1800);

  const boxes = await page.locator('[data-tour^="nav-"]').evaluateAll(els =>
    els.map(el => { const r = el.getBoundingClientRect(); return { c: Math.round(r.left + r.width / 2), bottom: Math.round(r.bottom), top: Math.round(r.top), h: Math.round(r.height) }; }));
  const centres = boxes.map(b => b.c);
  const gaps = centres.slice(1).map((c, i) => c - centres[i]);
  console.log("CENTRES", centres.join(","), "| GAPS", gaps.join(","), "| BOTTOMS", boxes.map(b => b.bottom).join(","));

  const nav = page.locator('[data-tour="nav-home"]').locator("xpath=ancestor::div[contains(@class,'backdrop-blur-md')]");
  await nav.screenshot({ path: "scratchpad/shots/nav-closeup.png" });
});
