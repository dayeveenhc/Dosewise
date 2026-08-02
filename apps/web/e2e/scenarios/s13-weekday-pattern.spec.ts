import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import type { TurnAction, TurnResult } from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s13 weekday-pattern (NEW-FE) — set_medication_reminder switches a DAILY med to a
// WEEKLY (weekday-only) schedule via propose→confirm. The committed action is a
// `schedule_entry` change carrying the new days; the elder Prescriptions card is
// ringed and the caption reads back the weekday change ("Updated: days mon, …").
// PATCH-QUEUE FINDING (see report, NOT a failure): the elder UI does not render the
// weekday pattern — lib/medications.ts::fetchElderMedications maps only
// schedule.times, and the Medication type / ElderlyPrescriptionScreen have no days.
const ARTIFACTS = "e2e/artifacts/s13";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s13"; // durable, NOT wiped

// The tool's weekday encoding: _normalize_days always emits mon..sun order, so a
// "weekdays" ask normalises to exactly these five tokens regardless of phrasing.
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];

test("s13 weekday-pattern: 'Only remind me to take my metformin on weekdays' -> propose→confirm sets a weekly (Mon–Fri) schedule", async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { data: signInData, error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  const jwt = signInData!.session!.access_token;
  // DAILY to start: times only, no days — the weekday restriction is what the turn adds.
  const { data: med, error: mErr } = await supa
    .from("medications")
    .insert({ elder_id: creds.userId, name: "Metformin", dosage: "500mg",
              purpose: "blood sugar", schedule: { times: ["08:00"], frequency: "daily" } })
    .select("id")
    .single();
  expect(mErr, mErr?.message).toBeNull();
  const medId: string = med!.id;

  // ── 2 TRIGGER ─────────────────────────────────────────────────────────────
  // ≤3 recorded propose→confirm PAIRS. :8901 sessions persist per elder_id, and a
  // bare "yes" only commits when the immediately-preceding propose stashed a matching
  // pending_reminder (match_pending guard) — so each confirm must follow a fresh
  // propose, not a lone retry. Note: a propose with no time cannot stash (the tool
  // asks for a time), so the model must carry the on-file 08:00 forward.
  const PROPOSE_PHRASE = "Only remind me to take my metformin on weekdays";
  const CONFIRM_PHRASE = "yes";
  const daysMatch = (a?: TurnAction) =>
    !!a && JSON.stringify(a.changed_fields?.days?.after) === JSON.stringify(WEEKDAYS);

  let propose: TurnResult | undefined;
  let confirm: TurnResult | undefined;
  let action: TurnAction | undefined;
  let proposeRouted = false;

  for (let pair = 1; pair <= 3; pair++) {
    propose = await agentTurn8901(jwt, PROPOSE_PHRASE);
    saveTurnArtifact(ARTIFACTS, `pair${pair}-propose`, propose);
    proposeRouted ||= propose.tools_used.includes("set_medication_reminder");
    console.log(`[PAIR ${pair}] propose tools=${JSON.stringify(propose.tools_used)} reply=${JSON.stringify(propose.reply.slice(0, 200))}`);

    // A propose must NEVER write — prove the DB is untouched right after the first one.
    if (pair === 1) {
      expect(propose.http, "propose turn HTTP status").toBe(200);
      const afterPropose = (await recheckDb(supa, "medications", { id: medId }))[0]
        .schedule as { frequency?: string; days?: string[] };
      expect(afterPropose.frequency, "propose must not write — still daily").toBe("daily");
      expect(afterPropose.days, "propose must not write — no weekday restriction yet").toBeUndefined();
    }

    confirm = await agentTurn8901(jwt, CONFIRM_PHRASE);
    saveTurnArtifact(ARTIFACTS, `pair${pair}-confirm`, confirm);
    console.log(`[PAIR ${pair}] confirm tools=${JSON.stringify(confirm.tools_used)}`);
    action = confirm.actions.find(a => a.tool === "set_medication_reminder") as TurnAction | undefined;
    if (daysMatch(action)) break;
  }

  expect(proposeRouted, "at least one propose routed to set_medication_reminder").toBe(true);
  expect(confirm!.http, "confirm turn HTTP status").toBe(200);
  expect(confirm!.tools_used, "confirm routed to set_medication_reminder").toContain("set_medication_reminder");
  expect(action, "confirm committed a set_medication_reminder action").toBeTruthy();
  expect(action!.entity_type, "committed entity_type is a schedule change").toBe("schedule_entry");
  expect(action!.entity_id, "committed entity_id is the seeded med uuid").toBe(medId);
  expect(action!.changed_fields?.days?.after, "committed days diff → Mon–Fri").toEqual(WEEKDAYS);

  // ── 3 RE-CHECK ────────────────────────────────────────────────────────────
  // Independent Supabase re-read — the DB is the truth, not the turn's reply.
  const rows = await recheckDb(supa, "medications", { id: medId });
  const stored = rows[0].schedule as { times?: string[]; frequency?: string; days?: string[] };
  console.log(`[RE-CHECK] stored schedule = ${JSON.stringify(stored)}`);
  expect(stored.days, "stored weekday encoding").toEqual(WEEKDAYS);
  expect(stored.frequency, "stored frequency is weekly").toBe("weekly");
  expect(stored.times?.length ?? 0, "a reminder time is retained on the weekly schedule").toBeGreaterThan(0);

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  await signIn(page, creds); // baseURL :5173, lands on Home
  await page.locator('[data-tour="nav-ai"]').click(); // start on the AI tab…
  await resetPhaseLog(page); // clear BEFORE the highlight phase under test
  // Fire the REAL committed action: ChangeHighlight auto-navigates AI →
  // Prescriptions, rings the med card (schedule_entry resolves to medication-<id>
  // via the "-{id}" suffix fallback), and shows the diff caption.
  await page.evaluate((a) => {
    (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a);
  }, action as unknown as Record<string, unknown>);

  const card = page.locator(`[data-testid="medication-${medId}"]`);
  await expect(card, "med card ringed").toHaveClass(/change-highlight/, { timeout: 10_000 });
  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption, "diff caption visible").toBeVisible();
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  const captionText = ((await caption.textContent()) ?? "").replace(/\s+/g, " ").trim();
  console.log(`[CAPTION] ${JSON.stringify(captionText)}`);
  // Caption reflects the WEEKDAY change — an "Updated" diff naming the days, never a
  // generic success or a mislabelled "Added".
  expect(captionText, "caption is an Updated diff").toContain("Updated:");
  expect(captionText.toLowerCase(), "caption names the days field").toContain("days");
  expect(captionText.toLowerCase(), "caption spells out the weekday pattern (mon…fri)").toContain("mon");
  expect(captionText.toLowerCase()).toContain("fri");

  // PATCH-QUEUE FINDING (recorded, NOT asserted): does the card itself render the
  // weekday pattern? It renders the time chip + "once a day" but drops the days.
  const cardText = ((await card.textContent()) ?? "").replace(/\s+/g, " ");
  const cardShowsWeekdays = /weekday|mon(day)?\b|mon[, –-]/i.test(cardText);
  console.log(`[UI-FINDING] Prescriptions card renders the weekday pattern = ${cardShowsWeekdays}; cardText=${JSON.stringify(cardText.slice(0, 200))}`);

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  await page.screenshot({ path: `${SHOTS}/weekday-pattern-ringed.png`, fullPage: true });

  // Let the highlight dwell run to completion so its phase-log entry is recorded
  // (recordDwell fires at auto-dismiss, HIGHLIGHT_DWELL_MIN_MS after the ring shows).
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
  // All timing via PACING above; the only literal is the 500ms scroll-settle wait.
});
