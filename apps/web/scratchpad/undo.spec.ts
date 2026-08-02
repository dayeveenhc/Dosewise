import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

// Proves the new log -> "Done for the day!" -> undo path end to end, including
// the real Supabase write: after undoing, the dose row must be back to
// `pending`, read independently of the UI.
function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

const SHOTS = process.env.SHOT_DIR || "scratchpad/shots";

test("log a dose, see Done for the day, then undo it", async ({ page }) => {
  const e = env();
  const supa = createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY);
  const email = `tw-elder-${Date.now()}@dosewise.test`;
  const password = "Throwaway!2026";
  const { data, error } = await supa.auth.signUp({ email, password });
  if (error || !data.user) throw new Error(`signUp failed: ${error?.message}`);
  const uid = data.user.id;
  await supa.from("profiles").insert({ id: uid, role: "elder", full_name: "Tan Ah Ma" });

  // One medication, scheduled an hour ago so it starts out "missed".
  const past = new Date(Date.now() - 60 * 60 * 1000);
  const hhmm = `${String(past.getHours()).padStart(2, "0")}:${String(past.getMinutes()).padStart(2, "0")}`;
  const { data: med } = await supa.from("medications")
    .insert({ elder_id: uid, name: "Metformin", dosage: "500mg", purpose: "Diabetes", schedule: { times: [hhmm] }, archived: false })
    .select("id").single();
  const medId = med!.id as string;

  await page.goto("/");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(
    () => typeof (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough === "function",
    null, { timeout: 40_000 },
  );
  await page.waitForTimeout(2000);

  // Starts missed -> the "still to take" banner is up.
  await expect(page.getByTestId("day-status-totake")).toBeVisible();

  // Log it.
  await page.getByRole("button", { name: /I Took It/i }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/undo-1-take-dialog.png` });
  await page.getByRole("button", { name: /^Confirm$/ }).click();
  await page.waitForTimeout(2500);

  // Everything for today is now taken.
  await expect(page.getByTestId("day-status-done")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/undo-2-done.png` });

  const { data: afterLog } = await supa.from("doses").select("status").eq("medication_id", medId);
  expect(afterLog?.some(d => d.status === "taken")).toBe(true);

  // Undo it — confirmation is mandatory.
  await page.getByRole("button", { name: /^Undo$/ }).click();
  await expect(page.getByText("Mark as not taken?")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/undo-3-confirm.png` });
  await page.getByRole("button", { name: /Yes, undo/ }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/undo-4-after.png` });

  // The real row went back to pending — read independently of the UI.
  const { data: afterUndo } = await supa.from("doses").select("status,logged_at").eq("medication_id", medId);
  expect(afterUndo?.length).toBeGreaterThan(0);
  expect(afterUndo?.every(d => d.status === "pending")).toBe(true);
  expect(afterUndo?.every(d => d.logged_at === null)).toBe(true);

  // And the UI is back to owing the dose.
  await expect(page.getByTestId("day-status-totake")).toBeVisible();
  console.log("USER:", email);
});
