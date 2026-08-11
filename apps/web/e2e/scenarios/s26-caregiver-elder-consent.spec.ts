import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  anonClient, assertPhaseMins, createCaregiverWithPendingLink, createThrowawayElder,
  expectRow, readPhaseLog, recheckDb, resetPhaseLog, signIn, startWalkthrough,
  tapWalkthroughNext, finishWalkthrough,
} from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s26 caregiver-elder-consent (CONSENT, taskName "accept_caregiver_link",
// tools: [] — no hermes tool routes this walkthrough, so there is no chat
// TRIGGER phrase to send; it is started the same way the app's own proactive
// navigation would, via the dev bridge). Promotes/supersedes
// e2e/accept-caregiver-link.spec.ts (left untouched) into the sNN template.
//
// THE consent guarantee under test: Mei may autonomously NAVIGATE the elder to
// the pending request (step "acceptLink.open" — has `act`), but the ELDER must
// tap Accept THEMSELVES (step "acceptLink.accept" — `waitFor: write-committed`,
// NO `act` — which is what actually guarantees consent (no act => not
// autonomous => no Next button at all). Read directly off
// src/app/lib/walkthrough/steps/accept_caregiver_link.ts, READ-ONLY). Mei never
// auto-grants account access. Only after that real, RLS-enforced write does the
// final act-less step ("acceptLink.verify") re-query care_links to confirm the
// link is really active before the walkthrough can claim success.
//
// Also audited precisely (never assumed): Walkthrough.tsx's
// `autonomous = !!(step.act || (!step.waitFor && (step.verify || step.reveal)))`
// gates the whole Next/Replay button block. That makes step1 autonomous (it
// HAS an act) -> Next DOES render; step2 is a pure waitFor (no act) ->
// autonomous is FALSE -> no Next ever renders; step3 is act-less but carries
// verify+reveal with no waitFor -> autonomous is TRUE again -> Next renders a
// second time. orchestrate.ts's runActStep also shows step1's
// `act.kind === "click"` records the phase name "click" (NOT "act" — only a
// bare select/upload act uses the literal "act" phase name), and step1 carries
// no verify/reveal, so its only two recorded phases are "navigate" (onEnter)
// and "click" (the act itself).

const SHOTS = "e2e/design-shots/scenarios/s26"; // durable, NOT wiped by --output

test("s26 caregiver-elder-consent: the elder's own tap (not Mei) flips care_links pending -> active", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  const elder = await createThrowawayElder();
  // The exact precondition helper for this flow: signs up a 2nd auth user (the
  // caregiver) + profile, then inserts a REAL pending care_links row AS that
  // caregiver — satisfying RLS's care_links_insert_as_caregiver
  // (auth.uid() = caregiver_id and status = 'pending', migration 0005).
  const { caregiverId } = await createCaregiverWithPendingLink(elder.userId);

  const supa = anonClient();
  const { error: sErr } = await supa.auth.signInWithPassword({ email: elder.email, password: elder.password });
  expect(sErr, sErr?.message).toBeNull();

  // Independent read of the fixture row (also captures its id for a precise
  // selector below — never lean on "there's only one pending row" alone).
  const fixtureRows = await recheckDb(supa, "care_links", { elder_id: elder.userId, caregiver_id: caregiverId });
  const linkRow = expectRow(fixtureRows, { status: "pending" });
  const linkId = linkRow.id as string;

  // ── 2 CONSENT PROOF (elder side, at new pacing) ────────────────────────────
  await signIn(page, elder); // baseURL :5173
  await resetPhaseLog(page); // clear BEFORE the phase under test
  await startWalkthrough(page, "accept_caregiver_link");

  // step1 (acceptLink.open) probe: autonomous (has `act`) -> per Walkthrough.tsx
  // the Next button DOES render (gated only on `autonomous && !phaseError`,
  // disabled until its own phase's minimum). It now HOLDS here until tapped
  // rather than auto-advancing, so the probe is no longer racing a window.
  const nextBtn = page.getByRole("button", { name: /^(Next|Done)$/ });
  await expect(nextBtn, "step1 HAS an act -> autonomous -> Next IS rendered").toBeVisible({ timeout: 15_000 });
  await tapWalkthroughNext(page);

  // step2 (acceptLink.accept): the pending-request card renders only once
  // fetchPendingLinkRequests resolves — a real Supabase round-trip. The
  // spotlight now keeps looking for it for MEASURE_TIMEOUT_MS and the step's
  // click listener re-attaches until it appears; before that, losing this race
  // left a black screen with no Exit and the tour stopped dead here.
  const accept = page.locator(`[data-walk="care-link-accept-${linkId}"]`);
  await expect(accept, "step2 accept button (this exact fixture row) visible").toBeVisible({ timeout: 15_000 });

  // step2 has NO `act` (confirmed by reading accept_caregiver_link.ts) -> per
  // Walkthrough.tsx `autonomous` is FALSE for it -> the whole Next/Replay block
  // never renders. Asserted precisely, not assumed.
  await expect(nextBtn, "step2 is a human waitFor (consent) step -> NO Next button").toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/1-awaiting-consent.png`, fullPage: true });

  // GUARDRAIL — independent recheckDb, BEFORE the tap: Mei's autonomous
  // navigation (step1) must not itself have touched the row. Still pending, no
  // honest error rendered, Accept still there.
  const stillPending = await recheckDb(supa, "care_links", { id: linkId });
  expect(stillPending, "exactly one row").toHaveLength(1);
  expect(stillPending[0].status, "still pending — Mei never auto-accepts").toBe("pending");
  await expect(page.getByText("I couldn't confirm that saved", { exact: false })).toHaveCount(0);
  await expect(accept).toBeVisible();

  // THE real human consent tap — Playwright simulates the elder's own click
  // (the overlay is pointer-events-none so a real tap reaches the button
  // beneath it exactly the same way a finger would).
  await accept.click();

  // step3 (acceptLink.verify) is act-less but autonomous (no waitFor, has
  // verify+reveal) -> Next renders again, this time for a much longer, easily
  // observable window (VERIFY_MIN_MS + REVEAL_PULSE_MS + dwell).
  await expect(nextBtn, "step3 is act-less but autonomous (verify+reveal, no waitFor) -> Next renders again").toBeVisible({ timeout: 10_000 });

  // Verify completes with no honest error; the consumed request card disappears
  // (ElderlyNotificationsScreen's own state update — independent of, and faster
  // than, the walkthrough engine's own reveal pacing below).
  await expect(page.getByText("I couldn't confirm that saved", { exact: false }), "no honest verify-failed error").toHaveCount(0, { timeout: 20_000 });
  await expect(accept, "consumed request card disappears on real activation").toHaveCount(0, { timeout: 20_000 });

  // Reveal phase: Replay is unique to it (Walkthrough.tsx renders it only while
  // paceState.phase === "reveal") — wait for it so the screenshot below really
  // captures the pulse/caption proof, not a moment before it existed.
  const replayBtn = page.getByRole("button", { name: "Replay", exact: true });
  await expect(replayBtn, "step3 reveal phase active").toBeVisible({ timeout: 20_000 });

  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  await page.screenshot({ path: `${SHOTS}/2-linked-active.png`, fullPage: true });

  // Complete deterministically via Next (only takes effect once reveal's OWN
  // REVEAL_PULSE_MS floor has elapsed — never before) instead of racing the
  // natural HIGHLIGHT_DWELL_MIN_MS auto-dismiss; this is also the last step, so
  // it ends the walkthrough. Doing this BEFORE reading the phase log matters:
  // recordPhase only fires once the reveal's paced() call resolves, and the
  // request-card removal above is driven by React state, not by the engine's
  // own pacing, so it does not by itself guarantee the reveal phase finished.
  await expect(nextBtn, "Next enabled once reveal's own pulse floor elapses").toBeEnabled({ timeout: 5_000 });
  await nextBtn.click();
  // That tap only ended the dwell. The final gate is TIMED now
  // (PACING.FINAL_AUTOCLOSE_MS, 2026-08-09): Done still ends it sooner, but
  // left alone the walkthrough closes itself — finishWalkthrough treats
  // either as completion. (Replay legitimately stays rendered through this
  // gate now, so its disappearance is no longer a phase marker here.)
  await finishWalkthrough(page);
  await expect(nextBtn, "walkthrough completed and the overlay unmounted").toHaveCount(0, { timeout: 10_000 });

  // Independent RE-CHECK: the ELDER's own tap — never Mei — flipped the row.
  await expect
    .poll(async () => {
      const rows = await recheckDb(supa, "care_links", { id: linkId });
      return rows[0]?.status;
    }, { timeout: 15_000 })
    .toBe("active");

  // ── 3 PACING ────────────────────────────────────────────────────────────
  const log = await readPhaseLog(page);
  const wt = log.filter(e => e.surface === "walkthrough");
  const countOf = (phase: string) => wt.filter(e => e.phase === phase).length;
  assertPhaseMins(log, [
    { surface: "walkthrough", phase: "navigate", min: PACING.NAVIGATE_MS },   // step1 onEnter
    { surface: "walkthrough", phase: "click", min: PACING.PRE_CLICK_MS },     // step1 act:click
    { surface: "walkthrough", phase: "verify", min: PACING.VERIFY_MIN_MS },   // step3 verify
    { surface: "walkthrough", phase: "reveal", min: PACING.REVEAL_PULSE_MS }, // step3 reveal
  ]);
  // Exact phase shape — no fill/between-fields anywhere in this flow, and each
  // of the four recorded phases fires exactly once (no Replay clicked, no step
  // re-run).
  expect(countOf("navigate"), "exactly one navigate (step1 onEnter)").toBe(1);
  expect(countOf("click"), "exactly one click (step1's act)").toBe(1);
  expect(countOf("verify"), "exactly one verify (step3)").toBe(1);
  expect(countOf("reveal"), "exactly one reveal (step3, no Replay clicked)").toBe(1);
  expect(countOf("field"), "no field phase (no fill act anywhere in this flow)").toBe(0);
  expect(countOf("act"), "no literal 'act'-named phase (step1's act is a click, not select/upload)").toBe(0);
  expect(countOf("between-fields"), "no between-fields phase").toBe(0);

  // ── 4 CAREGIVER-SIDE CONFIRMATION ──────────────────────────────────────────
  // The relationship is now mutual: the SAME row, looked up via the
  // CAREGIVER's own id column, also reads "active". (createCaregiverWithPendingLink
  // (helpers.ts) returns only { caregiverId } — no email/password/JWT — so this
  // spec cannot literally re-authenticate as that exact caregiver; PATCH-QUEUED
  // to the coordinator, see final report, to extend the helper's return shape
  // so a future revision can run this check under the caregiver's own session
  // too.) What IS independently verified here: (a) the identical row (matched
  // by id), looked up via the caregiver's own id column, is "active"; and (b)
  // RLS's care_links_select_party (supabase/migrations/0002_rls_policies.sql:
  // 71-74: `using (auth.uid() = elder_id or auth.uid() = caregiver_id)`) is
  // party-symmetric with NO status restriction on SELECT — so the caregiver's
  // own JWT is structurally guaranteed the identical read once status is
  // 'active'.
  const byCaregiver = await recheckDb(supa, "care_links", { caregiver_id: caregiverId, elder_id: elder.userId });
  const mutualRow = expectRow(byCaregiver, { status: "active" });
  expect(mutualRow.id, "same row (by id) confirms mutual, not a coincidental second link").toBe(linkId);

  // ── 5 SCREENSHOTS ── taken above: 1-awaiting-consent.png, 2-linked-active.png

  // ── 6 NO scenario-local ms literals ─── all timing via PACING above; the
  // only literal is the sanctioned 500ms settle wait, with its required comment.
});
