import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  anonClient, assertPhaseMins, createThrowawayElder, createCaregiverWithPendingLink, readPhaseLog,
  recheckAccessibility, resetPhaseLog, signIn, startWalkthrough, advanceWalkthroughToStep,
} from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

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
// the "Call" tap only ever renders CallMockup.tsx, a local animated component
// with no network/Supabase call. But the CONTACT ITSELF is now real
// (2026-08-02): the emergency contact IS the linked caregiver, read from
// care_links. It used to be data/patients.ts fixture data, which was always
// present and therefore silently guaranteed this tour's final target existed —
// so this spec now has to seed a real ACTIVE link, and ElderlyApp refuses the
// tour outright without one. This mirrors accept-caregiver-link.spec.ts, which is
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
const STEP3_TEXT = "Tap the green button";              // walk.emergencyContactTour.step3

// The consent-step invariant: the Call step is a waitFor (never `act`), so it is
// NEVER paced and the callout shows Exit but MUST NOT render a Next button
// (Walkthrough.tsx gates the whole Next/Replay block on `autonomous`). Steps 1-2
// ARE autonomous now (2026-07-28) and DO show Next, but the consent Call step
// must not — assert the callout IS present (Exit visible) so the absence of Next
// is meaningful, not just an unmounted overlay.
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
  // A throwaway elder WITH an active caregiver link: the emergency contact card
  // renders only when one exists, and its Call button is this tour's final
  // consent target. (createCaregiverWithPendingLink inserts as the caregiver,
  // which is what RLS requires; the elder's own accept is what activates it, so
  // flip the status here rather than simulating a tap we aren't testing.)
  const creds = await createThrowawayElder();
  await createCaregiverWithPendingLink(creds.userId);
  const supa = anonClient();
  const { data: signInData, error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  void signInData;
  // Only the elder may activate their own link (0005_care_links_consent_
  // hardening.sql), which is why this runs as the elder, after sign-in.
  const { error: actErr } = await supa
    .from("care_links").update({ status: "active" }).eq("elder_id", creds.userId);
  expect(actErr, actErr?.message).toBeNull();
  console.log(`[SEED] elder=${creds.userId} with an ACTIVE caregiver link`);

  // ── 2 WALKTHROUGH UI (hybrid: autonomous nav → human-tapped consent) ───────
  await signIn(page, creds); // lands on Home (:5173)
  await resetPhaseLog(page); // clear BEFORE the phase under test — the whole tour
  await startWalkthrough(page, "emergency_contact_tour");

  // Steps 1-2 are now AI-AUTO-ADVANCED (2026-07-28): Mei taps Settings and
  // spotlights the emergency-contact section herself — the person just watches.
  // Mei performs steps 1-2 herself; each then holds until the person taps Next.
  await expect(page.locator(NAV_SETTINGS), "step 1 nav target spotlit").toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  await page.screenshot({ path: `${SHOTS}/walkthrough-step1-tap-settings.png`, fullPage: true });

  // Step 2 spotlights the emergency-contact SECTION. Its data-walk anchor was
  // deleted by the settings-hub revamp and has now been restored on the
  // SectionCard — with it missing, this step spotlighted nothing at all.
  await advanceWalkthroughToStep(page, 2);
  await expect(page.locator(SECTION), "reaches the emergency-contact section").toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  await page.screenshot({ path: `${SHOTS}/walkthrough-step2-contact-section.png`, fullPage: true });

  // Step-NUMBER targeting, not "is the Call button visible?": the Call button
  // lives INSIDE the section step 2 spotlights, so a visibility predicate is
  // already true one step early and would advance nothing.
  await advanceWalkthroughToStep(page, 3);

  // Step 3 stays a CONSENT step — the elder's own tap, never Mei's: waitFor, so
  // the callout shows Exit but NO Next (dialing a real person needs the patient's
  // own tap). This is the scenario's core assertion — verify it BEFORE any tap,
  // so "no Next on the Call step" is on record independent of what happens next.
  await expect(page.locator(CALL_BTN), "step 3 call button spotlit").toBeVisible({ timeout: 15_000 });
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

  // Phase-log shape for the HYBRID tour: steps 1-2 are autonomous act:click, so
  // paced `click` phases ARE recorded now (the old fully-user-driven zero no
  // longer holds); the consent Call step (waitFor) adds none. Neither of steps
  // 1-2 declares onEnter, so there is no navigate phase — click only.
  const walkLog = await readPhaseLog(page);
  const walkPhases = walkLog.filter(e => e.surface === "walkthrough");
  console.log(`[PHASELOG] walkthrough entries=${JSON.stringify(walkPhases.map(e => `${e.surface}/${e.phase}`))}`);
  expect(walkPhases.length, "autonomous steps 1-2 record paced click phases").toBeGreaterThan(0);
  assertPhaseMins(walkLog, [{ surface: "walkthrough", phase: "click", min: PACING.PRE_CLICK_MS }]);

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
