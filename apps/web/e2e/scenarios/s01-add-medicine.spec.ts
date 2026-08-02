import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  expectRow, readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact, signIn,
  startWalkthrough, tapWalkthroughNext, advanceWalkthroughUntil, finishWalkthrough,
} from "../helpers";
import type { TurnResult } from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s01 add-medicine — AUDIT. Elder tells Mei about a new prescription; the soul
// contract is propose (add_prescription, confirmed=false) → confirm → queue the
// add_prescription_auto walkthrough (NOT a direct write — the walkthrough saves
// it). This spec proves that contract with real turns, then drives the built
// walkthrough deterministically and audits it against the PACING minimums.
const ARTIFACTS = "e2e/artifacts/s01";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s01"; // durable, NOT wiped

test("s01 add-medicine: 'new medicine — Lisinopril, 10mg' -> propose→confirm queues add_prescription_auto, walkthrough saves it", async ({ page }) => {
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

  // ── 2 TRIGGER ─────────────────────────────────────────────────────────────
  // ONE real conversation (hermes holds session state across turns for this
  // elder). The soul contract is propose (add_prescription, confirmed=false) →
  // confirm → queue add_prescription_auto — NEVER a direct confirmed=true write
  // on web. The opening phrase omits frequency, so per rail 3 the agent asks for
  // it before proposing; we answer, then confirm. Every raw turn is saved; the
  // confirm is retried ≤3× for routing variance.
  const OPENING = "The doctor gave me a new medicine — Lisinopril, 10mg, for blood pressure";
  const FREQUENCY = "Once a day, in the morning";
  const CONFIRM = "yes please";

  const turns: TurnResult[] = [];
  let proposeSeen = false;     // add_prescription routed with NO committed write
  let committedWrite = false;  // a confirmed=true direct write (web contract violation)
  let queued: TurnResult["walkthrough"] = null;

  const send = async (label: string, msg: string): Promise<TurnResult> => {
    const t = await agentTurn8901(jwt, msg);
    turns.push(t);
    saveTurnArtifact(ARTIFACTS, `turn-${String(turns.length).padStart(2, "0")}-${label}`, t);
    expect(t.http, `${label} HTTP`).toBe(200);
    const wroteMed = t.actions.some(a => a.tool === "add_prescription");
    if (t.tools_used.includes("add_prescription") && !wroteMed) proposeSeen = true;
    if (wroteMed) committedWrite = true;
    if (t.walkthrough?.task_name === "add_prescription_auto") queued = t.walkthrough;
    console.log(`[TRIGGER] ${label}: tools=${JSON.stringify(t.tools_used)} actions=${JSON.stringify(t.actions.map(a => a.tool))} walk=${JSON.stringify(t.walkthrough)}`);
    return t;
  };

  await send("opening", OPENING);
  if (!queued) await send("frequency", FREQUENCY);
  for (let i = 1; i <= 3 && !queued; i++) await send(`confirm-${i}`, CONFIRM);
  console.log(`[TRIGGER] ${turns.length} turn(s); proposeSeen=${proposeSeen} committedWrite=${committedWrite} params=${JSON.stringify(queued?.params)}`);

  // SCAN PROPOSES, NEVER COMMITS: the drug was proposed (confirmed=false, no
  // committed write action) at some point in the exchange...
  expect(proposeSeen, "add_prescription was PROPOSED (confirmed=false, no committed write)").toBe(true);
  // ...the chat NEVER commits the write itself (the walkthrough saves it)...
  expect(committedWrite, "chat must not commit the write directly on web").toBe(false);
  // ...and the confirm queued the app walkthrough with the real values.
  expect(queued?.task_name, "confirm queues add_prescription_auto").toBe("add_prescription_auto");
  expect(queued?.params?.name, "walkthrough carries the drug name").toBe("Lisinopril");

  // ── 3 RE-CHECK (post-trigger) ─────────────────────────────────────────────
  // Independent DB read: the propose→confirm exchange queued a walkthrough but
  // committed NOTHING — the write happens only when the UI walkthrough runs.
  const afterTrigger = await recheckDb(supa, "medications", { elder_id: creds.userId });
  expect(afterTrigger, "propose→confirm writes NO medication (the walkthrough saves it)").toHaveLength(0);

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  await signIn(page, creds); // baseURL :5173
  await resetPhaseLog(page); // clear BEFORE the phase under test

  // Drive the walkthrough deterministically with the patient's real values.
  await startWalkthrough(page, "add_prescription_auto", { name: "Lisinopril", dose: "10mg", purpose: "blood pressure" });

  // Form opens (Act: open), then the first field fills. The name value lands at
  // ~10 chars × FILL_MS_PER_CHAR, well under the FIELD_MIN_MS floor, so at this
  // instant the field phase minimum has NOT elapsed.
  // Autonomous steps no longer advance on their own — each holds at its commit
  // gate until the person taps Next — so commit step 1 (open the form) first.
  const nextBtn = page.getByRole("button", { name: /^(Next|Done)$/ });
  await expect(nextBtn, "Next exists on autonomous steps").toBeVisible({ timeout: 15_000 });
  await tapWalkthroughNext(page);

  // Probe (once): Next is DISABLED before the phase minimum (canAdvance stays
  // false until FIELD_MIN_MS), so it can't rush the fill. Probed at the START
  // of the fill — the pre-highlight ring is the phase's own opening beat, which
  // gives the whole FIELD_MIN_MS window. Probing after the value landed left
  // only the few hundred ms between "typing done" and "floor elapsed", which
  // was inherently racy once the trailing between-fields pause was removed.
  const nameInput = page.locator('[data-walk="rx-name"] input');
  await page.waitForSelector('[data-walk="rx-name"] input.walk-field-prehighlight', { state: "attached", timeout: 15_000 });
  await expect(nextBtn, "Next disabled before the phase minimum").toBeDisabled();

  await expect(nameInput).toHaveValue("Lisinopril", { timeout: 15_000 });

  // SCREENSHOT: mid-fill (form open, name filled).
  await page.screenshot({ path: `${SHOTS}/1-mid-fill.png`, fullPage: true });

  // Fills done → the run PAUSES at the manual-Save confirm step (waitFor, no
  // Next) — nothing commits on autopilot (2026-07-28 contract). The person
  // reviews, then taps Save THEMSELVES. Wait for the confirm callout (proves the
  // step's click listener is attached) before tapping, so the tap satisfies the
  // waitFor, not just the form. Then Submit → Verify (real re-query) → Reveal on
  // the Home timeline; the sheet closes on a proven save and the new dose shows
  // on Home with its "Just added" highlight.
  await advanceWalkthroughUntil(page, () => page.getByText("tap Save yourself", { exact: false }).isVisible());
  await expect(page.getByText("tap Save yourself", { exact: false }), "manual-Save confirm step reached").toBeVisible({ timeout: 25_000 });

  // The review card: what Mei typed, shown in the callout so the person can
  // actually CHECK it before committing. It must render on this waitFor step.
  await expect(page.getByText("Please check these details"), "review card on the confirm step").toBeVisible();
  await expect(page.getByRole("button", { name: "Change something" }), "Change affordance").toBeVisible();
  await expect(nextBtn, "consent step still has NO Next").toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/1b-review-card.png`, fullPage: true });

  const submitBtn = page.locator('[data-walk="rx-submit"]');
  await expect(submitBtn, "Save enabled once every field is filled").toBeEnabled();
  await submitBtn.click(); // the real user tap — the sanctioned end of a *_auto flow
  await expect(submitBtn, "sheet closes on a proven save").toBeHidden({ timeout: 25_000 });
  const homeTimeline = page.locator('[data-tour="elder-schedule"]');
  await expect(homeTimeline.getByText("Lisinopril", { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(homeTimeline.getByText("Just added", { exact: false }), "‘Just added’ highlight on the new dose").toBeVisible();

  // SCREENSHOT: reveal-on-Home.
  await page.screenshot({ path: `${SHOTS}/2-reveal-on-home.png`, fullPage: true });

  // The verify/reveal tail is autonomous, so it too holds at its commit gate —
  // the last step's button reads "Done". Tap through to finish; then the overlay
  // unmounts and the phase log (incl. the reveal phase) is complete.
  await finishWalkthrough(page);
  await expect(nextBtn, "overlay unmounts on completion").toHaveCount(0, { timeout: 15_000 });

  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  const log = await readPhaseLog(page);
  const wt = log.filter(e => e.surface === "walkthrough");
  const lastOf = (phase: string) => [...wt].reverse().find(e => e.phase === phase);
  for (const phase of ["navigate", "field", "between-fields", "click", "verify", "reveal"]) {
    const e = lastOf(phase);
    if (e) console.log(`[PACING] ${phase}: min=${e.minMs}ms measured=${(e.endedAt - e.startedAt).toFixed(0)}ms`);
  }
  console.log(`[PACING] field fills=${JSON.stringify(wt.filter(e => e.phase === "field").map(e => +(e.endedAt - e.startedAt).toFixed(0)))}`);

  // Standard minimums (assertPhaseMins uses the LAST entry per phase + jitter slack).
  assertPhaseMins(log, [
    { surface: "walkthrough", phase: "field", min: PACING.FIELD_MIN_MS },
    { surface: "walkthrough", phase: "click", min: PACING.PRE_CLICK_MS },
    { surface: "walkthrough", phase: "verify", min: PACING.VERIFY_MIN_MS },
    { surface: "walkthrough", phase: "reveal", min: PACING.REVEAL_PULSE_MS },
  ]);

  // "field ≥ FIELD_MIN_MS on EACH fill": three fills (name, dose, purpose), and
  // each one floored. Re-slice the log so each field is the last entry, and let
  // the sanctioned helper (with its internal slack) check every occurrence.
  const fieldIdxs = log
    .map((e, i) => ({ e, i }))
    .filter(x => x.e.surface === "walkthrough" && x.e.phase === "field")
    .map(x => x.i);
  expect(fieldIdxs, "three field fills paced (name, dose, purpose)").toHaveLength(3);
  for (const i of fieldIdxs) {
    assertPhaseMins(log.slice(0, i + 1), [{ surface: "walkthrough", phase: "field", min: PACING.FIELD_MIN_MS }]);
  }

  // ── 5 RE-CHECK (post-UI) ──────────────────────────────────────────────────
  // The walkthrough's own "Saved" is never trusted — re-read the DB. Exactly one
  // Lisinopril row, with the dose + purpose the walkthrough filled.
  const medRows = await recheckDb(supa, "medications", { elder_id: creds.userId });
  expectRow(medRows, { name: "Lisinopril", dosage: "10mg", purpose: "blood pressure" });
});
