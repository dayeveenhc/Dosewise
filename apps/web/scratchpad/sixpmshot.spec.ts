import { test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

// Manual test session: freezes the clock at 6:00pm today (same
// page.clock.setFixedTime pattern as homeshot.spec.ts / nowlineshot.spec.ts),
// seeds a throwaway elder with doses around that time, then pauses so a human
// can click around in the opened browser. Not an assertion spec — run headed.

function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

test("manual: app frozen at 6pm", async ({ page }) => {
  const e = env();
  const supa = createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY);
  const email = `tw-elder-${Date.now()}@dosewise.test`;
  const password = "Throwaway!2026";
  const { data, error } = await supa.auth.signUp({ email, password });
  if (!data?.session || !data.user) throw new Error(`sign-up produced no session: ${error?.message ?? "rate limited?"}`);
  const uid = data.user.id;

  await supa.from("profiles").insert({ id: uid, role: "elder", full_name: "Tan Ah Ma" });
  await supa.from("medications").insert([
    { elder_id: uid, name: "Metformin", purpose: "Diabetes", dosage: "1 tablet", schedule: { times: ["08:00"] } },
    { elder_id: uid, name: "Amlodipine", purpose: "Blood pressure", dosage: "1 tablet", schedule: { times: ["10:00"] } },
    { elder_id: uid, name: "Losartan", purpose: "Blood pressure", dosage: "1 tablet", schedule: { times: ["09:00", "12:00", "15:30"] } },
    { elder_id: uid, name: "Atorvastatin", purpose: "Cholesterol", dosage: "1 tablet", schedule: { times: ["18:00"] } },
  ]);

  const frozen = new Date();
  frozen.setHours(18, 0, 0, 0);
  await page.clock.setFixedTime(frozen);

  await page.goto("/");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(
    () => typeof (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough === "function",
    null, { timeout: 40_000 },
  );

  console.log(`Signed in as ${email} / ${password}, clock frozen at 18:00. Browser is yours — Playwright Inspector will stay open until you resume/close it.`);
  await page.pause();
});
