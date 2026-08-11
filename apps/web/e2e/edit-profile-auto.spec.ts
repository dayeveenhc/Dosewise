import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { anonClient, createThrowawayElder, signIn, startWalkthroughAuto, useAutoWalkthroughNav } from "./helpers";

// Guided Auto-Navigation — autonomous profile edit, end to end against REAL
// Supabase with a throwaway elder. Mei opens Settings → Your Profile, fills the
// weight field, saves, then Verify re-queries fetchProfile to confirm the new
// weightKg really persisted. Screenshots land in e2e/artifacts/edit-profile-auto.

const SHOTS = "e2e/artifacts/edit-profile-auto";

test("autonomous edit-profile: fill weight → save → verify persisted", async ({ page }) => {
  test.setTimeout(60_000);
  mkdirSync(SHOTS, { recursive: true });
  const creds = await createThrowawayElder();

  // This spec asserts on a run driving ITSELF; step-by-step is now the default.
  await useAutoWalkthroughNav(page);
  await signIn(page, creds);
  await startWalkthroughAuto(page, "edit_profile_auto");

  // Act: the Your Profile expander opens and Mei fills the weight field herself.
  const weight = page.locator('[data-walk="elder-profile-weight"]');
  await expect(weight).toBeVisible({ timeout: 15_000 });
  await expect(weight).toHaveValue("62", { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/1-weight-filled.png` });

  // Submit → Verify: the walkthrough completes only if the profile really saved.
  // Assert the honest error is NOT shown and the value is really in the DB.
  await expect(page.getByText("I couldn't confirm that saved", { exact: false })).toHaveCount(0, { timeout: 20_000 });

  const supa = anonClient();
  await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  await expect
    .poll(async () => {
      const { data } = await supa.from("profiles").select("accessibility").eq("id", creds.userId).maybeSingle();
      return (data?.accessibility as { weightKg?: number } | null)?.weightKg ?? null;
    }, { timeout: 15_000 })
    .toBe(62);
  await page.screenshot({ path: `${SHOTS}/2-saved.png` });
});

test("a blocked profile write is CAUGHT by Verify — no false success", async ({ page }) => {
  test.setTimeout(60_000);
  mkdirSync(SHOTS, { recursive: true });
  const creds = await createThrowawayElder();

  // Break the profile write (leave reads working) so the save never lands. The
  // elder's profile row was created during setup via the NODE client, before
  // this browser route is installed, so setup is unaffected — only the in-browser
  // saveProfile is blocked.
  await page.route("**/rest/v1/profiles**", route => {
    const m = route.request().method();
    if (m === "POST" || m === "PATCH") return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    return route.continue();
  });

  // This spec asserts on a run driving ITSELF; step-by-step is now the default.
  await useAutoWalkthroughNav(page);
  await signIn(page, creds);
  await startWalkthroughAuto(page, "edit_profile_auto");

  // It still fills and taps Save (Act/Submit), but Verify re-queries, finds the
  // old value, and STOPS with the honest error — never a false success.
  await expect(page.locator('[data-walk="elder-profile-weight"]')).toHaveValue("62", { timeout: 15_000 });
  await expect(page.getByText("I couldn't confirm that saved", { exact: false })).toBeVisible({ timeout: 25_000 });
  await page.screenshot({ path: `${SHOTS}/3-verify-failed.png` });

  // Nothing landed: the blocked write means weightKg never became 62 in the DB.
  const supa = anonClient();
  await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  const { data } = await supa.from("profiles").select("accessibility").eq("id", creds.userId).maybeSingle();
  expect((data?.accessibility as { weightKg?: number } | null)?.weightKg ?? null).not.toBe(62);
});
