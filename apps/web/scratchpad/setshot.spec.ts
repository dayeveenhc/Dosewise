import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

// Scratch sweep of the elder Settings hub, top to bottom.
test("settings hub", async ({ page }) => {
  const e = env();
  const supa = createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY);
  const email = `tw-elder-${Date.now()}@dosewise.test`;
  const { data } = await supa.auth.signUp({ email, password: "Throwaway!2026" });
  await supa.from("profiles").insert({
    id: data!.user!.id, role: "elder", full_name: "Tan Ah Ma",
    // Seeded so the profile screen shows a real record, not a page of dashes.
    accessibility: {
      dob: "1948-03-11", gender: "Female", weightKg: 58, heightCm: 155,
      conditions: ["Type 2 Diabetes", "Hypertension"],
      allergies: ["Peanuts"], drugAllergies: ["Penicillin"],
      wakeTime: "07:00", mealTimes: { breakfast: "08:00", lunch: "12:30", dinner: "19:00" }, sleepTime: "22:30",
    },
  });

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
  await page.locator('[data-tour="nav-settings"]').click();
  await page.waitForTimeout(700);

  const scroller = page.locator('[data-tour="elder-profile-section"]').locator("xpath=ancestor::div[contains(@class,'overflow-y-auto')][1]");
  // Search first: type a query and jump to the matching section.
  await page.locator('[data-walk="elder-settings-search"]').fill("contrast");
  await page.waitForTimeout(400);
  await frame.screenshot({ path: "scratchpad/shots/settings-search.png" });
  await page.getByText("Contrast", { exact: true }).click();
  await page.waitForTimeout(900);
  await frame.screenshot({ path: "scratchpad/shots/settings-jump.png" });
  await scroller.evaluate(el => el.scrollTo({ top: 0 }));
  await page.waitForTimeout(300);

  const shots = ["settings-1", "settings-2", "settings-3", "settings-4"];
  for (const [i, name] of shots.entries()) {
    if (i > 0) {
      await scroller.evaluate((el, n) => el.scrollTo({ top: n * (el.clientHeight - 80) }), i);
      await page.waitForTimeout(400);
    }
    await frame.screenshot({ path: `scratchpad/shots/${name}.png` });
  }

  // Colour vision is a dropdown: picking a mode must actually apply it (the
  // shapes panel only appears in a colour-blind mode).
  await scroller.evaluate(el => el.scrollTo({ top: 0 }));
  await page.waitForTimeout(300);
  // Off by default: the modes are hidden until the switch is on.
  await expect(page.locator('[data-walk="elder-colourvision"]')).toHaveCount(0);
  const cvToggle = page.locator('[data-walk="elder-colourvision-toggle"]');
  await cvToggle.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await frame.screenshot({ path: "scratchpad/shots/settings-cv-off.png" });
  await cvToggle.click();
  await page.waitForTimeout(500);
  const modes = page.locator('[data-walk="elder-colourvision"] button');
  await expect(modes).toHaveCount(3);
  await modes.nth(1).click();
  await page.waitForTimeout(400);
  await cvToggle.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await frame.screenshot({ path: "scratchpad/shots/settings-colourvision.png" });
  // `truncate` guarantees one line; what has to be checked is that no label is
  // actually being cut off in its column.
  // Measure the TEXT, not the box: scrollWidth omits right padding, so a
  // slightly-clipped label can still report scrollWidth === clientWidth.
  const clipped = await modes.evaluateAll(els => els.filter(el => {
    const cs = getComputedStyle(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return range.getBoundingClientRect().width > avail + 0.5;
  }).map(el => el.textContent));
  expect(clipped, "labels truncated in their column").toEqual([]);
  // Flicking it off and on again returns to the mode that was chosen.
  await cvToggle.click();
  await page.waitForTimeout(300);
  await cvToggle.click();
  await page.waitForTimeout(300);
  await expect(page.locator('[data-walk="elder-colourvision"] button').nth(1)).toHaveAttribute("aria-pressed", "true");
  await cvToggle.click();
  await page.waitForTimeout(300);

  // 24-hour clock lives under Accessibility and changes what times SHOW.
  await scroller.evaluate(el => el.scrollTo({ top: 0 }));
  await page.waitForTimeout(200);
  const h24 = page.locator('[data-walk="elder-24h-toggle"]');
  await h24.scrollIntoViewIfNeeded();
  await h24.click();
  await page.waitForTimeout(300);
  await frame.screenshot({ path: "scratchpad/shots/settings-24h.png" });
  await page.locator('[data-tour="nav-prescriptions"]').click();
  await page.waitForTimeout(700);
  await frame.screenshot({ path: "scratchpad/shots/rx-24h.png" });
  await page.locator('[data-tour="nav-settings"]').click();
  await page.waitForTimeout(500);

  // While 24h is on: the time editor drops the AM/PM column and the hour runs
  // 0–23, so a late time reads 22 rather than 10 PM.
  await page.locator('[data-walk="elder-profile-toggle"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-walk="elder-profile-edit"]').click();
  await page.waitForTimeout(400);
  // NOT :has-text("Change") — Playwright's has-text is case-insensitive and
  // "Save changes" matches it, which clicked Save instead of opening a row.
  const bedtimeRow = page.locator('button:has-text("22:30")').first();
  await bedtimeRow.scrollIntoViewIfNeeded();
  await bedtimeRow.click();
  await page.waitForTimeout(400);
  const hourWheel = page.getByRole("slider").first();
  await hourWheel.evaluate(el => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  await expect(page.getByRole("button", { name: "AM", exact: true })).toHaveCount(0);
  await expect(hourWheel).toHaveAttribute("aria-valuetext", "22");
  await frame.screenshot({ path: "scratchpad/shots/time-24h-editor.png" });
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Back" }).click();
  await page.waitForTimeout(400);

  await h24.scrollIntoViewIfNeeded();
  await h24.click();
  await page.waitForTimeout(300);

  // Profile: the card is the arrow row, and it opens read-only with the info
  // already filled in. Only "Edit profile" there unlocks the fields.
  await scroller.evaluate(el => el.scrollTo({ top: 0 }));
  await page.waitForTimeout(300);
  await page.locator('[data-walk="elder-profile-toggle"]').click();
  await page.waitForTimeout(500);
  await frame.screenshot({ path: "scratchpad/shots/settings-profile-read.png" });
  // Read mode is a record, not a form: no fields at all, and the seeded values
  // are the ones on screen.
  const weight = page.locator('[data-walk="elder-profile-weight"]');
  await expect(weight).toHaveCount(0);
  await expect(page.getByText("58", { exact: true })).toBeVisible();
  await expect(page.getByText("Type 2 Diabetes, Hypertension")).toBeVisible();
  // Edit lives in the header's top-right corner.
  await page.locator('[data-walk="elder-profile-edit"]').click();
  await page.waitForTimeout(400);
  await expect(weight).toBeEnabled();
  await expect(weight).toHaveValue("58");
  await frame.screenshot({ path: "scratchpad/shots/settings-profile-edit.png" });
  await page.getByRole("button", { name: "Back" }).click();
  await page.waitForTimeout(400);

  // Sign out sits on the settings page itself now, and the caregiver-mode
  // switch is gone entirely.
  await expect(page.locator('[data-walk="elder-sign-out"]')).toBeVisible();
  await expect(page.getByText("Switch to Caregiver Mode")).toHaveCount(0);

  // "About Dosewise" is its own screen now — just what the app is.
  await page.locator('[data-walk="elder-settings-about"]').click();
  await page.waitForTimeout(500);
  await frame.screenshot({ path: "scratchpad/shots/settings-about.png" });
  await page.getByRole("button", { name: "Back" }).click();
  await page.waitForTimeout(400);
  await frame.screenshot({ path: "scratchpad/shots/settings-back.png" });

  // Sign out at the end of the page must land back on the start screen.
  const signOut = page.locator('[data-walk="elder-sign-out"]');
  await signOut.scrollIntoViewIfNeeded();
  await frame.screenshot({ path: "scratchpad/shots/settings-signout.png" });
  await signOut.click();
  await expect(page.getByRole("button", { name: "Get started" })).toBeVisible({ timeout: 15_000 });
  await frame.screenshot({ path: "scratchpad/shots/settings-signed-out.png" });
});
