import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  anonClient, createThrowawayElder, readPhaseLog, recheckAccessibility,
  resetPhaseLog, signIn, startWalkthrough,
} from "../helpers";

// s22 emergency-contact (CONSENT) — a pure spotlight tour of the mock emergency
// contact card (ElderlySettingsScreen.tsx). Same family as accept_caregiver_link
// (s26): Mei only ever points and narrates; the elder performs every tap
// themselves, the final "Call" tap most of all — dialing a real person is a
// consent-bearing action Mei must never take on the patient's behalf
// (services/hermes/agent/soul.md: "It never applies to consent-bearing actions
// (linking a caregiver, contacting an emergency contact) — those always need
// the patient's own tap."). Owns: this spec + steps/emergency_contact_tour.ts.
//
// Manifest tools: [] and no verbatim trigger phrase is exercised here (unlike
// e.g. s19's real reorder tail) — there is nothing for a chat turn to commit:
// the contact is MOCK data (data/patients.ts's seeded `contacts` array; grepped
// supabase/ — there is no contacts/emergency_contacts table) and the "Call" tap
// only ever renders CallMockup.tsx, a local animated component with no
// network/Supabase call. This mirrors accept-caregiver-link.spec.ts, which is
// also chat-untriggerable and has no agentTurn8901 call. The ONE real backend
// effect anywhere in this scenario is profiles.accessibility.completedWalkthroughs
// (any walkthrough's own completion marker, ElderlyApp's handleWalkthroughAdvance)
// — used below as the RE-CHECK: unwritten before the human's tap, written only
// after it, proving nothing fires ahead of the real consent action.
const SHOTS = "e2e/design-shots/scenarios/s22"; // durable, NOT wiped

// emergency_contact_tour anchors (steps/emergency_contact_tour.ts) + per-step copy.
const NAV_SETTINGS = '[data-tour="nav-settings"]';
const SECTION = '[data-walk="elder-emergency-section"]';
const CALL_BTN = '[data-walk="elder-emergency-call"]';
const STEP1_TEXT = "Tap Settings.";                    // walk.emergencyContactTour.step1
const STEP2_TEXT = "the person to reach first";         // walk.emergencyContactTour.step2 (substring — avoids the em dash)
const STEP3_TEXT = "Tap the green button";              // walk.emergencyContactTour.step3

// The consent-class invariant (identical to s10/s19): a waitFor step is NEVER
// paced, so the callout shows Exit but MUST NOT render a Next button
// (Walkthrough.tsx gates the whole Next/Replay block on `autonomous`, false for
// every waitFor step — see emergency_contact_tour.ts's header comment: none of
// this tour's 3 steps declare `act`). Assert the callout IS present (Exit
// visible) so the absence of Next is meaningful, not just an unmounted overlay.
async function assertWaitForStep(page: Page, bodyText: string, label: string) {
  await expect(page.getByText(bodyText, { exact: false }), `${label}: callout body`).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), `${label}: Exit present`).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true }), `${label}: NO Next button (consent-class)`).toHaveCount(0);
}

test("s22 emergency-contact: user-driven spotlight tour -> elder's own tap (never Mei's) opens the mock call", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // Throwaway elder only. The emergency contact card is mock UI data seeded by
  // data/patients.ts (App.tsx's elder-data-load effect never touches `contacts`
  // when merging the real profile in) — no medications/care_links needed.
  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { data: signInData, error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  void signInData;
  console.log(`[SEED] elder=${creds.userId}`);

  // ── 2 WALKTHROUGH UI (consent core) ───────────────────────────────────────
  await signIn(page, creds); // lands on Home (:5173)
  await resetPhaseLog(page); // clear BEFORE the phase under test — the whole tour
  await startWalkthrough(page, "emergency_contact_tour");

  // Step 1: spotlight the always-mounted Settings nav; Next absent. The elder
  // taps it themselves to travel there (no onEnter — Mei does not navigate for
  // them either, matching "complete the navigation steps via real taps").
  await expect(page.locator(NAV_SETTINGS), "step 1 nav target").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, STEP1_TEXT, "step 1 go-to-settings");
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  await page.screenshot({ path: `${SHOTS}/walkthrough-step1-tap-settings.png`, fullPage: true });
  await page.locator(NAV_SETTINGS).click(); // real tap #1

  // Step 2: spotlight the emergency-contact section; Next absent. Tap the
  // section's own heading text (a non-button descendant) so the click bubbles
  // up to satisfy this step's `acknowledge` listener without landing on the
  // nested Call button underneath (mirrors s19's REFILL_ROW-vs-its-`p` split).
  await expect(page.locator(SECTION), "step 2 emergency-contact section").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, STEP2_TEXT, "step 2 section");
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  await page.screenshot({ path: `${SHOTS}/walkthrough-step2-contact-section.png`, fullPage: true });
  await page.locator(`${SECTION} p`).first().click(); // real tap #2 — nowhere near the Call button

  // Step 3: spotlight the REAL Call button itself (no indirection); Next
  // absent. This is the scenario's core consent assertion — verify it BEFORE
  // any tap, over several checks, so "no Next anywhere, especially here" is on
  // record independent of what happens next.
  await expect(page.locator(CALL_BTN), "step 3 call button").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, STEP3_TEXT, "step 3 call (consent)");
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  await page.screenshot({ path: `${SHOTS}/walkthrough-step3-call-consent-no-next.png`, fullPage: true });

  // ── 3 CONSENT PROOF ────────────────────────────────────────────────────────
  // Mei must NOT have auto-initiated the call: no CallMockup overlay yet (its
  // "Calling…"/"Connected" text only ever renders once ElderlySettingsScreen's
  // real onClick fires setShowCallPrimary(true) — nothing here has clicked it).
  await expect(page.getByText("Calling", { exact: false }), "no call UI before the human's tap").toHaveCount(0);
  await expect(page.getByText("Connected", { exact: false }), "not connected before the human's tap").toHaveCount(0);

  // Independent RE-CHECK: the walkthrough's own completion marker (the one real
  // backend write anywhere in this scenario) must NOT be set yet either — proof
  // that nothing, including the tour's own bookkeeping, has committed ahead of
  // the human's real action.
  const beforeCompleted = await recheckAccessibility(supa, creds.userId, "completedWalkthroughs");
  console.log(`[RE-CHECK pre-tap] completedWalkthroughs=${JSON.stringify(beforeCompleted)}`);
  expect(
    Array.isArray(beforeCompleted) && beforeCompleted.includes("emergency_contact_tour"),
    "not marked complete before the human's own tap",
  ).toBe(false);

  // The ONE real user action this whole scenario hinges on: the elder's own tap
  // on the actual Call button — never a programmatic el.click() from any test
  // helper standing in for Mei.
  await page.locator(CALL_BTN).click();

  // The call UI appears — but ONLY now, as a direct result of that real tap.
  await expect(page.getByText("Calling", { exact: false }), "call UI appears only after the human's tap").toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  await page.screenshot({ path: `${SHOTS}/call-fired-after-human-tap.png`, fullPage: true });

  // Same tap satisfies this last step's own listener too, completing the tour
  // (it's the final step) — the overlay unmounts.
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), "walkthrough completed by the same real tap").toHaveCount(0, { timeout: 15_000 });

  // Independent RE-CHECK, second half: completion now committed — but strictly
  // AFTER, never before, the human's own tap. (fire-and-forget write in
  // handleWalkthroughAdvance — poll for eventual consistency, never trust a UI
  // state change alone as proof of a DB write landing.)
  await expect
    .poll(async () => {
      const v = await recheckAccessibility(supa, creds.userId, "completedWalkthroughs");
      return Array.isArray(v) && v.includes("emergency_contact_tour");
    }, { timeout: 15_000 })
    .toBe(true);

  // No backend write for the CALL itself: CallMockup.tsx has no Supabase/fetch
  // call, and there is no contacts/emergency_contacts table to write to (grepped
  // supabase/ — none exists). The completedWalkthroughs write above is the tour's
  // own unrelated bookkeeping, not a call record.

  // Phase-log shape for this fully user-driven tour: EVERY step here is waitFor
  // (never `act`), so `autonomous` (Walkthrough.tsx) is false throughout and no
  // PaceController is ever created — not even a "navigate" phase (that phase
  // only ever fires from inside orchestrate.ts's runActStep, itself gated on
  // `autonomous`). So the honest shape is exactly zero recorded phases, not
  // merely "no field/click/act" — verified by reading both components, not
  // assumed.
  const walkLog = await readPhaseLog(page);
  const walkPhases = walkLog.filter(e => e.surface === "walkthrough");
  console.log(`[PHASELOG] walkthrough entries=${JSON.stringify(walkPhases.map(e => `${e.surface}/${e.phase}`))}`);
  expect(walkPhases, "fully user-driven tour records ZERO walkthrough phases (no autonomous step ever ran)").toHaveLength(0);

  // ── 4 SCREENSHOTS ──────────────────────────────────────────────────────────
  // Captured inline above at each meaningful moment (durable, e2e/design-shots/,
  // never wiped): step1 nav tap, step2 spotlighted contact section, step3
  // spotlighted call button with no Next (the key consent-step shot), and the
  // call firing only after the real tap.

  // ── 5 NO scenario-local ms literals ───────────────────────────────────────
  // This scenario has no paced/autonomous phase to floor-check (section 3 above
  // proves exactly zero), so PACING has nothing to assert against; every literal
  // in this file is the one canonical 500ms scrollIntoView settle wait, each
  // with its required comment — no other raw ms value appears.
});
