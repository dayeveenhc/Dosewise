import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  agentTurn8901, anonClient, assertPhaseMins, createThrowawayElder,
  readPhaseLog, recheckAccessibility, resetPhaseLog, saveTurnArtifact, signIn,
} from "../helpers";
import type { TurnAction } from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// s16 allergy-severity (NEW-BE-FE) — set_allergy_severity propose→confirm grades a
// SAVED allergy. The fixture seeds a LEGACY plain-string allergies list; the commit
// promotes it IN PLACE to {name, severity} objects (backend _promote_allergies —
// the whole list, order preserved, non-target entries kept). The honest path then
// rings the elder Settings allergy chip (data-testid="allergy-{slug}", slug of
// "Penicillin" = "penicillin") with a "severe" severity badge and the caption
// "Updated: Penicillin allergy — unset → severe".
const ARTIFACTS = "e2e/artifacts/s16";          // wiped per run (via --output)
const SHOTS = "e2e/design-shots/scenarios/s16"; // durable, NOT wiped

test("s16 allergy-severity: 'My penicillin allergy is severe, not mild' -> propose→confirm promotes the legacy string to {name, severity:'severe'} and rings the chip", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });

  // ── 1 FIXTURE ─────────────────────────────────────────────────────────────
  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { data: signInData, error: sErr } = await supa.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  });
  expect(sErr, sErr?.message).toBeNull();
  const jwt = signInData!.session!.access_token;
  // Seed accessibility.allergies as LEGACY PLAIN STRINGS (the pre-promotion shape)
  // AS the elder — this is exactly what proves the string→object promotion on the
  // first grade. Two entries so "order preserved" + "non-target intact" have teeth
  // rather than being vacuous: only Penicillin gets a severity; Aspirin must
  // survive the promotion untouched (severity null).
  const { error: aErr } = await supa.from("profiles")
    .update({ accessibility: { allergies: ["Penicillin", "Aspirin"] } })
    .eq("id", creds.userId);
  expect(aErr, aErr?.message).toBeNull();
  // Prove the seed landed as plain strings (the "before" state of the promotion).
  expect(
    await recheckAccessibility(supa, creds.userId, "allergies"),
    "seed is legacy plain strings",
  ).toEqual(["Penicillin", "Aspirin"]);

  // ── 2 TRIGGER (real :8901, propose→confirm on the SAME elder session) ───────
  // Sessions persist per elder_id, so propose (turn A) and confirm (turn B) MUST
  // use the same jwt — the confirm consumes the pending_bulk the propose stashed.
  const PROPOSE_PHRASE = "My penicillin allergy is severe, not mild";
  let propose = await agentTurn8901(jwt, PROPOSE_PHRASE);
  saveTurnArtifact(ARTIFACTS, "propose-attempt-1", propose);
  for (let attempt = 2; attempt <= 3 && !propose.tools_used.includes("set_allergy_severity"); attempt++) {
    console.log(`[PROPOSE] attempt ${attempt} (previous tools_used=${JSON.stringify(propose.tools_used)})`);
    propose = await agentTurn8901(jwt, PROPOSE_PHRASE);
    saveTurnArtifact(ARTIFACTS, `propose-attempt-${attempt}`, propose);
  }
  expect(propose.http, "propose turn HTTP status").toBe(200);
  expect(propose.tools_used, "propose routed to set_allergy_severity").toContain("set_allergy_severity");
  // A propose MUST NOT commit and MUST NOT write.
  expect(
    propose.actions.find(a => a.tool === "set_allergy_severity"),
    "propose: nothing committed yet",
  ).toBeFalsy();
  expect(propose.reply, "propose reads the severity back").toMatch(/severe/i);
  // The list is STILL the legacy plain strings — no promotion happened on propose.
  expect(
    await recheckAccessibility(supa, creds.userId, "allergies"),
    "propose did not write: allergies still legacy strings",
  ).toEqual(["Penicillin", "Aspirin"]);

  const CONFIRM_PHRASE = "yes";
  let confirm = await agentTurn8901(jwt, CONFIRM_PHRASE);
  saveTurnArtifact(ARTIFACTS, "confirm-attempt-1", confirm);
  for (let attempt = 2; attempt <= 3 && !confirm.actions.some(a => a.tool === "set_allergy_severity"); attempt++) {
    console.log(`[CONFIRM] attempt ${attempt} (previous tools_used=${JSON.stringify(confirm.tools_used)})`);
    confirm = await agentTurn8901(jwt, CONFIRM_PHRASE);
    saveTurnArtifact(ARTIFACTS, `confirm-attempt-${attempt}`, confirm);
  }
  expect(confirm.http, "confirm turn HTTP status").toBe(200);
  expect(confirm.tools_used, "confirm routed to set_allergy_severity").toContain("set_allergy_severity");
  const action = confirm.actions.find(a => a.tool === "set_allergy_severity") as TurnAction | undefined;
  expect(action, "confirm committed an allergy action").toBeTruthy();
  expect(action!.entity_type, "committed entity_type").toBe("allergy");
  // THE exact slug — byte-for-byte mirror of backend _allergy_slug("Penicillin").
  expect(action!.entity_id, "committed entity_id == slug('Penicillin')").toBe("penicillin");
  expect(action!.name, "committed carries the saved allergy name").toBe("Penicillin");
  expect(action!.changed_fields?.severity, "severity diff null → severe")
    .toEqual({ before: null, after: "severe" });

  // ── 3 RE-CHECK (independent Supabase re-read — the DB is the truth) ─────────
  const allergiesAfter = await recheckAccessibility(supa, creds.userId, "allergies");
  // PROMOTION: the whole list is now {name, severity} OBJECTS (was plain strings);
  // order preserved (Penicillin first), non-target Aspirin intact (promoted to an
  // object but its severity stays null).
  expect(allergiesAfter, "legacy strings promoted to objects; order + others intact")
    .toEqual([{ name: "Penicillin", severity: "severe" }, { name: "Aspirin", severity: null }]);

  // ── 4 UI + PACING (chat→highlight; no walkthrough) ──────────────────────────
  await signIn(page, creds); // baseURL :5173, lands on Home
  await page.locator('[data-tour="nav-settings"]').click(); // elder Settings tab
  // The always-visible allergy chip lives in the summary card, NOT the collapsed
  // "Your Profile" editor — so it is the ring target with nothing to expand. Wait
  // for the PROMOTED object to render before firing the highlight.
  const chip = page.locator('[data-testid="allergy-penicillin"]');
  await expect(chip, "promoted Penicillin chip rendered").toBeVisible({ timeout: 15_000 });
  await resetPhaseLog(page); // clear BEFORE the highlight phase under test
  // Fire the REAL committed action from the confirm turn: ChangeHighlight resolves
  // data-testid="allergy-penicillin", rings it, and shows the diff caption.
  await page.evaluate((a) => {
    (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a);
  }, action as unknown as Record<string, unknown>);

  await expect(chip, "allergy chip ringed").toHaveClass(/change-highlight/, { timeout: 10_000 });
  // The chip now renders the TRANSLATED severity label (severity.severe), not
  // the raw backend enum value — that word used to be the one piece of the
  // allergy row that never changed language.
  await expect(chip.locator("em"), "severity chip shows the localized 'severe'").toHaveText("Severe");
  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption, "change caption visible").toBeVisible();
  await page.waitForTimeout(500); // let smooth scrollIntoView settle
  const captionText = ((await caption.textContent()) ?? "").replace(/\s+/g, " ").trim();
  expect(captionText, "caption reflects the severity change — not a bare 'Added'")
    .toBe("Updated: Penicillin allergy — unset → severe");

  // ── 5 SCREENSHOT (ringed chip + caption) ────────────────────────────────────
  await page.screenshot({ path: `${SHOTS}/allergy-severity-ringed.png`, fullPage: true });

  // Let the highlight dwell run to completion so its phase-log entry is recorded
  // (recordDwell fires at auto-dismiss, HIGHLIGHT_DWELL_MIN_MS after the ring shows).
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

  // ── 6 NO scenario-local ms literals ─────────────────────────────────────────
  // All experience timing via PACING above; the only literal is the 500ms
  // scroll-settle wait, with its mandated comment.
});
