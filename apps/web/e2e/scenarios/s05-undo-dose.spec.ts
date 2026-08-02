import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  expectRow, readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import type { TurnAction } from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s05 undo-dose (NEW-BE-FE) — "Actually I didn't take my metformin — undo that"
// -> undo_dose flips TODAY's most-recently-logged taken dose back to pending
// IMMEDIATELY (undoing a fresh mistake needs no propose→confirm round-trip) ->
// the Home medication card rings with the undo caption "Unmarked: Metformin".
const ARTIFACTS = "e2e/artifacts/s05";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s05"; // durable, NOT wiped

// Today's 08:00 in Asia/Singapore (the elder tz Hermes uses; UTC+8, no DST) as a
// UTC ISO instant — the mistaken tick's scheduled slot. 08:00 SGT == 00:00 UTC of
// the SAME SGT calendar date, so midnight-UTC of today's SGT date IS 08:00 SGT.
function sgt0800TodayIso(): string {
  const sgtDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return new Date(`${sgtDate}T00:00:00.000Z`).toISOString();
}

test("s05 undo-dose: 'Actually I didn't take my metformin — undo that' -> dose flipped back to pending; Home card ringed 'Unmarked: Metformin'", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // Throwaway elder + Metformin (daily 08:00) + a dose ALREADY marked taken
  // today (logged_at now, scheduled_at today's 08:00 SGT slot) — the mistaken
  // tick undo_dose must flip back. RLS on doses is row-level by elder_id only, so
  // seeding the row directly as the elder in the "taken" state is allowed.
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

  const nowIso = new Date().toISOString();
  const { data: dose, error: dErr } = await supa
    .from("doses")
    .insert({
      medication_id: medId, elder_id: creds.userId,
      scheduled_at: sgt0800TodayIso(), status: "taken",
      logged_at: nowIso, logged_by: creds.userId,
    })
    .select("id")
    .single();
  expect(dErr, dErr?.message).toBeNull();
  const takenDoseId: string = dose!.id;
  console.log(`[FIXTURE] elder=${creds.userId} med=${medId} takenDose=${takenDoseId}`);

  // ── 2 TRIGGER ─────────────────────────────────────────────────────────────
  // ONE turn — undo_dose commits IMMEDIATELY (no propose→confirm). ≤3 recorded
  // attempts for LLM-routing variance; a failed attempt leaves the taken dose
  // intact (nothing consumed), so a retry on the same session can still undo it.
  const PHRASE = "Actually I didn't take my metformin — undo that";
  let turn = await agentTurn8901(jwt, PHRASE);
  saveTurnArtifact(ARTIFACTS, "turn-attempt-1", turn);
  for (let attempt = 2; attempt <= 3 && !turn.actions.some(a => a.tool === "undo_dose"); attempt++) {
    console.log(`[TRIGGER] attempt ${attempt} (previous tools_used=${JSON.stringify(turn.tools_used)})`);
    turn = await agentTurn8901(jwt, PHRASE);
    saveTurnArtifact(ARTIFACTS, `turn-attempt-${attempt}`, turn);
  }
  expect(turn.http, "agent/turn HTTP status").toBe(200);
  expect(turn.tools_used, "expected undo_dose routed").toContain("undo_dose");
  const action = turn.actions.find(a => a.tool === "undo_dose") as TurnAction | undefined;
  expect(action, "undo_dose committed action present on the SAME turn (immediate, no confirm)").toBeTruthy();
  expect(action!.entity_type, "committed entity_type").toBe("dose");
  expect(action!.entity_id, "committed entity_id is the MEDICATION uuid").toBe(medId);
  expect(action!.changed_fields?.status, "committed status diff taken → pending")
    .toEqual({ before: "taken", after: "pending" });
  expect(action!.dose_id, "committed dose_id is the seeded taken row").toBe(takenDoseId);
  // Undo is a direct write: this ONE turn already carries the committed action —
  // there is no proposal-only turn to wait through.
  console.log(`[TRIGGER] committed action=${JSON.stringify(action)}`);

  // ── 3 RE-CHECK ────────────────────────────────────────────────────────────
  // Independent Supabase re-read — the DB is the truth, not the turn's reply. The
  // mistaken tick is back to pending with logged_at cleared, and it is the SAME
  // row (not a new insert).
  const rows = await recheckDb(supa, "doses", { elder_id: creds.userId, medication_id: medId });
  const row = expectRow(rows, { status: "pending", logged_at: null });
  expect(row.id, "the SAME row we seeded was flipped, not a new one").toBe(takenDoseId);

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  await signIn(page, creds); // baseURL :5173, lands on Home
  await page.locator('[data-tour="nav-ai"]').click(); // start on the AI tab (renders no med cards)…
  await resetPhaseLog(page); // clear BEFORE the highlight phase under test
  // Fire the REAL committed action: ChangeHighlight auto-navigates AI → Home,
  // finds the medication card (dose entity_id → medication-{id} via the testid
  // suffix fallback), rings it, and shows the undo caption.
  await page.evaluate((a) => {
    (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a);
  }, action as unknown as Record<string, unknown>);

  const card = page.locator(`[data-testid="medication-${medId}"]`);
  await expect(card, "med card ringed").toHaveClass(/change-highlight/, { timeout: 10_000 });
  // The undo is reflected in the UI: the card is back to the NOT-taken state (the
  // taken variant strikes the name with line-through — there is none now).
  await expect(card.locator("p.line-through"), "card no longer shows the taken state").toHaveCount(0);
  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption, "undo caption visible").toBeVisible();
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  const captionText = ((await caption.textContent()) ?? "").replace(/\s+/g, " ").trim();
  console.log(`[UI] caption="${captionText}"`);
  expect(captionText, "caption is the undo verb + med name — never 'Taken'/'Updated'").toBe("Unmarked: Metformin");

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  await page.screenshot({ path: `${SHOTS}/undo-dose-ringed.png`, fullPage: true });
  await page.screenshot({ path: `${SHOTS}/undo-caption.png` });

  // PACING: the highlight dwells ≥ HIGHLIGHT_DWELL_MIN_MS before auto-dismiss.
  // recordDwell fires at auto-dismiss, HIGHLIGHT_DWELL_MIN_MS after the ring shows,
  // so wait for the dwell entry to land before reading the log.
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
  // All experience timing flows through PACING above; the only bare literal is
  // the 500ms scroll-settle wait (with its required comment). The 10s/15s/120s
  // values are Playwright deadlines, not UI pacing.
});
