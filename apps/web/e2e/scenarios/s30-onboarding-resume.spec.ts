import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, createThrowawayElder, readPhaseLog, recheckDb,
  resetPhaseLog, saveTurnArtifact, signIn, startWalkthrough,
} from "../helpers";
import type { TurnResult } from "../helpers";

// s30 onboarding-resume — the elderly wizard's real step order (CONTEXT.md):
// account -> profile -> conditions -> allergies -> routine -> current-meds ->
// med-history -> done. This spec verifies three things end to end:
//
//   (A) the wizard chain: a genuinely fresh (no profiles row yet) auth user
//       driven through 6 real stage transitions via actual Playwright
//       interaction (account signup, profile fields, a condition, allergies,
//       routine TimeFields, a current medication).
//   (B) exit-and-resume: whether backing all the way out mid-chain and
//       re-entering resumes near the same stage, or restarts.
//   (C) the chat-entry hook (App.tsx's onStartOnboardingWizard /
//       resumeElderAfterWizard, ElderlyApp.tsx's handleWalkthroughStart
//       special-case for task "onboarding") for an ALREADY-onboarded elder —
//       does it navigate in and back out cleanly?
//
// Two verified-from-source facts drive this spec's design, documented here so
// the assertions below don't look arbitrary:
//
// 1. GuidedSetupWizard.tsx's own stage position (`stepIndex`) is a plain
//    `useState(0)` with NO persistence anywhere (not walkthroughState.ts, not
//    Supabase) — it resets to 0 on every mount. Nothing ever calls
//    saveProfile() before the final "done" stage. So (B) is expected to
//    RESTART, not resume — this is the honest finding this scenario's own
//    name anticipates, not a spec bug.
// 2. The ~28-step spotlight tour in lib/walkthrough/steps/onboarding.ts is
//    real, but NO <Walkthrough> overlay is ever mounted while the wizard
//    itself is showing (grep confirms exactly two <Walkthrough> mount sites —
//    App.tsx's caregiver shell and ElderlyApp.tsx's elder shell — neither is
//    reachable from appMode==="onboarding"). So PACING (section D) is
//    expected to be an honest zero throughout, same shape as s20. This also
//    means every onboarding.ts step target this spec could drive is only
//    ever exercised as a plain wizard field, never as a spotlighted step.
const ARTIFACTS = "e2e/artifacts/s30";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s30"; // durable, NOT wiped

// Real English copy (src/app/lib/language.ts, "en" table) for each stage's
// StepHeader <h1> — the "visible stage-title change" signal CONTEXT.md's
// GuidedSetupWizard.tsx confirms is the only externally-observable proof of a
// stage transition (the wizard's own "wizard-step-changed" bus event has no
// listener at all while no <Walkthrough> is mounted, so it can't be tapped
// from Playwright — the title text is the real, verifiable signal here).
const TITLE = {
  accountNew: "Let's create your account",
  accountReturning: "What should we call you?",
  profile: "Tell us about yourself",
  conditions: "Any medical conditions?",
  allergies: "Do you have any allergies?",
  routine: "When do you usually eat and sleep?",
  currentMeds: "What medications are you taking now?",
  medHistory: "Any medications you've taken before?",
  done: "All set",
} as const;

const CONTINUE = '[data-walk="wizard-continue-button"]';
const BACK_NAME = "Back"; // WizardChrome's own back arrow, aria-label="wizard.back"

const heading = (page: Page, text: string) => page.getByRole("heading", { name: text, exact: false });

async function addTag(page: Page, containerWalk: string, value: string) {
  const container = page.locator(`[data-walk="${containerWalk}"]`);
  // The container also holds two sr-only type="file" inputs (camera/library
  // scan) — sr-only isn't display:none, so Playwright's :visible still counts
  // them; excluding by type is the reliable way to reach the real text field.
  await container.locator('input:not([type="file"])').fill(value);
  await container.locator(`[data-walk="${containerWalk}-add-btn"]`).click();
  await expect(container.getByText(value, { exact: false }), `${containerWalk} shows "${value}" tag`).toBeVisible();
}

// TimeField's tap-only stepper (components/TimesPicker.tsx) — open the editor,
// bump the hour once (a real stepper tap, not a raw <input type="time">), Save.
async function bumpTimeField(page: Page, dataWalk: string) {
  const container = page.locator(`[data-walk="${dataWalk}"]`);
  await container.locator("button").first().click();
  await container.getByLabel("Later hour").click();
  await container.getByRole("button", { name: "Save" }).click();
}

// Navigate a genuinely logged-out browser from Welcome all the way to the
// wizard's first ("account") stage — the real pre-account path a brand new
// elder takes, per WelcomeScreen -> OnboardingScreen -> SetupMethodScreen.
async function reachWizardFromWelcome(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: "For Myself", exact: false }).click();
  await page.locator('[data-walk="setup-method-guided"]').click();
  await expect(heading(page, TITLE.accountNew), "wizard opens on the account stage").toBeVisible({ timeout: 15_000 });
}

test("s30 onboarding-resume: fresh-user wizard chain (6 stage transitions) + exit restarts (not resumes) + already-onboarded chat-hook round-trip", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // Two identities, because parts A/B and part C need opposite starting states:
  //
  // Fixture 1 (A+B): a genuinely fresh pre-account user. Deliberately NOT
  // createThrowawayElder() (which seeds a profiles row immediately) — the
  // point of A is to drive the wizard's OWN real signup form, so the auth
  // user is created for real by the browser, inside the test, with no
  // profiles row until (if ever) the wizard's Finish tap runs.
  const freshEmail = `tw-onboard-${Date.now()}-${Math.floor(performance.now())}@dosewise.test`;
  const freshPassword = "Throwaway!2026";
  const freshFullName = "Wizard Test Elder";

  // Fixture 2 (C): a real ALREADY-onboarded elder (profiles row + a non-empty
  // medical profile), used both for the real-chat TRIGGER and the
  // deterministic dev-hook UI proof. Seeded with a distinctive condition so
  // part C's "does re-entering the wizard blow away real profile data" check
  // has something concrete to lose.
  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { data: signInData, error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  const jwt = signInData!.session!.access_token;
  const { error: seedErr } = await supa
    .from("profiles")
    .update({ accessibility: { conditions: ["Diabetes"], completedWalkthroughs: [] } })
    .eq("id", creds.userId);
  expect(seedErr, seedErr?.message).toBeNull();
  console.log(`[FIXTURE] fresh(pre-account)=${freshEmail} already-onboarded elder=${creds.userId}`);

  // ── 2 TRIGGER (part C: real chat, already-onboarded elder) ───────────────
  // soul.md/prompts.py verified precisely (services/hermes/src/hermes/agent/
  // prompts.py): the "walkthroughs not yet shown" gate is driven entirely by
  // CLIENT-SUPPLIED completed_walkthroughs — and markWalkthroughCompleted is
  // ONLY ever called from the spotlight overlay's genuine-completion handler
  // (App.tsx/ElderlyApp.tsx's handleWalkthroughAdvance). Since no overlay ever
  // runs for "onboarding" (see header comment, fact 2), completedWalkthroughs
  // can never contain "onboarding" for ANY elder — so the "not yet shown" gate
  // does NOT structurally block Mei from re-offering onboarding to an
  // already-onboarded elder. Whether the LLM actually chooses to call
  // start_walkthrough for a given phrase is model-behaviour variance (≤3
  // recorded attempts), independent of that structural finding.
  const OPENING = "Could we go through the whole setup again from the very beginning? I'd like to redo my account, conditions, allergies and medicines like when I first joined.";
  const CONFIRM = "Yes please, show me.";
  const turns: TurnResult[] = [];
  let queued: TurnResult["walkthrough"] = null;
  const send = async (label: string, msg: string): Promise<TurnResult> => {
    const t = await agentTurn8901(jwt, msg);
    turns.push(t);
    saveTurnArtifact(ARTIFACTS, `turn-${String(turns.length).padStart(2, "0")}-${label}`, t);
    expect(t.http, `${label} HTTP`).toBe(200);
    if (t.walkthrough?.task_name === "onboarding") queued = t.walkthrough;
    console.log(`[TRIGGER] ${label}: tools=${JSON.stringify(t.tools_used)} walk=${JSON.stringify(t.walkthrough)} reply="${t.reply.slice(0, 140)}"`);
    return t;
  };
  await send("opening", OPENING);
  for (let i = 1; i <= 3 && !queued; i++) await send(`confirm-${i}`, CONFIRM);
  console.log(`[TRIGGER] onboarding walkthrough queued via real chat: ${!!queued} (attempts=${turns.length})`);
  expect(turns.every(t => t.http === 200), "every attempt returned HTTP 200").toBe(true);
  // Report honestly rather than silently swallow: this is the one assertion
  // in this spec genuinely subject to LLM-choice variance rather than a fixed
  // contract (manifest.ts still names start_walkthrough as this scenario's
  // tool — the dev-hook path below is what makes the REST of the proof solid
  // regardless of this outcome).
  expect(queued?.task_name, "real chat eventually routes to start_walkthrough(\"onboarding\")").toBe("onboarding");

  // ── 3 RE-CHECK (baseline) ─────────────────────────────────────────────────
  // start_walkthrough deliberately never populates committed_actions (it's
  // not a write) — confirm the chat exchange alone touched nothing.
  const baseline = await recheckDb(supa, "profiles", { id: creds.userId });
  expect(baseline, "exactly one seeded profiles row").toHaveLength(1);
  expect((baseline[0].accessibility as { conditions?: string[] }).conditions, "chat alone did not touch the seeded profile")
    .toEqual(["Diabetes"]);

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  // ---- Part A: fresh-user wizard chain, 6 real stage transitions ----------
  await reachWizardFromWelcome(page);
  await page.screenshot({ path: `${SHOTS}/1-fresh-account-stage.png`, fullPage: true });

  // account -> profile (the ONE real signUp() this spec drives through the UI
  // — email confirmation is off on this project, so it lands a session
  // immediately, same as helpers.ts's createThrowawayElder).
  await page.locator('[data-walk="wizard-fullname"]').fill(freshFullName);
  await page.locator('[data-walk="wizard-email"]').fill(freshEmail);
  await page.locator('[data-walk="wizard-password"]').fill(freshPassword);
  await page.locator(CONTINUE).click();
  await expect(heading(page, TITLE.profile), "transition 1: account -> profile").toBeVisible({ timeout: 15_000 });

  // profile -> conditions
  await page.locator('[data-walk="wizard-dob"]').fill("1950-06-15");
  await page.locator('[data-walk="wizard-gender-picker"]').getByRole("button", { name: "Female" }).click();
  await page.locator('[data-walk="wizard-weight"]').fill("70");
  await page.locator('[data-walk="wizard-height"]').fill("165");
  await page.locator(CONTINUE).click();
  await expect(heading(page, TITLE.conditions), "transition 2: profile -> conditions").toBeVisible({ timeout: 10_000 });

  // conditions -> allergies
  await addTag(page, "wizard-conditions-taglist", "Diabetes");
  await page.screenshot({ path: `${SHOTS}/2-mid-chain-conditions.png`, fullPage: true });
  await page.locator(CONTINUE).click();
  await expect(heading(page, TITLE.allergies), "transition 3: conditions -> allergies").toBeVisible({ timeout: 10_000 });

  // allergies -> routine
  await addTag(page, "wizard-allergies-taglist", "Peanuts");
  await addTag(page, "wizard-drug-allergies-taglist", "Penicillin");
  await page.locator(CONTINUE).click();
  await expect(heading(page, TITLE.routine), "transition 4: allergies -> routine").toBeVisible({ timeout: 10_000 });

  // routine -> current-meds (real TimeField stepper taps, the same component
  // AddPrescriptionSheet/ElderlySettingsScreen use per CONTEXT.md).
  await bumpTimeField(page, "wizard-routine-wakeTime");
  await page.screenshot({ path: `${SHOTS}/3-mid-chain-routine.png`, fullPage: true });
  await bumpTimeField(page, "wizard-routine-breakfast");
  await bumpTimeField(page, "wizard-routine-sleepTime");
  await page.locator(CONTINUE).click();
  await expect(heading(page, TITLE.currentMeds), "transition 5: routine -> current-meds").toBeVisible({ timeout: 10_000 });

  // current-meds -> med-history (real MedList + TimesPicker quick-chip).
  await page.locator('[data-walk="wizard-medlist-open"]').click();
  await page.getByPlaceholder("e.g. Metformin").fill("Metformin");
  await page.getByPlaceholder("e.g. 500mg").fill("500mg");
  // MedList's `times` already defaults to one slot (breakfast, via
  // defaultDoseTime) — the "Morning" quick-chip is that SAME slot, so
  // toggling it would REMOVE the only time and disable Add. "Evening" is a
  // genuinely distinct slot, so this is a real ADD (1 -> 2 times), not a
  // same-value round-trip.
  await page.locator('[data-walk="wizard-medlist-timespicker"]').getByRole("button", { name: /Evening/ }).click();
  await page.locator('[data-walk="wizard-medlist-add-btn"]').click();
  await expect(page.getByText("Metformin", { exact: false }), "medication landed in the local list").toBeVisible();
  await page.screenshot({ path: `${SHOTS}/4-current-meds-added.png`, fullPage: true });
  await page.locator(CONTINUE).click();
  await expect(heading(page, TITLE.medHistory), "transition 6: current-meds -> med-history").toBeVisible({ timeout: 10_000 });
  console.log("[PART A] 6 real stage transitions covered: account->profile->conditions->allergies->routine->current-meds->med-history. " +
    "Not driven further to med-history->done: part B needs to exit MID-chain, and completing here isn't needed to prove the chain (see part C for a completion run).");

  // ---- Part B: exit mid-chain, then re-enter — resume or restart? --------
  // The ONLY exit affordance that exists (verified from GuidedSetupWizard.tsx
  // — WizardChrome's onBack is goBack while stepIndex>0, and only becomes
  // onExit once already back at stepIndex 0): back-arrow repeatedly to
  // stepIndex 0, then once more. Assert every intermediate title on the way
  // back too — real evidence back-navigation is precise, not just "eventually
  // gets to 0".
  const BACK_SEQUENCE = [TITLE.currentMeds, TITLE.routine, TITLE.allergies, TITLE.conditions, TITLE.profile, TITLE.accountNew];
  for (const title of BACK_SEQUENCE) {
    await page.getByRole("button", { name: BACK_NAME }).click();
    await expect(heading(page, title), `back-nav shows "${title}"`).toBeVisible({ timeout: 10_000 });
  }
  await page.getByRole("button", { name: BACK_NAME }).click(); // the 7th click: stepIndex===0 now, so onBack === onExit
  // NEWLY DISCOVERED, verified empirically (not assumed): onExit's non-resume
  // branch sets preAuthStage="method" (SetupMethodScreen), but App.tsx's
  // session-role effect (the `useEffect` a few hundred lines up whose deps
  // array is `[session, preAuthStage === "wizard"]`) fires on ANY exit from
  // "wizard" — its dependency is the BOOLEAN "is this exactly wizard", not
  // preAuthStage itself, so leaving "wizard" for ANY other stage re-triggers
  // it. For this fresh, still profile-less user it finds no profiles row and
  // force-navigates to "mode" (OnboardingScreen), racing past/overriding
  // onExit's own SetupMethodScreen destination. The app settles on "mode", not
  // "method" — a real, reproducible finding, patch-queued in the final
  // report. Asserting the REAL settled destination rather than the one the
  // code intended.
  await expect(heading(page, "Who are you using"), "exit actually settles on the mode-picker, not SetupMethodScreen (see patch-queue)").toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}/5-exit-state.png`, fullPage: true });
  await page.getByRole("button", { name: "For Myself", exact: false }).click();
  await expect(page.locator('[data-walk="setup-method-guided"]'), "re-selecting For Myself reaches SetupMethodScreen").toBeVisible({ timeout: 10_000 });

  // Re-enter. GuidedSetupWizard's stepIndex is a plain useState(0) with NO
  // persistence anywhere (not walkthroughState.ts, not Supabase) — this
  // remount is expected to RESTART at "account", not resume at "med-history".
  await page.locator('[data-walk="setup-method-guided"]').click();
  // The real signUp from part A DID persist (it's a genuine Supabase auth
  // session, not wizard component state) — so the live `hasSession` prop is
  // now true, and this fresh GuidedSetupWizard instance freezes
  // hasSessionAtStart=true, showing the RETURNING variant (name field only).
  // This is the nuanced, precise finding: the account itself is remembered,
  // but every field the user answered (name, dob, conditions, allergies,
  // routine, the added medication) and the stage position are ALL gone.
  await expect(heading(page, TITLE.accountReturning), "restart, not resume: back at account stage (returning variant)").toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-walk="wizard-fullname"]'), "preferred name lost").toHaveValue("");
  await expect(page.locator('[data-walk="wizard-email"]'), "email field not even re-rendered (hasSessionAtStart=true)").toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/6-resumed-state-restarted.png`, fullPage: true });
  // One more hop to prove it's not just the name — profile answers are gone too.
  await page.locator('[data-walk="wizard-fullname"]').fill("Second Pass");
  await page.locator(CONTINUE).click();
  await expect(heading(page, TITLE.profile), "advances to profile again").toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-walk="wizard-dob"]'), "previously-entered dob (1950-06-15) also lost").not.toHaveValue("1950-06-15");

  // RE-CHECK (fresh user): despite a real signUp + 6 real stage transitions +
  // a full exit/re-enter cycle, NOTHING was ever persisted server-side —
  // saveProfile() only runs inside finish() on the final "done" stage, which
  // this thread never reached. This is WHY resume can't work today even in
  // principle from the server side either: there is no draft anywhere.
  const supaFresh = anonClient();
  const { data: freshSignIn, error: freshErr } = await supaFresh.auth.signInWithPassword({ email: freshEmail, password: freshPassword });
  expect(freshErr, freshErr?.message).toBeNull();
  const freshUserId = freshSignIn!.session!.user.id;
  const freshProfileRows = await recheckDb(supaFresh, "profiles", { id: freshUserId });
  expect(freshProfileRows, "no profiles row exists yet — finish() was never reached").toHaveLength(0);

  // ---- Part C1: chat-hook round trip, a BLANK-PROFILE elder ----------------
  // Orchestrator note (post-agent live fixes, re-verified below): the first
  // draft of this spec used the SAME already-onboarded `creds` elder for both
  // the round-trip proof and the data-loss proof. Two real bugs it found were
  // fixed live in App.tsx/ElderlyApp.tsx/GuidedSetupWizard.tsx (see patch-queue
  // in the final report): (1) a stuck black overlay on return from the wizard,
  // (2) handleElderOnboardingWalkthrough now REFUSES re-entry for any elder
  // who already has real profile data (conditions/allergies/wakeTime/weight/
  // height), to stop finish()'s blind local-state overwrite from wiping it.
  // Fix (2) means `creds` (seeded with conditions:["Diabetes"]) can no longer
  // be driven through the wizard at all — so the round-trip proof now needs
  // its own genuinely BLANK elder, and the data-loss proof becomes "entry is
  // refused, profile untouched" instead of "entry succeeds, profile wiped".
  const blank = await createThrowawayElder();
  const supaBlank = anonClient();
  const { error: blankSignInErr } = await supaBlank.auth.signInWithPassword({
    email: blank.email, password: blank.password,
  });
  expect(blankSignInErr, blankSignInErr?.message).toBeNull();
  await page.evaluate(() => { window.localStorage.clear(); window.sessionStorage.clear(); });
  await signIn(page, blank);
  // signIn()'s own __dwStartWalkthrough readiness check resolves the instant
  // ANY such function exists — which is true from first paint (App.tsx
  // registers its OWN caregiver-shell version unconditionally on mount,
  // before sign-in even happens) — so it does NOT guarantee ElderlyApp's own
  // (elder-specific) hook has overwritten it yet. Waiting for a real,
  // elder-only DOM signal first is what actually proves ElderlyApp mounted
  // and ran its own registration effect (empirically necessary: without this,
  // the dev-hook call below silently no-ops against App.tsx's caregiver
  // handleWalkthroughStart, which has no "onboarding" special case and sets
  // state nothing in the elderly render branch reads).
  await expect(page.locator('[data-tour="elder-schedule"]'), "ElderlyApp Home mounted (its own dev-hook is now bound)").toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/7a-elder-home-before-hook.png`, fullPage: true });

  await resetPhaseLog(page); // clear BEFORE the phase under test (dev-hook entry)

  // Deterministic dev path (task-sanctioned fallback / independent proof
  // alongside the real-chat TRIGGER above): the same client-side entry point
  // Mei's start_walkthrough("onboarding") drives in the real app. `blank` has
  // no conditions/allergies/wakeTime/weight/height, so the new guard correctly
  // ALLOWS entry (nothing here to protect from an overwrite).
  await startWalkthrough(page, "onboarding");
  // hasSession is live-true for this real signed-in elder -> returning variant.
  await expect(heading(page, TITLE.accountReturning), "chat-hook navigated INTO the wizard for a blank-profile elder").toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/7b-chat-hook-entry-wizard.png`, fullPage: true });
  await page.locator('[data-walk="wizard-fullname"]').fill("Ah Ma Revisit 1");
  await page.locator(CONTINUE).click();
  await expect(heading(page, TITLE.profile), "at least one real transition inside the chat-hook entry too").toBeVisible({ timeout: 10_000 });

  // EXIT round-trip: back to account (1 click), then once more to exit.
  await page.getByRole("button", { name: BACK_NAME }).click();
  await expect(heading(page, TITLE.accountReturning)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: BACK_NAME }).click(); // onExit -> resumeElderAfterWizard branch -> appMode="elderly"

  // Real evidence, not assumed: does onExit's resumeElderAfterWizard branch
  // land back in a WORKING elder app? (Originally found stuck here — a stale
  // sessionStorage walkthrough marker, saved by ElderlyApp.handleWalkthroughStart
  // right before handing off to the wizard and never cleared on the way back,
  // restored walkthroughTask="onboarding" and mounted a REAL <Walkthrough>
  // whose first step selector doesn't exist in ElderlyApp — an un-dismissable
  // rect=null black scrim. Fixed by no longer saving that session at all for
  // this task, since ElderlyApp's own overlay never runs it either way.)
  const staleOverlay = page.locator('[class*="bg-black/75"]');
  const exitBtn = page.getByRole("button", { name: "Exit walkthrough" });
  const homeAnchor = page.locator('[data-tour="elder-schedule"]');
  await page.screenshot({ path: `${SHOTS}/8-chat-hook-exit-state.png`, fullPage: true });
  const overlayStuckAfterExit = await staleOverlay.isVisible().catch(() => false);
  const exitBtnCountAfterExit = await exitBtn.count();
  const homeVisibleAfterExit = await homeAnchor.isVisible().catch(() => false);
  console.log(`[PART C1 / onExit] stale black overlay visible=${overlayStuckAfterExit} exitBtnCount=${exitBtnCountAfterExit} homeAnchorVisible=${homeVisibleAfterExit}`);
  expect(overlayStuckAfterExit, "no stuck black overlay after onExit (fixed live — see patch-queue)").toBe(false);
  expect(homeVisibleAfterExit, "lands back on a genuinely working elder Home after onExit").toBe(true);

  // Re-enter a SECOND time and drive all the way to "done" — proves the
  // onComplete branch of resumeElderAfterWizard independently of the onExit
  // branch just tested. `blank` has nothing to lose, so a real completed save
  // here is the CORRECT, intended outcome (unlike the seeded elder in C2).
  await startWalkthrough(page, "onboarding");
  await expect(heading(page, TITLE.accountReturning), "second chat-hook entry also lands in the wizard").toBeVisible({ timeout: 15_000 });
  await page.locator('[data-walk="wizard-fullname"]').fill("Ah Ma Revisit 2");
  for (const expectedNext of [TITLE.profile, TITLE.conditions, TITLE.allergies, TITLE.routine, TITLE.currentMeds, TITLE.medHistory]) {
    await page.locator(CONTINUE).click();
    await expect(heading(page, expectedNext), `drive-to-done: reached "${expectedNext}"`).toBeVisible({ timeout: 10_000 });
  }
  await page.locator(CONTINUE).click(); // med-history -> done
  await expect(heading(page, TITLE.done), "reached the done stage").toBeVisible({ timeout: 10_000 });
  await page.locator(CONTINUE).click(); // Finish -> saveProfile() + markWalkthroughCompleted() + onComplete()

  await expect(homeAnchor, "onComplete's resumeElderAfterWizard branch lands back on elder Home").toBeVisible({ timeout: 15_000 });
  const overlayStuckAfterComplete = await staleOverlay.isVisible().catch(() => false);
  const exitBtnCountAfterComplete = await exitBtn.count();
  console.log(`[PART C1 / onComplete] stale black overlay visible=${overlayStuckAfterComplete} exitBtnCount=${exitBtnCountAfterComplete}`);
  expect(overlayStuckAfterComplete, "no stuck black overlay after onComplete (fixed live — see patch-queue)").toBe(false);
  await page.screenshot({ path: `${SHOTS}/9-chat-hook-complete-state.png`, fullPage: true });

  // RE-CHECK (blank elder, post-completion): a real finish() should have both
  // saved the profile AND marked "onboarding" complete (the fix for the
  // "not yet shown" gate never being able to suppress a second offer).
  const blankAfter = await recheckDb(supaBlank, "profiles", { id: blank.userId });
  expect(blankAfter, "blank elder still exactly one profiles row").toHaveLength(1);
  const blankRow = blankAfter[0] as { full_name: string; accessibility: { completedWalkthroughs?: string[] } };
  expect(blankRow.full_name, "the completed run's own name was saved").toBe("Ah Ma Revisit 2");
  expect(blankRow.accessibility.completedWalkthroughs ?? [], "finish() now marks onboarding complete")
    .toContain("onboarding");

  // ---- Part C2: the NEW guard — re-entry refused for a seeded elder -------
  // Switch to `creds` (seeded with conditions:["Diabetes"], no wakeTime) —
  // the exact shape the live agent run caught the original single-field
  // (`wakeTime`-only) guard missing. Firing the identical dev-hook call must
  // now be a silent, safe no-op: no wizard, no data loss.
  await page.evaluate(() => { window.localStorage.clear(); window.sessionStorage.clear(); });
  await signIn(page, creds);
  await expect(page.locator('[data-tour="elder-schedule"]'), "ElderlyApp Home mounted for the seeded elder").toBeVisible({ timeout: 15_000 });

  await startWalkthrough(page, "onboarding");
  // Give any (incorrect) navigation a real chance to happen before asserting
  // its absence — a bare immediate check would pass trivially.
  await page.waitForTimeout(1500); // settle window for a negative assertion, not a simulated dwell
  await expect(heading(page, TITLE.accountReturning), "guard refuses entry: wizard never appears for an elder with real profile data").toHaveCount(0);
  await expect(homeAnchor, "elder stays on Home — a silent, safe no-op").toBeVisible();
  await page.screenshot({ path: `${SHOTS}/10-guard-refused-seeded-elder.png`, fullPage: true });

  // PACING: every onboarding.ts step is waitFor-only and (per header comment,
  // fact 2) no <Walkthrough> ever mounts on the wizard itself, so this whole
  // UI section — parts A, B, C1, and C2 alike — should have produced ZERO
  // "walkthrough"-surface phase-log entries (no act step ever runs a
  // PaceController).
  const log = await readPhaseLog(page);
  const walkPhases = log.filter(e => e.surface === "walkthrough");
  console.log(`[PACING] walkthrough-surface phase-log entries=${JSON.stringify(walkPhases)}`);
  expect(walkPhases, "no paced walkthrough phases anywhere in this scenario (no act steps, no mounted overlay on the wizard)").toHaveLength(0);

  // ── 3 RE-CHECK (final, seeded elder) ───────────────────────────────────────
  const afterFinish = await recheckDb(supa, "profiles", { id: creds.userId });
  expect(afterFinish, "still exactly one profiles row").toHaveLength(1);
  const finalRow = afterFinish[0] as { full_name: string; accessibility: { conditions?: string[] } };
  console.log(`[RE-CHECK] seeded elder's profiles row after the refused re-entry: full_name="${finalRow.full_name}" accessibility=${JSON.stringify(finalRow.accessibility)}`);
  // createThrowawayElder() always seeds this exact name — proves the guard's
  // refusal really was a no-op, not just "conditions happened to survive".
  expect(finalRow.full_name, "name untouched — nothing in the row changed").toBe("Ah Ma (test)");
  expect(finalRow.accessibility.conditions, "seeded \"Diabetes\" condition SURVIVES — the guard actually engaged")
    .toEqual(["Diabetes"]);

  // ── 6 NO scenario-local ms literals ────────────────────────────────────────
  // No PACING import/constant applies: every timed assertion above is
  // Playwright's own auto-retrying expect(...).toBeVisible({timeout}) (test
  // infra tolerance, not a simulated dwell), and this flow has no
  // scrollIntoView-driven reveal animation to settle (no ChangeHighlight, no
  // autonomous reveal pulse — the wizard itself never scrolls programmatically),
  // so the one sanctioned 500ms settle literal genuinely does not apply here —
  // same honest absence as s20's closing note.
});
