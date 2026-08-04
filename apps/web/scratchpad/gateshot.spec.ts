import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

// Visual/behavioural check for the post-consultation pass:
//   Item C — fewer forced Next-taps in add_prescription_auto (name/dose/purpose
//   should collapse into ONE tap instead of three).
//   Item D — the overlay scrim is lighter and shows a coloured glow instead of
//   a hard mask edge.
// Not part of the e2e gate — throwaway elder, scratch only.

function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

const READY_COPY = "tap Next when you're ready";

async function stepCounter(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll("p")].find(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? ""));
    return el ? el.textContent!.trim() : null;
  });
}

test("add_prescription_auto: fewer gate taps + lighter overlay", async ({ page }) => {
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
  await page.waitForTimeout(1000);

  const frame = page.locator('div[class*="w-[390px]"]').first();

  await page.evaluate(
    ([t, p]) => (window as any).__dwStartWalkthrough(t, p),
    ["add_prescription_auto", { name: "Lisinopril", dose: "10mg", purpose: "Blood pressure" }] as [string, Record<string, string>],
  );

  // Step 1 (open): a real checkpoint tap — the form isn't open yet.
  await expect(page.locator('[data-walk="rx-name"] input')).toBeVisible({ timeout: 15_000 });
  await frame.screenshot({ path: "scratchpad/shots/gate-1-overlay-open.png" }); // Item D: lighter scrim + glow
  await page.getByText(READY_COPY, { exact: false }).waitFor({ state: "visible", timeout: 15_000 });
  await frame.screenshot({ path: "scratchpad/shots/gate-2-first-checkpoint.png" });
  await page.getByRole("button", { name: /Next/i }).click();

  // Steps "name" and "dose" must now auto-continue WITHOUT another tap — assert
  // the dose field fills itself while we only wait, never click.
  await expect(page.locator('[data-walk="rx-dose"]')).toHaveValue("10mg", { timeout: 15_000 });
  await expect(page.locator('[data-walk="rx-name"] input')).toHaveValue("Lisinopril");
  await frame.screenshot({ path: "scratchpad/shots/gate-3-auto-continued-to-dose.png" });

  // "purpose" is the last field before Save — it DOES gate (real checkpoint).
  await expect(page.locator('[data-walk="rx-purpose"] input')).toHaveValue("Blood pressure", { timeout: 15_000 });
  await page.getByText(READY_COPY, { exact: false }).waitFor({ state: "visible", timeout: 15_000 });
  await frame.screenshot({ path: "scratchpad/shots/gate-4-checkpoint-before-save.png" });
  await page.getByRole("button", { name: /Next/i }).click();

  // Now the real Save tap (waitFor step, not a gate).
  await expect(page.locator('[data-walk="rx-submit"]')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-walk="rx-submit"]').click();

  // Verify + reveal, then Done.
  await page.getByRole("button", { name: /Done/i }).waitFor({ state: "visible", timeout: 20_000 });
  await frame.screenshot({ path: "scratchpad/shots/gate-5-done.png" });
  console.log("[gateshot] total gate/tap actions used: open-checkpoint, purpose-checkpoint, Save, Done = 4 (was 6)");
});
