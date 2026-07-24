import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { anonClient, createThrowawayElder, signIn } from "./helpers";

// Point-2 proof: a doctor question Mei queues (add_doctor_question → real
// doctor_questions row) now (a) actually shows in the elder's "Ask a doctor"
// thread — previously it was seed-only and never appeared — and (b) gets
// ChangeHighlight-ringed by its real DB id. Full 5-step method against live data.
test("ChangeHighlight rings a real doctor question in the Ask-a-doctor thread", async ({ page }) => {
  mkdirSync("e2e/artifacts/doctor-question", { recursive: true });
  const creds = await createThrowawayElder();

  // Insert a real doctor_questions row AS the elder (RLS), capture its real id.
  const supa = anonClient();
  const { error: sErr } = await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  expect(sErr, sErr?.message).toBeNull();
  const question = "Is it safe to take Metformin with my new blood pressure pill?";
  const { data: row, error: qErr } = await supa
    .from("doctor_questions")
    .insert({ elder_id: creds.userId, question, source: "agent", status: "open" })
    .select("id,question")
    .single();
  expect(qErr, qErr?.message).toBeNull();
  const qid: string = row!.id;

  // Step 2/3: independent re-read confirming the id exists with that value.
  const { data: reread } = await supa.from("doctor_questions").select("id,question").eq("id", qid).single();
  expect(reread!.question).toBe(question);

  // Step 4: drive the real UI, fire the committed action for that real id.
  await signIn(page, creds);
  await page.evaluate(([id, q]) => {
    (window as unknown as { __dwHighlightChange: (a: unknown) => void }).__dwHighlightChange({
      tool: "add_doctor_question",
      summary: q,
      entity_type: "doctor_message",
      entity_id: id,
      changed_fields: { question: { before: null, after: q } },
    });
  }, [qid, question]);

  // The Ask-a-doctor thread opens and the exact row is present + ringed.
  const card = page.locator(`[data-testid="doctor_message-${qid}"]`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveClass(/change-highlight/, { timeout: 10_000 });
  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption).toBeVisible();
  await expect(caption).toContainText("Added");

  // Step 5: evidence.
  await page.screenshot({ path: "e2e/artifacts/doctor-question/highlighted.png", fullPage: true });
});
