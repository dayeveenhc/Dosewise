import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import type { TurnAction, TurnResult } from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s06 bulk-missed (AUDIT) — "tick ALL my missed doses" -> resolve_missed_doses
// propose→confirm -> ONE bulk action (entities[] of 3 doses) -> all three Home
// cards ring SIMULTANEOUSLY under one batch caption.
const ARTIFACTS = "e2e/artifacts/s06";           // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s06";  // durable, NOT wiped

// A UTC ISO -> "HH:MM" wall-clock in Asia/Singapore (the elder tz Hermes uses),
// so we can prove each taken row was back-dated to its slot, not stamped "now".
function sgtHHMM(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
}

// A bulk resolve_missed_doses commit: tool matches and it carries entities[].
function findBulk(turn: TurnResult): TurnAction | undefined {
  return turn.actions.find(a => a.tool === "resolve_missed_doses" && (a.entities?.length ?? 0) > 0);
}

test("s06 bulk-missed: 'tick all my missed doses' -> one bulk action rings all three cards", async ({ page }) => {
  test.setTimeout(150_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // Three meds, each scheduled ONCE at a top-of-hour that is already PAST in
  // SGT today (computed from the live SGT clock: 3h/2h/1h ago). No dose rows —
  // resolve_missed_doses derives the missed slots server-side from the schedule.
  const sgtHour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore", hour: "2-digit", hour12: false,
  }).format(new Date()));
  // Need three distinct HH:00 slots strictly before the current hour.
  test.skip(sgtHour < 3, `SGT hour is ${sgtHour}; run after 03:00 SGT for three distinct past HH:00 slots`);
  const slotFor = (h: number) => `${String(h).padStart(2, "0")}:00`;
  const MEDS = [
    { name: "Metformin",    dosage: "500mg", purpose: "blood sugar",    slot: slotFor(sgtHour - 3) },
    { name: "Amlodipine",   dosage: "5mg",   purpose: "blood pressure", slot: slotFor(sgtHour - 2) },
    { name: "Atorvastatin", dosage: "20mg",  purpose: "cholesterol",    slot: slotFor(sgtHour - 1) },
  ];
  console.log(`[FIXTURE] SGT hour=${sgtHour} past slots=${MEDS.map(m => m.slot).join(", ")}`);

  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { data: signInData, error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  const jwt = signInData!.session!.access_token;

  const medIdToSlot: Record<string, string> = {}; // med uuid -> its past slot
  const medIdToName: Record<string, string> = {};
  const medIds: string[] = [];
  for (const m of MEDS) {
    const { data, error } = await supa
      .from("medications")
      .insert({
        elder_id: creds.userId, name: m.name, dosage: m.dosage, purpose: m.purpose,
        schedule: { times: [m.slot], frequency: "daily" },
      })
      .select("id")
      .single();
    expect(error, error?.message).toBeNull();
    const id: string = data!.id;
    medIds.push(id);
    medIdToSlot[id] = m.slot;
    medIdToName[id] = m.name;
  }
  console.log(`[FIXTURE] elder=${creds.userId} meds=${JSON.stringify(medIdToSlot)}`);

  // ── 2 TRIGGER ─────────────────────────────────────────────────────────────
  // Real two-turn dialog on :8901. Turn A proposes (NO write); turn B "yes"
  // commits ONE bulk action. ≤3 attempt-pairs for LLM-routing variance; every
  // raw turn is saved. An attempt is accepted only when it exercises the whole
  // propose→confirm contract cleanly (propose wrote nothing; confirm = 3 entities).
  const PHRASE_A = "I missed my morning medicines — please tick all my missed doses";
  const PHRASE_B = "yes";
  let propose: TurnResult | undefined;
  let confirm: TurnResult | undefined;
  let bulk: TurnAction | undefined;
  let rowsAfterPropose: Record<string, unknown>[] | undefined;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const a = await agentTurn8901(jwt, PHRASE_A);
    saveTurnArtifact(ARTIFACTS, `propose-attempt-${attempt}`, a);
    const proposed = a.http === 200 && a.tools_used.includes("resolve_missed_doses") && a.actions.length === 0;
    // Independent proof the propose committed nothing (holds every iteration —
    // nothing is written until a successful confirm, which breaks the loop).
    const rows = await recheckDb(supa, "doses", { elder_id: creds.userId });

    const b = await agentTurn8901(jwt, PHRASE_B);
    saveTurnArtifact(ARTIFACTS, `confirm-attempt-${attempt}`, b);
    const act = findBulk(b);

    console.log(`[TRIGGER] attempt ${attempt}: proposed=${proposed} rowsAfterPropose=${rows.length} ` +
      `confirmTools=${JSON.stringify(b.tools_used)} bulkEntities=${act?.entities?.length ?? 0}`);

    if (proposed && rows.length === 0 && act && (act.entities?.length ?? 0) === 3) {
      propose = a; confirm = b; bulk = act; rowsAfterPropose = rows;
      break;
    }
  }

  expect(propose, "a clean propose turn (resolve_missed_doses routed, no writes)").toBeTruthy();
  expect(confirm, "a confirm turn committing the bulk action").toBeTruthy();
  expect(bulk, "one bulk resolve_missed_doses action with entities[]").toBeTruthy();
  // Propose read-back names all three meds so the elder sees exactly what a "yes" ticks.
  for (const m of MEDS) {
    expect(propose!.reply.toLowerCase(), `propose reply lists ${m.name}`).toContain(m.name.toLowerCase());
  }
  // Propose wrote NOTHING to the DB.
  expect(rowsAfterPropose, "propose wrote no dose rows").toHaveLength(0);

  // The observed bulk entities[] shape — one entity per missed dose.
  const entities = bulk!.entities as Array<Record<string, any>>;
  expect(entities).toHaveLength(3);
  console.log(`[BULK ENTITIES] ${JSON.stringify(entities, null, 2)}`);
  for (const e of entities) {
    expect(e.entity_type, "entity_type").toBe("dose");
    expect(medIds, "entity_id is one of the seeded med uuids").toContain(e.entity_id);
    expect(e.changed_fields?.status?.before, "status.before").toBeNull();
    expect(e.changed_fields?.status?.after, "status.after").toBe("taken");
    expect(e.dose_id, "dose_id present").toBeTruthy();
    expect(medIdToSlot[e.entity_id], `slot matches the med's scheduled slot`).toBe(e.slot);
    expect(e.name, "name present").toBe(medIdToName[e.entity_id]);
  }
  // The three entities cover exactly the three seeded meds (no dup / no miss).
  expect(new Set(entities.map(e => e.entity_id))).toEqual(new Set(medIds));

  // ── 3 RE-CHECK ──────────────────────────────────────────────────────────────
  // Independent Supabase re-read: exactly 3 taken rows, each back-dated to its
  // slot (SGT wall-clock), logged_at ≈ now.
  const doseRows = await recheckDb(supa, "doses", { elder_id: creds.userId });
  expect(doseRows, "exactly three doses written").toHaveLength(3);
  const now = Date.now();
  for (const row of doseRows) {
    const medId = String(row.medication_id);
    const slot = medIdToSlot[medId];
    expect(slot, `dose row maps to a seeded med`).toBeTruthy();
    expect(row.status, "row status").toBe("taken");
    // scheduled_at is the slot's SGT wall-clock today — NOT "now".
    expect(sgtHHMM(String(row.scheduled_at)), `${medIdToName[medId]} back-dated to its slot`).toBe(slot);
    expect(Math.abs(new Date(String(row.scheduled_at)).getTime() - now),
      "scheduled_at is back-dated, not now").toBeGreaterThan(30 * 60_000);
    // logged_at is the moment we ticked — ≈ now.
    expect(Math.abs(new Date(String(row.logged_at)).getTime() - now),
      "logged_at ≈ now").toBeLessThan(10 * 60_000);
  }
  // The action's dose_ids are exactly the rows just written.
  expect(new Set(entities.map(e => String(e.dose_id)))).toEqual(new Set(doseRows.map(r => String(r.id))));

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  await signIn(page, creds); // baseURL :5173, lands on Home
  await resetPhaseLog(page); // clear BEFORE the phase under test (the highlight)

  // Fire the bulk action from the AI tab: a tab already showing medication-*
  // testids (Home/Prescriptions) triggers the known dev-hook latch bug (the first
  // synchronous poll grabs pre-navigation cards, the tab switch unmounts them, the
  // isConnected bail ends the highlight with no ring). The AI screen renders no med
  // cards — production fires from there too, so this mirrors the real path.
  await page.locator('[data-tour="nav-ai"]').click();
  await expect(page.locator('[data-testid^="medication-"]'), "AI tab shows no med cards").toHaveCount(0);

  await page.evaluate(a => (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a), bulk);

  // ChangeHighlight navigates to Home and rings ALL THREE cards SIMULTANEOUSLY.
  const ringed = page.locator(".change-highlight");
  await expect(ringed, "all three cards ringed at once").toHaveCount(3, { timeout: 15_000 });
  for (const id of medIds) {
    await expect(page.locator(`[data-testid="medication-${id}"]`), `card ${id} ringed`).toHaveClass(/change-highlight/);
  }

  // ONE batch caption — describeBatch: verb "Taken", text = the backend summary.
  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption, "exactly one batch caption").toHaveCount(1);
  await expect(caption).toBeVisible();
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  const captionText = ((await caption.textContent()) ?? "").replace(/\s+/g, " ").trim();
  console.log(`[UI] batch caption="${captionText}"`);
  expect(captionText).toBe(`Taken: ${bulk!.summary}`);
  expect(captionText).toContain("3 missed doses marked taken");

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  await page.screenshot({ path: `${SHOTS}/all-three-ringed.png`, fullPage: true });
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
  // All timing via PACING above; the only bare literal is the 500ms settle wait
  // (with its required comment). Business windows (30min/10min/60_000) are DB
  // freshness bounds for the RE-CHECK, not UI pacing.
});
