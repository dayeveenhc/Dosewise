import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import type { TurnAction } from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s11 change-dose-time (NEW-FE) — set_medication_reminder propose→confirm on an
// EXISTING med: "change my metformin reminder from 8am to 9am" REPLACES the
// schedule times 08:00 → 09:00. The committed action is an entity_type
// "schedule_entry" whose entity_id is the medication uuid; ChangeHighlight rings
// the elder Prescriptions medication-{id} card via the "-{id}" suffix fallback
// (there is no schedule_entry-{id} node) and captions "Updated: dose time
// 8:00 AM → 9:00 AM". Propose+confirm MUST be the same elder/session (the :8901
// session persists per elder_id and holds the pending_reminder proposal).
const ARTIFACTS = "e2e/artifacts/s11";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s11"; // durable, NOT wiped

// schedule.times off a recheckDb medications row (jsonb → object), asserting a
// single matched row so the check can't silently pass on zero rows.
function scheduleTimes(rows: Record<string, unknown>[]): string[] {
  expect(rows, "exactly one medication row").toHaveLength(1);
  return ((rows[0].schedule as { times?: string[] } | null)?.times) ?? [];
}

test("s11 change-dose-time: 'Change my metformin reminder from 8am to 9am' -> propose→confirm replaces schedule times 08:00 → 09:00", async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // Fresh throwaway elder (its own :8901 session) + one Metformin on file with a
  // single daily 08:00 reminder. Same jwt drives BOTH turns below, so propose and
  // confirm land in the same session — the pending_reminder the propose stashes
  // is the one the "yes" confirms.
  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { data: signInData, error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  const jwt = signInData!.session!.access_token;
  const { data: med, error: mErr } = await supa
    .from("medications")
    .insert({ elder_id: creds.userId, name: "Metformin", dosage: "500mg",
              purpose: "blood sugar", schedule: { times: ["08:00"], frequency: "daily" } })
    .select("id")
    .single();
  expect(mErr, mErr?.message).toBeNull();
  const medId: string = med!.id;

  // ── 2 TRIGGER ─────────────────────────────────────────────────────────────
  // Propose→confirm across two turns of the SAME session. Each leg gets ≤3
  // recorded attempts for LLM-routing variance (mirrors s09's per-leg shape);
  // every attempt is saved whether it routed or not.
  // (a) PROPOSE — turn A reads the change back, writes NOTHING.
  const PROPOSE_PHRASE = "Change my metformin reminder from 8am to 9am";
  let propose = await agentTurn8901(jwt, PROPOSE_PHRASE);
  saveTurnArtifact(ARTIFACTS, "propose-attempt-1", propose);
  for (let attempt = 2; attempt <= 3 && !propose.tools_used.includes("set_medication_reminder"); attempt++) {
    console.log(`[PROPOSE] attempt ${attempt} (previous tools_used=${JSON.stringify(propose.tools_used)})`);
    propose = await agentTurn8901(jwt, PROPOSE_PHRASE);
    saveTurnArtifact(ARTIFACTS, `propose-attempt-${attempt}`, propose);
  }
  expect(propose.http, "propose turn HTTP status").toBe(200);
  expect(propose.tools_used, "propose routed to set_medication_reminder").toContain("set_medication_reminder");
  // A propose must NOT commit and must NOT write — the reminder is still 08:00.
  expect(
    propose.actions.find(a => a.tool === "set_medication_reminder"),
    "propose: nothing committed yet",
  ).toBeFalsy();
  expect(propose.reply, "propose reply reads the new time back").toMatch(/9:00|9\s*am|09:00|nine/i);
  expect(scheduleTimes(await recheckDb(supa, "medications", { id: medId })),
    "propose wrote nothing — schedule still 08:00").toEqual(["08:00"]);

  // (b) CONFIRM — turn B commits the stashed proposal.
  const CONFIRM_PHRASE = "yes";
  let confirm = await agentTurn8901(jwt, CONFIRM_PHRASE);
  saveTurnArtifact(ARTIFACTS, "confirm-attempt-1", confirm);
  for (let attempt = 2; attempt <= 3 && !confirm.actions.some(a => a.tool === "set_medication_reminder"); attempt++) {
    console.log(`[CONFIRM] attempt ${attempt} (previous tools_used=${JSON.stringify(confirm.tools_used)})`);
    confirm = await agentTurn8901(jwt, CONFIRM_PHRASE);
    saveTurnArtifact(ARTIFACTS, `confirm-attempt-${attempt}`, confirm);
  }
  expect(confirm.http, "confirm turn HTTP status").toBe(200);
  expect(confirm.tools_used, "confirm routed to set_medication_reminder").toContain("set_medication_reminder");
  const action = confirm.actions.find(a => a.tool === "set_medication_reminder") as TurnAction | undefined;
  expect(action, "confirm committed a reminder action").toBeTruthy();
  // entity_type is schedule_entry, but entity_id is the MEDICATION uuid — this is
  // exactly what makes the highlight resolve via the medication-{id} suffix fallback.
  expect(action!.entity_type, "committed entity_type").toBe("schedule_entry");
  expect(action!.entity_id, "committed entity_id is the seeded med uuid").toBe(medId);
  expect(action!.changed_fields?.times, "committed times diff 08:00 → 09:00")
    .toEqual({ before: ["08:00"], after: ["09:00"] });

  // ── 3 RE-CHECK ────────────────────────────────────────────────────────────
  // Independent Supabase re-read — the DB is the truth, not the turn's reply.
  expect(scheduleTimes(await recheckDb(supa, "medications", { id: medId })),
    "reminder time replaced 08:00 → 09:00 in DB").toEqual(["09:00"]);

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  await signIn(page, creds); // baseURL :5173, lands on Home
  await page.locator('[data-tour="nav-ai"]').click(); // start on the AI tab…
  await resetPhaseLog(page); // clear BEFORE the highlight phase under test
  // Fire the REAL committed action from turn B: ChangeHighlight auto-navigates
  // AI → Prescriptions, rings the exact card (schedule_entry → medication-{id}
  // suffix fallback), and shows the diff caption.
  await page.evaluate((a) => {
    (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a);
  }, action as unknown as Record<string, unknown>);

  const card = page.locator(`[data-testid="medication-${medId}"]`);
  await expect(card, "med card ringed").toHaveClass(/change-highlight/, { timeout: 10_000 });
  await expect(card, "card visibly shows the NEW reminder time").toContainText("9:00 AM");
  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption, "diff caption visible").toBeVisible();
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  const captionText = ((await caption.textContent()) ?? "").replace(/\s+/g, " ").trim();
  expect(captionText, "caption mentions the new time in 12h").toContain("9:00 AM");
  expect(captionText, "caption is the exact time diff — not a generic 'Added'/'Updated'")
    .toBe("Updated: dose time 8:00 AM → 9:00 AM");

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  await page.screenshot({ path: `${SHOTS}/change-dose-time-ringed.png`, fullPage: true });

  // Let the highlight dwell run to completion so its phase-log entry is recorded
  // (recordDwell fires at auto-dismiss, HIGHLIGHT_DWELL_MIN_MS after the ring shows).
  await page.waitForFunction(
    () => ((window as unknown as { __dwPhaseLog?: { surface: string; phase: string }[] }).__dwPhaseLog ?? [])
      .some(e => e.surface === "highlight" && e.phase === "dwell"),
    null,
    { timeout: 15_000 },
  );
  const log = await readPhaseLog(page);
  assertPhaseMins(log, [
    { surface: "highlight", phase: "dwell", min: PACING.HIGHLIGHT_DWELL_MIN_MS },
  ]);

  // ── 6 NO scenario-local ms literals ───────────────────────────────────────
  // All timing via PACING above; the only literal is the 500ms scroll-settle wait.
});
