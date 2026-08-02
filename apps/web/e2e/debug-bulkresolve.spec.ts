import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { anonClient, createThrowawayElder, env, signIn } from "./helpers";
import { firstHighlightable, testIdFor } from "../src/app/lib/changeHighlight";
import type { AgentAction } from "../src/app/lib/hermes";

// Debug-BulkResolve (REPRO ONLY — no fixes): demonstrate the frontend
// consumption path for a turn that commits THREE log_dose actions.
// 1. Seed elder + 3 past-due meds, replay the real two-turn dialog on :8901.
// 2. If the LLM commits >=2 actions, use the REAL actions[]; else mirror the
//    run-3 committed writes (3 taken doses at now) and use the exact action
//    shape captured from the real run (synthesis is disclosed in the log).
// 3. Run the REAL firstHighlightable() on the array (the exact call
//    ElderlyAIScreen.tsx:299 makes) -> only actions[0] is selected.
// 4. Drive the real Home UI: fire the one-slot dev hook with that selection ->
//    exactly ONE card rings; then fire actions[1] to show the singleton
//    replaces (never stacks) the previous ring.

const HERMES_LOCAL = "http://127.0.0.1:8901";
const SHOTS = "e2e/artifacts/debug-bulkresolve";

test("bulk resolve: 3 committed log_dose actions -> only actions[0] ever rings", async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // --- seed: elder + 3 meds, all times past (22:xx SGT at run time) ---------
  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { data: si, error: siErr } = await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  expect(siErr, siErr?.message).toBeNull();
  const jwt = si!.session!.access_token;

  const MEDS = [
    { name: "Metformin", dosage: "500mg", purpose: "blood sugar", schedule: { times: ["08:00"], frequency: "daily" } },
    { name: "Amlodipine", dosage: "5mg", purpose: "blood pressure", schedule: { times: ["09:00"], frequency: "daily" } },
    { name: "Atorvastatin", dosage: "20mg", purpose: "cholesterol", schedule: { times: ["12:00"], frequency: "daily" } },
  ];
  const medIds: Record<string, string> = {};
  for (const m of MEDS) {
    const { data, error } = await supa.from("medications").insert({ elder_id: creds.userId, ...m }).select("id").single();
    expect(error, error?.message).toBeNull();
    medIds[m.name] = data!.id;
  }
  console.log(`[SEED] elder=${creds.userId} meds=${JSON.stringify(medIds)}`);

  // --- replay the real two-turn dialog --------------------------------------
  async function turn(message: string) {
    const resp = await fetch(`${HERMES_LOCAL}/agent/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hermes-Api-Key": env().VITE_HERMES_API_KEY ?? "" },
      body: JSON.stringify({ message, jwt }),
    });
    expect(resp.ok, `agent/turn HTTP ${resp.status}`).toBeTruthy();
    return resp.json() as Promise<{ reply: string; tools_used: string[]; actions: AgentAction[] }>;
  }
  const t1 = await turn("resolve and tick all my missing dosages");
  console.log(`[TURN1] tools=${JSON.stringify(t1.tools_used)} actions=${t1.actions.length} reply=${JSON.stringify(t1.reply).slice(0, 160)}`);
  let actions = t1.actions;
  if (actions.length < 2) {
    const t2 = await turn("yes, all of them please");
    console.log(`[TURN2] tools=${JSON.stringify(t2.tools_used)} actions=${t2.actions.length} reply=${JSON.stringify(t2.reply).slice(0, 160)}`);
    actions = t2.actions;
  }

  let synthesized = false;
  if (actions.length < 2) {
    // LLM variance miss this run: mirror run 3's real committed writes so the
    // UI consumption path is still exercised with the exact real action shape.
    synthesized = true;
    actions = [];
    for (const m of MEDS) {
      const now = new Date().toISOString();
      const { data, error } = await supa.from("doses")
        .insert({ medication_id: medIds[m.name], elder_id: creds.userId, scheduled_at: now, status: "taken", logged_at: now, logged_by: creds.userId })
        .select("id").single();
      expect(error, error?.message).toBeNull();
      actions.push({
        tool: "log_dose", summary: m.name, name: m.name, entity_type: "dose", entity_id: medIds[m.name],
        dose_id: data!.id, changed_fields: { status: { before: null, after: "taken" } },
      } as AgentAction);
    }
  }
  console.log(`[ACTIONS] source=${synthesized ? "SYNTHESIZED (mirrors run-3 real shape)" : "REAL LLM turn"} count=${actions.length}`);
  console.log(JSON.stringify(actions, null, 2));
  expect(actions.length).toBe(3);

  // --- the REAL production selection: ElderlyAIScreen.tsx:299 ---------------
  const selected = firstHighlightable(actions);
  console.log(`[CONSUME] firstHighlightable -> ${selected?.summary} (${selected && testIdFor(selected)})`);
  console.log(`[CONSUME] never highlighted: ${actions.slice(1).map(a => a.summary).join(", ")}`);
  expect(selected).toBe(actions[0]);

  // --- drive the real Home UI ------------------------------------------------
  await signIn(page, creds);
  for (const m of MEDS) {
    await expect(page.locator(`[data-testid="medication-${medIds[m.name]}"]`)).toBeVisible({ timeout: 20_000 });
  }
  await page.screenshot({ path: `${SHOTS}/01-home-all-taken.png` });

  // Fire the one-slot hook with the production-selected action (actions[0]).
  await page.evaluate(a => (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a), selected);
  const ringed = page.locator(".change-highlight");
  await expect(ringed).toHaveCount(1, { timeout: 10_000 });
  const ringedId1 = await ringed.first().getAttribute("data-testid");
  console.log(`[UI] after firing actions[0]: exactly 1 ring, on ${ringedId1}`);
  await page.screenshot({ path: `${SHOTS}/02-only-first-card-ringed.png` });

  // Singleton behavior: a second change REPLACES the first (never two rings).
  await page.evaluate(a => (window as unknown as { __dwHighlightChange: (x: unknown) => void }).__dwHighlightChange(a), actions[1]);
  await expect(page.locator(`[data-testid="${testIdFor(actions[1])}"].change-highlight, [data-testid$="-${actions[1].entity_id}"].change-highlight`)).toHaveCount(1, { timeout: 10_000 });
  await expect(ringed).toHaveCount(1);
  const ringedId2 = await page.locator(".change-highlight").first().getAttribute("data-testid");
  console.log(`[UI] after firing actions[1]: still exactly 1 ring, now on ${ringedId2} (previous canceled)`);
  await page.screenshot({ path: `${SHOTS}/03-second-fire-replaces-first.png` });
});
