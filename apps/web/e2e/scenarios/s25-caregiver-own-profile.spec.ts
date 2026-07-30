import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, readPhaseLog, recheckAccessibility,
  resetPhaseLog, saveTurnArtifact,
} from "../helpers";
import type { TurnAction } from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s25 caregiver-own-profile (NEW-FE) — a caregiver tells Mei about THEIR OWN
// shellfish allergy; update_medical_profile propose->confirm writes it to
// profiles.accessibility.medical_profile on the CAREGIVER'S OWN row (services/
// hermes/api/routes.py derives elder_id from the JWT sub with no
// act-on-behalf-of, so a caregiver-authenticated turn's ToolContext.elder_id
// IS the caregiver's own id — this scenario has no elder/care_links at all,
// so there is no other row the write could possibly land on). "Already real"
// backend-wise; what this spec actually verifies live is whether the
// caregiver-side UI has anywhere to RING that write. ENTITY_TARGETS
// (src/app/lib/changeHighlight.ts) maps entity_type "profile_field" to
// caregiver screen "patient" -- but PatientScreen.tsx renders the LINKED
// ELDER's mock Patient object (medications/conditions/allergies/contacts only;
// no medicalProfile field exists on the Patient type at all) and there is no
// data-testid="profile_field-medical_profile" (or any "-medical_profile"
// suffix) anywhere in src/app. So the auto-navigation fires correctly, but
// ChangeHighlight's SEARCH_MS poll never finds a target and gives up loudly
// (console.error) instead of ringing anything. Confirmed by full source read
// of changeHighlight.ts/ChangeHighlight.tsx/PatientScreen.tsx/types.ts before
// writing this spec -- this is asserted as the actual (negative) outcome, not
// worked around.
const ARTIFACTS = "e2e/artifacts/s25";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s25"; // durable, NOT wiped

interface CaregiverCreds { email: string; password: string; userId: string }

// helpers.ts has no standalone "just a caregiver, no elder link" signup —
// createCaregiverWithPendingLink always ties one to an elder via a care_links
// insert, which this scenario doesn't need (update_medical_profile never
// touches care_links). Mirrors s23-caregiver-care-note.spec.ts's local helper
// EXACTLY (createThrowawayElder with role: "caregiver").
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
// this account. Mirrors s23's signInCaregiver EXACTLY: same login form, wait on
// a caregiver-shell-only readiness signal (bottom nav) instead.
async function signInCaregiver(page: Page, creds: CaregiverCreds) {
  await page.goto("/");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator('input[type="email"]').fill(creds.email);
  await page.locator('input[type="password"]').fill(creds.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForSelector('[data-tour="nav-ai"]', { timeout: 20_000 });
}

test("s25 caregiver-own-profile: 'I have a shellfish allergy myself, please note it in my profile' -> propose/confirm writes the CAREGIVER'S OWN medical_profile; no caregiver-side render target exists for profile_field (finding)", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  // A throwaway CAREGIVER account — no elder, no care_links row.
  // update_medical_profile writes to whatever id the JWT authenticates as, so
  // this scenario needs nothing else seeded.
  const creds = await createThrowawayCaregiver();
  const supa = anonClient();
  const { data: signInData, error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  const jwt = signInData!.session!.access_token;

  // ── 2 TRIGGER (real :8901, propose→confirm on the SAME caregiver session) ──
  // Sessions persist per authenticated id, so propose (turn A) and confirm
  // (turn B) MUST use the same jwt — the confirm consumes the pending_profile
  // the propose stashed (services/hermes/tools/base.py::match_pending).
  const PROPOSE_PHRASE = "I have a shellfish allergy myself, please note it in my profile";
  let propose = await agentTurn8901(jwt, PROPOSE_PHRASE);
  saveTurnArtifact(ARTIFACTS, "propose-attempt-1", propose);
  for (let attempt = 2; attempt <= 3 && !propose.tools_used.includes("update_medical_profile"); attempt++) {
    console.log(`[PROPOSE] attempt ${attempt} (previous tools_used=${JSON.stringify(propose.tools_used)})`);
    propose = await agentTurn8901(jwt, PROPOSE_PHRASE);
    saveTurnArtifact(ARTIFACTS, `propose-attempt-${attempt}`, propose);
  }
  expect(propose.http, "propose turn HTTP status").toBe(200);
  expect(propose.tools_used, "propose routed to update_medical_profile").toContain("update_medical_profile");
  // A propose MUST NOT commit and MUST NOT write.
  expect(
    propose.actions.find(a => a.tool === "update_medical_profile"),
    "propose: nothing committed yet",
  ).toBeFalsy();
  expect(propose.reply, "propose reads the allergy back").toMatch(/shellfish/i);
  // Independent re-read: the CAREGIVER's own profile has no medical_profile yet.
  expect(
    await recheckAccessibility(supa, creds.userId, "medical_profile"),
    "propose did not write: caregiver's own profile still has no medical_profile",
  ).toBeUndefined();

  const CONFIRM_PHRASE = "yes";
  let confirm = await agentTurn8901(jwt, CONFIRM_PHRASE);
  saveTurnArtifact(ARTIFACTS, "confirm-attempt-1", confirm);
  for (let attempt = 2; attempt <= 3 && !confirm.actions.some(a => a.tool === "update_medical_profile"); attempt++) {
    console.log(`[CONFIRM] attempt ${attempt} (previous tools_used=${JSON.stringify(confirm.tools_used)})`);
    confirm = await agentTurn8901(jwt, CONFIRM_PHRASE);
    saveTurnArtifact(ARTIFACTS, `confirm-attempt-${attempt}`, confirm);
  }
  expect(confirm.http, "confirm turn HTTP status").toBe(200);
  expect(confirm.tools_used, "confirm routed to update_medical_profile").toContain("update_medical_profile");
  const action = confirm.actions.find(a => a.tool === "update_medical_profile") as TurnAction | undefined;
  expect(action, "confirm committed a profile action").toBeTruthy();
  // Verified against services/hermes/tools/profile.py (read-only), not assumed:
  // entity_type is the literal "profile_field", entity_id the literal
  // "medical_profile" field-key (never the elder/caregiver uuid).
  expect(action!.entity_type, "committed entity_type").toBe("profile_field");
  expect(action!.entity_id, "committed entity_id is the field key").toBe("medical_profile");
  expect(action!.changed_fields?.medical_profile, "changed_fields.medical_profile diff present").toBeTruthy();
  expect(action!.changed_fields!.medical_profile!.before, "before is null (fresh profile)").toBeNull();
  const savedProfile = String(action!.changed_fields!.medical_profile!.after ?? "");
  expect(savedProfile, "profile captures what was actually said").toMatch(/shellfish/i);
  console.log(`[TRIGGER] committed action=${JSON.stringify(action)}`);

  // ── 3 RE-CHECK ────────────────────────────────────────────────────────────
  // Independent Supabase re-read — the DB is the truth, not the turn's reply.
  // creds.userId is the CAREGIVER's own id; this fixture never creates an
  // elder/profiles row at all, so there is no other row this could land on.
  const after = await recheckAccessibility(supa, creds.userId, "medical_profile");
  expect(after, "committed content lands on the CAREGIVER'S OWN profiles row").toBe(savedProfile);
  expect(String(after), "re-read independently confirms the shellfish allergy").toMatch(/shellfish/i);

  // ── 4 UI + PACING ─────────────────────────────────────────────────────────
  await signInCaregiver(page, creds); // baseURL :5173, lands on caregiver Dashboard
  const consoleErrors: string[] = [];
  page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  await resetPhaseLog(page); // clear BEFORE the highlight phase under test

  // Fire the REAL committed action (real changed_fields) through the caregiver
  // shell's dev hook — mirrors s23/s16's pattern, decoupled from a second live
  // LLM call. profile_field's caregiver target is "patient"
  // (changeHighlight.ts ENTITY_TARGETS), which the Dashboard we land on is
  // not, so a successful navigation here also proves the auto-navigate half
  // of the plumbing independently of whether anything is found to ring.
  await page.evaluate(a => {
    (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a);
  }, action!);

  // Auto-navigation DOES work: data-tour="cg-medlist" only renders inside
  // PatientScreen (verified: grepped as unique to that file), so its
  // visibility proves ChangeHighlight's onNavigate("patient") fired.
  await expect(
    page.locator('[data-tour="cg-medlist"]'),
    "auto-navigated to the caregiver Patient screen (profile_field's ENTITY_TARGETS.caregiver target)",
  ).toBeVisible({ timeout: 10_000 });

  // FINDING: PatientScreen renders the LINKED ELDER's mock Patient object
  // (medications/conditions/allergies/contacts) — it has no medicalProfile
  // field and no data-testid="profile_field-medical_profile" (nor any
  // "-medical_profile" suffix) anywhere in src/app. ChangeHighlight polls for
  // up to its internal SEARCH_MS budget, then gives up LOUDLY (a
  // console.error naming the exact missing testid) rather than silently. We
  // wait on that specific log line as the deterministic proof of "gave up",
  // rather than asserting an absence for an unbounded time.
  await expect.poll(
    () => consoleErrors.some(m => m.includes("element(s) never found for")),
    {
      message: "waiting for ChangeHighlight's give-up log once its internal search budget elapses",
      timeout: 8_000,
    },
  ).toBe(true);
  const missingMsg = consoleErrors.find(m => m.includes("element(s) never found for"));
  expect(missingMsg, "console.error names the exact missing testid").toContain(
    'data-testid="profile_field-medical_profile"',
  );

  // Confirms the negative outcome directly, not just via the console log.
  await expect(
    page.locator('[data-testid="profile_field-medical_profile"]'),
    "no element with this testid exists anywhere (the gap)",
  ).toHaveCount(0);
  await expect(
    page.locator(".change-highlight"),
    "nothing ever rings — no DOM target exists for profile_field caregiver-side",
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="change-highlight-caption"]'),
    "no caption ever shown (phase never reaches 'shown')",
  ).toHaveCount(0);
  // No scrollIntoView-settle wait here (the mandated 500ms literal): that only
  // applies once an element is FOUND and scrolled to, which never happens on
  // this path — see the finding above.

  // ── 5 SCREENSHOT ──────────────────────────────────────────────────────────
  // The real, current outcome: caregiver Patient screen, auto-navigated to,
  // showing no ring and no caption — durable evidence of the gap.
  await page.screenshot({ path: `${SHOTS}/patient-no-highlight-target.png`, fullPage: true });

  // PACING: no dwell entry is recorded — the highlight never reaches "shown",
  // so PACING.HIGHLIGHT_DWELL_MIN_MS (the min dwell sibling scenarios assert)
  // never applies here. Asserted directly against the phase log rather than
  // forcing assertPhaseMins to pass on an entry that doesn't exist.
  const log = await readPhaseLog(page);
  const dwellEntries = log.filter(e => e.surface === "highlight" && e.phase === "dwell");
  expect(
    dwellEntries,
    `no highlight/dwell phase-log entry recorded (would need >= ${PACING.HIGHLIGHT_DWELL_MIN_MS}ms if a ring were achievable here) — confirms the highlight never reached "shown"`,
  ).toHaveLength(0);

  // ── 6 NO scenario-local ms literals ───────────────────────────────────────
  // All timing constants come from the imported PACING object (referenced
  // above) or are Playwright test/action deadlines (10_000/8_000/20_000/
  // 120_000), not UI pacing. No scroll-settle wait is used (see section 4).
});
