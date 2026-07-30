import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  readPhaseLog, recheckAccessibility, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import type { TurnAction } from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s12 snooze-today (NEW-BE-FE) — "Remind me about my metformin in 30 minutes"
// -> snooze_dose moves TODAY's reminder for that dose to now+30min IMMEDIATELY
// (a one-time snooze needs no propose→confirm), writing a date-stamped entry to
// profiles.accessibility.dose_snoozes (read-merge-write). This is NOT a schedule
// edit — medications.schedule is untouched (that would be set_medication_reminder).
// The Home medication card rings "Snoozed: reminder to <time> today" and shows a
// "Snoozed until <time>" chip.
const ARTIFACTS = "e2e/artifacts/s12";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s12"; // durable, NOT wiped

// Pin the browser to the elder timezone Hermes reasons in (Asia/Singapore, UTC+8,
// no DST). The Home snooze chip only renders when the snooze entry's `date` — which
// Hermes writes in SGT — equals the browser's local date, and the slot/now logic
// must agree with the backend. A UTC test box drifts both near the 16:00-UTC date
// boundary; pinning SGT makes the frontend's "today" identical to Hermes's.
test.use({ timezoneId: "Asia/Singapore" });

// SGT wall-clock date (YYYY-MM-DD) — matches Hermes's local_date.isoformat() and,
// under the timezoneId above, the browser's own local date.
function sgtTodayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// "15:00" -> "3:00 PM", matching BOTH changeHighlight.hhmmTo12h (caption) and
// ElderlyHomeScreen.minutesToClock (chip): no leading-zero hour, 2-digit minute.
function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

test("s12 snooze-today: 'Remind me about my metformin in 30 minutes' -> today-only snooze written (schedule untouched); Home card ringed 'Snoozed:' + 'Snoozed until' chip", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // Throwaway elder + Metformin scheduled daily at 09:00 SGT — one due/upcoming
  // slot today for the snooze to target. NO dose is logged, so the Home card is a
  // normal (non-taken) reminder card, which is the variant that renders the chip.
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
              purpose: "blood sugar", schedule: { times: ["09:00"], frequency: "daily" } })
    .select("id")
    .single();
  expect(mErr, mErr?.message).toBeNull();
  const medId: string = med!.id;
  console.log(`[FIXTURE] elder=${creds.userId} med=${medId}`);

  // ── 2 TRIGGER ─────────────────────────────────────────────────────────────
  // ONE turn — snooze_dose commits IMMEDIATELY (a one-time snooze, no confirm). A
  // retry is safe: the write is a read-merge-write keyed on (med, slot, date), so
  // re-snoozing replaces the same entry rather than duplicating it.
  const PHRASE = "Remind me about my metformin in 30 minutes";
  let turn = await agentTurn8901(jwt, PHRASE);
  saveTurnArtifact(ARTIFACTS, "turn-attempt-1", turn);
  for (let attempt = 2; attempt <= 3 && !turn.actions.some(a => a.tool === "snooze_dose"); attempt++) {
    console.log(`[TRIGGER] attempt ${attempt} (previous tools_used=${JSON.stringify(turn.tools_used)})`);
    turn = await agentTurn8901(jwt, PHRASE);
    saveTurnArtifact(ARTIFACTS, `turn-attempt-${attempt}`, turn);
  }
  expect(turn.http, "agent/turn HTTP status").toBe(200);
  expect(turn.tools_used, "expected snooze_dose routed").toContain("snooze_dose");
  // TODAY-ONLY, not permanent: the schedule-editing tool must NOT be involved.
  expect(turn.tools_used, "must NOT route the permanent-schedule tool").not.toContain("set_medication_reminder");

  const action = turn.actions.find(a => a.tool === "snooze_dose") as TurnAction | undefined;
  expect(action, "snooze_dose committed action present on the SAME turn (immediate, no confirm)").toBeTruthy();
  expect(action!.entity_type, "committed entity_type").toBe("dose");
  expect(action!.entity_id, "committed entity_id is the MEDICATION uuid").toBe(medId);
  expect(action!.name, "committed medication name").toBe("Metformin");
  // The change is a reminder move (snoozed_until), NOT a schedule/times diff.
  const snoozedUntil = action!.changed_fields?.snoozed_until;
  expect(snoozedUntil?.before, "first snooze — before is null").toBeNull();
  const until = String(snoozedUntil?.after ?? "");
  expect(until, "after is an HH:MM local time").toMatch(/^\d{2}:\d{2}$/);
  const slot = String(action!.slot ?? "");
  expect(slot, "target slot is an HH:MM local time").toMatch(/^\d{2}:\d{2}$/);
  // Reply reads as a ONE-TIME/today-only snooze (the tool output says so; the
  // deterministic today-only proof is the DB re-check + tool routing below).
  expect(turn.reply.toLowerCase(), "reply conveys a today-only/one-time snooze")
    .toMatch(/today|one[- ]?time|just this|schedule.*(unchanged|same|stays)/);
  console.log(`[TRIGGER] committed action=${JSON.stringify(action)} reply="${turn.reply}"`);

  // ── 3 RE-CHECK ────────────────────────────────────────────────────────────
  // Independent Supabase re-read — the DB is the truth. The snooze landed in
  // profiles.accessibility.dose_snoozes as one date-stamped entry for TODAY, and
  // medications.schedule is UNCHANGED — proving a today-only reminder move, not a
  // permanent schedule edit.
  const snoozes = (await recheckAccessibility(supa, creds.userId, "dose_snoozes")) as
    Array<{ medication_id?: string; slot?: string; date?: string; until?: string; name?: string }> | undefined;
  expect(Array.isArray(snoozes), "dose_snoozes is an array").toBe(true);
  const entry = (snoozes ?? []).find(s => s.medication_id === medId && s.date === sgtTodayIso());
  expect(entry, `a dose_snoozes entry for med ${medId} dated ${sgtTodayIso()}`).toBeTruthy();
  expect(entry!.until, "stored until matches the committed action").toBe(until);
  expect(entry!.slot, "stored slot matches the committed action").toBe(slot);
  const { data: medAfter } = await supa.from("medications").select("schedule").eq("id", medId).single();
  expect((medAfter?.schedule as { times?: string[] } | null)?.times, "schedule.times UNTOUCHED (not a permanent change)")
    .toEqual(["09:00"]);

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  const twelve = to12h(until);
  await signIn(page, creds); // baseURL :5173, lands on Home (doseSnoozes already loaded)
  await page.locator('[data-tour="nav-ai"]').click(); // start on the AI tab (renders no med cards)…
  await resetPhaseLog(page); // clear BEFORE the highlight phase under test
  // Fire the REAL committed action: ChangeHighlight auto-navigates AI → Home,
  // finds the medication card (dose entity_id → medication-{id}), rings it, and
  // shows the "Snoozed:" caption.
  await page.evaluate((a) => {
    (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a);
  }, action as unknown as Record<string, unknown>);

  const card = page.locator(`[data-testid="medication-${medId}"]`);
  await expect(card, "med card ringed").toHaveClass(/change-highlight/, { timeout: 10_000 });
  // The one-time snooze chip (driven by patient.doseSnoozes for today's date) is
  // on the card — display-only proof the reminder moved; the schedule is unchanged.
  await expect(card.getByText(`Snoozed until ${twelve}`), "'Snoozed until <time>' chip visible on the card").toBeVisible();

  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption, "snooze caption visible").toBeVisible();
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  const captionText = ((await caption.textContent()) ?? "").replace(/\s+/g, " ").trim();
  console.log(`[UI] caption="${captionText}" chip="Snoozed until ${twelve}"`);
  expect(captionText, "caption is the snooze verb + moved-reminder detail — never 'Added'/'Updated'")
    .toBe(`Snoozed: reminder to ${twelve} today`);

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  await page.screenshot({ path: `${SHOTS}/snooze-ringed.png`, fullPage: true });
  await page.screenshot({ path: `${SHOTS}/snooze-caption.png` });

  // PACING: the highlight dwells ≥ HIGHLIGHT_DWELL_MIN_MS before auto-dismiss.
  // recordDwell fires at auto-dismiss, HIGHLIGHT_DWELL_MIN_MS after the ring shows,
  // so wait for the dwell entry to land before reading the log.
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
  // All experience timing flows through PACING above; the only bare literal is the
  // 500ms scroll-settle wait (with its required comment). The 10s/15s/120s values
  // are Playwright deadlines, not UI pacing.
});
