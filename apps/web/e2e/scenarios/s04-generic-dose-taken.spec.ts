import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  expectRow, readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import type { ElderCreds, TurnAction, TurnResult } from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s04 generic-dose-taken (NEW-FE) — the NO-NAME generic ask. When the elder says
// "I took my pills" WITHOUT naming a medicine, soul.md routes to log_dose with NO
// medication_name (soul.md §"Logging ONE dose"), and log_dose's _dose_plan decides
// across ALL meds: exactly one plausible dose logs straight away; several plausible
// doses write NOTHING and return the candidates for the agent to relay. This spec
// proves BOTH no-name branches against the REAL hermes on :8901:
//   PATH A (single plausible -> LOGS): one med (Metformin) with one pending dose ->
//     "I took my pills" logs it immediately, no name param needed; committed action
//     entity_type "dose"; the Home card rings "Taken: Metformin".
//   PATH B (multiple plausible -> ASKS): SEPARATE elder, two meds each with a
//     pending dose -> the SAME phrase routes log_dose but writes NOTHING and the
//     reply asks WHICH medication (naming the candidates); both doses stay pending.
// log_dose has no walkthrough — this is a chat -> highlight scenario.
const ARTIFACTS = "e2e/artifacts/s04";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s04"; // durable, NOT wiped

type Supa = ReturnType<typeof anonClient>;

// A fresh throwaway elder + its OWN signed-in supabase-js client, so PATH A and
// PATH B are genuinely independent :8901 sessions (HTTP sessions persist per
// elder_id; a shared client would clobber sessions).
async function newElder(): Promise<{ creds: ElderCreds; supa: Supa; jwt: string }> {
  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { data, error } = await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  expect(error, error?.message).toBeNull();
  return { creds, supa, jwt: data!.session!.access_token };
}

// Insert one daily medication, returning its uuid.
async function seedMed(supa: Supa, elderId: string, name: string, times: string[]): Promise<string> {
  const { data, error } = await supa
    .from("medications")
    .insert({ elder_id: elderId, name, dosage: "500mg", purpose: "daily health",
              schedule: { times, frequency: "daily" } })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  return data!.id as string;
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

// The no-name ask NAMES its candidates: an ask cue ("?" or the literal "which" —
// the tool instructs "Ask the user WHICH medication they took") AND every candidate
// medication named in the reply (soul.md §"Logging ONE dose" relays the tool's
// listing). Requiring the names present is exactly the "names candidates" contract.
function asksWhichMed(reply: string, names: string[]): boolean {
  const r = reply.toLowerCase();
  const isAsk = r.includes("?") || r.includes("which");
  const namesAll = names.every(n => r.includes(n.toLowerCase()));
  return isAsk && namesAll;
}

test("s04 generic-dose-taken: no-name 'I took my pills' LOGS when one dose is plausible; ASKS which when several are", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // Elder tz is Asia/Singapore (config.hermes_tz), so "T08:00+08:00" reads back as
  // local 08:00 — the morning slot the ask labels.
  const sgtDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const MORNING_ISO = `${sgtDate}T08:00:00+08:00`;

  // Elder A — SINGLE-plausible fixture: one med (Metformin) with one pending dose
  // today. "I took my pills" has exactly one dose it could mean -> logs it.
  const A = await newElder();
  const medAId = await seedMed(A.supa, A.creds.userId, "Metformin", ["08:00"]);
  const doseAId = await seedPendingDose(A.supa, medAId, A.creds.userId, MORNING_ISO);
  console.log(`[FIXTURE A] elder=${A.creds.userId} med=${medAId} pending=${doseAId}`);

  // Elder B — MULTIPLE-plausible fixture: two meds, each with a pending dose today.
  // Separate elder + session so PATH A's write can't bleed in. "I took my pills" is
  // genuinely ambiguous across the two -> the tool asks, writes nothing.
  const B = await newElder();
  const medB1Id = await seedMed(B.supa, B.creds.userId, "Metformin", ["08:00"]);
  const medB2Id = await seedMed(B.supa, B.creds.userId, "Lisinopril", ["08:00"]);
  const doseB1Id = await seedPendingDose(B.supa, medB1Id, B.creds.userId, MORNING_ISO);
  const doseB2Id = await seedPendingDose(B.supa, medB2Id, B.creds.userId, MORNING_ISO);
  console.log(`[FIXTURE B] elder=${B.creds.userId} metformin=${medB1Id}/${doseB1Id} lisinopril=${medB2Id}/${doseB2Id}`);

  // ── 2 TRIGGER — real turns against hermes on :8901 ──────────────────────────
  const PHRASE = "I took my pills"; // no medicine named — the generic ask

  // PATH A (SINGLE -> LOGS). ≤3 recorded attempts for LLM-routing variance;
  // accepted on the first that commits a log_dose. A non-committing attempt leaves
  // the pending dose intact, so a retry can still log it.
  let aTurn: TurnResult | undefined;
  let aAction: TurnAction | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t = await agentTurn8901(A.jwt, PHRASE);
    saveTurnArtifact(ARTIFACTS, `pathA-attempt-${attempt}`, t);
    const act = t.actions.find(x => x.tool === "log_dose");
    console.log(`[PATH A] attempt ${attempt}: tools=${JSON.stringify(t.tools_used)} committed=${!!act} reply=${JSON.stringify(t.reply.slice(0, 140))}`);
    if (t.http === 200 && act) { aTurn = t; aAction = act; break; }
  }
  expect(aTurn, "PATH A committed a log_dose with NO name given (≤3 attempts)").toBeTruthy();
  expect(aTurn!.tools_used, "PATH A routed to log_dose").toContain("log_dose");
  expect(aAction!.entity_type, "PATH A action.entity_type").toBe("dose");
  expect(aAction!.entity_id, "PATH A action.entity_id == Metformin uuid (Home card resolves)").toBe(medAId);
  expect(aAction!.dose_id, "PATH A flipped the single seeded pending row").toBe(doseAId);
  expect(aAction!.changed_fields?.status, "PATH A status pending -> taken").toEqual({ before: "pending", after: "taken" });

  // PATH B (MULTIPLE -> ASKS). Accepted only when the WHOLE ask contract holds:
  // log_dose routed, NOTHING committed, and the reply asks which medication (naming
  // the candidates). Nothing is consumed, so retries are safe.
  let bTurn: TurnResult | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t = await agentTurn8901(B.jwt, PHRASE);
    saveTurnArtifact(ARTIFACTS, `pathB-attempt-${attempt}`, t);
    const asks = asksWhichMed(t.reply, ["Metformin", "Lisinopril"]);
    console.log(`[PATH B] attempt ${attempt}: tools=${JSON.stringify(t.tools_used)} actions=${t.actions.length} asks=${asks} reply=${JSON.stringify(t.reply.slice(0, 200))}`);
    if (t.http === 200 && t.tools_used.includes("log_dose") && t.actions.length === 0 && asks) { bTurn = t; break; }
  }
  expect(bTurn, "PATH B routed log_dose, committed nothing, and asked which medication naming candidates (≤3 attempts)").toBeTruthy();
  expect(bTurn!.http, "PATH B HTTP status").toBe(200);
  expect(bTurn!.tools_used, "PATH B routed to log_dose (backend-driven disambiguation)").toContain("log_dose");
  expect(bTurn!.actions, "PATH B committed NOTHING — the ask path writes nothing").toHaveLength(0);
  expect(asksWhichMed(bTurn!.reply, ["Metformin", "Lisinopril"]), "PATH B reply asks WHICH medication, naming both candidates").toBe(true);

  // ── 3 RE-CHECK — authoritative independent Supabase re-reads (DB is truth) ───
  // PATH A: the single seeded dose is now taken (UPDATEd in place — still 1 row).
  const aFinal = await recheckDb(A.supa, "doses", { elder_id: A.creds.userId, medication_id: medAId });
  expect(aFinal, "PATH A: exactly the one seeded dose (flipped, none inserted)").toHaveLength(1);
  expectRow(aFinal, { id: doseAId, status: "taken" });
  // PATH B: the ask wrote nothing — both seeded doses are STILL pending, no inserts.
  const bFinal = await recheckDb(B.supa, "doses", { elder_id: B.creds.userId });
  expect(bFinal, "PATH B: still exactly the two seeded doses (nothing written)").toHaveLength(2);
  expect(bFinal.every(r => r.status === "pending"), "PATH B: BOTH doses still pending").toBe(true);
  expectRow(bFinal, { id: doseB1Id, status: "pending" });
  expectRow(bFinal, { id: doseB2Id, status: "pending" });

  // ── 4 UI + PACING ───────────────────────────────────────────────────────────
  // 4a — CHANGE HIGHLIGHT (Path A elder). Fire Path A's REAL committed action from
  // the AI tab — a tab with NO medication-* cards — so the first poll can't latch
  // onto pre-navigation nodes (MEMORY.md 2026-07-26); production fires from here
  // too. ChangeHighlight navigates AI -> Home and rings the Metformin card (the
  // dose entity resolves to medication-{id} via the testid suffix fallback).
  await signIn(page, A.creds); // baseURL :5173, lands on Home
  await page.locator('[data-tour="nav-ai"]').click();
  await expect(page.locator('[data-testid^="medication-"]'), "AI tab shows no med cards").toHaveCount(0);
  await resetPhaseLog(page); // isolate the highlight dwell entry
  await page.evaluate(
    a => (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a),
    aAction as unknown as Record<string, unknown>,
  );

  const card = page.locator(`[data-testid="medication-${medAId}"]`);
  await expect(card, "Home med card present after highlight nav").toBeVisible({ timeout: 15_000 });
  await expect(card, "Home med card ringed").toHaveClass(/change-highlight/, { timeout: 10_000 });
  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption, "highlight caption visible").toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  const captionText = ((await caption.textContent()) ?? "").replace(/\s+/g, " ").trim();
  console.log(`[HIGHLIGHT] caption="${captionText}"`);
  expect(captionText, "caption reads exactly 'Taken: Metformin'").toBe("Taken: Metformin");
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

  // 4b — ASK-STATE CHAT (Path B elder). Switch users: clear Path A's session, then
  // render Path B's GENUINE :8901 ask (bTurn.reply, already asserted above) inside
  // the REAL chat. The browser chat calls VITE_HERMES_URL (the demo backend), NOT
  // :8901 — so fulfil /agent/turn/stream with that real reply, making the ask-state
  // screenshot deterministic. The AUTHORITATIVE ask proof is section 2 (:8901).
  await page.evaluate(() => window.localStorage.clear());
  await page.context().clearCookies();
  const askReply = bTurn!.reply;
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

  await signIn(page, B.creds);
  await page.locator('[data-tour="nav-ai"]').click();
  const sendBtn = page.locator('[data-walk="elder-ai-send-button"]');
  await expect(sendBtn, "on the AI (Ask Mei) tab").toBeVisible({ timeout: 15_000 });
  await page.locator("textarea").first().fill(PHRASE);
  await sendBtn.click();
  // Mei's ask names the candidates (asserted above) — wait for a candidate to render.
  await expect(page.getByText("Metformin").last(), "chat renders the disambiguation ask naming a candidate").toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/ask-state-chat.png`, fullPage: true });

  // ── 5 SCREENSHOT ────────────────────────────────────────────────────────────
  // Durable evidence saved inline above: home-card-ringed.png (Path A highlight)
  // and ask-state-chat.png (Path B ask), both under e2e/design-shots/scenarios/s04.

  // ── 6 NO scenario-local ms literals ─────────────────────────────────────────
  // All experience timing flows through PACING (the dwell floor); other numeric
  // values are Playwright deadlines. The only bare literal is the 500ms
  // scrollIntoView settle above, with its required comment.
});
