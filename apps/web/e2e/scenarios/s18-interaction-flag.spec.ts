import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, createThrowawayElder, expectRow, readPhaseLog,
  recheckAccessibility, recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s18 interaction-flag (TRIGGER) — a proactive "is this safe with what I'm on?"
// what-if. RECORDED DECISION (docs/change-highlight-gap-analysis + scenario
// catalog): a proactive interaction check stays CONVERSATIONAL — the read-only,
// OpenFDA-grounded check_drug_interactions tool answers in chat and persists
// NOTHING (no committed_action, no highlight, no navigation, no interaction
// table exists by design). This scenario PROVES that decision holds: the whole
// point is the no-write re-check (empty actions + unchanged DB).
const ARTIFACTS = "e2e/artifacts/s18";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s18"; // durable, NOT wiped

// The trigger is verbatim what an elder would say. Warfarin (a classic NSAID
// interaction target) is the seeded current med, so "with what I'm already on"
// has a real regimen to check ibuprofen against.
const PHRASE = "Is it safe to take ibuprofen with what I'm already on?";
// A grounded caution points to the doctor/pharmacist or names the interaction —
// robust across all three OpenFDA outcomes (label flags warfarin / label is
// silent but "not a full clearance" / OpenFDA unreachable). NEVER a diagnosis.
const CAUTION_RE = /doctor|pharmacist|interact|caution|careful|clearance|check with|to be safe|bleed|blood[- ]?thinner|anticoagulant/i;
// …and it is grounded in the drugs actually asked about (ibuprofen is always
// echoed; warfarin when the label flags it).
const GROUNDING_RE = /ibuprofen|nurofen|brufen|warfarin/i;

test("s18 interaction-flag: 'Is it safe to take ibuprofen with what I'm already on?' -> conversational grounded caution, NOTHING persisted", async ({ page }) => {
  test.setTimeout(240_000); // up to 3 live TRIGGER turns + one live UI turn (OpenFDA-backed)
  mkdirSync(SHOTS, { recursive: true });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // Throwaway elder + ONE existing med (Warfarin) so the interaction check has a
  // real "current medications" list to cross-reference.
  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { data: signInData, error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  const jwt = signInData!.session!.access_token;
  const { data: med, error: mErr } = await supa
    .from("medications")
    .insert({ elder_id: creds.userId, name: "Warfarin", dosage: "5mg",
              purpose: "prevent blood clots", schedule: { times: ["08:00"], frequency: "daily" } })
    .select("id")
    .single();
  expect(mErr, mErr?.message).toBeNull();
  const medId: string = med!.id;

  // ── 2 TRIGGER (real :8901) ──────────────────────────────────────────────────
  // Route to the READ-ONLY check_drug_interactions and answer IN CONVERSATION.
  // ≤3 recorded attempts for LLM-routing variance; retry until the read-only
  // check routed AND nothing was committed (either miss is worth another try).
  let turn = await agentTurn8901(jwt, PHRASE);
  saveTurnArtifact(ARTIFACTS, "turn-attempt-1", turn);
  for (
    let attempt = 2;
    attempt <= 3 && !(turn.tools_used.includes("check_drug_interactions") && turn.actions.length === 0);
    attempt++
  ) {
    console.log(`[TRIGGER] attempt ${attempt} (previous tools_used=${JSON.stringify(turn.tools_used)}, actions=${turn.actions.length})`);
    turn = await agentTurn8901(jwt, PHRASE);
    saveTurnArtifact(ARTIFACTS, `turn-attempt-${attempt}`, turn);
  }
  console.log(`[TRIGGER] final reply=${JSON.stringify(turn.reply.slice(0, 300))}`);
  expect(turn.http, "agent/turn HTTP status").toBe(200);
  expect(turn.tools_used, "routed to the READ-ONLY interaction check").toContain("check_drug_interactions");
  // THE crux of the conversational-only decision: a read-only check commits
  // NOTHING — no committed_action, so the web app confirms/highlights nothing.
  expect(turn.actions, "no committed_action — check_drug_interactions persists nothing").toHaveLength(0);
  expect(turn.walkthrough, "no walkthrough queued — this is a plain conversational answer").toBeNull();
  // The reply is a grounded caution (points to the doctor / names the interaction),
  // never a clinical diagnosis.
  expect(turn.reply, "reply advises caution / points to the doctor or pharmacist").toMatch(CAUTION_RE);
  expect(turn.reply, "reply is grounded in the drugs asked about").toMatch(GROUNDING_RE);

  // ── 3 RE-CHECK (independent Supabase re-reads — the point of this scenario) ──
  // Prove NOTHING was written by the conversational answer.
  // (a) medications: still EXACTLY the one seeded Warfarin, unchanged — no new
  //     med row, nothing archived.
  const meds = await recheckDb(supa, "medications", { elder_id: creds.userId });
  expect(meds, "medication count unchanged — nothing added or removed").toHaveLength(1);
  expectRow(meds, { id: medId, name: "Warfarin", archived: false });
  // (b) no doctor_question was queued — the tool only OFFERS one, it never
  //     persists it on a proactive what-if.
  expect(
    await recheckDb(supa, "doctor_questions", { elder_id: creds.userId }),
    "no doctor_question persisted — the answer stayed conversational",
  ).toHaveLength(0);
  // (c) no interaction record lives in profiles.accessibility (or anywhere).
  expect(
    await recheckAccessibility(supa, creds.userId, "interactions"),
    "no 'interactions' key written to accessibility",
  ).toBeUndefined();
  // Belt-and-suspenders: NO accessibility key mentions interaction at all.
  const { data: prof, error: pErr } = await supa
    .from("profiles").select("accessibility").eq("id", creds.userId).single();
  expect(pErr, pErr?.message).toBeNull();
  const accessibility = ((prof as { accessibility?: Record<string, unknown> } | null)?.accessibility) ?? {};
  const interactionKeys = Object.keys(accessibility).filter(k => /interaction/i.test(k));
  expect(interactionKeys, "accessibility has no interaction-related key").toEqual([]);
  // (d) there is NO interaction_flags table BY DESIGN — a read of it must fail
  //     (relation absent), so an interaction can never be persisted anywhere.
  let interactionTableRead = false;
  try {
    await recheckDb(supa, "interaction_flags", { elder_id: creds.userId });
    interactionTableRead = true;
  } catch {
    /* expected: PostgREST rejects an unknown relation */
  }
  expect(interactionTableRead, "no interaction_flags table exists — interactions are never persisted").toBe(false);

  // ── 4 UI + PACING ───────────────────────────────────────────────────────────
  // Light UI proof: send the SAME message in the REAL elder chat and prove the
  // conversational-only decision holds on the surface — no ChangeHighlight ring,
  // no highlight caption, and no navigation to any "flagged" screen (there is
  // none). The authoritative no-write proof is the re-check above.
  await signIn(page, creds); // baseURL :5173, lands on Home
  await page.locator('[data-tour="nav-ai"]').click(); // open the chat
  // The composer's placeholder is ai.askAnything ("Ask me anything") — the
  // 2026-07-29 elderly revamp replaced the old "type or tap the mic" copy.
  const composer = page.getByPlaceholder(/ask me anything/i);
  await expect(composer, "elder chat composer is present").toBeVisible();
  await resetPhaseLog(page); // clear BEFORE the conversational turn under test

  await composer.fill(PHRASE);
  await page.locator('[data-walk="elder-ai-send-button"]').click();
  // The elder's message echoes immediately.
  await expect(page.getByText(PHRASE), "user message echoed in chat").toBeVisible();
  // Wait for Mei's conversational reply to land: user echo + reply = 2 message
  // bubbles. A read-only check queues no "working on it"/confirmation bubble.
  // This asserted 3 because the elder chat used to seed a canned greeting
  // bubble; the 2026-07-29 revamp removed it (buildGreeting is gone and the
  // thread starts empty), so 3 was unreachable. The old 120s budget turned that
  // deterministic miss into a 2-minute hang — 30s is plenty for one live turn.
  await expect(page.locator("p.whitespace-pre-line"), "Mei replied in the chat")
    .toHaveCount(2, { timeout: 30_000 });
  // Give the app one screen-transition settle: a committed write would navigate
  // within PACING.NAVIGATE_MS. Nothing did — this stays a chat.
  await page.waitForTimeout(PACING.NAVIGATE_MS);

  // ── 5 SCREENSHOT (durable — the conversational interaction answer in chat) ────
  await page.screenshot({ path: `${SHOTS}/interaction-answer-in-chat.png`, fullPage: true });

  // PROOF the conversational-only decision holds in the UI:
  //  - no ChangeHighlight ring anywhere (neither the success nor the stopped variant),
  expect(
    await page.locator(".change-highlight, .change-highlight-stopped").count(),
    "no ChangeHighlight ring fired — a read-only check highlights nothing",
  ).toBe(0);
  //  - no highlight caption pill,
  await expect(
    page.locator('[data-testid="change-highlight-caption"]'),
    "no highlight caption shown",
  ).toHaveCount(0);
  //  - still on the AI chat tab (no navigation to any 'flagged' screen — none exists),
  await expect(composer, "still in the chat — no navigation occurred").toBeVisible();
  //  - and the pacing log recorded NO highlight/walkthrough phase at all.
  const log = await readPhaseLog(page);
  const paced = log.filter(e => e.surface === "highlight" || e.surface === "walkthrough");
  expect(paced, `no paced highlight/walkthrough phase fired (saw ${JSON.stringify(paced)})`).toHaveLength(0);

  // ── 6 NO scenario-local ms literals ───────────────────────────────────────
  // This scenario paces NOTHING (no highlight, no walkthrough), so there is no
  // experience-timing literal to route through PACING — the one settle used IS
  // PACING.NAVIGATE_MS. The single raw number is the defensive Playwright wait
  // budget for a live LLM+OpenFDA reply (a polling cap, not experience timing);
  // no 500ms scroll-settle is needed since nothing scrolls into view.
});
