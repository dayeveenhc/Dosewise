import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  expectRow, readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import type { TurnAction, TurnResult } from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s07 multi-named-doses (NEW-BE-FE) — "I took my metformin and my lisinopril"
// -> log_doses (EXPLICIT LIST, not resolve_missed_doses' "all") propose→confirm
// -> ONE bulk action (entities[] of the 2 NAMED meds) -> both Home cards ring
// SIMULTANEOUSLY under one batch caption. Distinct from s06: the meds are NAMED,
// so the model must pick log_doses; each med already has a PENDING dose today,
// so the commit FLIPS those rows (pending→taken) rather than inserting new ones.
const ARTIFACTS = "e2e/artifacts/s07";           // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s07";  // durable, NOT wiped

// A bulk log_doses commit: the tool matches AND it carries entities[]. Asserting
// the tool here (not resolve_missed_doses) is half the scenario's whole point.
function findBulk(turn: TurnResult): TurnAction | undefined {
  return turn.actions.find(a => a.tool === "log_doses" && (a.entities?.length ?? 0) > 0);
}

// The model routed to the explicit-list tool, NOT the "all missed" tool.
function choseLogDosesNotResolve(turn: TurnResult): boolean {
  return turn.tools_used.includes("log_doses") && !turn.tools_used.includes("resolve_missed_doses");
}

test("s07 multi-named-doses: 'I took my metformin and my lisinopril' -> one log_doses bulk rings both cards", async ({ page }) => {
  test.setTimeout(150_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // Fresh throwaway elder + TWO NAMED meds, EACH with one PENDING dose today.
  // scheduled_at = now guarantees the dose is inside the Home window
  // (fetchElderMedications filters scheduled_at >= start of local day), so after
  // the flip both taken cards render. The pending-flip path ignores the slot, so
  // the exact time doesn't matter — only that exactly one pending row exists.
  const MEDS = [
    { name: "Metformin",  dosage: "500mg", purpose: "blood sugar",     slot: "08:00" },
    { name: "Lisinopril", dosage: "10mg",  purpose: "blood pressure",  slot: "09:00" },
  ];

  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { data: signInData, error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  const jwt = signInData!.session!.access_token;

  const nowIso = new Date().toISOString();
  const medIds: string[] = [];
  const medIdToName: Record<string, string> = {};
  const medIdToPendingDoseId: Record<string, string> = {}; // proves the commit FLIPS this exact row
  for (const m of MEDS) {
    const { data: med, error: mErr } = await supa
      .from("medications")
      .insert({
        elder_id: creds.userId, name: m.name, dosage: m.dosage, purpose: m.purpose,
        schedule: { times: [m.slot], frequency: "daily" },
      })
      .select("id")
      .single();
    expect(mErr, mErr?.message).toBeNull();
    const medId: string = med!.id;
    const { data: dose, error: dErr } = await supa
      .from("doses")
      .insert({ medication_id: medId, elder_id: creds.userId, scheduled_at: nowIso, status: "pending" })
      .select("id")
      .single();
    expect(dErr, dErr?.message).toBeNull();
    medIds.push(medId);
    medIdToName[medId] = m.name;
    medIdToPendingDoseId[medId] = dose!.id;
  }
  console.log(`[FIXTURE] elder=${creds.userId} meds=${JSON.stringify(medIdToName)} pending=${JSON.stringify(medIdToPendingDoseId)}`);

  // ── 2 TRIGGER ─────────────────────────────────────────────────────────────
  // Real two-turn dialog on :8901, SAME jwt both turns so pending_bulk carries
  // across the session (app.http_sessions is keyed by elder_id). Turn A proposes
  // (NO write); turn B "yes" commits ONE bulk action. ≤3 attempt-pairs for
  // LLM-routing variance; every raw turn is saved. An attempt is accepted only
  // when the whole propose→confirm contract holds cleanly: propose routed to
  // log_doses (NOT resolve_missed_doses) and wrote nothing; confirm committed a
  // 2-entity log_doses bulk.
  const PHRASE_A = "I took my metformin and my lisinopril";
  const PHRASE_B = "yes";
  let propose: TurnResult | undefined;
  let confirm: TurnResult | undefined;
  let bulk: TurnAction | undefined;
  let rowsAfterPropose: Record<string, unknown>[] | undefined;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const a = await agentTurn8901(jwt, PHRASE_A);
    saveTurnArtifact(ARTIFACTS, `propose-attempt-${attempt}`, a);
    const proposed = a.http === 200 && choseLogDosesNotResolve(a) && a.actions.length === 0;
    // Independent proof the propose committed nothing: both seeded doses still
    // pending, none taken (holds every iteration until a successful confirm).
    const rows = await recheckDb(supa, "doses", { elder_id: creds.userId });
    const stillPending = rows.filter(r => String(r.status) === "pending").length;
    const alreadyTaken = rows.filter(r => String(r.status) === "taken").length;

    const b = await agentTurn8901(jwt, PHRASE_B);
    saveTurnArtifact(ARTIFACTS, `confirm-attempt-${attempt}`, b);
    const act = findBulk(b);

    console.log(`[TRIGGER] attempt ${attempt}: proposeTools=${JSON.stringify(a.tools_used)} proposed=${proposed} ` +
      `pendingAfterPropose=${stillPending} takenAfterPropose=${alreadyTaken} ` +
      `confirmTools=${JSON.stringify(b.tools_used)} bulkEntities=${act?.entities?.length ?? 0}`);

    if (proposed && stillPending === 2 && alreadyTaken === 0 &&
        choseLogDosesNotResolve(b) && act && (act.entities?.length ?? 0) === 2) {
      propose = a; confirm = b; bulk = act; rowsAfterPropose = rows;
      break;
    }
  }

  expect(propose, "a clean propose turn (log_doses routed, NOT resolve_missed_doses, no writes)").toBeTruthy();
  expect(confirm, "a confirm turn committing the bulk action").toBeTruthy();
  expect(bulk, "one bulk log_doses action with entities[]").toBeTruthy();
  // Explicit-list vs "all": the model must have chosen log_doses on BOTH turns.
  expect(choseLogDosesNotResolve(propose!), "propose used log_doses, not resolve_missed_doses").toBe(true);
  expect(choseLogDosesNotResolve(confirm!), "confirm used log_doses, not resolve_missed_doses").toBe(true);
  // Propose read-back names BOTH meds so the elder sees exactly what a "yes" logs.
  for (const m of MEDS) {
    expect(propose!.reply.toLowerCase(), `propose reply lists ${m.name}`).toContain(m.name.toLowerCase());
  }
  // Propose wrote NOTHING: both doses still pending, none taken.
  expect(rowsAfterPropose, "propose left two rows").toHaveLength(2);
  expect(rowsAfterPropose!.filter(r => String(r.status) === "pending"), "both still pending after propose").toHaveLength(2);

  // The observed bulk entities[] shape — one entity per NAMED med.
  const entities = bulk!.entities as Array<Record<string, any>>;
  expect(entities).toHaveLength(2);
  console.log(`[BULK] tool=${bulk!.tool} summary=${JSON.stringify(bulk!.summary)}`);
  console.log(`[BULK ENTITIES] ${JSON.stringify(entities, null, 2)}`);
  for (const e of entities) {
    expect(e.entity_type, "entity_type").toBe("dose");
    expect(medIds, "entity_id is one of the seeded med uuids").toContain(e.entity_id);
    // Seeded a pending row per med, so the flip reads pending→taken (a fresh
    // insert would read null→taken); accept either per the tool contract, but
    // require the terminal state and prove the flip via dose_id below.
    expect([null, "pending"], "status.before").toContain(e.changed_fields?.status?.before ?? null);
    expect(e.changed_fields?.status?.after, "status.after").toBe("taken");
    expect(e.dose_id, "dose_id present").toBeTruthy();
    expect(e.name, "name present").toBe(medIdToName[e.entity_id]);
    // dose_id is the SEEDED pending row's id -> the commit FLIPPED it in place.
    expect(String(e.dose_id), `${medIdToName[e.entity_id]} flipped its seeded pending row`)
      .toBe(String(medIdToPendingDoseId[e.entity_id]));
  }
  // Both entities cover exactly the two seeded meds (no dup / no miss).
  expect(new Set(entities.map(e => e.entity_id))).toEqual(new Set(medIds));
  // Summary is the count-style batch text the caption renders.
  expect(String(bulk!.summary)).toMatch(/2 doses marked taken/);

  // ── 3 RE-CHECK ──────────────────────────────────────────────────────────────
  // Independent Supabase re-read: exactly 2 rows total (the seeded pending rows,
  // FLIPPED — never doubled), both taken, one per named med, logged_at ≈ now.
  const doseRows = await recheckDb(supa, "doses", { elder_id: creds.userId });
  expect(doseRows, "exactly two doses (the seeded rows, flipped)").toHaveLength(2);
  const now = Date.now();
  for (const medId of medIds) {
    const medRows = await recheckDb(supa, "doses", { elder_id: creds.userId, medication_id: medId });
    const row = expectRow(medRows, { status: "taken", id: medIdToPendingDoseId[medId] });
    expect(Math.abs(new Date(String(row.logged_at)).getTime() - now),
      `${medIdToName[medId]} logged_at ≈ now`).toBeLessThan(10 * 60_000);
    expect(String(row.logged_by), "logged_by is the elder").toBe(creds.userId);
  }
  // The action's dose_ids are exactly the two rows just written.
  expect(new Set(entities.map(e => String(e.dose_id)))).toEqual(new Set(doseRows.map(r => String(r.id))));

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  await signIn(page, creds); // baseURL :5173, lands on Home

  // Fire the bulk action from the AI tab (mirrors s06): a tab already showing
  // medication-* testids triggers the dev-hook latch bug (a synchronous first
  // poll grabs pre-navigation cards, the tab switch unmounts them, the
  // isConnected bail ends the highlight with no ring). The AI screen renders no
  // med cards — production fires from there too, so this mirrors the real path.
  await page.locator('[data-tour="nav-ai"]').click();
  await expect(page.locator('[data-testid^="medication-"]'), "AI tab shows no med cards").toHaveCount(0);

  await resetPhaseLog(page); // clear BEFORE the phase under test (the highlight)
  await page.evaluate(a => (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a), bulk);

  // ChangeHighlight navigates to Home and rings BOTH cards SIMULTANEOUSLY.
  const ringed = page.locator(".change-highlight");
  await expect(ringed, "both cards ringed at once").toHaveCount(2, { timeout: 15_000 });
  for (const id of medIds) {
    await expect(page.locator(`[data-testid="medication-${id}"]`), `card ${id} ringed`).toHaveClass(/change-highlight/);
  }

  // ONE batch caption — describeBatch: verb "Taken" (every entity status→taken),
  // text = the backend summary.
  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption, "exactly one batch caption").toHaveCount(1);
  await expect(caption).toBeVisible();
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  const captionText = ((await caption.textContent()) ?? "").replace(/\s+/g, " ").trim();
  console.log(`[UI] batch caption="${captionText}"`);
  expect(captionText).toBe(`Taken: ${bulk!.summary}`);
  expect(captionText).toContain("2 doses marked taken");

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  await page.screenshot({ path: `${SHOTS}/both-cards-ringed.png`, fullPage: true });
  await page.screenshot({ path: `${SHOTS}/batch-caption.png` });

  // PACING: the highlight dwells ≥ HIGHLIGHT_DWELL_MIN_MS before auto-dismiss.
  // The dwell entry is written when the highlight finishes — wait for it, read it.
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
  // All UI timing via PACING above; the only bare literal is the 500ms settle
  // wait (with its required comment). The 10min window in the RE-CHECK is a DB
  // freshness bound (logged_at ≈ now), not UI pacing.
});
