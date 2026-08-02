import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

test("add prescription: unsafe dose check + time wheel", async ({ page }) => {
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
  await page.locator('[data-tour="nav-prescriptions"]').click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /Add/ }).first().click();
  await page.waitForTimeout(600);

  // A plausible regimen saves without a word.
  await page.locator('[data-walk="rx-name"] input').fill("Metformin");
  await page.locator('[data-walk="rx-dose"]').fill("1 tablet");
  await page.waitForTimeout(200);

  await frame.screenshot({ path: "scratchpad/shots/rx-debug.png" });
  // The time editor: wheel affordance, and dragging it changes the value.
  // Scoped to the row BUTTON: the standing "never change your dose" warning
  // behind the sheet also contains the word "Change".
  await page.locator('button:has-text("Change")').first().click();
  await page.waitForTimeout(400);
  const hourWheel = page.getByRole("slider").first();
  // The editor opens below the fold in this sheet; centre it or the drag starts
  // on a point that is under the sticky footer.
  await hourWheel.evaluate(el => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  await frame.screenshot({ path: "scratchpad/shots/rx-timewheel.png" });
  const before = await hourWheel.getAttribute("aria-valuetext");
  const box = (await hourWheel.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 80, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const after = await hourWheel.getAttribute("aria-valuetext");
  expect(after, `drag up should raise the hour (was ${before})`).not.toBe(before);

  // Minutes move ONE at a time, and a drag really covers several of them —
  // a functional-update bug used to make any drag worth exactly one minute.
  const minuteWheel = page.getByRole("slider").nth(1);
  const minsBefore = Number(await minuteWheel.getAttribute("aria-valuetext"));
  await page.getByRole("button", { name: "Later minutes" }).first().click();
  expect(Number(await minuteWheel.getAttribute("aria-valuetext"))).toBe((minsBefore + 1) % 60);
  const mbox = (await minuteWheel.boundingBox())!;
  await page.mouse.move(mbox.x + mbox.width / 2, mbox.y + mbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(mbox.x + mbox.width / 2, mbox.y + mbox.height / 2 - 60, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const dragged = (Number(await minuteWheel.getAttribute("aria-valuetext")) - minsBefore - 1 + 60) % 60;
  expect(dragged, "a 60px drag should cover several minutes").toBeGreaterThan(2);
  await frame.screenshot({ path: "scratchpad/shots/rx-timewheel-dragged.png" });
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await page.waitForTimeout(300);

  // Now the unsafe count: 10 tablets at once must be questioned before saving.
  await page.locator('[data-walk="rx-dose"]').fill("10 tablets");
  await page.getByPlaceholder(/Diabetes|diabetes/).first().fill("Diabetes");
  await page.waitForTimeout(300);
  await page.locator('[data-walk="rx-submit"]').click();
  await page.waitForTimeout(500);
  await expect(page.locator('[data-walk="confirm-dialog-confirm"]')).toBeVisible();
  await frame.screenshot({ path: "scratchpad/shots/rx-dose-warning.png" });
});
