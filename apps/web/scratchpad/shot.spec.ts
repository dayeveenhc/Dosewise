import { test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

// Scratch visual-check spec: stands up a throwaway elder on the live project
// (the established, user-approved pattern from e2e/helpers.ts), seeds a few
// medications so the schedule has content, and films each elder tab.
function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

const SHOTS = process.env.SHOT_DIR || "scratchpad/shots";

test("elder visual sweep", async ({ page }) => {
  const e = env();
  const supa = createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY);
  const email = `tw-elder-${Date.now()}@dosewise.test`;
  const password = "Throwaway!2026";
  const { data, error } = await supa.auth.signUp({ email, password });
  if (error || !data.user) throw new Error(`signUp failed: ${error?.message}`);
  const uid = data.user.id;
  await supa.from("profiles").insert({ id: uid, role: "elder", full_name: "Tan Ah Ma" });

  const now = new Date();
  const hh = (h: number, m: number) => `${String(Math.max(0, Math.min(23, h))).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const seed = [
    { name: "Metformin", dosage: "500mg", purpose: "Diabetes", times: [hh(8, 0)] },
    { name: "Amlodipine", dosage: "5mg", purpose: "Blood pressure", times: [hh(now.getHours() - 2, 0)] },
    { name: "Atorvastatin", dosage: "20mg", purpose: "Cholesterol", times: [hh(now.getHours() + 1, 30)] },
    { name: "Latanoprost Eye Drops", dosage: "1 drop", purpose: "Glaucoma", times: [hh(21, 0)] },
  ];
  for (const s of seed) {
    await supa.from("medications").insert({
      elder_id: uid, name: s.name, dosage: s.dosage, purpose: s.purpose,
      schedule: { times: s.times }, archived: false,
    });
  }

  await page.goto("/");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(
    () => typeof (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough === "function",
    null, { timeout: 40_000 },
  );
  await page.waitForTimeout(2500);

  const frame = page.locator('div[class*="w-[390px]"]').first();
  for (const tab of ["home", "prescriptions", "ai", "notifications", "settings"]) {
    await page.locator(`[data-tour="nav-${tab}"]`).click();
    await page.waitForTimeout(1500);
    await frame.screenshot({ path: `${SHOTS}/${tab}.png` });
  }
  console.log("USER:", email);
});
