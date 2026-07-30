import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  expectRow, readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import type { TurnAction, TurnResult } from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s08 discontinue-med (NEW-BE-FE) — discontinue_medication propose→confirm on an
// EXISTING med. This is a STOP, never a delete: the commit sets archived=true and
// the row stays in the record (an independent re-read proves it still exists). The
// UI proof is the DISTINCT non-good-news treatment — the archived card renders as a
// muted "Stopped" row, ringed with the NON-emerald `.change-highlight-stopped`
// variant (NOT the emerald `.change-highlight` success ring), captioned
// "Stopped: Metformin". Same elder/session throughout: :8901 keeps session state
// per elder_id, so the confirm must land on the proposal this same elder made.
const ARTIFACTS = "e2e/artifacts/s08";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s08"; // durable, NOT wiped

test("s08 discontinue-med: 'stop taking my metformin — the doctor took me off it' -> propose→confirm archives (never deletes); card rings the non-emerald Stopped variant", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // A fresh throwaway elder with one ACTIVE Metformin 500mg (archived=false set
  // explicitly, so the "still active after propose" invariant is unambiguous).
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
              purpose: "blood sugar", archived: false,
              schedule: { times: ["08:00"], frequency: "daily" } })
    .select("id")
    .single();
  expect(mErr, mErr?.message).toBeNull();
  const medId: string = med!.id;

  // ── 2 TRIGGER (real :8901, propose→confirm, SAME elder/session) ─────────────
  // The model drives this as a safety dialog: the initial "stop my metformin"
  // request, then "yes" PROPOSES (reads the stop back, notes it STAYS as Stopped
  // and is never deleted, commits nothing), then a further "yes" COMMITS. It may
  // add a clarify turn first, so we advance the SAME session with bounded "yes"
  // replies (≤3 confirmations after the request; every raw turn saved), capturing
  // the propose turn and the commit turn wherever they land. dbAfterPropose is an
  // independent re-read taken right after the propose, BEFORE any commit — proving
  // the propose wrote nothing.
  const REQUEST = "I want to stop taking my metformin — the doctor took me off it";
  const YES = "yes";
  const MAX_CONFIRMATIONS = 3; // request + up to 3 "yes" turns absorbs a clarify-first turn

  let propose: TurnResult | undefined;               // read-back turn: tool used, nothing committed
  let dbAfterPropose: Record<string, unknown>[] | undefined;
  let confirm: TurnResult | undefined;               // the commit turn
  let committed: TurnAction | undefined;

  for (let i = 0; i <= MAX_CONFIRMATIONS && !committed; i++) {
    const phrase = i === 0 ? REQUEST : YES;
    const turn = await agentTurn8901(jwt, phrase);
    saveTurnArtifact(ARTIFACTS, `turn-${i + 1}-${i === 0 ? "request" : "yes"}`, turn);
    const usedTool = turn.tools_used.includes("discontinue_medication");
    const wrote = turn.actions.some(a => a.tool === "discontinue_medication");
    console.log(`[TURN ${i + 1}] phrase=${JSON.stringify(phrase)} tools=${JSON.stringify(turn.tools_used)} wrote=${wrote}`);
    if (usedTool && !wrote && !propose) {
      // First PROPOSE (read-back, no write). Snapshot the DB now — before any
      // commit turn — so "propose wrote nothing" is proven independently.
      propose = turn;
      dbAfterPropose = await recheckDb(supa, "medications", { id: medId });
    }
    if (wrote) {
      confirm = turn;
      committed = turn.actions.find(a => a.tool === "discontinue_medication") as TurnAction;
    }
  }

  // The PROPOSE — a discontinue_medication read-back that commits nothing.
  expect(propose, "a discontinue_medication PROPOSE (read-back, no write) occurred").toBeTruthy();
  expect(propose!.http, "propose turn HTTP status").toBe(200);
  expect(propose!.tools_used, "propose routed to discontinue_medication").toContain("discontinue_medication");
  expect(
    propose!.actions.find(a => a.tool === "discontinue_medication"),
    "propose committed NOTHING (no discontinue write in actions)",
  ).toBeFalsy();
  expect(propose!.reply, "propose reads the med name back").toMatch(/metformin/i);
  expect(
    propose!.reply,
    "propose notes it STAYS as Stopped / is not deleted",
  ).toMatch(/stop|record|history|delet|remov|keep|kept|remain/i);
  // Independent re-read taken right after the propose, before commit: still ACTIVE.
  expect(dbAfterPropose, "DB snapshot captured after the propose").toBeTruthy();
  expectRow(dbAfterPropose!, { id: medId, archived: false });

  // The CONFIRM — a further "yes" commits the archive.
  expect(confirm, "a subsequent confirm committed the discontinue").toBeTruthy();
  expect(confirm!.http, "confirm turn HTTP status").toBe(200);
  expect(confirm!.tools_used, "confirm routed to discontinue_medication").toContain("discontinue_medication");
  expect(committed, "confirm committed a discontinue action").toBeTruthy();
  expect(committed!.entity_type, "committed entity_type").toBe("medication");
  expect(committed!.entity_id, "committed entity_id is the seeded med").toBe(medId);
  expect(
    committed!.changed_fields?.status,
    "committed status diff active → discontinued",
  ).toEqual({ before: "active", after: "discontinued" });

  // ── 3 RE-CHECK (independent Supabase re-read — the DB is the truth) ──────────
  // The whole point of discontinue: the row is ARCHIVED, NEVER deleted. Re-select
  // by the exact seeded id — it must still EXIST, now with archived=true.
  const rows = await recheckDb(supa, "medications", { id: medId });
  expect(rows, "row still EXISTS — discontinue archives, never deletes").toHaveLength(1);
  expectRow(rows, { id: medId, archived: true });

  // ── 4 UI + PACING ───────────────────────────────────────────────────────────
  await signIn(page, creds); // baseURL :5173, lands on Home; archived med loads into pastMedications
  await page.locator('[data-tour="nav-ai"]').click(); // start on the AI tab…
  await resetPhaseLog(page); // clear BEFORE the highlight phase under test
  // Fire the REAL committed action from the confirm turn: ChangeHighlight
  // auto-navigates AI → Prescriptions, finds the muted Stopped row, rings it,
  // shows the caption.
  await page.evaluate((a) => {
    (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a);
  }, committed! as unknown as Record<string, unknown>);

  const card = page.locator(`[data-testid="medication-${medId}"]`);
  // The NON-emerald Stopped ring lands (waits out the async pastMedications refetch).
  await expect(card, "stopped card wears the .change-highlight-stopped ring").toHaveClass(/change-highlight-stopped/, { timeout: 10_000 });
  // DISTINCT-treatment proof: classList tokens are exact — "change-highlight-stopped"
  // is a SEPARATE token from "change-highlight". Capture both atomically while shown:
  // it must wear the stopped ring and must NOT ALSO wear the emerald success ring.
  const ringTokens = await card.evaluate((el) => ({
    stopped: el.classList.contains("change-highlight-stopped"),
    plain: el.classList.contains("change-highlight"),
  }));
  expect(ringTokens.stopped, "wears the NON-emerald .change-highlight-stopped ring").toBe(true);
  expect(ringTokens.plain, "must NOT wear the emerald success .change-highlight ring").toBe(false);

  // The card renders as a muted "Stopped" row: its name + the Stopped badge.
  await expect(card, "stopped card shows the med name").toContainText("Metformin");
  await expect(card.getByText("Stopped", { exact: true }), "muted Stopped badge visible on the card").toBeVisible();

  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption, "highlight caption visible").toBeVisible();
  await page.waitForTimeout(500); // let smooth scrollIntoView settle

  // ── 5 SCREENSHOT (durable — captures the Stopped-styled ringed card + caption) ─
  await page.screenshot({ path: `${SHOTS}/discontinue-stopped-ringed.png`, fullPage: true });

  // Caption reads the not-good-news verb, not a generic success: "Stopped: Metformin".
  const captionText = ((await caption.textContent()) ?? "").replace(/\s+/g, " ").trim();
  expect(captionText, "caption is the STOPPED verb + med name — never 'Updated'/'Added'").toBe("Stopped: Metformin");

  // Let the dwell run to completion so its phase-log entry is recorded (recordDwell
  // fires at auto-dismiss, HIGHLIGHT_DWELL_MIN_MS after the ring first showed).
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
