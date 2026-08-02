import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  anonClient, assertPhaseMins, createThrowawayElder, recheckDb, readPhaseLog,
  resetPhaseLog, signIn, startWalkthrough, advanceWalkthroughToStep, finishWalkthrough,
} from "../helpers";
import { PACING } from "../../src/app/lib/walkthrough/pacing";

// App.tsx's handleWalkthroughAdvance calls `void markWalkthroughCompleted(...)`
// on tour completion — fire-and-forget, never awaited by the UI, and itself a
// fetch-then-upsert round trip to the (hosted, not local) Supabase project. A
// single immediate recheckDb can race it and read the row before the write
// lands (mirrors s27/s29's identical, already-documented race). Bounded,
// short-interval poll for an already-fired background write to become
// visible; not a UI-pacing wait.
async function waitForCompletedWalkthrough(
  supa: SupabaseClient, userId: string, taskName: string,
): Promise<Record<string, unknown>[]> {
  const attempts = 10;
  const intervalMs = 300;
  let rows = await recheckDb(supa, "profiles", { id: userId });
  for (let i = 0; i < attempts; i++) {
    const completed = (rows[0]?.accessibility as { completedWalkthroughs?: string[] } | undefined)?.completedWalkthroughs ?? [];
    if (completed.includes(taskName)) return rows;
    await sleep(intervalMs);
    rows = await recheckDb(supa, "profiles", { id: userId });
  }
  return rows; // exhausted — return the last read and let the assertion below fail honestly
}

// s20 language-voice (VIEW) — a client-side spotlight tour of the elder's Voice
// & Language settings (ElderlySettingsScreen.tsx). Manifest tools: [] is literal:
// language & voiceOutput are localStorage-only settings (lib/languageContext's
// "dosewise-language", accessibility.tsx's "dosewise:accessibility") with NO
// Hermes tool and NO Supabase write — so there is no real TRIGGER turn (nothing
// for an LLM to route to) and no ChangeHighlight tail.
//
// 2026-07-28 contract flip (Item 5): this tour is now AI-AUTO-ADVANCED. All three
// steps are `act:click`, so Mei drives the spotlight herself at the slow PACING
// rate — the person just watches. Crucially she clicks the CONTAINER of each
// control (the nav item, the card, the <select>), NEVER toggling Read-Aloud or
// picking a language, so the tour changes NOTHING on the person's behalf. This
// spec proves exactly that: the tour self-drives to completion, records paced
// walkthrough phases (no longer the old user-driven "zero phases"), and language
// + voiceOutput stay UNCHANGED while Supabase gains only the generic
// completion-marker every walkthrough writes. Owns: this spec + steps/language_voice_tour.ts.
const SHOTS = "e2e/design-shots/scenarios/s20"; // durable, NOT wiped

// Read the two client-only settings this tour spotlights, straight out of
// localStorage — the same keys languageContext / accessibility.tsx own. No
// Supabase involved: this IS the "where the value actually lives" check.
async function readClientSettings(page: import("@playwright/test").Page): Promise<{ language: string | null; voiceOutput: boolean | undefined }> {
  return page.evaluate(() => {
    const language = window.localStorage.getItem("dosewise-language");
    const raw = window.localStorage.getItem("dosewise:accessibility");
    let voiceOutput: boolean | undefined;
    try { voiceOutput = raw ? JSON.parse(raw).voiceOutput : undefined; } catch { voiceOutput = undefined; }
    return { language, voiceOutput };
  });
}

test("s20 language-voice: AI-auto-advanced Voice & Language tour self-drives, records paced phases, and changes NOTHING (client + backend)", async ({ page }) => {
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

  // Baseline Supabase snapshot BEFORE any UI interaction, so the VIEW-ONLY proof
  // is a real before/after diff.
  const profileBefore = await recheckDb(supa, "profiles", { id: creds.userId });
  expect(profileBefore, "exactly the one seeded profiles row").toHaveLength(1);
  const medsBefore = await recheckDb(supa, "medications", { elder_id: creds.userId });
  expect(medsBefore, "no medications exist (none seeded)").toHaveLength(0);

  // ── 2 TRIGGER — deliberately NONE ─────────────────────────────────────────
  // manifest.ts's tools: [] for s20 is literal: no phrase routes an LLM tool call
  // here — language/voiceOutput are pure client settings, so this tour's only
  // entry point is the app's own UI (dev-bridge startWalkthrough stands in for
  // that in-app trigger).

  // ── 2/4 WALKTHROUGH UI — AUTONOMOUS, SELF-DRIVING ─────────────────────────
  await signIn(page, creds); // lands on Home (:5173)
  const before = await readClientSettings(page);
  console.log(`[CLIENT before] language=${before.language} voiceOutput=${before.voiceOutput}`);

  // resetPhaseLog first so the log holds only this interaction. Every step is
  // act:click → autonomous → Mei performs each tap herself at the PACING pace,
  // but the step then HOLDS at its commit gate until the person taps Next
  // (nothing auto-advances any more), so we supply those taps below.
  await resetPhaseLog(page);
  await startWalkthrough(page, "language_voice_tour");

  // The overlay appears (step 1 spotlights the always-mounted Settings nav) and,
  // being autonomous, renders a Next control (a user-driven consent step never
  // does). Mei performs each step's tap; the person decides when to move on.
  await expect(page.locator('[data-tour="nav-settings"]'), "step 1 nav target spotlit").toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), "overlay is up").toBeVisible();

  // Screenshot mid-tour: the language selector step is the deliverable shot.
  await advanceWalkthroughToStep(page, 3);
  await page.screenshot({ path: `${SHOTS}/walkthrough-step3-language-selector.png`, fullPage: true });

  // Tapping through the rest completes it: the overlay unmounts (Exit gone).
  await finishWalkthrough(page);
  await expect(page.getByRole("button", { name: "Exit walkthrough" }), "tour completes once tapped through").toHaveCount(0, { timeout: 20_000 });

  // ── PACING: it is now PACED (the inverse of the old "zero phases") ─────────
  const walkLog = await readPhaseLog(page);
  const walkPhases = walkLog.filter(e => e.surface === "walkthrough");
  console.log(`[PHASELOG] walkthrough entries=${JSON.stringify(walkPhases.map(e => `${e.surface}/${e.phase}`))}`);
  expect(walkPhases.length, "autonomous tour records paced walkthrough phases").toBeGreaterThan(0);
  // Three act:click steps (step 1 no onEnter; steps 2-3 have onEnter → a navigate
  // settle): so a `click` phase (PRE_CLICK_MS) and a `navigate` phase (NAVIGATE_MS)
  // are both present, each floored at its minimum.
  assertPhaseMins(walkLog, [
    { surface: "walkthrough", phase: "click", min: PACING.PRE_CLICK_MS },
    { surface: "walkthrough", phase: "navigate", min: PACING.NAVIGATE_MS },
  ]);

  // ── 3 VIEW-ONLY PROOF: the tour changed NOTHING ───────────────────────────
  const after = await readClientSettings(page);
  console.log(`[CLIENT after] language=${after.language} voiceOutput=${after.voiceOutput}`);
  expect(after.language, "language unchanged — Mei only spotlit the selector, never picked one").toBe(before.language);
  expect(after.voiceOutput, "voiceOutput unchanged — Mei clicked the card container, never the toggle").toBe(before.voiceOutput);

  // Backend: identity untouched; accessibility gains ONLY the generic
  // walkthrough-completion marker (markWalkthroughCompleted — shared engine
  // bookkeeping every task writes, NOT a language/voice write and NOT a committed
  // agent action). No medications touched.
  // Polled, not single-shot — see waitForCompletedWalkthrough's comment: the
  // completion write is fire-and-forget from the UI's perspective.
  const profileAfter = await waitForCompletedWalkthrough(supa, creds.userId, "language_voice_tour");
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
  await page.screenshot({ path: `${SHOTS}/settings-after-tour.png`, fullPage: true });

  // ── 5 NO scenario-local ms literals ───────────────────────────────────────
  // All timing assertions go through PACING via assertPhaseMins; no raw literals.
});
