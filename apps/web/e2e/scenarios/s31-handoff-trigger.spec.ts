import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, createThrowawayElder,
  expectRow, recheckDb, saveTurnArtifact, signIn,
} from "../helpers";
import type { TurnAction } from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s31 handoff-trigger (TRIGGER, tools: []) — this is TRIGGER-LOGIC, not a
// specific tool's routing correctness (that's s03/s09/etc.): it verifies the
// conversational->screen HANDOFF mechanism itself —
// src/app/lib/agentActions.ts's ACTION_TARGETS + firstRoutableAction, wired in
// ElderlyAIScreen.tsx's send():
//   - on a routable tool_end (live SSE event, matched against ACTION_TARGETS by
//     tool name) it navigates to ACTION_TARGETS[tool].elderly after
//     PACING.NAVIGATE_MS;
//   - a turn that commits NOTHING (empty actions[]) never navigates, because
//     the *fallback* path gates on firstRoutableAction(actions) === null.
//
// ISOLATION NOTE (read before touching the stubs below): a committed action
// that ALSO carries a resolvable entity_type/entity_id (per changeHighlight.ts
// ENTITY_TARGETS) is picked up by ChangeHighlight, which navigates in a
// useEffect the instant `change` is set — i.e. un-paced, no PACING.NAVIGATE_MS
// delay. Every real write tool sets entity_type/entity_id unconditionally
// (services/hermes tools/base.py::record_action has no optional path), so a
// genuine log_dose action racing through the REAL app would have ChangeHighlight
// win the tab-flip almost immediately, making "the handoff navigate happens
// after ~NAVIGATE_MS" unmeasurable/meaningless — that mechanism's OWN pacing
// (HIGHLIGHT_DWELL_MIN_MS) is already asserted by s01/s03/s09/s10. To isolate
// the mechanism THIS scenario owns, the positive-case UI stub relays the REAL
// committed log_dose action minus entity_type/entity_id (AgentAction's fields
// are optional exactly for "a tool mid-migration" per hermes.ts's docstring;
// this deliberately exercises that case) so firstHighlightable(...) is null and
// ChangeHighlight never mounts — leaving ONLY the tool_end-driven ACTION_TARGETS
// timer to drive the observed tab flip.
const ARTIFACTS = "e2e/artifacts/s31";           // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s31";  // durable, NOT wiped

const SEND_BTN = '[data-walk="elder-ai-send-button"]';
const HOME_MARKER = '[data-tour="elder-schedule"]'; // ElderlyHomeScreen-only testid

// Build a `**/agent/turn/stream` SSE body from an ordered list of frame objects
// (mirrors src/app/lib/hermes.ts's AgentTurnEvent contract exactly).
function sseBody(frames: Record<string, unknown>[]): string {
  return frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join("");
}

async function stubStream(page: Page, frames: Record<string, unknown>[]) {
  await page.unroute("**/agent/turn/stream").catch(() => {});
  await page.route("**/agent/turn/stream", async route => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    return route.fulfill({ status: 200, contentType: "text/event-stream", headers: cors, body: sseBody(frames) });
  });
}

test("s31 handoff-trigger: committed action navigates after NAVIGATE_MS; propose-only stays on chat", async ({ page }) => {
  test.setTimeout(240_000);
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
  const nowIso = new Date().toISOString();
  const { data: pend, error: pErr } = await supa
    .from("doses")
    .insert({ medication_id: medId, elder_id: creds.userId, scheduled_at: nowIso, status: "pending" })
    .select("id")
    .single();
  expect(pErr, pErr?.message).toBeNull();
  console.log(`[FIXTURE] elder=${creds.userId} med=${medId} pendingDose=${pend!.id}`);

  // ── 2 TRIGGER ─────────────────────────────────────────────────────────────
  // (a) POSITIVE — a turn that COMMITS a routable action: log_dose.
  const TAKEN_PHRASE = "I just took my metformin";
  let taken = await agentTurn8901(jwt, TAKEN_PHRASE);
  saveTurnArtifact(ARTIFACTS, "positive-attempt-1", taken);
  for (let attempt = 2; attempt <= 3 && !taken.actions.some(a => a.tool === "log_dose"); attempt++) {
    console.log(`[POSITIVE] attempt ${attempt} (previous tools_used=${JSON.stringify(taken.tools_used)})`);
    taken = await agentTurn8901(jwt, TAKEN_PHRASE);
    saveTurnArtifact(ARTIFACTS, `positive-attempt-${attempt}`, taken);
  }
  expect(taken.http, "positive turn HTTP status").toBe(200);
  expect(taken.tools_used, "positive turn routed to log_dose").toContain("log_dose");
  const takenAction = taken.actions.find(a => a.tool === "log_dose") as TurnAction | undefined;
  expect(takenAction, "positive turn committed a log_dose action").toBeTruthy();
  expect(takenAction!.entity_type, "committed entity_type").toBe("dose");
  expect(takenAction!.entity_id, "committed entity_id == med uuid").toBe(medId);
  console.log(`[POSITIVE] committed action=${JSON.stringify(takenAction)}`);

  // (b) NEGATIVE — a turn that only PROPOSES: update_medication_dosage propose
  // (mirrors s09's established propose contract). tools_used includes the tool
  // (it genuinely dispatched — services/hermes tools/medications.py branches on
  // confirmed INSIDE the handler) but actions[] is empty: nothing committed.
  const PROPOSE_PHRASE = "The doctor changed my metformin dose to 1000mg";
  let proposed = await agentTurn8901(jwt, PROPOSE_PHRASE);
  saveTurnArtifact(ARTIFACTS, "negative-attempt-1", proposed);
  for (let attempt = 2; attempt <= 3 && !proposed.tools_used.includes("update_medication_dosage"); attempt++) {
    console.log(`[NEGATIVE] attempt ${attempt} (previous tools_used=${JSON.stringify(proposed.tools_used)})`);
    proposed = await agentTurn8901(jwt, PROPOSE_PHRASE);
    saveTurnArtifact(ARTIFACTS, `negative-attempt-${attempt}`, proposed);
  }
  expect(proposed.http, "negative turn HTTP status").toBe(200);
  expect(proposed.tools_used, "negative turn routed to update_medication_dosage").toContain("update_medication_dosage");
  expect(
    proposed.actions.find(a => a.tool === "update_medication_dosage"),
    "propose commits NOTHING — actions[] has no update_medication_dosage entry",
  ).toBeFalsy();
  console.log(`[NEGATIVE] tools_used=${JSON.stringify(proposed.tools_used)} actions=${JSON.stringify(proposed.actions)}`);

  // ── 3 RE-CHECK ────────────────────────────────────────────────────────────
  // (a) positive: the dose really flipped to taken (independent re-read).
  const doseRows = await recheckDb(supa, "doses", { elder_id: creds.userId, medication_id: medId });
  expectRow(doseRows, { status: "taken" });
  // (b) negative: the medication's dosage is UNCHANGED — the propose wrote nothing.
  expectRow(await recheckDb(supa, "medications", { id: medId }), { dosage: "500mg" });

  // ── 4 UI + PACING — the actual trigger-logic matrix ─────────────────────────
  await signIn(page, creds); // baseURL :5173, lands on Home
  await page.locator('[data-tour="nav-ai"]').click();
  const sendBtn = page.locator(SEND_BTN);
  await expect(sendBtn, "on the AI (Ask Mei) tab").toBeVisible({ timeout: 15_000 });

  // 4a — POSITIVE MATRIX CELL: committed action -> navigates AI -> Home, timed.
  // Stub relays the REAL captured tool_start/tool_end + reply/tools_used, but
  // (per the ISOLATION NOTE above) the final action omits entity_type/entity_id
  // so ChangeHighlight cannot also fire and race the measurement.
  await stubStream(page, [
    { type: "tool_start", tool: "log_dose" },
    { type: "tool_end", tool: "log_dose", is_error: false },
    {
      type: "final",
      reply: taken.reply,
      tools_used: taken.tools_used,
      actions: [{ tool: "log_dose", summary: takenAction!.summary, changed_fields: takenAction!.changed_fields }],
      walkthrough: null,
    },
  ]);
  await expect(page.locator(HOME_MARKER), "not on Home before the trigger").toHaveCount(0);
  const composer = page.locator("textarea").first();
  await composer.fill(TAKEN_PHRASE);
  const t0 = await page.evaluate(() => performance.now());
  await sendBtn.click();
  // waitForSelector (not expect().toBeVisible()) so its resolution instant IS
  // the measurement point — resolves the moment Playwright's poll sees it.
  await page.waitForSelector(HOME_MARKER, { state: "visible", timeout: 15_000 });
  const t1 = await page.evaluate(() => performance.now());
  const navigateDelayMs = t1 - t0;
  console.log(`[MEASURED] AI-send -> Home marker visible: ${navigateDelayMs.toFixed(1)}ms (PACING.NAVIGATE_MS=${PACING.NAVIGATE_MS})`);
  // Lower bound: t0 is captured BEFORE the click (before dispatch/route-handling
  // latency even begins), and the app's own timer only starts once its tool_end
  // handler runs — so a real ~NAVIGATE_MS-paced flip is NEVER measured under
  // PACING.NAVIGATE_MS here; no slack needed on this side.
  expect(navigateDelayMs, `navigated to Home >= PACING.NAVIGATE_MS (${PACING.NAVIGATE_MS}ms)`).toBeGreaterThanOrEqual(PACING.NAVIGATE_MS);
  // Generous upper bound (PACING-derived multiplier, precedent: s17/s21) — this
  // is a floor-respecting handoff, not a many-seconds-later fluke.
  expect(navigateDelayMs, "navigated reasonably close to NAVIGATE_MS, not much later").toBeLessThan(PACING.NAVIGATE_MS * 6);

  await page.screenshot({ path: `${SHOTS}/positive-landed-on-home.png`, fullPage: true });

  // 4b — NEGATIVE MATRIX CELL: propose-only -> stays on the chat tab.
  // Faithful replay: services/hermes agent/loop.py::_dispatch_tool emits
  // tool_start/tool_end (is_error=false) for EVERY tool dispatch, propose or
  // confirm alike (tools_used already proves update_medication_dosage really
  // ran) — so the honest stub relays that same tool_start/tool_end pair, with
  // the final frame's actions[] genuinely empty (the real captured propose
  // turn). This exercises the negative case exactly as it occurs for real,
  // rather than only the easy "no tool called at all" case.
  await page.locator('[data-tour="nav-ai"]').click();
  await expect(sendBtn, "back on the AI tab for the negative case").toBeVisible({ timeout: 15_000 });
  await stubStream(page, [
    { type: "tool_start", tool: "update_medication_dosage" },
    { type: "tool_end", tool: "update_medication_dosage", is_error: false },
    { type: "final", reply: proposed.reply, tools_used: proposed.tools_used, actions: [], walkthrough: null },
  ]);
  await composer.fill(PROPOSE_PHRASE);
  await sendBtn.click();
  await expect(page.getByText(proposed.reply.replace(/\*\*/g, "").slice(0, 40), { exact: false }).last(),
    "the propose reply rendered in chat").toBeVisible({ timeout: 15_000 });

  // Wait THROUGH the window a scheduled ACTION_TARGETS timer would fire in
  // (twice over, for margin). Soft assertions: even if a handoff DOES fire
  // (see finding below), the run continues so the screenshot below captures
  // the true landed state as evidence, rather than aborting mid-proof.
  await page.waitForTimeout(PACING.NAVIGATE_MS);
  expect.soft(await sendBtn.isVisible(), "still on chat after 1x NAVIGATE_MS — no handoff on propose-only").toBe(true);
  expect.soft(await page.locator(HOME_MARKER).count(), "Home never mounted after 1x NAVIGATE_MS").toBe(0);
  await page.waitForTimeout(PACING.NAVIGATE_MS);
  expect.soft(await sendBtn.isVisible(), "still on chat after 2x NAVIGATE_MS — no delayed handoff either").toBe(true);
  expect.soft(await page.locator(HOME_MARKER).count(), "Home never mounted after 2x NAVIGATE_MS").toBe(0);
  if (!(await sendBtn.isVisible())) {
    // FINDING: send() (ElderlyAIScreen.tsx) navigates on ANY routable tool_end
    // SSE event (matched purely by tool name against ACTION_TARGETS + !is_error)
    // regardless of whether the call actually committed. services/hermes's
    // _dispatch_tool (agent/loop.py) emits tool_start/tool_end for EVERY tool
    // dispatch, propose or confirm alike — so a propose-only
    // update_medication_dosage call ALSO fires this live navigate, unlike the
    // (correctly actions[]-gated) `if (!navigated) { firstRoutableAction(...) }`
    // fallback a few lines below it, which never runs once the live path has
    // already set navigated=true. Read-only per this scenario's file boundary
    // (ElderlyAIScreen.tsx) — reported, not patched, here.
    console.error("[FINDING] propose-only update_medication_dosage navigated away from chat (live tool_end path is not commit-gated) — see comment above.");
  }

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  // Named for what it actually documents (see FINDING above if a handoff fired).
  await page.screenshot({ path: `${SHOTS}/negative-propose-outcome.png`, fullPage: true });

  // ── 6 NO scenario-local ms literals ───────────────────────────────────────
  // All timing via PACING.NAVIGATE_MS (bare, or *N multiplier — precedent:
  // s17/s21); no scroll-settle wait was needed (no smooth scrollIntoView is
  // involved in this trigger-logic scenario), so even the one usually-allowed
  // literal is absent here.
});
