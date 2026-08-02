import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, readPhaseLog, recheckDb, resetPhaseLog, saveTurnArtifact,
} from "../helpers";

// s24 caregiver-link-new (AUDIT) — the CAREGIVER-role branch of the
// link_caregiver walkthrough (caregiverLinkRequestSteps in
// src/app/lib/walkthrough/steps/link_caregiver.ts, READ-ONLY here): a
// caregiver scans an elder's QR, optionally picks a relationship, and sends a
// pending care_links request. Owns: this spec file ONLY.
//
// No PACING import: every step in caregiverLinkRequestSteps is a waitFor
// step (no `act`), so Walkthrough.tsx's `autonomous` is always false here —
// no PaceController ever runs, so there is no PACING minimum to floor-check
// (see the phase-log assertion near the bottom, which asserts ABSENCE
// instead, mirroring s10's own zero-phases finding for request_refill).
//
// THREE FINDINGS surfaced while building this (all out of this scenario's
// file scope — patch-queued, not fixed here, since App.tsx/ScanLinkSheet.tsx
// are outside e2e/scenarios/s24-caregiver-link-new.spec.ts):
//
// (a) NO DEV HOOK FOR THE CAREGIVER SHELL. e2e/helpers.ts's signIn() /
// startWalkthrough() assume window.__dwStartWalkthrough, which is wired up
// ONLY inside ElderlyApp.tsx's own effect ("grep __dw src/app/App.tsx" = 0
// hits vs 4 in ElderlyApp.tsx). App.tsx's caregiver dashboard has its own
// full parallel walkthrough engine (handleWalkthroughStart/Advance/Verify/
// Reveal, mirroring ElderlyApp's) but never exposes it on window, so
// signIn()'s waitForFunction would simply hang for a caregiver account. The
// ONLY real path into caregiverLinkRequestSteps is a live Ask-Mei
// conversation through AskMeiScreen's onWalkthroughStart wiring
// (App.tsx:685) — so this spec signs in and starts the walkthrough locally
// rather than via the shared helpers, fusing the TRIGGER proof with the real
// UI drive for the part with no synthetic shortcut available.
//
// (b) link.cg.open-switcher (step 1) has no onEnter, unlike sibling
// request_refill's step 1 (s10), which does. Ask Mei (the only real entry
// point) lives on the "ai" screen; the patient switcher only renders on
// "dashboard"/"patient"/"timeline" (App.tsx's showPatientSwitcher). So right
// after the walkthrough queues, the spotlight has nothing to attach to —
// confirmed empirically: a bare black overlay with no callout/Exit button,
// because Walkthrough.tsx's measure() gives up retrying and nothing re-fires
// it once stepIndex stops changing. A real caregiver told "follow along in
// the app" would tap back to their home tab themselves; this spec performs
// that same real tap rather than treating it as a bypass.
//
// (c) A real, reproducible CRASH at step 3. ScanLinkSheet.tsx's camera
// effect depends on [phase, language]; when the camera fails to acquire
// (getUserMedia rejects — deterministic in this headless/camera-less box,
// but equally true for any real caregiver whose camera is denied/absent/
// busy), the .catch() flips phase to "error", which — being in the SAME
// effect's own dependency array — re-fires the effect's cleanup. That
// cleanup calls scanner.stop() on an instance that never reached "running",
// which html5-qrcode throws SYNCHRONOUSLY ("Cannot stop, scanner is not
// running or paused."). With no error boundary anywhere in the tree, this
// unmounts the ENTIRE app to a blank page. Reproduced deterministically
// across every run while building this spec — not merely "camera
// undriveable in headless Playwright" but a real bug that would strike any
// user whose camera fails to start.
const ARTIFACTS = "e2e/artifacts/s24";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s24"; // durable, NOT wiped

interface CaregiverCreds { email: string; password: string; userId: string }

// Adapted from helpers.ts's createThrowawayElder / the caregiver half of
// createCaregiverWithPendingLink — but with NO elder and NO care_links row:
// this scenario is the caregiver INITIATING a link, so there's nothing to
// link to yet.
async function createThrowawayCaregiver(name: string): Promise<CaregiverCreds> {
  const supa = anonClient();
  const email = `tw-cg-${Date.now()}-${Math.floor(performance.now())}@dosewise.test`;
  const password = "Throwaway!2026";
  const { data, error } = await supa.auth.signUp({ email, password });
  if (error || !data.user) throw new Error(`caregiver signUp failed: ${error?.message}`);
  const { error: pErr } = await supa.from("profiles").insert({ id: data.user.id, role: "caregiver", full_name: name });
  if (pErr) throw new Error(`caregiver profile seed failed: ${pErr.message}`);
  return { email, password, userId: data.user.id };
}

// Local sign-in: mirrors helpers.ts's signIn() form-filling exactly, but
// waits for the CAREGIVER dashboard's own real DOM landmark instead of
// __dwStartWalkthrough (Finding (a) above — that hook doesn't exist for this
// role, so re-using signIn() verbatim would hang for the full 20s timeout).
async function signInCaregiver(page: Page, creds: CaregiverCreds) {
  await page.goto("/");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator('input[type="email"]').fill(creds.email);
  await page.locator('input[type="password"]').fill(creds.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(SWITCHER), "caregiver dashboard landed").toBeVisible({ timeout: 20_000 });
}

// AskMeiScreen.tsx's send button carries no data-walk/testid — lucide-react's
// own stable class convention (createLucideIcon.js: `lucide-${kebabName}`,
// verified by reading node_modules/lucide-react/dist/esm/createLucideIcon.js)
// is the least-fragile selector available without editing that read-only file.
const SEND_BTN = "button:has(svg.lucide-send)";
const SWITCHER = '[data-tour="cg-patientswitcher"]';
const SCAN_QR_BTN = '[data-walk="patientswitcher-scan-qr"]';
const SCANNER = "#care-link-scanner";

const STEP1_TEXT = "Tap here to open the patient switcher.";
const STEP2_TEXT = "Tap Scan QR code";
const STEP3_TEXT = "Hold your camera up to the QR code";

// The consent-class invariant (mirrors s10's assertWaitForStep): a waitFor
// step never renders Next (Walkthrough.tsx gates Next/Replay on `autonomous`,
// always false here), only Exit — assert Exit present so the absence of
// Next is meaningful, not just "nothing rendered yet".
async function assertWaitForStep(page: Page, bodyText: string, label: string) {
  await expect(page.getByText(bodyText, { exact: false }), `${label}: callout body`).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), `${label}: Exit present`).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true }), `${label}: NO Next button (consent-class)`).toHaveCount(0);
}

// Send a chat message and wait for Mei's reply bubble to land — a real
// condition wait (agent-role message rows before/after), never a fixed sleep.
async function sendAndAwaitReply(page: Page, message: string) {
  const agentBubbles = page.locator("div.flex.justify-start.gap-2");
  const before = await agentBubbles.count();
  await page.locator("textarea").first().fill(message);
  await page.locator(SEND_BTN).click();
  await expect(agentBubbles, `reply to "${message}"`).toHaveCount(before + 1, { timeout: 25_000 });
}

const HINT = "I want to add another patient I'm caring for.";
const YES = "Yes, please show me.";
const MORE_EXPLICIT = "Yes — please show me how to scan their QR code now.";

test("s24 caregiver-link-new: caregiver Ask-Mei 'add another patient' -> caregiverLinkRequestSteps (no Next)", async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });

  const pageErrors: string[] = [];
  page.on("pageerror", err => pageErrors.push(err.message));

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // Two throwaway caregivers: one for an ISOLATED backend-only TRIGGER proof
  // (clean conversation, mirroring the template's agentTurn8901 pattern), one
  // for the real UI drive below — kept separate so the UI account's own live
  // conversation isn't seeded with the first account's prior turns.
  const triggerCreds = await createThrowawayCaregiver("Tan Wei (trigger, test)");
  const creds = await createThrowawayCaregiver("Tan Wei (test)");
  const supa = anonClient();
  console.log(`[FIXTURE] triggerCaregiver=${triggerCreds.userId} uiCaregiver=${creds.userId}`);

  // ── 2 TRIGGER ─────────────────────────────────────────────────────────────
  // soul.md's Guided-walkthroughs rail: "only call start_walkthrough after a
  // clear yes" — probed empirically (4/4 clean runs) as a genuine two-turn
  // consent exchange, not LLM-routing variance on one phrase. Recorded as
  // exactly that: a hint, then an explicit yes, with a third more-explicit
  // fallback — <=3 real messages total, every attempt saved.
  const { data: signInData, error: sErr } = await supa.auth.signInWithPassword({
    email: triggerCreds.email, password: triggerCreds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  const jwt = signInData!.session!.access_token;

  let turn = await agentTurn8901(jwt, HINT);
  saveTurnArtifact(ARTIFACTS, "turn-attempt-1-hint", turn);
  console.log(`[TRIGGER] attempt 1 (hint): tools_used=${JSON.stringify(turn.tools_used)} walkthrough=${JSON.stringify(turn.walkthrough)}`);
  if (turn.walkthrough?.task_name !== "link_caregiver") {
    turn = await agentTurn8901(jwt, YES);
    saveTurnArtifact(ARTIFACTS, "turn-attempt-2-yes", turn);
    console.log(`[TRIGGER] attempt 2 (yes): tools_used=${JSON.stringify(turn.tools_used)} walkthrough=${JSON.stringify(turn.walkthrough)}`);
  }
  if (turn.walkthrough?.task_name !== "link_caregiver") {
    turn = await agentTurn8901(jwt, MORE_EXPLICIT);
    saveTurnArtifact(ARTIFACTS, "turn-attempt-3-explicit", turn);
    console.log(`[TRIGGER] attempt 3 (explicit): tools_used=${JSON.stringify(turn.tools_used)} walkthrough=${JSON.stringify(turn.walkthrough)}`);
  }
  expect(turn.http, "agent/turn HTTP status").toBe(200);
  expect(turn.tools_used, "start_walkthrough routed").toContain("start_walkthrough");
  expect(turn.walkthrough?.task_name, "walkthrough task_name from manifest.ts (s24 row: link_caregiver)").toBe("link_caregiver");

  // ── 3 RE-CHECK (part 1: nothing to check yet) ────────────────────────────
  // start_walkthrough never writes (services/hermes/tools/walkthrough.py:
  // deliberately not appended to committed_actions) — there is nothing in the
  // DB to re-check from the TRIGGER alone. Per this scenario's own brief,
  // the meaningful re-check is conditional on how far the real UI drive
  // gets, so it's completed as "part 2" after section 4 below.

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  await signInCaregiver(page, creds);
  await page.locator('[data-tour="nav-ai"]').click();
  await expect(page.locator(SEND_BTN), "on AI tab (walkthrough trigger point)").toBeVisible({ timeout: 10_000 });
  await resetPhaseLog(page);

  // Drive the same two(-to-three)-turn consent exchange for real, in the
  // browser this time. After each reply, hop to Dashboard (Finding (b)'s
  // real-user workaround) and check for the Exit button as the "did it
  // start" signal — harmless no-op if it hasn't started yet.
  const onDashboardWithExit = async () => {
    await page.locator('[data-tour="nav-dashboard"]').click();
    return (await page.getByRole("button", { name: "Exit walkthrough" }).count()) > 0;
  };
  const backToAi = async () => {
    await page.locator('[data-tour="nav-ai"]').click();
    await expect(page.locator(SEND_BTN), "back on AI tab").toBeVisible({ timeout: 10_000 });
  };

  await sendAndAwaitReply(page, HINT);
  // Finding (b) evidence: immediately after a reply that hasn't started the
  // walkthrough yet, no Exit button exists on the ai screen either (nothing
  // queued) — soft-logged, not hard-asserted, since which turn actually
  // starts it varies with LLM routing.
  console.log(`[FINDING-b] Exit count on ai screen right after HINT reply: ${await page.getByRole("button", { name: "Exit walkthrough" }).count()}`);
  let started = await onDashboardWithExit();
  if (!started) {
    await backToAi();
    await sendAndAwaitReply(page, YES);
    started = await onDashboardWithExit();
  }
  if (!started) {
    await backToAi();
    await sendAndAwaitReply(page, MORE_EXPLICIT);
    started = await onDashboardWithExit();
  }
  expect(started, "walkthrough started within <=3 real chat turns and step 1 recovered via a real dashboard tap").toBe(true);

  // Step 1: spotlight on the patient switcher, Next absent.
  await assertWaitForStep(page, STEP1_TEXT, "step 1 open-switcher");
  await page.screenshot({ path: `${SHOTS}/walkthrough-step1-open-switcher.png`, fullPage: true });
  await page.locator(SWITCHER).click(); // real user action -> satisfies step 1's waitFor

  // Step 2: spotlight on "Scan QR code", Next absent.
  await expect(page.locator(SCAN_QR_BTN), "step 2 target visible").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, STEP2_TEXT, "step 2 tap-scan-qr");
  await page.screenshot({ path: `${SHOTS}/walkthrough-step2-tap-scan-qr.png`, fullPage: true });
  await page.locator(SCAN_QR_BTN).click(); // real user action -> satisfies step 2's waitFor, opens ScanLinkSheet

  // Step 3: the real camera (ScanLinkSheet.tsx, read-only, has no manual-
  // entry fallback; this box has no ffmpeg to build a legitimate fake-video-
  // capture fixture either) — genuinely undriveable here. Reaching for it
  // anyway (rather than stopping at step 2's click) surfaces Finding (c).
  //
  // Both #care-link-scanner mounting AND the step-3 callout text are only
  // TRANSIENT signals — either can render BEFORE the async getUserMedia
  // rejection is even known, moments before the delayed crash actually lands
  // (confirmed: a run can show the callout, then still crash a moment later).
  // The one signal that is NOT racy is the pageerror listener itself — it is
  // event-driven, so pageErrors.length flips the instant the real crash
  // happens, independent of whatever DOM state a follow-up query would race
  // against. Give it a full, generous window to fire if it's going to; only
  // if it never does within that window is this environment actually showing
  // the (fixed, or otherwise non-crashing) step-3 UI.
  const crashed = await expect.poll(() => pageErrors.length > 0, { timeout: 15_000 })
    .toBe(true).then(() => true).catch(() => false);
  const calloutShown = !crashed && (await page.getByText(STEP3_TEXT, { exact: false }).count()) > 0;
  console.log(`[STEP3] crashed=${crashed} calloutShown=${calloutShown} pageErrors=${JSON.stringify(pageErrors)}`);
  saveTurnArtifact(ARTIFACTS, "step3-camera-outcome", { crashed, calloutShown, pageErrors });
  await page.screenshot({ path: `${SHOTS}/walkthrough-step3-camera-outcome.png`, fullPage: true });

  if (crashed) {
    // Finding (c): confirm the crash is THIS specific bug, not some unrelated
    // failure, by asserting the exact library error fingerprint.
    expect(pageErrors.some(e => e.includes("Cannot stop, scanner is not running or paused")),
      "crash fingerprint matches the ScanLinkSheet cleanup bug (Finding c)").toBe(true);
  } else {
    // Only reachable if a fixed ScanLinkSheet or different camera behavior
    // means Finding (c) no longer reproduces — falls back to verifying step
    // 3 honestly instead of assuming the crash.
    expect(calloutShown, "no crash AND no step-3 callout — an unrecognized third state").toBe(true);
    await assertWaitForStep(page, STEP3_TEXT, "step 3 scan-camera");
  }
  // Steps 4/5 (pick-relationship, send-request) are unreachable either way:
  // both depend on a successful decode this environment cannot produce.

  // Consent-class invariant: every step in caregiverLinkRequestSteps is
  // waitFor (no `act`), so `autonomous` is always false and NO PaceController
  // ever runs for this walkthrough — zero "walkthrough" surface phase-log
  // entries of any kind, not just field/click/act (mirrors s10's own
  // zero-phases finding for request_refill, one level stronger since this
  // walkthrough has no autonomous tail at all).
  const walkLog = await readPhaseLog(page);
  const walkPhases = walkLog.filter(e => e.surface === "walkthrough");
  console.log(`[PHASELOG] entries=${JSON.stringify(walkPhases.map(e => `${e.surface}/${e.phase}`))}`);
  expect(walkPhases, "user-driven-only walkthrough records NO paced phases at all").toHaveLength(0);

  // ── 3 RE-CHECK (part 2) ───────────────────────────────────────────────────
  // Independent Supabase re-read: prove the incomplete flow left no trace —
  // no care_links row for this caregiver, however far the UI got (it never
  // reached send-request).
  const rows = await recheckDb(supa, "care_links", { caregiver_id: creds.userId });
  expect(rows, "no care_links row — the flow never reached send-request").toHaveLength(0);

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  // (captured inline above at each reachable step: step1, step2, step3-outcome)

  // ── 6 NO scenario-local ms literals ───────────────────────────────────────
  // All waits are condition-based (toBeVisible/toHaveCount timeouts,
  // waitForFunction) — no raw sleep literal anywhere in this file.
});
