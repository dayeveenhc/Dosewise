import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins,
  expectRow, readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact,
} from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s23 caregiver-care-note (NEW-BE-FE) — a caregiver tells Mei to save a
// care-log note; add_care_note commits IMMEDIATELY under the CAREGIVER'S OWN
// id (services/hermes/api/routes.py derives elder_id from the JWT sub — no
// act-on-behalf-of exists for a caregiver-authenticated turn, so
// ToolContext.elder_id IS the caregiver here) -> the note lands in the
// caregiver's OWN conversation_turns row and renders in their OWN Messages
// thread, ringed. This is the first scenario to drive the caregiver-side
// ChangeHighlight plumbing live.
const ARTIFACTS = "e2e/artifacts/s23";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s23"; // durable, NOT wiped
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CaregiverCreds { email: string; password: string; userId: string }

// helpers.ts has no standalone "just a caregiver, no elder link" signup —
// createCaregiverWithPendingLink always ties one to an elder via a care_links
// insert, which this scenario doesn't need (add_care_note never touches
// care_links). Mirrors createThrowawayElder exactly, with role: "caregiver".
async function createThrowawayCaregiver(): Promise<CaregiverCreds> {
  const supa = anonClient();
  const email = `tw-cg-${Date.now()}-${Math.floor(performance.now())}@dosewise.test`;
  const password = "Throwaway!2026";
  const { data, error } = await supa.auth.signUp({ email, password });
  if (error || !data.user) throw new Error(`caregiver signUp failed: ${error?.message}`);
  const { error: pErr } = await supa.from("profiles").insert({ id: data.user.id, role: "caregiver", full_name: "Tan Wei (test)" });
  if (pErr) throw new Error(`caregiver profile seed failed: ${pErr.message}`);
  return { email, password, userId: data.user.id };
}

// helpers.ts's exported signIn() waits for window.__dwStartWalkthrough, a hook
// only ever registered by the ELDER shell (ElderlyApp.tsx's DEV-only effect).
// A caregiver-role login never mounts that shell (App.tsx routes appMode
// "caregiver" instead), so the shared helper would hang out its 20s timeout for
// this account. Same login FORM (LoginScreen) either way — only the routed
// destination differs — so drive the identical clicks and wait on a
// caregiver-shell-only readiness signal instead: the bottom nav only renders
// once App.tsx's caregiver branch has mounted.
async function signInCaregiver(page: Page, creds: CaregiverCreds) {
  await page.goto("/");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator('input[type="email"]').fill(creds.email);
  await page.locator('input[type="password"]').fill(creds.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForSelector('[data-tour="nav-ai"]', { timeout: 20_000 });
}

test("s23 caregiver-care-note: 'Note for the care log: Mom seemed more tired than usual today' -> add_care_note commits to the CAREGIVER'S OWN thread, ringed in Messages", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // A throwaway CAREGIVER account — no elder, no care_links row. add_care_note
  // writes to whatever id the JWT authenticates as, so this scenario needs
  // nothing else seeded.
  const creds = await createThrowawayCaregiver();
  const supa = anonClient();
  const { data: signInData, error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  const jwt = signInData!.session!.access_token;

  // ── 2 TRIGGER ─────────────────────────────────────────────────────────────
  // Verbatim realistic phrase; ≤3 recorded attempts for LLM-routing variance.
  const PHRASE = "Note for the care log: Mom seemed more tired than usual today";
  let turn = await agentTurn8901(jwt, PHRASE);
  saveTurnArtifact(ARTIFACTS, "turn-attempt-1", turn);
  for (let attempt = 2; attempt <= 3 && !turn.tools_used.includes("add_care_note"); attempt++) {
    console.log(`[TRIGGER] attempt ${attempt} (previous tools_used=${JSON.stringify(turn.tools_used)})`);
    turn = await agentTurn8901(jwt, PHRASE);
    saveTurnArtifact(ARTIFACTS, `turn-attempt-${attempt}`, turn);
  }
  expect(turn.http, "agent/turn HTTP status").toBe(200);
  expect(turn.tools_used, "expected tool routed").toContain("add_care_note");
  const action = turn.actions.find(a => a.tool === "add_care_note");
  expect(action, "committed add_care_note action present (immediate, no confirm)").toBeTruthy();
  expect(action!.entity_type, "committed entity_type").toBe("care_note");
  expect(action!.entity_id, "entity_id is the new conversation_turns row uuid").toMatch(UUID_RE);
  const noteId = action!.entity_id!;
  expect(action!.changed_fields?.note, "changed_fields.note diff present").toBeTruthy();
  expect(action!.changed_fields!.note!.before, "note is new (before null)").toBeNull();
  const savedNote = String(action!.changed_fields!.note!.after ?? "");
  expect(savedNote, "note captures what was actually said").toMatch(/tired/i);
  console.log(`[TRIGGER] committed action=${JSON.stringify(action)}`);

  // ── 3 RE-CHECK ────────────────────────────────────────────────────────────
  // Independent Supabase re-read — the DB is the truth, not the turn's reply.
  // Filtered by the CAREGIVER's own id (conversation_turns.elder_id holds it,
  // per routes.py's JWT-sub derivation — there is no elder in this scenario at
  // all) + tool=add_care_note.
  // NOTE: this filter also matches a SECOND row every time — see the "known
  // issue" in this scenario's report: agent/loop.py's _persist() tags the
  // per-turn assistant-reply memory log with tool=tools_used[-1], so the
  // bot's own confirmation sentence ALSO gets tool="add_care_note" and shows
  // up alongside the real note. expectRow's exact `id` match still isolates
  // the real row deterministically; this is flagged, not silently worked
  // around.
  const rows = await recheckDb(supa, "conversation_turns", { elder_id: creds.userId, tool: "add_care_note" });
  const row = expectRow(rows, { id: noteId, speaker: "system" });
  expect(row.transcript, "stored transcript matches the committed changed_fields.after").toBe(savedNote);

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  await signInCaregiver(page, creds); // baseURL :5173, lands on the caregiver Dashboard
  await resetPhaseLog(page); // clear BEFORE the highlight phase under test
  // Fire the REAL committed action (real conversation_turns uuid) through the
  // caregiver shell's dev hook — mirrors every sibling scenario's pattern
  // (e.g. s05/s21), decoupled from a second live LLM call. care_note's
  // caregiver target is "messages" (changeHighlight.ts ENTITY_TARGETS), and the
  // Dashboard we land on is not it, so this also proves the auto-navigate.
  //
  // BLOCKED: window.__dwHighlightChange is registered ONLY by
  // src/app/screens/elderly/ElderlyApp.tsx's DEV-only effect (the elder
  // shell) — App.tsx's caregiver branch mounts <ChangeHighlight
  // mode="caregiver"> and wires AskMeiScreen's onHighlightChange={
  // setHighlightChange} (real chat turns work), but never registers this
  // hook, so this call throws "window.__dwHighlightChange is not a
  // function" for a caregiver session. Confirmed empirically (see report)
  // and by grep: no occurrence of __dwHighlightChange outside
  // ElderlyApp.tsx. Patch-queued: mirror ElderlyApp.tsx's
  // useEffect(() => { ... window.__dwHighlightChange = setHighlightChange
  // ... }, []) into App.tsx's caregiver render branch. Left as-written
  // (matching the sibling pattern) so this spec goes green the moment
  // that hook lands — no further edit needed here.
  await page.evaluate(a => {
    (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a);
  }, action!);

  const note = page.locator(`[data-testid="care_note-${noteId}"]`);
  await expect(note, "care note ringed in Messages").toHaveClass(/change-highlight/, { timeout: 10_000 });
  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption, "highlight caption visible").toBeVisible();
  await expect(caption, "caption reads as a new note (all-new field -> 'Added')").toContainText("Added:");
  await expect(caption, "caption carries the note content").toContainText(/tired/i);
  await page.waitForTimeout(500); // let smooth scrollIntoView settle

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  await page.screenshot({ path: `${SHOTS}/care-note-ringed.png`, fullPage: true });
  await note.screenshot({ path: `${SHOTS}/care-note-closeup.png` });

  // PACING: the highlight dwells ≥ HIGHLIGHT_DWELL_MIN_MS before auto-dismiss.
  // recordDwell fires at auto-dismiss, HIGHLIGHT_DWELL_MIN_MS after the ring
  // shows, so wait for the dwell entry to land before reading the log.
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
  // All experience timing flows through PACING above; the only bare literal is
  // the 500ms scroll-settle wait (with its required comment). The 10s/15s/20s/
  // 120s values are Playwright deadlines, not UI pacing.
});
