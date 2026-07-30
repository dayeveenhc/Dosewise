import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  expectRow, readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s21 doctor-question — elder asks Mei to queue a question for their doctor;
// add_doctor_question writes a real doctor_questions row and ChangeHighlight
// rings it in the AI screen's "Ask a doctor" sub-tab (AUDIT).
const ARTIFACTS = "e2e/artifacts/s21";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s21"; // durable, NOT wiped
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The queued question must actually be about what the elder asked — accept the
// regional synonyms an LLM might normalize to, nothing looser.
const PARACETAMOL_RE = /paracetamol|panadol|acetaminophen/i;

test("s21 doctor-question: 'Please ask my doctor whether I can take paracetamol together with my metformin' -> open doctor_questions row, ringed in the Ask-a-doctor thread", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { data: signInData, error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  const jwt = signInData!.session!.access_token;
  // "my metformin" in the trigger phrase must be real for this elder.
  const { error: mErr } = await supa
    .from("medications")
    .insert({ elder_id: creds.userId, name: "Metformin", dosage: "500mg",
              purpose: "blood sugar", schedule: { times: ["08:00"], frequency: "daily" } });
  expect(mErr, mErr?.message).toBeNull();

  // ── 2 TRIGGER ─────────────────────────────────────────────────────────────
  // Verbatim realistic phrase; ≤3 recorded attempts for LLM-routing variance.
  const PHRASE = "Please ask my doctor whether I can take paracetamol together with my metformin";
  let turn = await agentTurn8901(jwt, PHRASE);
  saveTurnArtifact(ARTIFACTS, "turn-attempt-1", turn);
  for (let attempt = 2; attempt <= 3 && !turn.tools_used.includes("add_doctor_question"); attempt++) {
    console.log(`[TRIGGER] attempt ${attempt} (previous tools_used=${JSON.stringify(turn.tools_used)})`);
    turn = await agentTurn8901(jwt, PHRASE);
    saveTurnArtifact(ARTIFACTS, `turn-attempt-${attempt}`, turn);
  }
  expect(turn.http, "agent/turn HTTP status").toBe(200);
  expect(turn.tools_used, "expected tool routed").toContain("add_doctor_question");
  const action = turn.actions.find(a => a.tool === "add_doctor_question");
  expect(action, "committed add_doctor_question action present").toBeTruthy();
  expect(action!.entity_type, "action entity_type").toBe("doctor_message");
  expect(action!.entity_id, "action entity_id is the inserted row's uuid").toMatch(UUID_RE);
  const qid = action!.entity_id!;
  const queued = action!.changed_fields?.question;
  expect(queued, "action changed_fields.question present").toBeTruthy();
  expect(String(queued!.after ?? "").trim(), "queued question text non-empty").not.toBe("");

  // ── 3 RE-CHECK ────────────────────────────────────────────────────────────
  // Independent Supabase re-read — the DB is the truth, never the turn.
  const rows = await recheckDb(supa, "doctor_questions", { id: qid, elder_id: creds.userId });
  const row = expectRow(rows, { status: "open", source: "agent" });
  const stored = String(row.question);
  expect(stored, "stored question mentions paracetamol").toMatch(PARACETAMOL_RE);
  expect(stored, "stored question mentions metformin").toMatch(/metformin/i);
  expect(stored, "stored question matches the committed changed_fields.after").toBe(String(queued!.after));

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  await signIn(page, creds); // baseURL :5173
  await page.locator('[data-tour="nav-ai"]').click(); // open the AI tab first
  await resetPhaseLog(page); // clear BEFORE the highlight under test
  // Fire the REAL committed action (real row uuid) through the app's own hook.
  await page.evaluate(a => {
    (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a);
  }, action!);
  // The app must open the "Ask a doctor" sub-tab and ring the exact row's card.
  const card = page.locator(`[data-testid="doctor_message-${qid}"]`);
  await expect(card).toBeVisible({ timeout: PACING.HIGHLIGHT_DWELL_MIN_MS * 4 });
  await expect(card).toHaveClass(/change-highlight/);
  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption).toBeVisible();
  await expect(caption).toContainText("Added:"); // all-new fields -> "Added" verb
  await expect(caption).toContainText(PARACETAMOL_RE); // caption carries the question
  await page.waitForTimeout(500); // let smooth scrollIntoView settle

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  // Captured DURING the dwell (ring + caption disappear at auto-dismiss).
  await page.screenshot({ path: `${SHOTS}/ringed-card-with-caption.png`, fullPage: true });
  await card.screenshot({ path: `${SHOTS}/ringed-card-closeup.png` });

  // (4 cont.) PACING — ChangeHighlight records its "dwell" phase entry only at
  // auto-dismiss, so the phase-log assert must run after the evidence shots:
  // wait for the caption to dismiss itself, then assert the measured dwell.
  await expect(caption).toBeHidden({ timeout: PACING.HIGHLIGHT_DWELL_MIN_MS * 2 });
  const log = await readPhaseLog(page);
  assertPhaseMins(log, [
    { surface: "highlight", phase: "dwell", min: PACING.HIGHLIGHT_DWELL_MIN_MS },
  ]);
  // Generous upper bound: dwell auto-dismisses at the minimum, so anything past
  // 3x means the teardown timer failed.
  const dwell = log.filter(e => e.surface === "highlight" && e.phase === "dwell").at(-1)!;
  expect(dwell.endedAt - dwell.startedAt, "dwell auto-dismissed near the minimum")
    .toBeLessThan(PACING.HIGHLIGHT_DWELL_MIN_MS * 3);

  // ── 6 NO scenario-local ms literals ───────────────────────────────────────
  // All timing above flows through PACING; the single allowed literal is the
  // 500ms scroll-settle wait, written with its canonical comment.
});
