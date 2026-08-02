import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  expectRow, readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import type { ElderCreds, TurnAction, TurnResult } from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s03 named-dose-taken (FIXED-P1) — THE headline fix: log_dose(medication_name?,
// slot?) now runs its _dose_plan selection engine, so a NAMED dose with more than
// one pending slot is ASKED about (nothing written) instead of silently ticking
// the wrong (latest) row, while a single plausible dose still logs immediately.
// This spec proves BOTH paths against the REAL fixed hermes on :8901:
//   PATH A (ask-when-ambiguous): two pending Metformin doses (08:00 + 20:00), no
//     slot -> reply ASKS which, log_dose routed, actions EMPTY, both still pending;
//     then "the morning one" flips EXACTLY the 08:00 row (independent re-read).
//   PATH B (proceed-when-unambiguous): one pending dose -> logs immediately, no ask.
// UI: the real chat renders the ask-state; Path A turn-2's committed action rings
// the Home medication card "Taken: Metformin". log_dose has no walkthrough.
const ARTIFACTS = "e2e/artifacts/s03";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s03"; // durable, NOT wiped

type Supa = ReturnType<typeof anonClient>;

// A fresh throwaway elder + its OWN signed-in supabase-js client (so PATH A and
// PATH B are genuinely independent :8901 sessions — HTTP sessions persist per
// elder_id, and a shared client would clobber sessions).
async function newElder(): Promise<{ creds: ElderCreds; supa: Supa; jwt: string }> {
  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { data, error } = await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  expect(error, error?.message).toBeNull();
  return { creds, supa, jwt: data!.session!.access_token };
}

// Insert one PENDING dose for `medId` at `iso`, returning its row id.
async function seedPendingDose(supa: Supa, medId: string, elderId: string, iso: string): Promise<string> {
  const { data, error } = await supa
    .from("doses")
    .insert({ medication_id: medId, elder_id: elderId, scheduled_at: iso, status: "pending" })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  return data!.id as string;
}

// Did Mei ASK which dose (rather than log one)? A genuine disambiguation question:
// a question mark PLUS either the literal "which" (the tool instructs "Ask the
// user WHICH one they took") or both dose cues named (morning/8am AND evening/8pm).
function asksWhichDose(reply: string): boolean {
  const r = reply.toLowerCase();
  if (!r.includes("?")) return false;
  if (r.includes("which")) return true;
  const morning = /\bmorning\b|8(?::00)?\s*(?:a\.?m\.?|am)/.test(r);
  const evening = /\bevening\b|\bnight\b|8(?::00)?\s*(?:p\.?m\.?|pm)|20:00/.test(r);
  return morning && evening;
}

test("s03 named-dose-taken: ambiguous 'I just took my metformin' ASKS which dose; a single pending dose logs immediately", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // Elder tz is Asia/Singapore (config.hermes_tz), so scheduled_at "T08:00+08:00"
  // reads back as local 08:00 and "T20:00+08:00" as local 20:00 — the two slots
  // _dose_plan lists, and "the morning one" (day-part anchor 08:00) resolves to
  // the 08:00 row.
  const sgtDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const MORNING_ISO = `${sgtDate}T08:00:00+08:00`;
  const EVENING_ISO = `${sgtDate}T20:00:00+08:00`;

  // Elder A — the AMBIGUOUS fixture: Metformin scheduled twice daily with a
  // PENDING dose row for EACH slot today.
  //
  // A FACTORY, because PATH A is a two-turn dialogue and its retry has to
  // re-run the WHOLE pair. Hermes keeps conversation state per elder_id and
  // replays it as history, so retrying only turn 2 on the same elder makes the
  // model read its own previous answer back ("I've already logged that") and
  // fail identically every time — the effective attempt count was 1, not 3.
  // Resetting between turns is not an option either: "the morning one" is
  // meaningless without turn 1's question in context.
  const makeAmbiguousElder = async () => {
    const A = await newElder();
    const { data: medA, error: mAErr } = await A.supa
      .from("medications")
      .insert({ elder_id: A.creds.userId, name: "Metformin", dosage: "500mg", purpose: "blood sugar",
                schedule: { times: ["08:00", "20:00"], frequency: "daily" } })
      .select("id")
      .single();
    expect(mAErr, mAErr?.message).toBeNull();
    const medAId: string = medA!.id;
    const morning = await seedPendingDose(A.supa, medAId, A.creds.userId, MORNING_ISO);
    const evening = await seedPendingDose(A.supa, medAId, A.creds.userId, EVENING_ISO);
    console.log(`[FIXTURE A] elder=${A.creds.userId} med=${medAId} morning=${morning} evening=${evening}`);
    return { A, medAId, doseMorningId: morning, doseEveningId: evening };
  };

  let { A, medAId, doseMorningId, doseEveningId } = await makeAmbiguousElder();

  // Elder B — the UNAMBIGUOUS fixture: Metformin scheduled once with a single
  // PENDING dose today. Separate elder + session so PATH A's pending state can't
  // bleed in.
  const B = await newElder();
  const { data: medB, error: mBErr } = await B.supa
    .from("medications")
    .insert({ elder_id: B.creds.userId, name: "Metformin", dosage: "500mg", purpose: "blood sugar",
              schedule: { times: ["08:00"], frequency: "daily" } })
    .select("id")
    .single();
  expect(mBErr, mBErr?.message).toBeNull();
  const medBId: string = medB!.id;
  const doseBId = await seedPendingDose(B.supa, medBId, B.creds.userId, MORNING_ISO);
  console.log(`[FIXTURE B] elder=${B.creds.userId} med=${medBId} pending=${doseBId}`);

  // ── 2 TRIGGER — real turns against the FIXED hermes on :8901 ────────────────
  // PATH A · turn 1 (ASK-WHEN-AMBIGUOUS). ≤3 recorded attempts for LLM-routing
  // variance; an attempt is accepted only when it exercises the whole ask
  // contract: log_dose routed, NOTHING committed, and the reply asks which dose.
  const PHRASE_TAKEN = "I just took my metformin";
  let a1: TurnResult | undefined;
  let a2: TurnResult | undefined;
  let a2Action: TurnAction | undefined;
  let afterAsk: Record<string, unknown>[] = [];

  // Retry the WHOLE PAIR on a FRESH elder. Turn 2 only makes sense as a reply to
  // turn 1's question, so the retry unit is the dialogue, not a single turn —
  // and a fresh elder is what makes each attempt an independent sample instead
  // of the model re-reading its own earlier answer out of session history.
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) ({ A, medAId, doseMorningId, doseEveningId } = await makeAmbiguousElder());

    const t1 = await agentTurn8901(A.jwt, PHRASE_TAKEN);
    saveTurnArtifact(ARTIFACTS, `pathA-turn1-attempt-${attempt}`, t1);
    const asked = t1.http === 200 && t1.tools_used.includes("log_dose") && t1.actions.length === 0 && asksWhichDose(t1.reply);
    console.log(`[PATH A t1] attempt ${attempt}: tools=${JSON.stringify(t1.tools_used)} actions=${t1.actions.length} asks=${asksWhichDose(t1.reply)} reply=${JSON.stringify(t1.reply.slice(0, 160))}`);
    if (!asked) continue;

    // Independent DB re-read AFTER the ask (must precede turn 2's write): the
    // ask wrote nothing — still exactly the two seeded rows, BOTH pending.
    const rows = await recheckDb(A.supa, "doses", { elder_id: A.creds.userId, medication_id: medAId });

    const t2 = await agentTurn8901(A.jwt, "the morning one");
    saveTurnArtifact(ARTIFACTS, `pathA-turn2-attempt-${attempt}`, t2);
    const act = t2.actions.find(x => x.tool === "log_dose");
    console.log(`[PATH A t2] attempt ${attempt}: tools=${JSON.stringify(t2.tools_used)} committed=${!!act} dose_id=${act?.dose_id} reply=${JSON.stringify(t2.reply.slice(0, 120))}`);
    // A reply that CLAIMS a dose was logged while committing nothing is a
    // fabricated adherence confirmation — the elder believes it's recorded and
    // the record disagrees. Surfaced loudly; it is not a retry-able hiccup.
    if (!act && /logged|recorded|marked/i.test(t2.reply)) {
      console.error(`[PATH A t2] attempt ${attempt}: Mei CLAIMED a dose was logged but committed nothing — ${JSON.stringify(t2.reply.slice(0, 200))}`);
    }
    if (t2.http === 200 && act) { a1 = t1; afterAsk = rows; a2 = t2; a2Action = act; break; }
  }

  expect(a1, "PATH A turn 1: log_dose routed, nothing committed, reply asked which dose (≤3 whole-dialogue attempts)").toBeTruthy();
  expect(a1!.http, "turn 1 HTTP status").toBe(200);
  expect(a1!.tools_used, "turn 1 routed to log_dose").toContain("log_dose");
  expect(a1!.actions, "turn 1 committed NOTHING — the ask path writes nothing").toHaveLength(0);
  expect(asksWhichDose(a1!.reply), "turn 1 reply asks WHICH dose").toBe(true);

  expect(afterAsk, "ask inserted/flipped nothing — still the two seeded doses").toHaveLength(2);
  expect(afterAsk.every(r => r.status === "pending"), "BOTH doses still pending after the ask").toBe(true);
  expectRow(afterAsk, { id: doseMorningId, status: "pending" });
  expectRow(afterAsk, { id: doseEveningId, status: "pending" });

  expect(a2, "PATH A turn 2 committed a log_dose (≤3 whole-dialogue attempts)").toBeTruthy();
  expect(a2Action!.entity_type, "turn 2 action.entity_type").toBe("dose");
  expect(a2Action!.entity_id, "turn 2 action.entity_id == med uuid (Home card resolves)").toBe(medAId);
  expect(a2Action!.dose_id, "turn 2 flipped the 08:00 row, not the 20:00 one").toBe(doseMorningId);
  expect(a2Action!.changed_fields?.status, "turn 2 status pending -> taken").toEqual({ before: "pending", after: "taken" });

  // PATH B (PROCEED-WHEN-UNAMBIGUOUS) — separate elder, one pending dose: the same
  // phrase must log IMMEDIATELY, no question.
  let b: TurnResult | undefined;
  let bAction: TurnAction | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t = await agentTurn8901(B.jwt, PHRASE_TAKEN);
    saveTurnArtifact(ARTIFACTS, `pathB-attempt-${attempt}`, t);
    const act = t.actions.find(x => x.tool === "log_dose");
    console.log(`[PATH B] attempt ${attempt}: tools=${JSON.stringify(t.tools_used)} committed=${!!act} asks=${asksWhichDose(t.reply)} reply=${JSON.stringify(t.reply.slice(0, 160))}`);
    if (t.http === 200 && act) { b = t; bAction = act; break; }
  }
  expect(b, "PATH B committed a log_dose immediately (≤3 attempts)").toBeTruthy();
  expect(b!.tools_used, "PATH B routed to log_dose").toContain("log_dose");
  expect(asksWhichDose(b!.reply), "PATH B did NOT ask which dose — it proceeded (unambiguous)").toBe(false);
  expect(bAction!.entity_type, "PATH B action.entity_type").toBe("dose");
  expect(bAction!.entity_id, "PATH B action.entity_id == med B uuid").toBe(medBId);
  expect(bAction!.dose_id, "PATH B flipped the single pending row").toBe(doseBId);
  expect(bAction!.changed_fields?.status, "PATH B status pending -> taken").toEqual({ before: "pending", after: "taken" });

  // ── 3 RE-CHECK — authoritative independent Supabase re-reads (the DB is truth) ─
  // PATH A: turn 2 flipped ONLY the 08:00 row; the 20:00 row is untouched, and no
  // new row was inserted (the pending row was UPDATEd in place).
  const aFinal = await recheckDb(A.supa, "doses", { elder_id: A.creds.userId, medication_id: medAId });
  expect(aFinal, "PATH A: still exactly two dose rows (pending flipped, none inserted)").toHaveLength(2);
  expectRow(aFinal, { id: doseMorningId, status: "taken" });
  expectRow(aFinal, { id: doseEveningId, status: "pending" });
  // PATH B: the single seeded dose is now taken.
  const bFinal = await recheckDb(B.supa, "doses", { elder_id: B.creds.userId, medication_id: medBId });
  expect(bFinal, "PATH B: exactly the one seeded dose").toHaveLength(1);
  expectRow(bFinal, { id: doseBId, status: "taken" });

  // ── 4 UI + PACING (Path A elder) ────────────────────────────────────────────
  // 4a — ASK-STATE CHAT. Render the GENUINE :8901 turn-1 ask (a1.reply, already
  // asserted above) inside the REAL chat. The browser's chat calls VITE_HERMES_URL
  // (the demo backend), NOT :8901 — so we fulfil /agent/turn/stream with that real
  // reply, making the ask-state screenshot deterministic and decoupled from the
  // demo backend's state. The AUTHORITATIVE ask proof is section 2 (against :8901).
  const askReply = a1!.reply;
  await page.route("**/agent/turn/stream", async route => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const frame = `data: ${JSON.stringify({ type: "final", reply: askReply, tools_used: ["log_dose"], actions: [], walkthrough: null })}\n\n`;
    return route.fulfill({ status: 200, contentType: "text/event-stream", headers: cors, body: frame });
  });

  await signIn(page, A.creds); // baseURL :5173, lands on Home
  await page.locator('[data-tour="nav-ai"]').click();
  const sendBtn = page.locator('[data-walk="elder-ai-send-button"]');
  await expect(sendBtn, "on the AI (Ask Mei) tab").toBeVisible({ timeout: 15_000 });

  await page.locator("textarea").first().fill(PHRASE_TAKEN);
  await sendBtn.click();
  // Wait for Mei's ask bubble (the real captured reply) to render.
  const snippet = askReply.replace(/\*\*/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  await expect(page.getByText(snippet, { exact: false }).last(), "chat renders the disambiguation ask").toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/ask-state-chat.png`, fullPage: true });

  // 4b — CHANGE HIGHLIGHT. Fire Path A turn-2's REAL committed action. Fire from
  // the AI tab — a tab with NO medication-* cards — so the first sync poll can't
  // latch onto pre-navigation nodes (MEMORY.md 2026-07-26); production fires from
  // here too. ChangeHighlight navigates AI -> Home and rings the med card.
  await expect(page.locator('[data-testid^="medication-"]'), "AI tab shows no med cards").toHaveCount(0);
  await resetPhaseLog(page); // isolate the highlight dwell entry
  await page.evaluate(
    a => (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a),
    a2Action as unknown as Record<string, unknown>,
  );

  // Elder A's Metformin has two dose slots today (08:00 + 20:00), so the Home
  // timeline renders TWO cards sharing data-testid="medication-{medAId}".
  // ChangeHighlight resolves the entity via querySelector (the FIRST match) and
  // rings that one, so target .first() here too.
  const card = page.locator(`[data-testid="medication-${medAId}"]`).first();
  await expect(card, "Home med card present after highlight nav").toBeVisible({ timeout: 15_000 });
  await expect(card, "Home med card ringed").toHaveClass(/change-highlight/, { timeout: 10_000 });
  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption, "highlight caption visible").toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  const captionText = ((await caption.textContent()) ?? "").replace(/\s+/g, " ").trim();
  console.log(`[HIGHLIGHT] caption="${captionText}"`);
  expect(captionText, "caption reads exactly 'Taken: Metformin'").toBe("Taken: Metformin");

  // ── 5 SCREENSHOT ────────────────────────────────────────────────────────────
  await page.screenshot({ path: `${SHOTS}/home-card-ringed.png`, fullPage: true });

  // PACING: the highlight dwells ≥ HIGHLIGHT_DWELL_MIN_MS before auto-dismiss. The
  // dwell entry is recorded at auto-dismiss — wait for it, then assert the floor.
  await page.waitForFunction(
    () => ((window as unknown as { __dwPhaseLog?: { surface: string; phase: string }[] }).__dwPhaseLog ?? [])
      .some(e => e.surface === "highlight" && e.phase === "dwell"),
    null,
    { timeout: 15_000 },
  );
  const log = await readPhaseLog(page);
  assertPhaseMins(log, [{ surface: "highlight", phase: "dwell", min: PACING.HIGHLIGHT_DWELL_MIN_MS }]);

  // ── 6 NO scenario-local ms literals ─────────────────────────────────────────
  // All timing via PACING (dwell floor) + Playwright wait timeouts; the only bare
  // literal is the 500ms scrollIntoView settle above, with its required comment.
});
