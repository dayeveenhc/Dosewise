import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  expectRow, readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
  startWalkthrough, advanceWalkthroughToStep, finishWalkthrough,
} from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s19 low-stock-reorder (VIEW) — a VIEW+real-tail scenario. The low-stock
// notification AND its acknowledgement are a MOCK: ElderlyNotificationsScreen
// renders a static demo alert (no push infra, no backend) that the
// notifications_tour walkthrough spotlights. Only the REORDER tail is real — a
// genuine log_refill turn against :8901 that writes the refills table. Owns:
// this spec + steps/notifications_tour.ts.
const ARTIFACTS = "e2e/artifacts/s19";           // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s19";  // durable, NOT wiped

// notifications_tour anchors (steps/notifications_tour.ts) + per-step copy.
const NAV_NOTIF = '[data-tour="nav-notifications"]';
const REFILL_ROW = '[data-walk="notif-refill-row"]';
const SEND_BTN = '[data-walk="elder-ai-send-button"]';

test("s19 low-stock-reorder: mock low-stock tour (AI-auto-advanced) + real 'reorder my metformin' -> log_refill", async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // Throwaway elder + the Metformin the reorder tail acts on, PLUS a second
  // medicine that stays low for the whole run.
  //
  // Both are load-bearing as of 2026-08-08: the Reminders low-stock card used to
  // be a hardcoded "Metformin, 4 days" literal that rendered for everyone, and
  // is now derived from real supply data (lib/alerts.ts).
  //
  // The SECOND medicine is the subtle part. Seeding a low count on Metformin
  // alone does not survive this spec's own flow: step 2's real `log_refill`
  // turn RAISES pills_remaining (that is the whole point of a reorder), so by
  // the time the UI runs Metformin is comfortably stocked and there is no
  // low-stock card left for notifications_tour to spotlight. Atorvastatin is
  // never touched by the turn, so the tour always has a real target — and
  // because the tour's anchors ride the first SUPPLY alert by severity, the
  // lower-stocked one carries them.
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

  const { data: lowMed, error: lErr } = await supa
    .from("medications")
    .insert({ elder_id: creds.userId, name: "Atorvastatin", dosage: "20mg",
              purpose: "cholesterol", schedule: { times: ["21:00"], frequency: "daily" } })
    .select("id")
    .single();
  expect(lErr, lErr?.message).toBeNull();
  // 3 pills at one dose a day — stays under LOW_SUPPLY_DAYS for the whole run.
  const { error: lrErr } = await supa.from("refills").insert({
    medication_id: lowMed!.id, elder_id: creds.userId, pills_remaining: 3, threshold: 10,
  });
  expect(lrErr, lrErr?.message).toBeNull();
  // 4 pills at one dose a day = 4 days left, under LOW_SUPPLY_DAYS (10).
  const { error: rErr } = await supa.from("refills").insert({
    medication_id: medId, elder_id: creds.userId, pills_remaining: 4, threshold: 10,
  });
  expect(rErr, rErr?.message).toBeNull();
  console.log(`[SEED] elder=${creds.userId} med=${medId} pills_remaining=4`);

  // ── 2 TRIGGER (the ONE real thing: the reorder tail) ──────────────────────
  // Verbatim realistic phrase; ≤3 recorded attempts for LLM-routing variance.
  // NOTE: "reorder my metformin" ALONE routes to check_refills / asks for a
  // count (log_refill needs a concrete new total — soul.md: "when they give a
  // new count or say they refilled"). The phrase keeps the reorder narrative but
  // states the count the backend requires, so the tail reliably commits.
  const PHRASE = "Yes, please reorder my metformin. I just picked up 60 pills.";
  let turn = await agentTurn8901(jwt, PHRASE);
  saveTurnArtifact(ARTIFACTS, "turn-attempt-1", turn);
  for (let attempt = 2; attempt <= 3 && !turn.tools_used.includes("log_refill"); attempt++) {
    console.log(`[TRIGGER] attempt ${attempt} (previous tools_used=${JSON.stringify(turn.tools_used)})`);
    turn = await agentTurn8901(jwt, PHRASE);
    saveTurnArtifact(ARTIFACTS, `turn-attempt-${attempt}`, turn);
  }
  expect(turn.http, "agent/turn HTTP status").toBe(200);
  expect(turn.tools_used, "expected log_refill routed").toContain("log_refill");
  const action = turn.actions.find(a => a.tool === "log_refill");
  expect(action, "committed log_refill action present").toBeTruthy();
  expect(action!.entity_type, "entity_type").toBe("refill_request");
  expect(action!.entity_id, "entity_id == med uuid (so the med card resolves)").toBe(medId);
  expect(action!.changed_fields?.pills_remaining, "changed_fields.pills_remaining present").toBeTruthy();
  expect(action!.refill_id, "refill_id (refills row id) carried for verification").toBeTruthy();
  const committedCount = action!.changed_fields!.pills_remaining.after;
  console.log(`[TURN] action=${JSON.stringify(action)}`);

  // ── 3 RE-CHECK (independent Supabase re-read — never trust the turn) ───────
  const rows = await recheckDb(supa, "refills", { medication_id: medId });
  const row = expectRow(rows, { medication_id: medId, elder_id: creds.userId });
  expect(row.pills_remaining, "DB pills_remaining matches the committed action").toBe(committedCount);
  console.log(`[REREAD] refills row: ${JSON.stringify(row)}`);

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  await signIn(page, creds); // lands on Home (:5173)

  // 4a — WALKTHROUGH (the MOCK acknowledge flow, now AI-AUTO-ADVANCED, 2026-07-28).
  // Start from Home so step 1's nav to Notifications is a real transition.
  // resetPhaseLog first so the log holds only this interaction. Every step is
  // act:click → autonomous → the tour SELF-DRIVES (no user taps) and records
  // paced phases.
  await resetPhaseLog(page);
  await startWalkthrough(page, "notifications_tour");

  // Step 1 spotlights the always-mounted Notifications nav. Mei performs each
  // step's tap herself, but a step never advances on its own — the person taps
  // Next when they're ready, which is what advanceWalkthroughUntil supplies.
  await expect(page.locator(NAV_NOTIF), "step 1 nav target spotlit").toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/walkthrough-step1-tap-notifications.png`, fullPage: true });

  // It travels to Notifications and spotlights the mock low-stock alert row.
  await advanceWalkthroughToStep(page, 2);
  await page.screenshot({ path: `${SHOTS}/walkthrough-step2-refill-row.png`, fullPage: true });

  // Tapping through the rest completes it: the final step's Got it tap
  // acknowledges the alert (host state, no backend write), and the overlay
  // unmounts.
  await finishWalkthrough(page);
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), "tour completes once tapped through").toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(REFILL_ROW), "low-stock alert dismissed by the Got-it tap").toHaveCount(0);

  // Phase-log shape for an autonomous tour: PACED walkthrough phases (the inverse
  // of the old user-driven zero). Three act:click steps (steps 2-3 carry onEnter →
  // a navigate settle), so click + navigate phases are present, each floored.
  const walkLog = await readPhaseLog(page);
  const walkPhases = walkLog.filter(e => e.surface === "walkthrough");
  console.log(`[PHASELOG] walkthrough entries=${JSON.stringify(walkPhases.map(e => `${e.surface}/${e.phase}`))}`);
  expect(walkPhases.length, "autonomous tour records paced walkthrough phases").toBeGreaterThan(0);
  assertPhaseMins(walkLog, [
    { surface: "walkthrough", phase: "click", min: PACING.PRE_CLICK_MS },
    { surface: "walkthrough", phase: "navigate", min: PACING.NAVIGATE_MS },
  ]);

  // 4b — CHANGE HIGHLIGHT (the real reorder result, proven on the UI). First
  // settle the real med list on Prescriptions: the elder shell shows the demo
  // patient until refreshMeds replaces `medications` with the real fetch. Wait
  // until exactly the one real Metformin card remains so the later highlight nav
  // rings a single, deterministic target.
  await page.locator('[data-tour="nav-prescriptions"]').click();
  await expect(page.locator(`[data-testid="medication-${medId}"]`), "real med card").toBeVisible({ timeout: 20_000 });
  // Count the medication CARDS, not the Request-refill button — the card count
  // is the deterministic signal that the real fetch has replaced the demo
  // patient.
  // TWO now: the reorder target plus the medicine seeded to stay low so the
  // tour has something to spotlight. The count is what proves the real fetch
  // has replaced the demo patient.
  await expect(page.locator('[data-testid^="medication-"]'), "med list settled to the two real meds").toHaveCount(2, { timeout: 20_000 });

  // Fire the REAL committed action from the AI tab (never Prescriptions — firing
  // where medication-* testids already render latches the first sync poll onto
  // pre-navigation nodes; see MEMORY.md 2026-07-26). resetPhaseLog to isolate the
  // dwell entry.
  await page.locator('[data-tour="nav-ai"]').click();
  await expect(page.locator(SEND_BTN), "on AI tab before firing highlight").toBeVisible({ timeout: 10_000 });
  await resetPhaseLog(page);
  await page.evaluate(a => (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a), action);

  // ChangeHighlight navigates to Prescriptions and rings the med card
  // (refill_request entity_id == medId → suffix-fallback resolves medication-{medId}).
  const card = page.locator(`[data-testid="medication-${medId}"]`);
  await expect(card, "med card present after highlight nav").toBeVisible({ timeout: 15_000 });
  await expect(card, "med card ringed").toHaveClass(/change-highlight/, { timeout: 10_000 });
  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption, "refill caption visible").toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  const captionText = ((await caption.textContent()) ?? "").trim();
  console.log(`[HIGHLIGHT] caption="${captionText}"`);
  expect(captionText, "caption names the medication").toContain("Metformin");
  expect(captionText, "caption is a refill/supply caption").toMatch(/pill/i);

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  await page.screenshot({ path: `${SHOTS}/highlight-refill-card-ringed.png`, fullPage: true });

  // PACING: the highlight dwell must respect its minimum. Wait for the dwell to
  // record (auto-dismiss at HIGHLIGHT_DWELL_MIN_MS), then assert the floor.
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
  // All timing via PACING (dwell floor) + Playwright wait timeouts; the only raw
  // literal is the 500ms scrollIntoView settle above, with its comment.
});
