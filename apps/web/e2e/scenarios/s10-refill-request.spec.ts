import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  expectRow, readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s10 refill-request (AUDIT) — the user-driven `request_refill` walkthrough
// (waitFor steps, no acts; consent-class → Next must NOT render) plus the real
// `log_refill` tail. Owns: this spec + steps/request_refill.ts.
const ARTIFACTS = "e2e/artifacts/s10";           // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s10";  // durable, NOT wiped

// Documented per-step selectors + instruction copy for request_refill.ts.
const REFILL_BTN = '[data-walk="med-request-refill-btn"]';
const SEND_BTN = '[data-walk="elder-ai-send-button"]';
const STEP1_TEXT = "Tap Request refill on the medicine";       // walk.refill.tapRequest
const STEP2_TEXT = "Mei's already written the message";        // walk.refill.sendMessage
const STEP3_TEXT = "Mei's noting the refill down now";         // walk.refill.confirmed

// The consent-class invariant: a waitFor step is NEVER paced, so the callout
// shows Exit but MUST NOT render a Next button (Walkthrough.tsx gates the whole
// Next/Replay block on `autonomous`, which is false for waitFor steps). Assert
// the callout IS present (Exit visible) so the absence of Next is meaningful.
async function assertWaitForStep(page: Page, bodyText: string, label: string) {
  await expect(page.getByText(bodyText, { exact: false }), `${label}: callout body`).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), `${label}: Exit present`).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true }), `${label}: NO Next button (consent-class)`).toHaveCount(0);
}

test("s10 refill-request: 'I just picked up my metformin refill, 30 pills' -> log_refill + user-driven walkthrough (no Next)", async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
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

  // ── 2 TRIGGER (real refill tail) ──────────────────────────────────────────
  // Verbatim realistic phrase; ≤3 recorded attempts for LLM-routing variance.
  const PHRASE = "I just picked up my metformin refill, 30 pills";
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
  expect(action!.changed_fields!.pills_remaining.after, "pills_remaining.after").toBe(30);
  expect(action!.refill_id, "refill_id (refills row id) carried for verification").toBeTruthy();
  console.log(`[TURN] action=${JSON.stringify(action)}`);

  // ── 3 RE-CHECK (independent Supabase re-read) ─────────────────────────────
  const rows = await recheckDb(supa, "refills", { medication_id: medId });
  expectRow(rows, { pills_remaining: 30, medication_id: medId, elder_id: creds.userId });
  console.log(`[REREAD] refills row: ${JSON.stringify(rows)}`);

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  await signIn(page, creds); // lands on Home (:5173)

  // Settle the real med list first: the elder shell renders the demo patient
  // (several seed meds) until refreshMeds replaces `medications` with the real
  // fetch. Land on Prescriptions and wait until exactly the one real Metformin
  // card remains, so the walkthrough spotlights a single, deterministic target.
  await page.locator('[data-tour="nav-prescriptions"]').click();
  await expect(page.locator(`[data-testid="medication-${medId}"]`), "real med card").toBeVisible({ timeout: 20_000 });
  await expect(page.locator(REFILL_BTN), "med list settled to the one real med").toHaveCount(1, { timeout: 20_000 });

  // 4a — WALKTHROUGH (user-driven). Start it from the AI tab — Mei's real trigger
  // point — so step 1's onEnter is exercised: it must switch to Prescriptions on
  // its own (the fix; without onEnter the prescriptions-only target never mounts
  // from chat and the step can't advance). resetPhaseLog first so the log holds
  // only this interaction. These are waitFor steps → NO PaceController → the
  // walkthrough records NO navigate/field/click phases (asserted below).
  await page.locator('[data-tour="nav-ai"]').click();
  await expect(page.locator(SEND_BTN), "on AI tab (walkthrough trigger point)").toBeVisible({ timeout: 10_000 });
  await resetPhaseLog(page);
  await page.evaluate(() =>
    (window as unknown as { __dwStartWalkthrough: (t: string, p?: Record<string, string>) => void })
      .__dwStartWalkthrough("request_refill", {}));

  // Step 1: onEnter switched to Prescriptions and the spotlight is on the single
  // Request-refill button; Next absent.
  await expect(page.locator(REFILL_BTN), "step 1 onEnter navigated to Prescriptions").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, STEP1_TEXT, "step 1 tap-request");
  await page.screenshot({ path: `${SHOTS}/walkthrough-step1-tap-request.png`, fullPage: true });
  // Real user action: tap Request refill → opens Ask Mei with a pre-filled message.
  await page.locator(REFILL_BTN).click();

  // Step 2: spotlight on the AI Send button, Next absent.
  await expect(page.locator(SEND_BTN), "step 2 target visible").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, STEP2_TEXT, "step 2 send-message");
  // The elder types the real refill count and taps Send themselves (Mei never
  // sends on their behalf). The DOM click advances step 2 regardless of the turn;
  // the turn's committed log_refill is what step 3 waits on.
  const composer = page.locator("textarea").first();
  await composer.fill(PHRASE);
  await page.locator(SEND_BTN).click();

  // Step 3: spotlight still on Send, body switches to "confirmed", Next absent.
  await assertWaitForStep(page, STEP3_TEXT, "step 3 confirmed");

  // Best-effort: step 3 auto-completes when the UI turn commits log_refill
  // (agent-action-committed bus event). LLM/backend variance → soft; the real
  // log_refill proof is section 2 (authoritative, against :8901).
  const exitBtn = page.getByRole("button", { name: "Exit walkthrough" });
  const completed = await exitBtn.waitFor({ state: "detached", timeout: 25_000 }).then(() => true).catch(() => false);
  console.log(`[WALKTHROUGH] step 3 auto-completed via committed log_refill: ${completed}`);
  if (!completed) await exitBtn.click(); // dismiss so the overlay can't mask the highlight

  // Phase-log shape for a user-driven walkthrough: honestly, ZERO walkthrough
  // phases (waitFor steps never instantiate a PaceController), so there are no
  // field/click/act phases — the expected shape.
  const walkLog = await readPhaseLog(page);
  const walkPhases = walkLog.filter(e => e.surface === "walkthrough");
  console.log(`[PHASELOG] walkthrough entries=${JSON.stringify(walkPhases.map(e => `${e.surface}/${e.phase}`))}`);
  expect(walkPhases.filter(e => ["field", "click", "act", "between-fields"].includes(e.phase)),
    "user-driven steps record NO paced field/click phases").toHaveLength(0);

  // 4b — CHANGE HIGHLIGHT. Fire the REAL committed action from the AI tab (never
  // Prescriptions — firing where medication-* testids already render latches the
  // first sync poll onto pre-navigation nodes; see MEMORY.md 2026-07-26).
  await page.locator('[data-tour="nav-ai"]').click();
  await expect(page.locator(SEND_BTN), "on AI tab before firing highlight").toBeVisible({ timeout: 10_000 });
  await resetPhaseLog(page); // isolate the dwell entry
  await page.evaluate(a => (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a), action);

  // ChangeHighlight navigates to Prescriptions and rings the med card (refill_request
  // entity_id == medId → suffix-fallback resolves medication-{medId}).
  const card = page.locator(`[data-testid="medication-${medId}"]`);
  await expect(card, "med card present after highlight nav").toBeVisible({ timeout: 15_000 });
  await expect(card, "med card ringed").toHaveClass(/change-highlight/, { timeout: 10_000 });
  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption, "refill caption visible").toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  const captionText = ((await caption.textContent()) ?? "").trim();
  console.log(`[HIGHLIGHT] caption="${captionText}"`);
  expect(captionText, "caption names the medication").toContain("Metformin");
  expect(captionText, "caption is a refill/supply caption").toMatch(/pill|30/i);

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
