import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  expectRow, readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
  startWalkthrough,
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
const ACK_BTN = '[data-walk="notif-ack-btn"]';
const SEND_BTN = '[data-walk="elder-ai-send-button"]';
const REFILL_BTN = '[data-walk="med-request-refill-btn"]';
const STEP1_TEXT = "Tap Notifications";                                    // walk.notificationsTour.step1
const STEP2_TEXT = "Alerts like this appear when a medicine is running low"; // walk.notificationsTour.step2
const STEP3_TEXT = "Tap Got it";                                          // walk.notificationsTour.step3

// The consent-class invariant (identical to s10): a waitFor step is NEVER paced,
// so the callout shows Exit but MUST NOT render a Next button (Walkthrough.tsx
// gates the whole Next/Replay block on `autonomous`, false for every waitFor
// step). Assert the callout IS present (Exit visible) so the absence of Next is
// meaningful, not just an unmounted overlay.
async function assertWaitForStep(page: Page, bodyText: string, label: string) {
  await expect(page.getByText(bodyText, { exact: false }), `${label}: callout body`).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), `${label}: Exit present`).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true }), `${label}: NO Next button (consent-class)`).toHaveCount(0);
}

test("s19 low-stock-reorder: mock low-stock tour (no Next) + real 'reorder my metformin' -> log_refill", async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // Throwaway elder + one Metformin med. The low-stock alert is a static mock so
  // it needs no seeding; the med is the target of the real reorder tail.
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
  console.log(`[SEED] elder=${creds.userId} med=${medId}`);

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

  // 4a — WALKTHROUGH (the MOCK acknowledge flow, user-driven). Start from Home so
  // step 1's "Tap Notifications" is a real transition. resetPhaseLog first so the
  // log holds only this interaction. These are waitFor steps → NO PaceController →
  // the tour records NO phases at all (asserted below).
  await resetPhaseLog(page);
  await startWalkthrough(page, "notifications_tour");

  // Step 1: spotlight the always-mounted Notifications nav; Next absent. The
  // person taps it themselves to travel to the alert.
  await expect(page.locator(NAV_NOTIF), "step 1 nav target").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, STEP1_TEXT, "step 1 go-to-notifications");
  await page.screenshot({ path: `${SHOTS}/walkthrough-step1-tap-notifications.png`, fullPage: true });
  await page.locator(NAV_NOTIF).click();

  // Step 2: spotlight the mock low-stock ROW; Next absent. The person taps the
  // alert to read it — a NON-button descendant (the title <p>), so it does NOT
  // hit the Got it button (that would dismiss the card early and unmount step 3).
  await expect(page.locator(REFILL_ROW), "step 2 mock alert row").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, STEP2_TEXT, "step 2 refill-row");
  await page.screenshot({ path: `${SHOTS}/walkthrough-step2-refill-row.png`, fullPage: true });
  await page.locator(`${REFILL_ROW} p`).first().click();

  // Step 3: spotlight the Got it button; Next absent. Tapping it dismisses the
  // mock card AND completes the tour (last step).
  await expect(page.locator(ACK_BTN), "step 3 ack button").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, STEP3_TEXT, "step 3 ack");
  await page.locator(ACK_BTN).click();

  // Tour complete: overlay gone (no Exit) and the mock alert dismissed (the ack
  // is purely local — no backend, as this is a MOCK notification).
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), "walkthrough overlay dismissed").toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(REFILL_ROW), "mock alert dismissed by Got it").toHaveCount(0);

  // Phase-log shape for a user-driven tour: honestly ZERO walkthrough phases —
  // waitFor steps never instantiate a PaceController, so there are no
  // navigate/field/click/act phases to record (same honest shape as s10).
  const walkLog = await readPhaseLog(page);
  const walkPhases = walkLog.filter(e => e.surface === "walkthrough");
  console.log(`[PHASELOG] walkthrough entries=${JSON.stringify(walkPhases.map(e => `${e.surface}/${e.phase}`))}`);
  expect(walkPhases, "user-driven tour records NO paced walkthrough phases").toHaveLength(0);

  // 4b — CHANGE HIGHLIGHT (the real reorder result, proven on the UI). First
  // settle the real med list on Prescriptions: the elder shell shows the demo
  // patient until refreshMeds replaces `medications` with the real fetch. Wait
  // until exactly the one real Metformin card remains so the later highlight nav
  // rings a single, deterministic target.
  await page.locator('[data-tour="nav-prescriptions"]').click();
  await expect(page.locator(`[data-testid="medication-${medId}"]`), "real med card").toBeVisible({ timeout: 20_000 });
  await expect(page.locator(REFILL_BTN), "med list settled to the one real med").toHaveCount(1, { timeout: 20_000 });

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
