import { expect, test } from "@playwright/test";
import { anonClient, createThrowawayElder, recheckDb, signIn } from "../helpers";

// Orchestrator verification (not one of the 32 numbered scenarios): Phase-4
// spot-check of s03 found the SAME dose-selection bug the chat path was fixed
// for (Phase 1) still live in the DIRECT card-tap path — lib/medications.ts's
// logDoseTaken took only medicationId, so with two pending slots today it
// flipped whichever was "most recent pending" regardless of which card the
// elder actually tapped. Fixed by threading the tapped card's own slot
// through; this proves the fix with a real UI tap, not just a unit check.
test("manual card-tap flips the SLOT TAPPED, not the latest pending, when a med has two pending doses today", async ({ page }) => {
  test.setTimeout(60_000);
  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { error: sErr } = await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  expect(sErr, sErr?.message).toBeNull();

  const { data: med, error: mErr } = await supa
    .from("medications")
    .insert({ elder_id: creds.userId, name: "Metformin", dosage: "500mg", purpose: "blood sugar",
      schedule: { times: ["08:00", "20:00"], frequency: "daily" } })
    .select("id").single();
  expect(mErr, mErr?.message).toBeNull();
  const medId: string = med!.id;

  const today = new Date().toISOString().slice(0, 10);
  const amIso = new Date(`${today}T08:00:00`).toISOString();
  const pmIso = new Date(`${today}T20:00:00`).toISOString();
  const { data: amDose, error: amErr } = await supa.from("doses")
    .insert({ medication_id: medId, elder_id: creds.userId, scheduled_at: amIso, status: "pending" })
    .select("id").single();
  expect(amErr, amErr?.message).toBeNull();
  const { data: pmDose, error: pmErr } = await supa.from("doses")
    .insert({ medication_id: medId, elder_id: creds.userId, scheduled_at: pmIso, status: "pending" })
    .select("id").single();
  expect(pmErr, pmErr?.message).toBeNull();

  await signIn(page, creds);
  const card = page.locator(`[data-testid="medication-${medId}"]`);
  await expect(card.first()).toBeVisible({ timeout: 15_000 });

  // Tap the 8:00 AM card specifically, then confirm the time-adjust dialog
  // that "I Took It" opens (confirmTake -> onLogDose fires only from there,
  // never from the card tap itself) — assert only THAT slot flips.
  const morningCard = page.locator(`[data-testid="medication-${medId}"]`).filter({ hasText: "8:00 AM" });
  await expect(morningCard).toBeVisible({ timeout: 10_000 });
  await morningCard.getByRole("button", { name: /Took It/i }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();

  await expect.poll(async () => {
    const rows = await recheckDb(supa, "doses", { id: amDose!.id });
    return rows[0]?.status;
  }, { timeout: 10_000 }).toBe("taken");

  const pmRows = await recheckDb(supa, "doses", { id: pmDose!.id });
  expect(pmRows[0]?.status, "the 8 PM dose must still be pending — tapping the 8 AM card must not touch it").toBe("pending");
});
