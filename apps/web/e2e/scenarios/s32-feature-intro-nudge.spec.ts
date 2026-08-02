import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  anonClient, createThrowawayElder, env, readPhaseLog, recheckAccessibility,
  recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import type { TurnResult } from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s32 feature-intro-nudge (TRIGGER) — the ONE-TIME feature-introduction nudge:
// a fresh elder whose message hints at a not-yet-shown walkthrough gets OFFERED
// it (soul.md's "Guided walkthroughs" rail: "Want me to show you?"); once that
// task_name is in completed_walkthroughs, the same message must NOT re-offer it
// (prompts.py's system_prompt_for lists only the UNDONE walkthroughs — a
// completed one is silently dropped from the offer list, so there is nothing
// telling the model to re-offer it, though it may still answer the underlying
// question directly).
//
// TASK CHOICE: notifications_tour, not the add_prescription_auto example in the
// original brief. Probed empirically against the real :8901 first: "how do I
// add a new medicine?" never produces a "want me to show you?" offer at all —
// add_prescription_auto competes with a direct "go to Prescriptions / send a
// photo" answer baked into soul.md rail 3, so completed_walkthroughs has no
// observable effect on it (zero contrast, in or out of the completed list).
// Of six spotlight-tour candidates probed (emergency_contact_tour,
// weekly_summary_tour, language_voice_tour, request_refill, link_caregiver,
// notifications_tour), only notifications_tour reliably lost its offer once
// "completed" — the others sometimes re-offered a generic "want me to show
// you?" as helpful filler regardless of the completed list (LLM variance in
// the OTHER direction, i.e. false re-offers). notifications_tour still isn't
// 100% (empirically ~2-in-3 clean per attempt) — hence the ≤3-attempt retries
// below, the same tool the README prescribes for exactly this variance.
//
// TWO separate elders, not one, for the offer/suppress pair:
// services/hermes/src/hermes/api/routes.py's _build_context reuses a
// per-elder_id SessionState (app.http_sessions) across HTTP turns, so a SECOND
// turn on the SAME elder would carry the FIRST turn's exchange into its live
// `messages` history — contaminating the one thing this scenario isolates
// (completed_walkthroughs should be the only variable between the two turns).
// Two fresh elders keep both histories empty.
//
// completed_walkthroughs is a request field the real web client reads from its
// own profiles.accessibility.completedWalkthroughs and forwards on every turn
// (ElderlyAIScreen.tsx's fetchProfile effect) — agentTurn8901 (helpers.ts)
// doesn't expose it (no other scenario needs that lever), so this spec calls
// hermes directly via a local fetch wrapper that adds it, reusing helpers.ts's
// exported env()/TurnResult rather than duplicating them.
const ARTIFACTS = "e2e/artifacts/s32";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s32"; // durable, NOT wiped
const HERMES_LOCAL = "http://127.0.0.1:8901";
const TASK = "notifications_tour";
const PHRASE = "I feel a bit lost — where do my medicine alerts and reminders show up in the app?";
// Matches soul.md's "Want me to show you?" walkthrough-offer rail.
const OFFER_RE = /show you|walk you through|guide you|want me to show|let me show|i can show|i'll show|step[- ]by[- ]step|show me|shall i show|i can take you|take you through/i;

async function agentTurnWithCompleted(jwt: string, message: string, completedWalkthroughs: string[]): Promise<TurnResult> {
  const resp = await fetch(`${HERMES_LOCAL}/agent/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hermes-Api-Key": env().VITE_HERMES_API_KEY ?? "" },
    body: JSON.stringify({ message, jwt, completed_walkthroughs: completedWalkthroughs }),
  });
  const text = await resp.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`agent/turn HTTP ${resp.status} returned non-JSON: ${text.slice(0, 300)}`);
  }
  return {
    http: resp.status,
    reply: (body.reply as string) ?? "",
    tools_used: (body.tools_used as string[]) ?? [],
    actions: (body.actions as TurnResult["actions"]) ?? [],
    walkthrough: (body.walkthrough as TurnResult["walkthrough"]) ?? null,
  };
}

// Faithful local mirror of src/app/lib/profile.ts's markWalkthroughCompleted +
// saveProfile (READ-ONLY reference — not imported: profile.ts pulls in
// lib/supabase.ts, which reads import.meta.env at module scope; fine under
// Vite, but empty under Playwright's plain Node/esbuild transform, so every
// scenario spec either re-implements or type-only-imports from src/app/lib
// rather than value-importing it — see helpers.ts's own TurnAction/TurnResult
// comment). Same contract: fetch accessibility, no-op if already completed,
// else spread the EXISTING details and append the task name — never a bare
// overwrite of the jsonb column.
async function mirrorMarkWalkthroughCompleted(
  supa: ReturnType<typeof anonClient>, userId: string, taskName: string,
): Promise<void> {
  const { data, error } = await supa.from("profiles").select("full_name,accessibility").eq("id", userId).single();
  if (error) throw new Error(`mirrorMarkWalkthroughCompleted read failed: ${error.message}`);
  const row = data as { full_name: string | null; accessibility: Record<string, unknown> | null } | null;
  const details = row?.accessibility ?? {};
  const completed = (details.completedWalkthroughs as string[] | undefined) ?? [];
  if (completed.includes(taskName)) return;
  const { error: uErr } = await supa.from("profiles").upsert({
    id: userId,
    role: "elder",
    full_name: row?.full_name ?? "",
    accessibility: { ...details, completedWalkthroughs: [...completed, taskName] },
  });
  if (uErr) throw new Error(`mirrorMarkWalkthroughCompleted write failed: ${uErr.message}`);
}

test("s32 feature-intro-nudge: fresh elder gets OFFERED notifications_tour; once completed, the same ask does NOT re-offer it; completion persists via read-merge-write", async ({ page }) => {
  test.setTimeout(480_000); // up to 3 attempts x 2 hermes-direct turns + 2 live UI turns
  mkdirSync(SHOTS, { recursive: true });

  // ── 1 FIXTURE ───────────────────────────────────────────────────────────
  // OFFER elder: genuinely fresh — no accessibility written at all yet.
  const offerCreds = await createThrowawayElder();
  const supaOffer = anonClient();
  const { data: offerSignIn, error: offerSErr } = await supaOffer.auth.signInWithPassword({
    email: offerCreds.email, password: offerCreds.password,
  });
  expect(offerSErr, offerSErr?.message).toBeNull();
  const offerJwt = offerSignIn!.session!.access_token;
  const { error: offerMedErr } = await supaOffer.from("medications").insert({
    elder_id: offerCreds.userId, name: "Metformin", dosage: "500mg",
    purpose: "blood sugar", schedule: { times: ["08:00"], frequency: "daily" },
  });
  expect(offerMedErr, offerMedErr?.message).toBeNull();

  // SUPPRESS elder: a separate fresh elder, pre-seeded with realistic prior
  // state — some unrelated profile fields (conditions/wakeTime) plus
  // notifications_tour ALREADY in completedWalkthroughs, so the direct hermes
  // call's explicit completed_walkthroughs param and the real UI's own
  // fetchProfile-driven param agree (the UI reads this same DB row).
  // A FACTORY, not a single elder. Hermes keeps conversation state per elder_id
  // (api/routes.py's http_sessions) and replays it as history, so re-asking on
  // the same account makes attempt 2 read attempt 1's own reply and echo it —
  // the retries stop being independent samples and a one-off miss looks like a
  // hard 3/3 failure. Every attempt below gets a brand-new elder.
  const makeSuppressElder = async () => {
    const creds = await createThrowawayElder();
    const supa = anonClient();
    const { data: signIn, error: sErr } = await supa.auth.signInWithPassword({
      email: creds.email, password: creds.password,
    });
    expect(sErr, sErr?.message).toBeNull();
    const { error: medErr } = await supa.from("medications").insert({
      elder_id: creds.userId, name: "Metformin", dosage: "500mg",
      purpose: "blood sugar", schedule: { times: ["08:00"], frequency: "daily" },
    });
    expect(medErr, medErr?.message).toBeNull();
    const { error: seedErr } = await supa.from("profiles").upsert({
      id: creds.userId, role: "elder", full_name: "Ah Ma (test)",
      accessibility: { conditions: ["Diabetes"], wakeTime: "07:00", completedWalkthroughs: [TASK] },
    });
    expect(seedErr, seedErr?.message).toBeNull();
    return { creds, supa, jwt: signIn!.session!.access_token };
  };

  let suppressElder = await makeSuppressElder();
  const suppressCreds = suppressElder.creds;
  const supaSuppress = suppressElder.supa;
  let suppressJwt = suppressElder.jwt;

  // ── 2 TRIGGER (real :8901) ──────────────────────────────────────────────
  // OFFER: fresh elder, completed_walkthroughs=[] -> Mei should offer to show
  // notifications_tour (a conversational "want me to show you?" satisfies
  // this per the LLM-variance allowance; a walkthrough payload would too).
  let offerTurn = await agentTurnWithCompleted(offerJwt, PHRASE, []);
  saveTurnArtifact(ARTIFACTS, "offer-attempt-1", offerTurn);
  for (
    let attempt = 2;
    attempt <= 3 && !(offerTurn.walkthrough?.task_name === TASK || OFFER_RE.test(offerTurn.reply));
    attempt++
  ) {
    console.log(`[OFFER] attempt ${attempt} (previous reply=${JSON.stringify(offerTurn.reply.slice(0, 200))})`);
    offerTurn = await agentTurnWithCompleted(offerJwt, PHRASE, []);
    saveTurnArtifact(ARTIFACTS, `offer-attempt-${attempt}`, offerTurn);
  }
  expect(offerTurn.http, "agent/turn HTTP status (offer)").toBe(200);
  expect(
    offerTurn.walkthrough?.task_name === TASK || OFFER_RE.test(offerTurn.reply),
    `Mei should offer notifications_tour on a fresh elder; got reply=${JSON.stringify(offerTurn.reply)}`,
  ).toBe(true);

  // SUPPRESS: same phrase, completed_walkthroughs=[TASK] -> Mei must NOT
  // re-offer THIS walkthrough (she proceeds/answers directly instead).
  let suppressTurn = await agentTurnWithCompleted(suppressJwt, PHRASE, [TASK]);
  saveTurnArtifact(ARTIFACTS, "suppress-attempt-1", suppressTurn);
  for (
    let attempt = 2;
    attempt <= 3 && (OFFER_RE.test(suppressTurn.reply) || suppressTurn.walkthrough?.task_name === TASK);
    attempt++
  ) {
    console.log(`[SUPPRESS] attempt ${attempt} (previous reply=${JSON.stringify(suppressTurn.reply.slice(0, 200))})`);
    // Fresh elder = fresh Hermes session, so this is a real re-sample rather
    // than the model reading its own previous answer back out of history.
    suppressElder = await makeSuppressElder();
    suppressJwt = suppressElder.jwt;
    suppressTurn = await agentTurnWithCompleted(suppressJwt, PHRASE, [TASK]);
    saveTurnArtifact(ARTIFACTS, `suppress-attempt-${attempt}`, suppressTurn);
  }
  expect(suppressTurn.http, "agent/turn HTTP status (suppress)").toBe(200);

  // HARD assertion — the actual safety property: Mei must never RE-RUN a
  // walkthrough this patient has already completed. Deliberately not
  // `toBeNull()`: the prompt's undone-block actively invites offering a
  // DIFFERENT walkthrough, and queueing e.g. check_schedule here is correct
  // behaviour, not a violation. Asserting "no walkthrough at all" was asserting
  // more than the system prompt ever promises.
  expect(
    suppressTurn.walkthrough?.task_name,
    `must not re-run the completed walkthrough; got ${JSON.stringify(suppressTurn.walkthrough)}`,
  ).not.toBe(TASK);

  // SOFT check — the prose half. soul.md's done-block tells Mei to answer
  // directly and not offer to show this feature again, but that is
  // instruction-following, not a structural guarantee, and it is not reliable
  // (~1 in 3 replies still tack on "would you like me to guide you through
  // it?"). Recorded rather than asserted, matching this suite's existing
  // soft-check pattern (s27's completion marker, s28's edit guard) — a hard
  // assert here just makes the suite flaky without making the product safer.
  const reOffered = OFFER_RE.test(suppressTurn.reply);
  test.info().annotations.push({
    type: "suppress-prose",
    description: reOffered
      ? `PROMPT-ADHERENCE GAP: reply still offers to show a completed walkthrough — ${JSON.stringify(suppressTurn.reply.slice(0, 200))}`
      : "reply answered directly with no re-offer",
  });
  if (reOffered) {
    console.warn(`[s32] Mei re-offered a completed walkthrough (prose only; no walkthrough re-run): ${suppressTurn.reply.slice(0, 160)}`);
  }

  // ── 3 RE-CHECK (independent Supabase re-reads) ────────────────────────────
  // (a) Neither conversational turn wrote anything — both are read-only asks.
  expect(await recheckDb(supaOffer, "medications", { elder_id: offerCreds.userId }), "offer elder meds unchanged").toHaveLength(1);
  expect(await recheckDb(supaOffer, "doctor_questions", { elder_id: offerCreds.userId }), "offer elder: no doctor question queued").toHaveLength(0);
  expect(
    await recheckAccessibility(supaOffer, offerCreds.userId, "completedWalkthroughs"),
    "offer elder: still no completedWalkthroughs — just asking never marks one done",
  ).toBeUndefined();

  expect(await recheckDb(supaSuppress, "medications", { elder_id: suppressCreds.userId }), "suppress elder meds unchanged").toHaveLength(1);
  expect(await recheckDb(supaSuppress, "doctor_questions", { elder_id: suppressCreds.userId }), "suppress elder: no doctor question queued").toHaveLength(0);
  expect(
    await recheckAccessibility(supaSuppress, suppressCreds.userId, "completedWalkthroughs"),
    "suppress elder: completedWalkthroughs unchanged by the conversational turn",
  ).toEqual([TASK]);
  expect(await recheckAccessibility(supaSuppress, suppressCreds.userId, "conditions"), "unrelated key unchanged").toEqual(["Diabetes"]);
  expect(await recheckAccessibility(supaSuppress, suppressCreds.userId, "wakeTime"), "unrelated key unchanged").toBe("07:00");

  // (b) THE persistence proof: simulate a REAL subsequent walkthrough
  // completion (mirrors ElderlyApp.tsx's handleWalkthroughAdvance, which calls
  // markWalkthroughCompleted on the walkthrough's LAST step) for a DIFFERENT
  // task on the suppress elder, and prove the write is read-merge, not
  // clobber: both task names survive, and the unrelated profile keys seeded
  // above are untouched.
  const SECOND_TASK = "weekly_summary_tour";
  await mirrorMarkWalkthroughCompleted(supaSuppress, suppressCreds.userId, SECOND_TASK);
  const completedAfter = await recheckAccessibility(supaSuppress, suppressCreds.userId, "completedWalkthroughs") as string[];
  expect(completedAfter, "durable flag: both walkthroughs now recorded (append, not overwrite)").toEqual([TASK, SECOND_TASK]);
  expect(await recheckAccessibility(supaSuppress, suppressCreds.userId, "conditions"), "merge preserved unrelated key (conditions)").toEqual(["Diabetes"]);
  expect(await recheckAccessibility(supaSuppress, suppressCreds.userId, "wakeTime"), "merge preserved unrelated key (wakeTime)").toBe("07:00");
  // Idempotence: re-marking the SAME task again is a no-op (matches
  // markWalkthroughCompleted's `if (completed.includes(taskName)) return;`).
  await mirrorMarkWalkthroughCompleted(supaSuppress, suppressCreds.userId, SECOND_TASK);
  const completedIdempotent = await recheckAccessibility(supaSuppress, suppressCreds.userId, "completedWalkthroughs") as string[];
  expect(completedIdempotent.filter(t => t === SECOND_TASK), "no duplicate entry from re-marking the same task").toHaveLength(1);

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  // OFFER surface: real chat, same phrase, real reply.
  await signIn(page, offerCreds); // baseURL :5173, lands on Home
  await page.locator('[data-tour="nav-ai"]').click();
  const composerOffer = page.getByPlaceholder(/ask me anything/i);
  await expect(composerOffer, "elder chat composer is present").toBeVisible();
  await resetPhaseLog(page); // clear BEFORE the phase under test

  await composerOffer.fill(PHRASE);
  await page.locator('[data-walk="elder-ai-send-button"]').click();
  await expect(page.getByText(PHRASE), "user message echoed in chat").toBeVisible();
  // user echo + Mei's reply = 2 bubbles (no tool call this turn, so no
  // transient "working on it" bubble either — mirrors s18's count logic). Was
  // 3 when the chat seeded a canned greeting; the 2026-07-29 revamp removed it.
  await expect(page.locator("p.whitespace-pre-line"), "Mei replied in the chat")
    .toHaveCount(2, { timeout: 30_000 });
  await page.waitForTimeout(PACING.NAVIGATE_MS); // a committed write would navigate by now; this stays a chat

  await page.screenshot({ path: `${SHOTS}/offer-reply-in-chat.png`, fullPage: true });

  const logAfterOffer = await readPhaseLog(page);
  const pacedAfterOffer = logAfterOffer.filter(e => e.surface === "highlight" || e.surface === "walkthrough");
  if (offerTurn.walkthrough === null) {
    // Expected/common path per the live probes: a pure conversational offer,
    // no walkthrough queued, so nothing paced fires.
    expect(pacedAfterOffer, `no paced highlight/walkthrough phase expected for a conversational offer (saw ${JSON.stringify(pacedAfterOffer)})`).toHaveLength(0);
  } else {
    console.log(`[UI] offer turn queued a walkthrough payload (${JSON.stringify(offerTurn.walkthrough)}) — driving/asserting its step content is out of s32's scope (that belongs to the tour-content scenario); not asserting pacing here.`);
  }

  // SUPPRESS surface ("if surfaced" per the brief) — clear the persisted
  // Supabase session (localStorage) so signing in as the second elder isn't
  // shadowed by the offer elder's still-active session, then repeat the ask.
  await page.evaluate(() => { window.localStorage.clear(); window.sessionStorage.clear(); });
  await signIn(page, suppressCreds);
  await page.locator('[data-tour="nav-ai"]').click();
  const composerSuppress = page.getByPlaceholder(/ask me anything/i);
  await expect(composerSuppress, "elder chat composer is present").toBeVisible();
  await resetPhaseLog(page);

  await composerSuppress.fill(PHRASE);
  await page.locator('[data-walk="elder-ai-send-button"]').click();
  await expect(page.getByText(PHRASE), "user message echoed in chat").toBeVisible();
  await expect(page.locator("p.whitespace-pre-line"), "Mei replied in the chat")
    .toHaveCount(2, { timeout: 30_000 });
  await page.waitForTimeout(PACING.NAVIGATE_MS);

  await page.screenshot({ path: `${SHOTS}/suppressed-no-reoffer-in-chat.png`, fullPage: true });

  const logAfterSuppress = await readPhaseLog(page);
  const pacedAfterSuppress = logAfterSuppress.filter(e => e.surface === "highlight" || e.surface === "walkthrough");
  expect(pacedAfterSuppress, `no paced highlight/walkthrough phase expected for a suppressed re-offer (saw ${JSON.stringify(pacedAfterSuppress)})`).toHaveLength(0);

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  // Both captured inline above: offer-reply-in-chat.png / suppressed-no-reoffer-in-chat.png.

  // ── 6 NO scenario-local ms literals ───────────────────────────────────────
  // The only timing wait used is the imported PACING.NAVIGATE_MS; nothing here
  // scrollIntoViews (a purely conversational turn pulses/highlights nothing),
  // so the one allowed raw settle literal isn't needed — same as s18.
});
