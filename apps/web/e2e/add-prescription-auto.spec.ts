import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { anonClient, createThrowawayElder, signIn, startWalkthroughAuto, tapWalkthroughNext, useAutoWalkthroughNav } from "./helpers";
import { PACING } from "../src/app/lib/walkthrough/pacing";

// Phase 2 flagship — drive the AUTONOMOUS add-prescription walkthrough end to end
// against REAL Supabase, with a throwaway elder. Proves all five phases:
// Navigate → Act (open) → Act×3 (fill) → Submit → Verify (real re-query) →
// Reveal (the real new dose on the Home timeline). Screenshots per phase land in
// e2e/artifacts/add-prescription-auto.

const SHOTS = "e2e/artifacts/add-prescription-auto";

test("autonomous add-prescription: act → submit → verify → reveal → closes itself", async ({ page }) => {
  test.setTimeout(90_000);
  mkdirSync(SHOTS, { recursive: true });
  const creds = await createThrowawayElder();

  // This spec is ABOUT the run driving itself, and step-by-step is now the
  // default — opt this browser into Auto navigation explicitly.
  await useAutoWalkthroughNav(page);
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

  // The Confirm recap holds for a first-timer's own tap (TrustMode); the real
  // Save is always the person's. Wait for the recap BEFORE tapping — a tap that
  // lands mid-fill only fast-forwards that phase, and a Save clicked before the
  // walkthrough reaches its own Submit step closes the sheet under the recap,
  // whose review rows then read blank forever.
  await expect(page.getByText("Please check these details")).toBeVisible({ timeout: 30_000 });
  await tapWalkthroughNext(page);
  await expect(page.getByText("Please check these details")).toBeHidden({ timeout: 10_000 });
  await page.locator('[data-walk="rx-submit"]').click();

  // Phases: Submit → Verify → Reveal. The sheet closes on a real save; then the
  // reveal lands on the Home timeline, where the new dose really shows (proof the
  // write landed, and that the person ends on their schedule — not a list).
  await expect(page.locator('[data-walk="rx-submit"]')).toBeHidden({ timeout: 20_000 });
  const homeTimeline = page.locator('[data-tour="elder-schedule"]');
  await expect(homeTimeline.getByText("Lisinopril", { exact: false })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/4-revealed-on-home.png` });

  // THE RUN ENDS BY ITSELF. Nothing is tapped from here: the last step's gate is
  // the timed FINAL_AUTOCLOSE_MS window, so the overlay must unmount on its own.
  // Nothing asserted this before, which is how "the walkthrough didn't stop"
  // shipped — the Save step used to end on the CLICK, so a Verify that raced the
  // insert left the run parked with no working Done at all.
  await expect(page.getByText(/^Step \d+ of \d+$/), "reaches the last step").toBeVisible({ timeout: 20_000 });
  const counter = await page.getByText(/^Step \d+ of \d+$/).textContent();
  const [, cur, total] = counter!.match(/^Step (\d+) of (\d+)$/)!;
  expect(cur, "on the final step").toBe(total);
  await expect(
    page.getByText(/^Step \d+ of \d+$/),
    "overlay closes itself with no taps",
  ).toHaveCount(0, { timeout: PACING.FINAL_AUTOCLOSE_MS + 15_000 });

  // Verify independently against the DB that the write is really there.
  const supa = anonClient();
  await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  const { data: meds } = await supa.from("medications").select("name").eq("elder_id", creds.userId);
  expect((meds ?? []).some(m => (m.name ?? "").toLowerCase() === "lisinopril")).toBe(true);
});

test("a SLOW write is waited for, not raced: the run still completes", async ({ page }) => {
  test.setTimeout(120_000);
  const creds = await createThrowawayElder();

  // Hold the medication INSERT for 6s — longer than the Verify poll used to get
  // when the step advanced on the click. This is the exact shape of the reported
  // bug: the walkthrough moved on while handleAdd was still awaiting the insert,
  // Verify re-queried an empty table and stopped the run. The Save step now waits
  // on the "medication-saved" bus event, so the write can take as long as it likes.
  await page.route("**/rest/v1/medications**", async route => {
    if (route.request().method() === "POST") await new Promise(r => setTimeout(r, 6000));
    return route.continue();
  });

  // This spec is ABOUT the run driving itself, and step-by-step is now the
  // default — opt this browser into Auto navigation explicitly.
  await useAutoWalkthroughNav(page);
  await signIn(page, creds);
  await startWalkthroughAuto(page, "add_prescription_auto", { name: "Lisinopril", dose: "10mg", purpose: "Blood pressure" });
  await expect(page.locator('[data-walk="rx-dose"]')).toHaveValue("10mg", { timeout: 20_000 });
  await expect(page.getByText("Please check these details")).toBeVisible({ timeout: 30_000 });
  await tapWalkthroughNext(page);
  await expect(page.getByText("Please check these details")).toBeHidden({ timeout: 10_000 });
  await page.locator('[data-walk="rx-submit"]').click();

  // Watch for the honest-failure copy for the WHOLE run, not at one instant:
  // the raced Verify only gives up after its 4.8s poll.
  let sawVerifyFailed = false;
  const watcher = setInterval(() => {
    void page.getByText("I couldn't confirm that saved", { exact: false }).count()
      .then(n => { if (n > 0) sawVerifyFailed = true; })
      .catch(() => { /* page closing */ });
  }, 250);

  await expect(page.locator('[data-tour="elder-schedule"]').getByText("Lisinopril", { exact: false }))
    .toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/^Step \d+ of \d+$/), "closes itself after the slow write")
    .toHaveCount(0, { timeout: PACING.FINAL_AUTOCLOSE_MS + 20_000 });
  clearInterval(watcher);
  expect(sawVerifyFailed, "the run never had to stop and apologise").toBe(false);

  // And exactly ONE medication. With the old click-driven Save step the Verify
  // gave up while the insert was still in flight, and the recovery path then
  // wrote the medicine a SECOND time — the person ended up with a duplicate.
  const supa = anonClient();
  await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  const { data: meds } = await supa.from("medications").select("name").eq("elder_id", creds.userId);
  expect(meds ?? [], "no duplicate row from a raced Verify").toHaveLength(1);
});

test("the dose time Mei was told about is what gets saved — not the 8am default", async ({ page }) => {
  test.setTimeout(90_000);
  mkdirSync(SHOTS, { recursive: true });
  const creds = await createThrowawayElder();

  // This spec is ABOUT the run driving itself, and step-by-step is now the
  // default — opt this browser into Auto navigation explicitly.
  await useAutoWalkthroughNav(page);
  await signIn(page, creds);
  // "one at 12 pm" — the case that was silently filed at 08:00, because
  // start_walkthrough's params carried no time at all.
  await startWalkthroughAuto(page, "add_prescription_auto", {
    name: "Lisinopril", dose: "10mg", purpose: "Blood pressure", times: "12:00",
  });

  await expect(page.locator('[data-walk="rx-dose"]')).toHaveValue("10mg", { timeout: 20_000 });
  // The form itself carries the real time, and the Confirm recap shows it back
  // so the person can check it before committing.
  await expect(page.locator('[data-walk="rx-times"]').getByText("12:00 PM")).toBeVisible();
  await expect(page.getByText("Please check these details")).toBeVisible({ timeout: 25_000 });
  await page.screenshot({ path: `${SHOTS}/6-recap-with-time.png` });

  await tapWalkthroughNext(page);
  await expect(page.getByText("Please check these details")).toBeHidden({ timeout: 10_000 });
  await page.locator('[data-walk="rx-submit"]').click();
  await expect(page.locator('[data-walk="rx-submit"]')).toBeHidden({ timeout: 25_000 });

  // The DB is the only thing that settles it.
  const supa = anonClient();
  await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  const { data: meds } = await supa.from("medications")
    .select("name,schedule").eq("elder_id", creds.userId);
  const row = (meds ?? []).find(m => (m.name ?? "").toLowerCase() === "lisinopril");
  expect(row, "the medication saved").toBeTruthy();
  expect((row!.schedule as { times?: string[] }).times).toEqual(["12:00"]);
});

test("failure path: a blocked write NEVER advances the walkthrough — and is never a dead end", async ({ page }) => {
  // Long: the Save step's timeoutMs is deliberately a minute (see the step
  // file — the idle popup, not this, is the net for a person who is just
  // reading), so proving the stalled state renders a Done means waiting it out.
  test.setTimeout(200_000);
  mkdirSync(SHOTS, { recursive: true });
  const creds = await createThrowawayElder();

  // Break the medication INSERT (leave reads working) so the write never lands.
  await page.route("**/rest/v1/medications**", route => {
    if (route.request().method() === "POST") return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    return route.continue();
  });

  // This spec is ABOUT the run driving itself, and step-by-step is now the
  // default — opt this browser into Auto navigation explicitly.
  await useAutoWalkthroughNav(page);
  await signIn(page, creds);
  await startWalkthroughAuto(page, "add_prescription_auto", { name: "Lisinopril", dose: "10mg", purpose: "Blood pressure" });
  await expect(page.locator('[data-walk="rx-dose"]')).toHaveValue("10mg", { timeout: 20_000 });
  await expect(page.getByText("Please check these details")).toBeVisible({ timeout: 30_000 });
  await tapWalkthroughNext(page);
  await expect(page.getByText("Please check these details")).toBeHidden({ timeout: 10_000 });
  await page.locator('[data-walk="rx-submit"]').click();

  // The sheet says plainly that it couldn't save, and the walkthrough does NOT
  // move on — a failed write emits no "medication-saved", so the Save step keeps
  // waiting rather than claiming a success it can't prove. Tapping Save again
  // would still work.
  await expect(page.getByText("Couldn't save the medication", { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Just added", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/5-save-failed.png` });

  // And it is never a DEAD END: once the wait times out the step says so and
  // offers a real way back to the app. Before this pass a stalled non-final step
  // rendered NOTHING in the action row — the lone grey "Exit walkthrough" was
  // the only control on screen, which is exactly what was reported.
  const done = page.getByRole("button", { name: "Done" });
  await expect(done, "a stalled step still offers Done").toBeVisible({ timeout: 90_000 });
  await done.click();
  await expect(page.getByText(/^Step \d+ of \d+$/), "Done ends the run").toHaveCount(0, { timeout: 10_000 });

  // Nothing landed in the DB.
  const supa = anonClient();
  await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  const { data: meds } = await supa.from("medications").select("name").eq("elder_id", creds.userId);
  expect(meds ?? []).toHaveLength(0);
});
