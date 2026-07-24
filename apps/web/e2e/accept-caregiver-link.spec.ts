import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { anonClient, createCaregiverWithPendingLink, createThrowawayElder, signIn, startWalkthrough } from "./helpers";

// Guided Auto-Navigation — CONSENT flow, end to end against REAL Supabase.
// Mei autonomously navigates to the pending caregiver link request, but the
// ELDER must tap Accept THEMSELVES (linking grants account access — Mei must
// never auto-grant it). The walkthrough pauses on a human `write-committed`
// waitFor; only after the elder's real, RLS-enforced Accept tap commits does
// the final act-less Verify step re-query care_links to confirm the link is
// really active.

const SHOTS = "e2e/artifacts/accept-caregiver-link";

test("consent flow: Mei navigates, elder taps Accept, Verify confirms link active", async ({ page }) => {
  test.setTimeout(90_000);
  mkdirSync(SHOTS, { recursive: true });

  const elder = await createThrowawayElder();
  await createCaregiverWithPendingLink(elder.userId);

  await signIn(page, elder);
  await startWalkthrough(page, "accept_caregiver_link");

  // Mei navigates to Notifications and spotlights the Accept button — but does
  // NOT click it. The pending-request card renders only after
  // fetchPendingLinkRequests resolves, so wait for the button to appear.
  const accept = page.locator('[data-walk^="care-link-accept-"]');
  await expect(accept).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/1-awaiting-consent.png` });

  // GUARDRAIL: Mei did NOT auto-accept. The walkthrough is paused waiting for
  // the human tap — the link must still be pending in the DB, and the Accept
  // button must still be present (walkthrough still active, no honest error).
  const supa = anonClient();
  await supa.auth.signInWithPassword({ email: elder.email, password: elder.password });
  const { data: before } = await supa.from("care_links").select("status").eq("elder_id", elder.userId);
  expect(before?.length ?? 0).toBeGreaterThan(0);
  expect(before?.every(r => r.status === "pending")).toBe(true);
  await expect(page.getByText("I couldn't confirm that saved", { exact: false })).toHaveCount(0);
  await expect(accept).toBeVisible();

  // The human consent tap — Playwright simulates the elder's real click. The
  // overlay is pointer-events-none (click-through) so this reaches the button.
  await accept.click();

  // Verify completes without the honest error: the real activation committed,
  // ElderlyNotificationsScreen emitted "care-link-activated", and the act-less
  // Verify step re-queried care_links and found it active. The request card is
  // consumed, so the Accept button disappears.
  await expect(page.getByText("I couldn't confirm that saved", { exact: false })).toHaveCount(0, { timeout: 20_000 });
  await expect(accept).toHaveCount(0, { timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/2-linked.png` });

  // Independent DB assertion: the link is now really active.
  await expect
    .poll(async () => {
      const { data } = await supa.from("care_links").select("status").eq("elder_id", elder.userId).eq("status", "active");
      return (data ?? []).length;
    }, { timeout: 15_000 })
    .toBeGreaterThan(0);
});
