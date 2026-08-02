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
