import type { Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PhaseLogEntry } from "../src/app/lib/walkthrough/phaseLog";

// Shared e2e helpers for the Guided Auto-Navigation live drives. Tests run with
// cwd = apps/web, so .env is a relative read.

export function env() {
  const raw = readFileSync(".env", "utf8").split("\n").filter(l => l.includes("="));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

export function anonClient() {
  const e = env();
  return createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY);
}

export interface ElderCreds { email: string; password: string; userId: string }

// Create + seed a fresh throwaway elder on the live project (email confirmation
// is off, so signUp yields a session immediately; a profiles row with role=elder
// routes the app to the elder home). Disposable, user-approved.
export async function createThrowawayElder(): Promise<ElderCreds> {
  const supa = anonClient();
  const email = `tw-elder-${Date.now()}-${Math.floor(performance.now())}@dosewise.test`;
  const password = "Throwaway!2026";
  const { data, error } = await supa.auth.signUp({ email, password });
  if (error || !data.user) throw new Error(`signUp failed: ${error?.message}`);
  const { error: pErr } = await supa.from("profiles").insert({ id: data.user.id, role: "elder", full_name: "Ah Ma (test)" });
  if (pErr) throw new Error(`profile seed failed: ${pErr.message}`);
  return { email, password, userId: data.user.id };
}

// Sign in through the real login form and wait for the elder app (dev trigger).
export async function signIn(page: Page, creds: ElderCreds) {
  await page.goto("/");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator('input[type="email"]').fill(creds.email);
  await page.locator('input[type="password"]').fill(creds.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(
    () => typeof (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough === "function",
    null,
    { timeout: 20_000 },
  );
}

export function startWalkthrough(page: Page, task: string, params: Record<string, string> = {}) {
  return page.evaluate(
    ([t, p]) => (window as unknown as { __dwStartWalkthrough: (x: string, y?: Record<string, string>) => void }).__dwStartWalkthrough(t as string, p as Record<string, string>),
    [task, params] as [string, Record<string, string>],
  );
}

// Precondition for the accept-caregiver-link scenario: a real PENDING care_links
// row must exist for the elder to Accept. Sign up a 2nd auth user (the
// caregiver) + profile, then INSERT the pending row AS that caregiver — which is
// exactly what RLS requires (auth.uid() = caregiver_id AND status = 'pending').
export async function createCaregiverWithPendingLink(elderId: string): Promise<{ caregiverId: string }> {
  const supa = anonClient();
  const email = `tw-cg-${Date.now()}-${Math.floor(performance.now())}@dosewise.test`;
  const { data, error } = await supa.auth.signUp({ email, password: "Throwaway!2026" });
  if (error || !data.user) throw new Error(`caregiver signUp failed: ${error?.message}`);
  const caregiverId = data.user.id;
  const { error: pErr } = await supa.from("profiles").insert({ id: caregiverId, role: "caregiver", full_name: "Tan Wei (test)" });
  if (pErr) throw new Error(`caregiver profile failed: ${pErr.message}`);
  const { error: lErr } = await supa.from("care_links").insert({
    elder_id: elderId,
    caregiver_id: caregiverId,
    relationship: "son",
    status: "pending",
    permissions: { requested_by_name: "Tan Wei (test)", relationship: "son" },
  });
  if (lErr) throw new Error(`care_links insert failed: ${lErr.message}`);
  return { caregiverId };
}

// ───────────────────── Phase-2 scenario verification harness ─────────────────
// Shared helpers for the per-scenario specs under e2e/scenarios/ — see
// e2e/scenarios/README.md for the mandatory six-section spec template.

const HERMES_LOCAL = "http://127.0.0.1:8901";

// The window.__dwPhaseLog entry shape, re-exported so specs can type
// readPhaseLog() results without importing from src themselves. Type-only on
// purpose: it is erased at transpile time, so phaseLog.ts (which touches
// import.meta.env) is never actually loaded under node.
export type { PhaseLogEntry };

// Independent post-write DB re-read — THE verification every write scenario
// runs after a turn. Never trust the turn's own response: re-select with a
// fresh query and assert on what is actually stored.
export async function recheckDb(
  client: SupabaseClient,
  table: string,
  filters: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  let q = client.from(table).select("*");
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  const { data, error } = await q;
  if (error) throw new Error(`recheckDb(${table}, ${JSON.stringify(filters)}) failed: ${error.message}`);
  return (data ?? []) as Record<string, unknown>[];
}

// Independent re-read of a value inside profiles.accessibility (jsonb) by
// dot-path; numeric segments index arrays (e.g. "dose_snoozes",
// "symptom_reports.0.symptom"). Returns undefined when the path doesn't exist.
export async function recheckAccessibility(client: SupabaseClient, userId: string, path: string): Promise<unknown> {
  const { data, error } = await client.from("profiles").select("accessibility").eq("id", userId).single();
  if (error) throw new Error(`recheckAccessibility(${userId}, "${path}") failed: ${error.message}`);
  let value: unknown = (data as { accessibility?: unknown } | null)?.accessibility;
  for (const seg of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[seg];
  }
  return value;
}

// Assert EXACTLY ONE of `rows` matches every expected key/value (jsonb values
// compared structurally). Throws with a per-row, per-key diff on failure;
// returns the matched row for follow-on assertions.
export function expectRow(
  rows: Record<string, unknown>[],
  expected: Record<string, unknown>,
): Record<string, unknown> {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const mismatches = (row: Record<string, unknown>) =>
    Object.entries(expected)
      .filter(([k, v]) => !same(row[k], v))
      .map(([k, v]) => `${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(row[k])}`);
  const matches = rows.filter(r => mismatches(r).length === 0);
  if (matches.length === 1) return matches[0];
  const diff = rows.map((r, i) => `  row[${i}]: ${mismatches(r).join("; ") || "MATCH"}`).join("\n");
  throw new Error(
    `expectRow: expected exactly 1 of ${rows.length} row(s) to match ${JSON.stringify(expected)}, got ${matches.length}.\n` +
    (diff || "  (no rows)"),
  );
}

// Loose local mirrors of the /agent/turn response shapes (src/app/lib/
// hermes.ts AgentAction / WalkthroughPayload). Declared here, like the
// existing specs do, so e2e never loads in-flux src modules at runtime.
export interface TurnAction {
  tool: string;
  summary?: string;
  name?: string;
  entity_type?: string;
  entity_id?: string;
  changed_fields?: Record<string, { before: unknown; after: unknown }>;
  entities?: Array<{ entity_type: string; entity_id: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface TurnResult {
  http: number;
  reply: string;
  tools_used: string[];
  actions: TurnAction[];
  walkthrough: { task_name: string; params?: Record<string, string> } | null;
}

// One REAL turn against the LOCAL hermes on :8901 (mirrors
// scenario1-dose-taken.spec.ts's fetch). Throws when :8901 is unreachable or
// answers non-JSON; otherwise returns the parsed body plus the HTTP status so
// specs assert `turn.http` explicitly.
export async function agentTurn8901(jwt: string, message: string): Promise<TurnResult> {
  let resp: Response;
  try {
    resp = await fetch(`${HERMES_LOCAL}/agent/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hermes-Api-Key": env().VITE_HERMES_API_KEY ?? "" },
      body: JSON.stringify({ message, jwt }),
    });
  } catch (err) {
    throw new Error(`agent/turn fetch failed — is the local hermes on :8901 running? (${err})`);
  }
  const text = await resp.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`agent/turn HTTP ${resp.status} returned non-JSON: ${text.slice(0, 300)}`);
  }
  return {
    http: resp.status,
    reply: (body.reply as string) ?? "",
    tools_used: (body.tools_used as string[]) ?? [],
    actions: (body.actions as TurnAction[]) ?? [],
    walkthrough: (body.walkthrough as TurnResult["walkthrough"]) ?? null,
  };
}

// Save a turn's raw JSON under the scenario's artifacts dir — one file per
// trigger attempt, recorded whether the attempt routed correctly or not.
export function saveTurnArtifact(dir: string, name: string, payload: unknown): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name.endsWith(".json") ? name : `${name}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

// Read the DEV pacing instrumentation (src/app/lib/walkthrough/phaseLog.ts).
export function readPhaseLog(page: Page): Promise<PhaseLogEntry[]> {
  return page.evaluate(() => (window as unknown as { __dwPhaseLog?: PhaseLogEntry[] }).__dwPhaseLog ?? []);
}

// Clear the phase log — call immediately before the phase under test so
// assertPhaseMins only ever sees entries from that interaction.
export function resetPhaseLog(page: Page): Promise<void> {
  return page.evaluate(() => {
    (window as unknown as { __dwPhaseLog?: unknown[] }).__dwPhaseLog = [];
  });
}

// Assert measured phase durations respect their PACING minimums. For each
// expectation the LAST matching entry wins (a run may pace the same phase
// several times); slackMs (default 25) absorbs timer jitter. Deliberately NO
// upper bound here — callers add generous upper checks case-by-case.
export function assertPhaseMins(
  log: PhaseLogEntry[],
  expectations: Array<{ surface?: string; phase: string; min: number }>,
  opts: { slackMs?: number } = {},
): void {
  const slack = opts.slackMs ?? 25;
  const failures: string[] = [];
  for (const exp of expectations) {
    const label = `${exp.surface ? `${exp.surface}/` : ""}${exp.phase}`;
    const matches = log.filter(e => e.phase === exp.phase && (!exp.surface || e.surface === exp.surface));
    if (matches.length === 0) {
      const seen = log.map(e => `${e.surface}/${e.phase}`).join(", ") || "empty";
      failures.push(`${label}: no matching entry in phase log (${log.length} entries: ${seen})`);
      continue;
    }
    const entry = matches[matches.length - 1];
    const measured = entry.endedAt - entry.startedAt;
    if (measured < exp.min - slack) {
      failures.push(`${label}: measured ${measured.toFixed(1)}ms < min ${exp.min}ms (slack ${slack}ms)`);
    }
  }
  if (failures.length > 0) throw new Error(`assertPhaseMins failed:\n  - ${failures.join("\n  - ")}`);
}

// ── Walkthrough advance helpers ───────────────────────────────────────────
// Autonomous steps no longer advance by themselves: each finishes its phases
// and then HOLDS at a terminal commit gate with Next (or Done, on the last
// step) enabled, until the person taps. These stand in for those taps.
const NEXT_RE = /^(Next|Done)$/;

// The callout's "Step X of Y" counter, or null when no overlay is up.
export async function walkthroughStep(page: Page): Promise<{ current: number; total: number } | null> {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll("p")].find(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? ""));
    const m = el?.textContent?.trim().match(/^Step (\d+) of (\d+)$/);
    return m ? { current: Number(m[1]), total: Number(m[2]) } : null;
  });
}

// ONE commit tap.
//
// Next means two different things depending on when it lands, and Playwright's
// click actionability can't tell them apart (the button is enabled for both):
// DURING a phase, after that phase's minimum, it only fast-forwards the
// remaining dwell; at the terminal commit GATE it advances the step. So wait
// for the gate's own copy (walk.ready) before tapping, otherwise the tap is
// spent shortening a dwell and the step never moves.
//
// Then wait for the STEP COUNTER to change — NOT for the button to go disabled:
// the Next button is the same DOM node across steps, so a fast loop would
// otherwise tap one step twice. A vanished counter means the last step
// committed and the overlay unmounted, which also counts as progress.
const READY_COPY = "tap Next when you're ready";

export async function tapWalkthroughNext(page: Page, timeout = 30_000): Promise<void> {
  const before = await walkthroughStep(page);
  await page.getByText(READY_COPY, { exact: false })
    .waitFor({ state: "visible", timeout })
    .catch(() => { /* fall through: assert on the counter below, not on copy */ });
  await page.getByRole("button", { name: NEXT_RE }).click({ timeout });
  await page.waitForFunction(
    (prev: number | null) => {
      const el = [...document.querySelectorAll("p")].find(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? ""));
      if (!el) return true; // overlay gone — the walkthrough finished
      const m = el.textContent!.trim().match(/^Step (\d+) of (\d+)$/)!;
      return Number(m[1]) !== prev;
    },
    before?.current ?? null,
    { timeout },
  );
}

// Tap Next until `done()` reports true. Bounded so a genuinely stuck
// walkthrough fails loudly with its position rather than spinning.
export async function advanceWalkthroughUntil(
  page: Page,
  done: () => Promise<boolean>,
  max = 12,
): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await done()) return;
    if (!(await walkthroughStep(page))) break; // overlay gone; let done() decide
    await tapWalkthroughNext(page);
  }
  if (await done()) return;
  throw new Error(`advanceWalkthroughUntil: condition never met after ${max} taps (at ${JSON.stringify(await walkthroughStep(page))})`);
}

// Advance until the callout reports it is ON step `n` (1-based).
//
// Prefer this over a DOM predicate when the element you're waiting for is
// already on screen at an EARLIER step: a tour's later targets are usually
// siblings of its earlier ones (the emergency Call button sits inside the
// emergency section the previous step spotlights), so "is it visible?" is
// satisfied before the tour has actually got there and nothing advances.
export async function advanceWalkthroughToStep(page: Page, n: number, max = 12): Promise<void> {
  await advanceWalkthroughUntil(page, async () => ((await walkthroughStep(page))?.current ?? 0) >= n, max);
}

// Tap Next until the overlay unmounts — covers a wholly autonomous tour.
//
// A vanished overlay only counts as COMPLETION if we actually reached the final
// step. Returning success on any disappearance would let a tour that dies at
// step 2 pass both this AND the usual "Exit is gone" assertion that follows it
// — the exact stalled-tour shape this whole pass exists to catch.
export async function finishWalkthrough(page: Page, max = 12): Promise<void> {
  let last = await walkthroughStep(page);
  if (!last) throw new Error("finishWalkthrough: no walkthrough overlay is up");
  for (let i = 0; i < max; i++) {
    const cur = await walkthroughStep(page);
    if (!cur) {
      if (last.current < last.total) {
        throw new Error(
          `finishWalkthrough: overlay disappeared at step ${last.current}/${last.total} — the walkthrough did not complete`,
        );
      }
      return;
    }
    last = cur;
    await tapWalkthroughNext(page);
  }
  const stuck = await walkthroughStep(page);
  if (stuck) throw new Error(`finishWalkthrough: still running after ${max} taps (at ${JSON.stringify(stuck)})`);
}

// ───────────────── Real-chat walkthrough entry (production path) ─────────────
//
// Every walkthrough spec starts its run through `startWalkthrough` — the DEV
// `window.__dwStartWalkthrough` hook, called right after signIn while the app is
// still on the HOME tab. That is not how a walkthrough ever begins in
// production: there, Mei queues it from a reply while the person is sitting on
// the Ask Mei tab with the conversation on screen. The two differ in exactly the
// way that breaks tours — a screen already mounted in some other internal state
// never re-mounts, so the tour's first target may not exist at all.
//
// This drives the real path: type into the real composer, send, and wait for the
// overlay. Use it for at least one task per family; the dev hook stays fine for
// the rest (it is faster and does not depend on LLM routing).
export async function startWalkthroughFromChat(
  page: Page,
  message: string,
  opts: { timeout?: number } = {},
): Promise<boolean> {
  const timeout = opts.timeout ?? 60_000;
  await page.locator('[data-tour="nav-ai"]').click();
  const composer = page.locator('[data-walk="elder-ai-composer"]');
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  await composer.fill(message);
  await page.locator('[data-walk="elder-ai-send-button"]').click();
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll("p")].some(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? "")),
      null,
      { timeout },
    );
    return true;
  } catch {
    return false; // the model didn't route to a walkthrough this attempt
  }
}

// Put the app in the state a real chat-launched walkthrough starts from: the AI
// tab, in CHAT mode (not the help tiles). Deterministic — no LLM involved — so a
// spec can assert "a tour started from here still finds its first target"
// without depending on routing. This is the condition that killed the two travel
// walkthroughs: their first step points at a help-tile that chat mode unmounts.
export async function parkOnChat(page: Page, text = "hello"): Promise<void> {
  await page.locator('[data-tour="nav-ai"]').click();
  const composer = page.locator('[data-walk="elder-ai-composer"]');
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  await composer.fill(text);
  // The stable anchor, not an accessible-name regex: Send's aria-label is the
  // localized `notifications.send`, so /send/i only ever matches in English —
  // and a helper that silently fails to send makes its caller pass vacuously.
  await page.locator('[data-walk="elder-ai-send-button"]').click();
  // Chat mode is entered synchronously on send — wait for the person's own
  // bubble rather than for Mei's reply, so this never depends on the network.
  await page.getByText(text, { exact: true }).first().waitFor({ timeout: 15_000 });
}
