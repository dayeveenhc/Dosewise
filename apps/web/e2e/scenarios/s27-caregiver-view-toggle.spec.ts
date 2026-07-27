import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  anonClient, recheckDb, readPhaseLog, resetPhaseLog,
  signIn, startWalkthrough,
} from "../helpers";

// s27 caregiver-view-toggle (VIEW) — a PURE client-side spotlight tour of the
// caregiver→elder role switch (SettingsScreen.tsx's "cg-switch-mode" button,
// wired to App.tsx's openModeSwitch). manifest tools: [] is literal: there is
// no phrase an elder/caregiver could say that routes an LLM tool call here —
// this is a local appMode flip (App.tsx: onSwitchMode -> preAuthStage="mode",
// appMode="onboarding" -> pick "For Myself" -> appMode="elderly") persisted
// only to localStorage (lib/sessionState.ts's persistAppMode), so — like s20 —
// there is no TRIGGER turn to send and no ChangeHighlight tail.
//
// IMPORTANT NAMING NOTE (found empirically, not assumed): "view toggle" here
// is a ROLE/VIEW switch — the caregiver previews the SAME account's OWN data
// as an elder would see it (App.tsx's elderly-mode-loading effect re-fetches
// profile+medications using elderId = the caregiver's own auth uid, then
// overwrites patients[0] with that identity) — it is NOT the multi-patient
// PatientSwitcher (data-tour="cg-patientswitcher", already the subject of
// s28's patient_schedule_tour.ts and link_caregiver.ts). Confirmed from the
// actual product copy: walk.caregiverViewToggleTour.step2 literally reads
// "Tap here to switch into the elder's own view of the app — to see exactly
// what they see." and the button's own label is settings.switchToElderly
// ("Switch to Elderly View"). So this scenario's "different patient's data"
// proof is: the caregiver dashboard shows the mock patient's nickname ("Ah
// Ma"/Mdm Tan Bee Leng, data/patients.ts's PATIENTS[0]) before toggling, and
// the elder shell's own header shows the CAREGIVER's OWN seeded full_name
// after toggling — a real, different name, for a real, different reason
// (role swap, not patient swap) — documented honestly rather than forced to
// fit a multi-patient framing that doesn't match what the code does.
//
// Owns: this spec + steps/caregiver_view_toggle_tour.ts (left unedited — the
// coordinator's skeleton already matches an established green sibling's exact
// shape (patient_schedule_tour.ts): no per-step onEnter beyond step 1's real
// nav click, which — verified via React 18's automatic event-batching — lands
// screen="settings" in the same commit as the walkthrough's stepIndex advance,
// so step 2's target is already mounted with no extra onEnter needed).
const SHOTS = "e2e/design-shots/scenarios/s27"; // durable, NOT wiped

interface CaregiverCreds { email: string; password: string; userId: string }

// helpers.ts has no standalone "just a caregiver" signup (createCaregiverWithPendingLink
// always ties one to an elder via a care_links insert, which this scenario —
// a pure client-side mode toggle — doesn't need at all). Mirrors s23's local
// createThrowawayCaregiver exactly, including its full_name, so the "a
// different name now appears" proof below reads the same seeded value other
// caregiver scenarios use.
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

// The consent-class invariant (identical to s19/s20/notifications_tour): a
// waitFor step is NEVER paced, so the callout shows Exit but MUST NOT render a
// Next button (Walkthrough.tsx gates the whole Next/Replay block on
// `autonomous`, false for every waitFor step). Assert the callout IS present
// (Exit visible) so the absence of Next is meaningful, not just an unmounted
// overlay.
async function assertWaitForStep(page: Page, bodyText: string, label: string) {
  await expect(page.getByText(bodyText, { exact: false }), `${label}: callout body`).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), `${label}: Exit present`).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true }), `${label}: NO Next button (consent-class)`).toHaveCount(0);
}

test("s27 caregiver-view-toggle: user-driven caregiver->elder view-toggle tour (no Next) -> real role switch to ElderlyApp showing the caregiver's OWN identity, no backend write", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // A throwaway CAREGIVER account — no elder, no care_links, no medications.
  // The mock patients (data/patients.ts's PATIENTS, "Mdm Tan Bee Leng"/"Ah Ma"
  // and "Mr Wong Kah Wai"/"Ah Gong") are hardcoded initial state for EVERY
  // caregiver session (App.tsx: useState<Patient[]>(PATIENTS)) — nothing to
  // seed there; they come free with any caregiver login.
  const creds = await createThrowawayCaregiver();
  const supa = anonClient();
  const { error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  console.log(`[SEED] caregiver=${creds.userId} (no elder/care_links/medications needed — pure client-side role-toggle tour)`);

  // Baseline Supabase snapshot, taken BEFORE any UI interaction, so the later
  // VIEW-ONLY proof is a real before/after diff, not just a post-hoc read.
  const profileBefore = await recheckDb(supa, "profiles", { id: creds.userId });
  expect(profileBefore, "exactly the one seeded profiles row").toHaveLength(1);
  const medsBefore = await recheckDb(supa, "medications", { elder_id: creds.userId });
  expect(medsBefore, "no medications exist for this account before toggling").toHaveLength(0);

  // ── 2 TRIGGER — deliberately NONE ─────────────────────────────────────────
  // manifest.ts's tools: [] for s27 is literal: there is no phrase that routes
  // an LLM tool call here — the caregiver->elder role switch is a pure local
  // appMode flip with no Hermes tool and no Supabase write, so — exactly like
  // s20 — this tour's only real entry point is the app's own UI (dev-bridge
  // startWalkthrough below stands in for that in-app trigger).

  // ── 2/4 WALKTHROUGH UI + REAL ROLE SWITCH ─────────────────────────────────
  // Standard signIn() helper: verifying it now ALSO works for a caregiver
  // session, per the infra note that App.tsx's caregiver branch just gained
  // its own window.__dwStartWalkthrough (mirroring ElderlyApp.tsx). Confirmed
  // by reading the source (not just assumed): App.tsx registers the hook in a
  // plain top-level useEffect(() => {...}, []) — unconditional on appMode,
  // since it is a hook of the App() component itself, not of a
  // conditionally-mounted child — so it exists from first paint regardless of
  // caregiver/elder routing, and calling it only ever touches the stable
  // setWalkthroughTask/setWalkthroughStepIndex setters (always live, per
  // React's setState-identity guarantee, even if the wrapping closure were
  // stale). signIn()'s waitForFunction check is therefore satisfied for a
  // caregiver login too — empirically confirmed green below, no local
  // signInCaregiver() variant needed (unlike s23/s25, written before this hook
  // existed for the caregiver branch).
  await signIn(page, creds); // lands on caregiver Dashboard (:5173)

  // Capture the BEFORE state on the real Dashboard: the mock patient's
  // nickname, not the caregiver's own identity.
  const switcher = page.locator('[data-tour="cg-patientswitcher"]');
  await expect(switcher, "caregiver dashboard shows the MOCK patient before toggling").toContainText("Ah Ma");
  await page.screenshot({ path: `${SHOTS}/before-caregiver-dashboard.png`, fullPage: true });

  // resetPhaseLog first so the log holds only this interaction. Both steps
  // are waitFor (user-driven) -> NO PaceController is ever instantiated for
  // them (Walkthrough.tsx: `autonomous = !!(step.act || ...)`, false here) ->
  // the tour records NO walkthrough phase-log entries at all (asserted below;
  // same honest zero shape as s10/s19/s20).
  await resetPhaseLog(page);
  await startWalkthrough(page, "caregiver_view_toggle_tour");

  // Step 1: spotlight the always-mounted Settings nav; Next absent. The person
  // taps it themselves to travel there (a real click: satisfies this step's
  // waitFor AND fires BottomNav's own onSelect->setScreen("settings") — React
  // 18 batches both state updates from the same native event into one commit,
  // so step 2's target is already mounted by the time it's measured).
  await expect(page.locator('[data-tour="nav-settings"]'), "step 1 nav target").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, "Tap Settings", "step 1 go-to-settings");
  await page.locator('[data-tour="nav-settings"]').click();

  // Step 2: spotlight the real "Switch to Elderly View" button; Next absent.
  // Screenshot here per the deliverable (a tour step spotlighting the toggle
  // control) BEFORE acting, so the shot shows the spotlight, not the after-state.
  await expect(page.locator('[data-walk="cg-switch-mode"]'), "step 2 switch-mode target").toBeVisible({ timeout: 15_000 });
  await assertWaitForStep(page, "switch into the elder's own view", "step 2 switch-mode");
  await page.screenshot({ path: `${SHOTS}/walkthrough-step2-switch-mode.png`, fullPage: true });

  // Real user action: tap the switch-mode button. "acknowledge" is satisfied
  // by a real click on the spotlighted element itself (Walkthrough.tsx treats
  // click|acknowledge identically) — the SAME click also fires the real
  // onSwitchMode handler (openModeSwitch), so this one tap both completes the
  // tour (last step) AND opens the real mode picker underneath.
  await page.locator('[data-walk="cg-switch-mode"]').click();

  // Tour complete (last step): overlay gone (no Exit).
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), "walkthrough overlay dismissed").toHaveCount(0, { timeout: 15_000 });

  // Phase-log shape for a fully user-driven tour: honestly ZERO walkthrough
  // phases — no navigate/field/click/act entries either, since neither of
  // this tour's 2 steps carries `act` (or a waitFor-less verify/reveal), so
  // Walkthrough.tsx's autonomous flag is false for both and orchestrate.ts's
  // runActStep (the only place that ever calls PaceController.paced(), the
  // sole producer of "walkthrough" phase-log entries) never runs.
  const walkLog = await readPhaseLog(page);
  const walkPhases = walkLog.filter(e => e.surface === "walkthrough");
  console.log(`[PHASELOG] walkthrough entries=${JSON.stringify(walkPhases.map(e => `${e.surface}/${e.phase}`))}`);
  expect(walkPhases, "user-driven tour records NO paced walkthrough phases").toHaveLength(0);

  // Complete the real toggle: the mode picker (OnboardingScreen) is now showing
  // underneath where the tour overlay was — pick "For Myself" (onSelect("elderly")),
  // which — since a session already exists and needsWizard is false — goes
  // straight to appMode="elderly" with NO wizard interstitial.
  await expect(page.getByText("Who are you using", { exact: false }), "real mode picker now showing").toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /For Myself/i }).click();

  // ── 3 VIEW-ONLY PROOF (replaces a DB re-check) ────────────────────────────
  await page.waitForTimeout(500); // let smooth scrollIntoView settle

  // The toggle genuinely changed which view is shown: the elder shell is now
  // mounted (nav-home only exists there — the caregiver's own "home" nav item
  // is literally id="dashboard", per nav.ts) and the caregiver shell is gone.
  await expect(page.locator('[data-tour="nav-home"]'), "elder shell now showing (caregiver nav has no nav-home)").toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-tour="cg-patientswitcher"]'), "caregiver patient switcher gone").toHaveCount(0);

  // The toggle genuinely changed which identity's data is shown: the elder
  // shell's own header ("Hello, {name}!") now greets the CAREGIVER'S OWN
  // seeded full_name — a real, different name from the mock "Ah Ma" shown
  // before toggling (App.tsx's elderly-mode-loading effect re-fetches this
  // account's own profile and overwrites patients[0].nickname with it).
  await expect(page.getByText("Tan Wei", { exact: false }), "elder header now greets the CAREGIVER'S OWN name, not the mock patient").toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Ah Ma", { exact: false }), "the mock patient's name is gone from view").toHaveCount(0);

  // Assert NO backend write occurred for the toggle itself: the appMode flip
  // is pure localStorage (lib/sessionState.ts's persistAppMode), never
  // Supabase — and ensureProfile (App.tsx's elderly-mode effect) is a
  // find-or-insert that no-ops here since the row already exists (verified by
  // reading its source: SELECT first, INSERT only `if (!data)`). One caveat,
  // discovered empirically and worth being honest about (identical to s20's):
  // ANY walkthrough's last step calls profile.ts's markWalkthroughCompleted
  // (App.tsx's handleWalkthroughAdvance) — generic engine bookkeeping shared
  // by every task name, NOT a view-toggle-specific write and NOT a committed
  // agent action (no medications/doses/care_links row, no
  // entity_type/entity_id/changed_fields — CONTEXT.md's propose-vs-commit).
  // So the precise, honest assertion is: identity fields untouched, and
  // accessibility gained ONLY that one completion marker.
  const profileAfter = await recheckDb(supa, "profiles", { id: creds.userId });
  expect(profileAfter, "still exactly one profiles row").toHaveLength(1);
  const before0 = profileBefore[0] as Record<string, unknown>;
  const after0 = profileAfter[0] as Record<string, unknown>;
  for (const key of ["id", "role", "full_name", "dialect", "created_at"]) {
    expect(after0[key], `profiles.${key} unchanged`).toEqual(before0[key]);
  }
  expect(after0.accessibility, "accessibility gained ONLY the walkthrough-completion marker")
    .toEqual({ ...(before0.accessibility as Record<string, unknown>), completedWalkthroughs: ["caregiver_view_toggle_tour"] });
  const medsAfter = await recheckDb(supa, "medications", { elder_id: creds.userId });
  expect(medsAfter, "medications untouched (still none — viewing is read-only)").toHaveLength(0);

  // ── 4 SCREENSHOT ──────────────────────────────────────────────────────────
  await page.screenshot({ path: `${SHOTS}/after-elderly-view.png`, fullPage: true });

  // ── 5 NO scenario-local ms literals ────────────────────────────────────────
  // This tour has no paced phase (both steps are waitFor — no PaceController
  // minimum ever applies, so there is no PACING constant to import or assert
  // against, mirroring s20's identical no-autonomous-step tour exactly); the
  // only raw literal is the 500ms scrollIntoView settle above, with its
  // required comment.
});
