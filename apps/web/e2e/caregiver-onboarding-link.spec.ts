import { test, expect } from "@playwright/test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { QRCodeSVG } from "qrcode.react";
import { createThrowawayElder, anonClient } from "./helpers";

// Inlined rather than imported from lib/careLinks: that module pulls in
// lib/supabase, whose import.meta.env has no meaning in the Playwright runtime.
const buildCareLinkPayload = (elderId: string, name: string) =>
  JSON.stringify({ app: "dosewise", kind: "care-link", v: 1, elderId, name });

// The caregiver-onboarding QR entry ("For a loved one" -> "Scan a loved one's QR
// code"). The scan happens BEFORE signup, so nothing can be written at scan time —
// RLS 0005 requires caregiver_id = auth.uid(). This proves the deferral actually
// lands: the sheet must not claim a request was sent, and the real pending
// care_links row must exist only after the wizard's account step.
//
// Headless Chromium has no camera, so this also covers the upload fallback: the
// error phase must still offer "upload a photo of the code" rather than dead-ending.
test("caregiver onboarding: scan a loved one's QR -> account -> real pending care_links row", async ({ page }) => {
  test.setTimeout(120_000);

  const elder = await createThrowawayElder();
  const svg = renderToStaticMarkup(
    React.createElement(QRCodeSVG, { value: buildCareLinkPayload(elder.userId, "Ah Ma (test)"), size: 320, level: "M" }),
  );

  // Rasterize the elder's QR the way a caregiver would have it: a photo in their library.
  const qrPage = await page.context().newPage();
  await qrPage.setContent(`<body style="margin:0;background:#fff">${svg}</body>`);
  const qrPng = "e2e/artifacts/tmp-qr.png";
  await qrPage.locator("svg").screenshot({ path: qrPng });
  await qrPage.close();

  const errors: string[] = [];
  page.on("pageerror", e => errors.push(String(e)));

  await page.goto("/");
  await page.getByText(/get started/i).first().click();
  await page.getByText(/For a Loved One/i).first().click();

  const card = page.locator('[data-walk="setup-method-scan-qr"]');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();

  // Headless Chromium has no camera, so the sheet lands in its error phase —
  // which must still offer the upload fallback rather than only "Close".
  const upload = page.locator('[data-walk="scanlink-upload-qr"], [data-walk="scanlink-upload-qr-error"]').first();
  await expect(upload).toBeVisible({ timeout: 15_000 });
  const chooser = page.waitForEvent("filechooser");
  await upload.click();
  await (await chooser).setFiles(qrPng);

  await expect(page.getByText("Ah Ma (test)")).toBeVisible({ timeout: 20_000 });
  // Deferred mode: nothing has been written yet, so it must not say it has.
  await expect(page.getByText(/Send request/i)).toHaveCount(0);
  await expect(page.getByText(/Request sent/i)).toHaveCount(0);

  await page.locator('[data-walk="scanlink-relationship-chips"] button').first().click();
  await page.locator('[data-walk="scanlink-send-button"]').click();

  // Account step — the link request rides on this session existing.
  const email = `tw-cg-${Date.now()}@dosewise.test`;
  const password = "Throwaway!2026";
  await expect(page.getByText(/create your account/i)).toBeVisible({ timeout: 15_000 });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /create account/i }).click();

  // Placeholder step now names the person instead of "coming soon".
  await expect(page.getByText(/Ah Ma \(test\)/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/coming soon/i)).toHaveCount(0);
  await page.screenshot({ path: "e2e/artifacts/tmp-placeholder.png" });

  await page.getByRole("button", { name: /dosewise/i }).click();
  // finish() is async (saveProfile -> createLinkRequest -> markWalkthroughCompleted);
  // leaving the wizard is the signal that all three resolved.
  await expect(page.getByText(/couldn't send the link request/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /dosewise/i })).toHaveCount(0, { timeout: 30_000 });
  await page.screenshot({ path: "e2e/artifacts/tmp-dashboard.png" });

  // The real proof: a pending care_links row owned by the new caregiver.
  const supa = anonClient();
  const { data: signIn } = await supa.auth.signInWithPassword({ email, password });
  expect(signIn.user).toBeTruthy();
  await expect.poll(async () => {
    const { data } = await supa.from("care_links").select("elder_id,status").eq("caregiver_id", signIn.user!.id);
    return data ?? [];
  }, { timeout: 20_000 }).toHaveLength(1);
  const { data: rows } = await supa
    .from("care_links").select("elder_id,caregiver_id,status,relationship,permissions")
    .eq("caregiver_id", signIn.user!.id);
  console.log("care_links rows:", JSON.stringify(rows));
  expect(rows![0].elder_id).toBe(elder.userId);
  expect(rows![0].status).toBe("pending");

  expect(errors, "no uncaught page errors").toEqual([]);
});
