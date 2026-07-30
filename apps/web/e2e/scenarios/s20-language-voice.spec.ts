import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  anonClient, createThrowawayElder, recheckDb, readPhaseLog, resetPhaseLog,
  signIn, startWalkthrough,
} from "../helpers";

// s20 language-voice (VIEW) — a PURE client-side spotlight tour of the elder's
// Voice & Language settings (ElderlySettingsScreen.tsx). Manifest tools: []
// is literal: language & voiceOutput are localStorage-only settings
// (lib/languageContext.tsx's "dosewise-language", accessibility.tsx's
// "dosewise:accessibility") with NO Hermes tool and NO Supabase write — so,
// unlike s10/s19, there is no real TRIGGER turn to send at all (nothing for an
// LLM to route to) and no ChangeHighlight tail. Sections 2 TRIGGER + 4 UI are
// folded into one "walkthrough + real client change" block; section 3
// RE-CHECK becomes the VIEW-ONLY proof: the client setting genuinely changes,
// while Supabase stays untouched FOR THOSE SETTINGS specifically (medications:
// fully untouched; profiles: gains only the generic completedWalkthroughs
// bookkeeping marker every walkthrough writes on completion — see the comment
// at the profiles re-check below). Owns: this spec + steps/language_voice_tour.ts.
const SHOTS = "e2e/design-shots/scenarios/s20"; // durable, NOT wiped

// language_voice_tour anchors (steps/language_voice_tour.ts) + per-step copy.
const NAV_SETTINGS = '[data-tour="nav-settings"]';
const LANG_SECTION = '[data-tour="elder-language"]';
const LANG_SELECT = '[data-walk="elder-language-select"]';
const STEP1_TEXT = "Tap Settings";            // walk.languageVoiceTour.step1
const STEP2_TEXT = "Mei can read her replies aloud here"; // walk.languageVoiceTour.step2 (NOT "Voice & Language" — the real Settings card already has that as its own heading, so it isn't unique to the callout)
const STEP3_TEXT = "pick the language";       // walk.languageVoiceTour.step3

// The consent-class invariant (identical to s10/s19): a waitFor step is NEVER
// paced, so the callout shows Exit but MUST NOT render a Next button
// (Walkthrough.tsx gates the whole Next/Replay block on `autonomous`, false
// for every waitFor step). Assert the callout IS present (Exit visible) so the
// absence of Next is meaningful, not just an unmounted overlay.
async function assertWaitForStep(page: Page, bodyText: string, label: string) {
  await expect(page.getByText(bodyText, { exact: false }), `${label}: callout body`).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), `${label}: Exit present`).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true }), `${label}: NO Next button (consent-class)`).toHaveCount(0);
}

// Read the two client-only settings this tour spotlights, straight out of
// localStorage — the same keys languageContext.tsx / accessibility.tsx own.
// No Supabase involved: this IS the "where the value actually lives" check.
async function readClientSettings(page: Page): Promise<{ language: string | null; voiceOutput: boolean | undefined }> {
  return page.evaluate(() => {
    const language = window.localStorage.getItem("dosewise-language");
    const raw = window.localStorage.getItem("dosewise:accessibility");
    let voiceOutput: boolean | undefined;
    try { voiceOutput = raw ? JSON.parse(raw).voiceOutput : undefined; } catch { voiceOutput = undefined; }
    return { language, voiceOutput };
  });
}

test("s20 language-voice: user-driven Voice & Language tour (no Next) -> client-only language + voiceOutput change, no backend write", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  console.log(`[SEED] elder=${creds.userId} (no medications needed — Settings-only tour)`);

  // Baseline Supabase snapshot, taken BEFORE any UI interaction, so the later
  // VIEW-ONLY proof is a real before/after diff, not just a post-hoc read.
  const profileBefore = await recheckDb(supa, "profiles", { id: creds.userId });
  expect(profileBefore, "exactly the one seeded profiles row").toHaveLength(1);
  const medsBefore = await recheckDb(supa, "medications", { elder_id: creds.userId });
  expect(medsBefore, "no medications exist (none seeded)").toHaveLength(0);

  // ── 2 TRIGGER — deliberately NONE ─────────────────────────────────────────
  // manifest.ts's tools: [] for s20 is literal: there is no phrase an elder
  // could say that routes an LLM tool call here — language/voiceOutput are
  // pure client settings, so this tour's only real entry point is the app's
  // own UI (dev-bridge startWalkthrough below stands in for that in-app
  // trigger, exactly as s19 uses it for its mock notifications tour).

  // ── 2/4 WALKTHROUGH UI + REAL CLIENT CHANGE ───────────────────────────────
  await signIn(page, creds); // lands on Home (:5173)
  const before = await readClientSettings(page);
  console.log(`[CLIENT before] language=${before.language} voiceOutput=${before.voiceOutput}`);

  // resetPhaseLog first so the log holds only this interaction. All 3 steps
  // are waitFor (user-driven) -> NO PaceController is ever instantiated for
  // them (Walkthrough.tsx: `autonomous = !!(step.act || ...)`, false here) ->
  // the tour records NO walkthrough phase-log entries at all (asserted below;
  // same honest zero shape as s10/s19 — the field/click/act/navigate phases
  // only exist inside the autonomous act path in orchestrate.ts, never taken).
  await resetPhaseLog(page);
  await startWalkthrough(page, "language_voice_tour");

  // Step 1: spotlight the always-mounted Settings nav; Next absent. The person
  // taps it themselves to travel there.
  await expect(page.locator(NAV_SETTINGS), "step 1 nav target").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, STEP1_TEXT, "step 1 go-to-settings");
  await page.locator(NAV_SETTINGS).click();

  // Step 2: spotlight the Voice & Language card; Next absent. The person taps
  // the Read-Aloud toggle itself — a real descendant control inside the
  // spotlighted card — which both flips voiceOutput AND, by native DOM
  // bubbling, satisfies this step's "acknowledge" waitFor (Walkthrough.tsx
  // treats click|acknowledge identically; the listener sits on the card, not
  // the button, since no distinct waitFor.selector was set).
  await expect(page.locator(LANG_SECTION), "step 2 section target").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, STEP2_TEXT, "step 2 voice-language-section");
  const voiceToggle = page.locator(LANG_SECTION).locator("button").first();
  await expect(voiceToggle, "Read-Aloud toggle reflects the default ON state").toHaveAttribute("aria-pressed", "true");
  await voiceToggle.click(); // real user tap: flips voiceOutput AND advances step 2

  // Step 3: spotlight the language <select>; Next absent. Screenshot here per
  // the deliverable (a tour step spotlighting the language selector) BEFORE
  // acting, so the shot shows the spotlight, not the after-state.
  await expect(page.locator(LANG_SELECT), "step 3 select target").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, STEP3_TEXT, "step 3 pick-language");
  await page.screenshot({ path: `${SHOTS}/walkthrough-step3-language-selector.png`, fullPage: true });

  // Real user action: pick a different language. "select-change" only
  // satisfies on a genuine value change (never a bare tap), so the tour
  // completing is itself evidence the language actually changed.
  await page.locator(LANG_SELECT).selectOption("zh");

  // Tour complete (last step): overlay gone (no Exit).
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), "walkthrough overlay dismissed").toHaveCount(0, { timeout: 15_000 });

  // Phase-log shape for a fully user-driven tour: honestly ZERO walkthrough
  // phases — no navigate/field/click/act entries either, since none of this
  // tour's steps carry `act` (or a waitFor-less verify/reveal), so
  // Walkthrough.tsx's autonomous flag is false for all 3 and orchestrate.ts's
  // runActStep (the only place that ever calls PaceController.paced(), the
  // sole producer of "walkthrough" phase-log entries) never runs.
  const walkLog = await readPhaseLog(page);
  const walkPhases = walkLog.filter(e => e.surface === "walkthrough");
  console.log(`[PHASELOG] walkthrough entries=${JSON.stringify(walkPhases.map(e => `${e.surface}/${e.phase}`))}`);
  expect(walkPhases, "user-driven tour records NO paced walkthrough phases").toHaveLength(0);

  // ── 3 VIEW-ONLY PROOF (replaces a DB re-check) ────────────────────────────
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  const captionLabel = page.locator(LANG_SECTION).getByText("语言", { exact: true }); // zh for "Language"
  await expect(captionLabel, "UI text itself re-rendered in the newly picked language").toBeVisible({ timeout: 10_000 });
  await expect(voiceToggle, "Read-Aloud toggle now reflects OFF").toHaveAttribute("aria-pressed", "false");

  const after = await readClientSettings(page);
  console.log(`[CLIENT after] language=${after.language} voiceOutput=${after.voiceOutput}`);
  expect(after.language, "persisted localStorage language actually changed").toBe("zh");
  expect(after.language, "language differs from before").not.toBe(before.language);
  expect(after.voiceOutput, "persisted localStorage voiceOutput flipped from its prior value").toBe(!before.voiceOutput);

  // Assert NO backend write occurred FOR THE SETTINGS THEMSELVES: no committed
  // action was ever possible (there was no TRIGGER turn — see section 2), and
  // independently re-reading Supabase proves language/voiceOutput never reached
  // it. One caveat, discovered empirically and worth being honest about: ANY
  // walkthrough's last step calls profile.ts's markWalkthroughCompleted
  // (ElderlyApp.tsx's handleWalkthroughAdvance) — generic engine bookkeeping
  // shared by every task name (autonomous or user-driven, request_refill,
  // notifications_tour, this one alike), NOT a language/voice-specific write and
  // NOT a committed agent action (no medications/doses/refills/care_links row,
  // no entity_type/entity_id/changed_fields — CONTEXT.md's propose-vs-commit).
  // So the precise, honest assertion is: identity fields untouched, and
  // accessibility gained ONLY that one completion marker — no language/
  // voiceOutput/medical key ever appears there.
  const profileAfter = await recheckDb(supa, "profiles", { id: creds.userId });
  expect(profileAfter, "still exactly one profiles row").toHaveLength(1);
  const before0 = profileBefore[0] as Record<string, unknown>;
  const after0 = profileAfter[0] as Record<string, unknown>;
  for (const key of ["id", "role", "full_name", "dialect", "created_at"]) {
    expect(after0[key], `profiles.${key} unchanged`).toEqual(before0[key]);
  }
  expect(after0.accessibility, "accessibility gained ONLY the walkthrough-completion marker — no language/voiceOutput/medical keys")
    .toEqual({ ...(before0.accessibility as Record<string, unknown>), completedWalkthroughs: ["language_voice_tour"] });
  const medsAfter = await recheckDb(supa, "medications", { elder_id: creds.userId });
  expect(medsAfter, "medications untouched (still none)").toHaveLength(0);

  // ── 4 SCREENSHOT ──────────────────────────────────────────────────────────
  await page.screenshot({ path: `${SHOTS}/settings-after-change.png`, fullPage: true });

  // ── 5 NO scenario-local ms literals ────────────────────────────────────────
  // This tour has no paced phase (all 3 steps are waitFor — no PaceController
  // minimum ever applies), so there is no PACING constant to assert against;
  // the only raw literal is the 500ms scrollIntoView settle above, with its
  // required comment.
});
