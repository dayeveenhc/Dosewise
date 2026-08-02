import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

// Drives the new autonomous add_doctor_question_auto walkthrough end to end:
// Mei taps across to Reminders, opens the add box, types, saves — and the row
// must really exist in doctor_questions, read back independently of the UI.
function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

const SHOTS = process.env.SHOT_DIR || "scratchpad/shots";

test("add_doctor_question_auto files a real question under Reminders", async ({ page }) => {
  const e = env();
  const supa = createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY);
  const email = `tw-elder-${Date.now()}@dosewise.test`;
  const password = "Throwaway!2026";
  const { data, error } = await supa.auth.signUp({ email, password });
  if (error || !data.user) throw new Error(`signUp failed: ${error?.message}`);
  const uid = data.user.id;
  await supa.from("profiles").insert({ id: uid, role: "elder", full_name: "Tan Ah Ma" });

  await page.goto("/");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(
    () => typeof (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough === "function",
    null, { timeout: 40_000 },
  );
  await page.waitForTimeout(1500);

  const question = "Should I take Metformin before or after breakfast?";
  await page.evaluate(
    ([task, params]) => (window as unknown as { __dwStartWalkthrough: (t: string, p?: Record<string, string>) => void })
      .__dwStartWalkthrough(task as string, params as Record<string, string>),
    ["add_doctor_question_auto", { question }] as [string, Record<string, string>],
  );

  // Poll the REAL row rather than the page: the typed text is visible inside
  // the textarea long before Save commits, so asserting on screen text here
  // passes for the wrong reason (it did, once — hence the polling).
  await expect.poll(async () => {
    const { data } = await supa.from("doctor_questions").select("question,source").eq("elder_id", uid);
    return data?.find(r => r.question === question)?.source ?? null;
  }, { timeout: 45_000, intervals: [500] }).toBe("elder");

  // And the saved question is rendered as a card, not just sitting in the box.
  await expect(page.locator('[data-walk="elder-doctor-questions"]').getByText(question)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/doctorq-result.png` });

  // And the walkthrough never showed its honest failure state.
  await expect(page.getByText("couldn't confirm", { exact: false })).toHaveCount(0);
  console.log("USER:", email);
});
