import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { anonClient, createThrowawayElder, env, signIn, walkthroughStep } from "../e2e/helpers";
import { TRUST_MODE_THRESHOLD } from "../src/app/lib/walkthrough/pacing";

// ─────────────────────────────────────────────────────────────────────────────
// Item 3 (RiskClassifier) — the end-to-end thread that pytest cannot see.
//
// test_risk_classifier.py proves assess_risk's math. e2e/helpers.ts's
// startWalkthrough() takes a `risk` argument that goes straight into the dev
// hook, deliberately BYPASSING real classification (its own comment says so) —
// so every existing risk assertion in this repo is about a hand-written
// literal, not about anything the server produced.
//
// This spec closes that gap in three steps:
//   1. a REAL /agent/turn on the scratch hermes (:8901) classifies a genuinely
//      risky write and returns walkthrough.risk;
//   2. the browser's own chat path consumes that real response (page.route
//      redirects the app's /agent/turn to :8901, because the standing Vite
//      server's VITE_HERMES_URL is baked at serve time and points at the
//      demo backend, which predates this feature);
//   3. the Confirm phase holds a VETERAN (trust earned, manual mode off) at an
//      explicit tap — the one configuration that otherwise auto-elapses.
//
// Plus the negative: a benign task carries no `risk` key at all.

const HERMES = "http://127.0.0.1:8901";
const ARTIFACTS = "scratchpad/shots/risk";

interface RawTurn {
  http: number;
  reply: string;
  tools_used: string[];
  actions: Array<Record<string, unknown>>;
  walkthrough: {
    task_name: string;
    params?: Record<string, string>;
    risk?: { flagged: boolean; signals: string[]; reasons: string[] };
  } | null;
}

// A raw turn — helpers.ts's agentTurn8901 models `walkthrough` without `risk`
// (it predates this feature), and the whole point here is the key it drops.
async function rawTurn(jwt: string, message: string): Promise<RawTurn> {
  const resp = await fetch(`${HERMES}/agent/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hermes-Api-Key": env().VITE_HERMES_API_KEY ?? "" },
    body: JSON.stringify({ message, jwt }),
  });
  const text = await resp.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { throw new Error(`non-JSON HTTP ${resp.status}: ${text.slice(0, 300)}`); }
  return {
    http: resp.status,
    reply: (body.reply as string) ?? "",
    tools_used: (body.tools_used as string[]) ?? [],
    actions: (body.actions as Array<Record<string, unknown>>) ?? [],
    walkthrough: (body.walkthrough as RawTurn["walkthrough"]) ?? null,
  };
}

// Seed an elder who already takes Lisinopril 5mg, so a proposed 20mg is a real
// 4x jump against real on-file data — DOSAGE_INCREASE_MULTIPLIER is 2x.
async function seedElderOnLisinopril() {
  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { data, error } = await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  const { error: medErr } = await supa.from("medications").insert({
    elder_id: creds.userId, name: "Lisinopril", dosage: "5mg",
    purpose: "blood pressure", schedule: { times: ["08:00"], frequency: "daily" },
  });
  if (medErr) throw new Error(`medication seed failed: ${medErr.message}`);
  return { creds, supa, jwt: data.session!.access_token };
}

// Make the app's own /agent/turn calls land on the scratch hermes, so the
// REAL client code path (ElderlyAIScreen's send() → hermes.ts::agentTurn →
// handleWalkthroughStart(task, params, risk)) consumes a REAL classifier
// response. Nothing about the client is stubbed.
async function routeAgentTurnToScratchHermes(
  page: Page,
  seenByBrowser: Array<{ task_name?: string; risk?: unknown }>,
) {
  // CORS matters here: the page is localhost:5173 and VITE_HERMES_URL is the
  // ngrok origin, so every turn is cross-origin and the browser sends a
  // preflight OPTIONS first. Forwarding that as a POST would send an empty
  // body to /agent/turn, and a fulfilled response without
  // Access-Control-Allow-Origin is rejected by the browser before the app
  // ever sees it — which would look exactly like LLM routing variance
  // ("the walkthrough never started") rather than a harness bug.
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  // BOTH endpoints. The elder chat calls agentTurnStream() → /agent/turn/stream
  // (ElderlyAIScreen.tsx), which a `**/agent/turn` glob does NOT match — the
  // first version of this spec silently let every real turn through to the
  // deployed demo backend (which predates the risk feature) and then reported
  // "the browser was handed no risk" as if it were a product finding.
  await page.route("**/agent/turn**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS, body: "" });
      return;
    }
    const path = new URL(req.url()).pathname.endsWith("/stream") ? "/agent/turn/stream" : "/agent/turn";
    const resp = await fetch(`${HERMES}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hermes-Api-Key": req.headers()["x-hermes-api-key"] ?? env().VITE_HERMES_API_KEY ?? "",
      },
      body: req.postData() ?? "{}",
    });
    const body = await resp.text();
    // Record what the BROWSER is actually handed — so a later "the Confirm
    // step held" assertion can be tied to a real risk object rather than
    // assumed to follow from one. The stream endpoint answers as SSE, so scan
    // every `data:` line rather than parsing the whole body as one object.
    const candidates = path.endsWith("/stream")
      ? body.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim())
      : [body];
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(c) as { walkthrough?: { task_name?: string; risk?: unknown } };
        if (parsed.walkthrough) {
          seenByBrowser.push(parsed.walkthrough);
          console.log(`[BROWSER GOT] task=${parsed.walkthrough.task_name} risk=${JSON.stringify(parsed.walkthrough.risk)}`);
        }
      } catch { /* non-JSON keep-alive / error lines */ }
    }
    await route.fulfill({
      status: resp.status,
      headers: {
        ...CORS,
        "Content-Type": resp.headers.get("content-type") ?? "application/json",
      },
      body,
    });
  });
}

// Make this device a TRUSTED veteran: past TRUST_MODE_THRESHOLD completions
// with manual mode off. This is the ONLY configuration in which the Confirm
// phase auto-elapses — so it is the only one where a risk flag proves anything.
async function makeVeteran(page: Page) {
  await page.evaluate((threshold) => {
    const key = "dosewise:accessibility";
    const cur = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    window.localStorage.setItem(key, JSON.stringify({
      ...cur, walkthroughManualMode: false, walkthroughCompletionCount: threshold + 2,
    }));
  }, TRUST_MODE_THRESHOLD);
  await page.reload();
  await page.waitForFunction(
    () => typeof (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough === "function",
    null, { timeout: 20_000 },
  );
}

test.describe.configure({ mode: "serial" });

test("item 3: a real /agent/turn classifies a 4x dosage jump and returns risk.flagged with the dosage_jump signal", async () => {
  test.setTimeout(300_000);
  mkdirSync(ARTIFACTS, { recursive: true });

  const { creds, jwt } = await seedElderOnLisinopril();
  console.log(`[SEED] elder=${creds.userId} already on Lisinopril 5mg`);

  // The soul contract is propose → confirm → queue the *_auto walkthrough, so
  // the flagged instance only exists after the confirm turn. ≤3 confirm
  // attempts for LLM routing variance, every attempt recorded.
  const turns: RawTurn[] = [];
  const send = async (label: string, msg: string) => {
    const t = await rawTurn(jwt, msg);
    turns.push(t);
    writeFileSync(`${ARTIFACTS}/turn-${String(turns.length).padStart(2, "0")}-${label}.json`, JSON.stringify(t, null, 2));
    console.log(`[TURN ${label}] tools=${JSON.stringify(t.tools_used)} walk=${JSON.stringify(t.walkthrough)}`);
    return t;
  };

  let queued: RawTurn["walkthrough"] = null;
  // Must be an ADD, not an update. "put my Lisinopril up to 20mg" is routed
  // (correctly) to update_medication_dosage, which is not a walkthrough task
  // at all — so nothing is ever risk-assessed. This is s01's own propose→
  // confirm phrasing, which is what queues add_prescription_auto; the 20mg
  // against the seeded 5mg is what makes the classifier's dosage axis fire.
  await send("opening", "The doctor gave me a new medicine — Lisinopril, 20mg, for blood pressure");
  await send("frequency", "Once a day, in the morning");
  for (let i = 1; i <= 3 && !queued; i++) {
    const t = await send(`confirm-${i}`, i === 1 ? "yes please, go ahead" : "yes, please add it");
    // ONLY the task under test counts. Accepting "whatever walkthrough came
    // back" would happily assert the risk contract against a different
    // instance (a condition add, a refill) and call it a pass.
    if (t.walkthrough?.task_name === "add_prescription_auto") queued = t.walkthrough;
  }

  expect(queued, `no walkthrough was ever queued across ${turns.length} turn(s)`).not.toBeNull();
  console.log(`[RISK] ${JSON.stringify(queued!.risk, null, 2)}`);

  // THE assertion this whole item was missing: risk is present on the wire,
  // produced by real classification against real on-file data.
  expect(queued!.risk, "the turn carries a risk object at all").toBeDefined();
  expect(queued!.risk!.flagged, `20mg against on-file 5mg is flagged: ${JSON.stringify(queued!.risk)}`).toBe(true);
  // Match the STABLE signal code, never the human-readable prose.
  expect(queued!.risk!.signals, "the dosage-jump axis is what fired").toContain("dosage_jump");
  expect(queued!.risk!.reasons.length, "signals and reasons stay the same length").toBe(queued!.risk!.signals.length);

  writeFileSync(`${ARTIFACTS}/risk-flagged.json`, JSON.stringify(queued, null, 2));
});

test("item 3: a benign add_condition_auto turn carries no risk key at all", async () => {
  test.setTimeout(300_000);
  mkdirSync(ARTIFACTS, { recursive: true });
  const { creds, jwt } = await seedElderOnLisinopril();
  console.log(`[SEED] elder=${creds.userId}`);

  const turns: RawTurn[] = [];
  let queued: RawTurn["walkthrough"] = null;
  for (let i = 1; i <= 3 && !queued; i++) {
    const t = await rawTurn(jwt, i === 1
      ? "Please add high blood pressure to my health conditions"
      : "yes please, add high blood pressure to my conditions");
    turns.push(t);
    writeFileSync(`${ARTIFACTS}/benign-turn-${i}.json`, JSON.stringify(t, null, 2));
    console.log(`[TURN benign-${i}] tools=${JSON.stringify(t.tools_used)} walk=${JSON.stringify(t.walkthrough)}`);
    if (t.walkthrough?.task_name) queued = t.walkthrough;
  }

  expect(queued, "a walkthrough was queued").not.toBeNull();
  if (queued!.task_name === "add_condition_auto") {
    // add_condition_auto IS in RISK_ASSESSED_TASKS but carries no medication
    // name/dose/time params, so every axis stays silent: a risk object that
    // exists and is honest about finding nothing.
    if (queued!.risk) {
      expect(queued!.risk.flagged, `benign condition add must not be flagged: ${JSON.stringify(queued!.risk)}`).toBe(false);
      expect(queued!.risk.signals, "no axis fired").toHaveLength(0);
    } else {
      console.log("[RISK] no risk key on a benign add_condition_auto — also correct");
    }
  } else {
    console.log(`[RISK] routed to ${queued!.task_name} instead; risk=${JSON.stringify(queued!.risk)}`);
    expect(queued!.risk?.flagged ?? false, "nothing benign is flagged").toBe(false);
  }
});

test("item 3: the real risk flag reaches the browser and forces a Confirm tap a veteran would otherwise skip", async ({ page }) => {
  test.setTimeout(300_000);
  mkdirSync(ARTIFACTS, { recursive: true });

  const { creds } = await seedElderOnLisinopril();
  const seenByBrowser: Array<{ task_name?: string; risk?: unknown }> = [];
  await routeAgentTurnToScratchHermes(page, seenByBrowser);
  await signIn(page, creds);
  await makeVeteran(page);

  // Confirm the device really is in the auto-advance configuration — otherwise
  // a held Confirm proves nothing (a first-timer is held regardless).
  const trust = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("dosewise:accessibility") ?? "{}"));
  console.log(`[TRUST] ${JSON.stringify(trust)}`);
  expect(trust.walkthroughManualMode).toBe(false);
  expect(trust.walkthroughCompletionCount).toBeGreaterThanOrEqual(TRUST_MODE_THRESHOLD);

  // Real chat, real turn (routed to :8901), real classification.
  await page.locator('[data-tour="nav-ai"]').click();
  const composer = page.locator('[data-walk="elder-ai-composer"]');
  await composer.waitFor({ state: "visible", timeout: 15_000 });

  const say = async (msg: string) => {
    await composer.fill(msg);
    await page.locator('[data-walk="elder-ai-send-button"]').click();
    await page.waitForTimeout(1_000);
  };

  await say("The doctor gave me a new medicine — Lisinopril, 20mg, for blood pressure");
  await say("Once a day, in the morning");
  let started = false;
  for (let i = 0; i < 3 && !started; i++) {
    started = await page.waitForFunction(
      () => [...document.querySelectorAll("p")].some(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? "")),
      null, { timeout: 45_000 },
    ).then(() => true).catch(() => false);
    if (!started) await say(i === 0 ? "yes please, go ahead" : "yes, add it");
  }
  expect(started, "the real chat path started the walkthrough").toBe(true);
  await page.screenshot({ path: `${ARTIFACTS}/veteran-walkthrough-started.png` });

  // Tie the hold below to a REAL flagged instance the browser was handed —
  // without this, a Confirm that held for some other reason would read as a
  // pass for the risk contract.
  writeFileSync(`${ARTIFACTS}/browser-received.json`, JSON.stringify(seenByBrowser, null, 2));
  const flagged = seenByBrowser.find(w =>
    w.task_name === "add_prescription_auto" && (w.risk as { flagged?: boolean } | undefined)?.flagged === true);
  expect(flagged, `the browser was handed a risk-flagged add_prescription_auto: ${JSON.stringify(seenByBrowser)}`)
    .toBeDefined();
  console.log(`[BROWSER RISK] ${JSON.stringify(flagged!.risk)}`);

  // The walkthrough is running with a REAL risk object. Advance to the Confirm
  // step and prove it HOLDS. For a veteran, every other autonomous step
  // auto-advances after READY_AUTO_MS — so if Confirm also auto-elapsed, the
  // run would sail past it to the Submit waitFor with zero taps.
  const confirmCopy = page.getByText(/check it below|tap Change|Everything's ready/i);
  const deadline = Date.now() + 120_000;
  let sawConfirmHold = false;
  let lastStep = await walkthroughStep(page);
  while (Date.now() < deadline) {
    const cur = await walkthroughStep(page);
    if (!cur) break;
    if (await confirmCopy.first().isVisible().catch(() => false)) {
      // Sit still well past READY_AUTO_MS + CONFIRM_MIN_MS. If the step is
      // genuinely tap-gated, the counter must not move on its own.
      const before = cur.current;
      await page.waitForTimeout(6_000);
      const after = await walkthroughStep(page);
      await page.screenshot({ path: `${ARTIFACTS}/veteran-held-at-confirm.png` });
      console.log(`[CONFIRM] step ${before} → ${JSON.stringify(after)} after 6s of no interaction`);
      expect(after?.current, "a risk-flagged Confirm holds for an explicit tap even for a veteran").toBe(before);
      sawConfirmHold = true;
      break;
    }
    if (cur.current === lastStep?.current) await page.waitForTimeout(750);
    lastStep = cur;
  }
  expect(sawConfirmHold, "the run reached a Confirm step to assert on").toBe(true);
});
