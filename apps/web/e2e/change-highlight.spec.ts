import { test, expect } from "@playwright/test";
import { anonClient, createThrowawayElder, signIn } from "./helpers";

// Phase-1 keystone proof for the ChangeHighlight canonical layer, end to end
// against REAL data (live Supabase, real medication row):
//   1. create a throwaway elder + a real medication (captures its real DB id),
//   2. independently re-read that id from Supabase (proves it exists),
//   3. drive the real UI and fire a committed action carrying that entity_id +
//      real changed_fields,
//   4. assert the EXACT card is ringed (.change-highlight) and the caption is
//      built from changed_fields ("dose time 18:00 → 20:00"),
//   5. screenshot the highlighted state.
test("ChangeHighlight rings the exact medication card with a changed_fields caption", async ({ page }) => {
  const creds = await createThrowawayElder();

  // Insert a real medication AS the elder (RLS), capture its real id.
  const supa = anonClient();
  const { error: sErr } = await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  expect(sErr, sErr?.message).toBeNull();
  const { data: med, error: mErr } = await supa
    .from("medications")
    .insert({ elder_id: creds.userId, name: "Metformin", dosage: "500mg", purpose: "blood sugar", schedule: { times: ["18:00"], frequency: "daily" } })
    .select("id,schedule")
    .single();
  expect(mErr, mErr?.message).toBeNull();
  const medId: string = med!.id;

  // Step 2: independent re-read confirming the id exists with the expected value.
  const { data: reread } = await supa.from("medications").select("id,name,schedule").eq("id", medId).single();
  expect(reread!.name).toBe("Metformin");
  expect((reread!.schedule as { times: string[] }).times).toEqual(["18:00"]);

  // Step 3: drive the real UI, land on the medication list, then fire the change.
  await signIn(page, creds);
  await page.getByRole("button", { name: "Medications" }).click().catch(() => {});
  await expect(page.locator(`[data-testid="medication-${medId}"]`)).toBeVisible({ timeout: 15_000 });

  await page.evaluate(([id]) => {
    (window as unknown as { __dwHighlightChange: (a: unknown) => void }).__dwHighlightChange({
      tool: "set_medication_reminder",
      summary: "Metformin at 20:00",
      entity_type: "schedule_entry",
      entity_id: id,
      changed_fields: { times: { before: ["18:00"], after: ["20:00"] } },
    });
  }, [medId]);

  // Step 4: the exact card is ringed and the caption is derived from changed_fields.
  const card = page.locator(`[data-testid="medication-${medId}"]`);
  await expect(card).toHaveClass(/change-highlight/, { timeout: 10_000 });
  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption).toBeVisible();
  await expect(caption).toContainText("Updated");
  // Bugfix-B: dose times render in 12h ("6:00 PM"), not raw 24h HH:MM.
  await expect(caption).toContainText("dose time 6:00 PM → 8:00 PM");

  // Step 5: evidence.
  await page.screenshot({ path: "e2e/artifacts/change-highlight/highlighted.png", fullPage: true });
});
