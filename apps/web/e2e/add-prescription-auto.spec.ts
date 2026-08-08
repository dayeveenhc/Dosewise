import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { anonClient, createThrowawayElder, signIn, startWalkthroughAuto } from "./helpers";

// Phase 2 flagship — drive the AUTONOMOUS add-prescription walkthrough end to end
// against REAL Supabase, with a throwaway elder. Proves all five phases:
// Navigate → Act (open) → Act×3 (fill) → Submit → Verify (real re-query) →
// Reveal (the real new dose on the Home timeline). Screenshots per phase land in
// e2e/artifacts/add-prescription-auto.

const SHOTS = "e2e/artifacts/add-prescription-auto";

test("autonomous add-prescription: act → submit → verify → reveal", async ({ page }) => {
  test.setTimeout(60_000);
  mkdirSync(SHOTS, { recursive: true });
  const creds = await createThrowawayElder();

  await signIn(page, creds);
  await page.screenshot({ path: `${SHOTS}/1-elder-home.png` });

  // Drive with the patient's REAL values (params) — proves parameterization, not
  // the hardcoded default.
  await startWalkthroughAuto(page, "add_prescription_auto", { name: "Lisinopril", dose: "10mg", purpose: "Blood pressure" });

  // Phase: Act (open) — the Add Prescription form appears.
  await expect(page.locator('[data-walk="rx-name"] input')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/2-form-open.png` });

  // Phase: Act (fill) — Mei fills each field herself with the passed-in values.
  await expect(page.locator('[data-walk="rx-dose"]')).toHaveValue("10mg", { timeout: 15_000 });
  await expect(page.locator('[data-walk="rx-name"] input')).toHaveValue("Lisinopril");
  await page.screenshot({ path: `${SHOTS}/3-fields-filled.png` });

  // Phases: Submit → Verify → Reveal. The sheet closes on a real save; then the
  // reveal lands on the Home timeline, where the new dose really shows (proof the
  // write landed, and that the person ends on their schedule — not a list).
  await expect(page.locator('[data-walk="rx-submit"]')).toBeHidden({ timeout: 20_000 });
  const homeTimeline = page.locator('[data-tour="elder-schedule"]');
  await expect(homeTimeline.getByText("Lisinopril", { exact: false })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/4-revealed-on-home.png` });

  // Verify independently against the DB that the write is really there.
  const supa = anonClient();
  await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  const { data: meds } = await supa.from("medications").select("name").eq("elder_id", creds.userId);
  expect((meds ?? []).some(m => (m.name ?? "").toLowerCase() === "lisinopril")).toBe(true);
});

test("failure path: a blocked write is CAUGHT by Verify — no false success", async ({ page }) => {
  test.setTimeout(60_000);
  mkdirSync(SHOTS, { recursive: true });
  const creds = await createThrowawayElder();

  // Break the medication INSERT (leave reads working) so the write never lands.
  await page.route("**/rest/v1/medications**", route => {
    if (route.request().method() === "POST") return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    return route.continue();
  });

  await signIn(page, creds);
  await startWalkthroughAuto(page, "add_prescription_auto");

  // It still fills and taps Save (Act/Submit), but Verify re-queries, finds
  // nothing, and STOPS with the honest error — never a success claim.
  await expect(page.locator('[data-walk="rx-submit"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("I couldn't confirm that saved", { exact: false })).toBeVisible({ timeout: 25_000 });
  await page.screenshot({ path: `${SHOTS}/5-verify-failed.png` });

  // No success-style copy appears, and nothing landed in the DB.
  await expect(page.getByText("Just added", { exact: false })).toHaveCount(0);
  const supa = anonClient();
  await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  const { data: meds } = await supa.from("medications").select("name").eq("elder_id", creds.userId);
  expect(meds ?? []).toHaveLength(0);
});
