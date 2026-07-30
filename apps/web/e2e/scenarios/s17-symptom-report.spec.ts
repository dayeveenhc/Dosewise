import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  readPhaseLog, recheckAccessibility, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import type { SymptomReport } from "../../src/app/lib/profile";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s17 symptom-report (NEW-BE-FE) — "I've been feeling dizzy after taking my
// metformin" -> add_symptom writes the report IMMEDIATELY (a health report never
// stalls on a confirm) into profiles.accessibility.symptom_reports with a fresh
// uuid id, best-effort attaching the medication it was linked to. The committed
// action's entity_id is THAT new SYMPTOM id (not the medication's), so the
// Settings "Symptoms noted" row (data-testid="symptom-{id}") rings with a
// "Noted:" caption. The reply is empathetic, never diagnoses, and offers to
// queue a doctor question.
const ARTIFACTS = "e2e/artifacts/s17";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s17"; // durable, NOT wiped

// add_symptom ids are uuid4().hex — 32 hex chars, NO dashes (services/hermes
// tools/symptoms.py). A real medication id is a dashed DB uuid, so matching this
// shape is itself proof the entity_id is the symptom's, never the medicine's.
const SYMPTOM_ID_RE = /^[0-9a-f]{32}$/i;

test("s17 symptom-report: 'I've been feeling dizzy after taking my metformin' -> add_symptom logs a symptom entry (entity_id = the SYMPTOM id), Settings row ringed 'Noted:'", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // Throwaway elder + a real Metformin med so the reported symptom can tie to a
  // medication on file by name (find_medications resolves the single match).
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
  console.log(`[FIXTURE] elder=${creds.userId} med=${medId}`);

  // ── 2 TRIGGER ─────────────────────────────────────────────────────────────
  // add_symptom commits IMMEDIATELY on the same turn. Retry ONLY while it hasn't
  // routed yet: a routed attempt has already WRITTEN one report, so re-sending
  // would append a second — the retry guard keeps the write count at exactly one.
  const PHRASE = "I've been feeling dizzy after taking my metformin";
  let turn = await agentTurn8901(jwt, PHRASE);
  saveTurnArtifact(ARTIFACTS, "turn-attempt-1", turn);
  for (let attempt = 2; attempt <= 3 && !turn.tools_used.includes("add_symptom"); attempt++) {
    console.log(`[TRIGGER] attempt ${attempt} (previous tools_used=${JSON.stringify(turn.tools_used)})`);
    turn = await agentTurn8901(jwt, PHRASE);
    saveTurnArtifact(ARTIFACTS, `turn-attempt-${attempt}`, turn);
  }
  expect(turn.http, "agent/turn HTTP status").toBe(200);
  expect(turn.tools_used, "expected add_symptom routed").toContain("add_symptom");

  const action = turn.actions.find(a => a.tool === "add_symptom");
  expect(action, "committed add_symptom action present on the SAME turn (immediate write)").toBeTruthy();
  expect(action!.entity_type, "committed entity_type").toBe("symptom");
  // THE core assertion for this scenario: the entity_id is the NEW symptom's id,
  // never the medication's. Proven two ways — its hex-no-dash shape, and !== medId.
  expect(action!.entity_id, "entity_id has the symptom uuid4().hex shape").toMatch(SYMPTOM_ID_RE);
  expect(action!.entity_id, "entity_id is the SYMPTOM id, NOT the medication id").not.toBe(medId);
  const symId = action!.entity_id!;
  const symField = action!.changed_fields?.symptom;
  expect(symField, "changed_fields.symptom present").toBeTruthy();
  expect(symField!.before, "a new report: symptom.before is null").toBeNull();
  expect(String(symField!.after), "symptom.after captures what they reported").toMatch(/dizz/i);
  // The medicine it was linked to rides along on the action (record_action extra).
  expect(String(action!.medication_name), "action carries the resolved medication name").toBe("Metformin");
  console.log(`[TRIGGER] committed action=${JSON.stringify(action)}`);

  // Safety rails on the reply: empathetic acknowledgement + offer to queue a
  // doctor question, and NEVER a diagnosis. (Assertions on generated text are a
  // proxy — they confirm the observable safety signals, not that no phrasing
  // could ever slip; the raw reply is saved in the turn artifact for review.)
  const reply = turn.reply ?? "";
  console.log(`[TRIGGER] reply="${reply}"`);
  expect(reply.trim().length, "reply is non-empty").toBeGreaterThan(0);
  expect(reply, "reply acknowledges + confirms it was saved (empathetic, warm)")
    .toMatch(/noted|saved|recorded|health note|sorry|thank/i);
  expect(reply, "reply offers to queue a question for their doctor")
    .toMatch(/doctor/i);
  expect(reply, "reply must NOT diagnose (no 'diagnose/diagnosis')").not.toMatch(/diagnos/i);
  expect(reply, "reply must NOT name a definitive condition as the cause")
    .not.toMatch(/\byou (?:have|'?ve got|are having) (?:a |an |early )?(?:diabetes|hypoglyc[ae]mia|low blood sugar|high blood pressure|hypertension|vertigo|a stroke|an infection)\b/i);

  // ── 3 RE-CHECK ────────────────────────────────────────────────────────────
  // Independent Supabase re-read of the accessibility.symptom_reports array — the
  // DB is the truth, not the turn's reply. Exactly ONE entry, and it IS the
  // action's entity (same id), with the symptom text, medication link, and a
  // noted_at timestamp.
  const reports = (await recheckAccessibility(supa, creds.userId, "symptom_reports")) as SymptomReport[] | undefined;
  expect(Array.isArray(reports), "symptom_reports is an array").toBe(true);
  expect(reports!.length, "exactly one symptom report written").toBe(1);
  const entry = reports![0];
  expect(entry.id, "stored entry id === the action's entity_id (the symptom id)").toBe(symId);
  expect(String(entry.symptom), "stored symptom text").toMatch(/dizz/i);
  expect(entry.medication_id, "stored entry links back to the Metformin med id").toBe(medId);
  expect(entry.medication_name, "stored entry carries the resolved med name").toBe("Metformin");
  expect(entry.noted_at, "stored entry has a noted_at timestamp").toBeTruthy();
  expect(Number.isNaN(new Date(entry.noted_at).getTime()), "noted_at parses as a real date").toBe(false);

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  await signIn(page, creds); // baseURL :5173, lands on Home (NOT Settings)
  await resetPhaseLog(page); // clear BEFORE the highlight phase under test
  // Fire the REAL committed action (real symptom id): ChangeHighlight auto-navigates
  // Home -> Settings, where the "Symptoms noted" section (fetched from the DB row we
  // just wrote) renders symptom-{id}; it rings that row and shows the "Noted:" caption.
  await page.evaluate((a) => {
    (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a);
  }, action as unknown as Record<string, unknown>);

  const row = page.locator(`[data-testid="symptom-${symId}"]`);
  // Generous deadline: auto-nav + the Settings profile fetch + ChangeHighlight's
  // async element poll (all engine-internal, not pacing).
  await expect(row, "symptom row visible in the Symptoms-noted section")
    .toBeVisible({ timeout: PACING.HIGHLIGHT_DWELL_MIN_MS * 4 });
  await expect(row, "symptom row ringed").toHaveClass(/change-highlight/);
  await expect(row, "row shows the symptom text").toContainText(/dizz/i);

  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption, "caption visible").toBeVisible();
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  const captionText = ((await caption.textContent()) ?? "").replace(/\s+/g, " ").trim();
  console.log(`[UI] caption="${captionText}"`);
  expect(captionText, "caption uses the 'Noted:' verb (never 'Added'/'Updated')").toContain("Noted:");
  expect(captionText, "caption carries the reported symptom text").toMatch(/dizz/i);

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  // Captured DURING the dwell (ring + caption disappear at auto-dismiss).
  await page.screenshot({ path: `${SHOTS}/symptom-ringed-with-caption.png`, fullPage: true });
  await row.screenshot({ path: `${SHOTS}/symptom-row-closeup.png` });

  // (4 cont.) PACING — ChangeHighlight records its "dwell" phase entry only at
  // auto-dismiss, so wait for the caption to dismiss itself, then assert the
  // measured dwell respected the minimum.
  await expect(caption, "caption auto-dismisses after the dwell").toBeHidden({ timeout: PACING.HIGHLIGHT_DWELL_MIN_MS * 2 });
  const log = await readPhaseLog(page);
  assertPhaseMins(log, [
    { surface: "highlight", phase: "dwell", min: PACING.HIGHLIGHT_DWELL_MIN_MS },
  ]);
  // Generous upper bound: the dwell auto-dismisses at the minimum, so past 3x
  // means the teardown timer failed.
  const dwell = log.filter(e => e.surface === "highlight" && e.phase === "dwell").at(-1)!;
  expect(dwell.endedAt - dwell.startedAt, "dwell auto-dismissed near the minimum")
    .toBeLessThan(PACING.HIGHLIGHT_DWELL_MIN_MS * 3);

  // ── 6 NO scenario-local ms literals ───────────────────────────────────────
  // All experience timing flows through PACING above; the only bare literal is the
  // 500ms scroll-settle wait (with its required comment). The 120s value is a
  // Playwright test deadline and the *4/*2/*3 factors are multiples of PACING,
  // not UI pacing constants.
});
