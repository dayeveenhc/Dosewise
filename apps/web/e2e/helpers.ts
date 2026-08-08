import type { Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

// `risk` (Item 2, TrustMode verification only) forces a risk-flagged instance
// through the dev hook without depending on a live Hermes turn actually
// classifying it that way — see ElderlyApp.tsx's hook registration comment.
export async function startWalkthrough(
  page: Page,
  task: string,
  params: Record<string, string> = {},
  risk?: { flagged: boolean; signals: string[]; reasons: string[] },
) {
  await page.evaluate(
    ([t, p, r]) => (window as unknown as {
      __dwStartWalkthrough: (x: string, y?: Record<string, string>, z?: typeof r) => void;
    }).__dwStartWalkthrough(t as string, p as Record<string, string>, r),
    [task, params, risk] as [string, Record<string, string>, typeof risk],
  );
  await useStepByStepNav(page);
}

/**
 * Start a walkthrough and leave AutoNav ON — the run flows step to step by
 * itself, exactly as it does for a person who never touches the toggle.
 *
 * Use this for specs that watch a whole autonomous flow reach its outcome
 * ("Mei fills the form and the write lands") and never tap Next. Use
 * `startWalkthrough` for specs that assert gate by gate, which need the run to
 * hold still between assertions.
 *
 * The split became necessary once the toggle started meaning what it says:
 * `computeHoldGate` used to collapse a run of consecutive field fills for
 * everyone, so a step-by-step run still flowed several steps on its own and a
 * no-tap spec got away with forcing step-by-step. It no longer does — someone
 * who asks to be walked through step by step now really gets a gate per field —
 * so a no-tap spec has to ask for Auto explicitly.
 */
export async function startWalkthroughAuto(
  page: Page,
  task: string,
  params: Record<string, string> = {},
) {
  await page.evaluate(
    ([t, p]) => (window as unknown as {
      __dwStartWalkthrough: (x: string, y?: Record<string, string>) => void;
    }).__dwStartWalkthrough(t as string, p as Record<string, string>),
    [task, params] as [string, Record<string, string>],
  );
}

// Put the walkthrough's AutoNav toggle on "Step by step".
//
// The overlay ships with Auto ON by default: it flows from step to step on its
// own so nobody has to tap Next after every field Mei fills. Every walkthrough
// spec below, though, drives the run BY tapping Next and asserts on what is on
// screen at each gate — with Auto on, the run would move under the assertions.
// Flipping the toggle is not a test-only backdoor: it is the same control a
// person taps, so exercising it here also proves it works.
//
// Located by data-walk, NOT by accessible name. The control used to be a
// two-button "Auto | Step by step" segmented row inside the callout and is now
// a single fast-forward toggle pinned to the overlay's top right, whose name is
// localized and changes with its own state — a name-based locator would break
// on both counts. One button now, so the sense is inverted: press it when it
// reads pressed (Auto on) to turn Auto off.
//
// Tolerant of a missing toggle: the spotlight-only tours reach the callout at
// slightly different times, and a spec that never reaches a gate doesn't need it.
export async function useStepByStepNav(page: Page): Promise<void> {
  const toggle = page.locator('[data-walk="walk-autonav"]');
  try {
    await toggle.waitFor({ state: "visible", timeout: 10_000 });
    if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
  } catch {
    /* no overlay/toggle yet — the spec's own assertions will say so */
  }
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

// ───────────────────── Pooled throwaway accounts ─────────────────────────────
//
// WHY: one fresh signup per task (~25 per highlight sweep) hits Supabase's
// signup throttle after roughly 70 accounts, at which point signUp stops
// answering. That surfaces as a per-task budget timeout with zero steps
// measured — indistinguishable, in a report, from a product defect. The limit
// is per-IP as well as per-email, so spacing the calls does not help; REUSING a
// handful of accounts does.
//
// The pool round-robins a small set of accounts held in a JSON file, minting a
// new one only while the pool is short, and RESETS an account before handing it
// over. Reset-at-acquire (not at release) is deliberate: a run that crashes
// mid-task leaves dirt behind, and only the next acquirer is in a position to
// clear it.
//
// ── The reset is UPDATE-based, NOT delete-based, and it cannot be otherwise ──
// `supabase/migrations/0004_rls_hardening.sql` adds a RESTRICTIVE
// `for delete ... using (false)` policy to profiles, care_links, medications,
// doses, refills, doctor_questions and conversation_turns. A DELETE issued as
// the signed-in user therefore matches zero rows — and PostgREST reports that
// as SUCCESS, not an error, so a delete-based reset would silently hand over a
// dirty account. Everything below is an UPDATE that makes the row invisible to
// the app (the same thing the product itself does — `medications.ts` archives,
// never deletes), followed by an independent READ-BACK: an empty error field
// proves nothing here, only a re-query does.
const POOL_FILE = process.env.DW_ELDER_POOL ?? "scratchpad/.dw-elder-pool.json";

interface PoolBucket { accounts: ElderCreds[]; cursor: number }
type PoolShape = Record<string, PoolBucket>;

let poolMinted = 0;
let poolReused = 0;

// How many accounts this process had to CREATE vs reuse — the sweep reports it,
// since "the pool worked" is exactly "minted stayed near zero".
export function poolStats(): { minted: number; reused: number } {
  return { minted: poolMinted, reused: poolReused };
}

function readPool(): PoolShape {
  try {
    return JSON.parse(readFileSync(POOL_FILE, "utf8")) as PoolShape;
  } catch {
    return {};
  }
}

function writePool(pool: PoolShape): void {
  mkdirSync(dirname(POOL_FILE), { recursive: true });
  writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
}

// Everything a walkthrough run can write, put back to the state a brand-new
// account is in — as the signed-in user, under RLS.
//
// `accessibility: {}` is the load-bearing one for CONTENT (conditions, travel
// plan, dob/weight, completedWalkthroughs all live in that jsonb blob, so a
// reused account would arrive with the forms already filled). Note it does NOT
// reset TrustMode: `walkthroughCompletionCount` lives in the browser's
// `dosewise:accessibility` localStorage key (src/app/accessibility.tsx), not on
// the profile — resetBrowserState() below is what clears that.
export async function resetElderState(
  supa: SupabaseClient,
  userId: string,
  role: "elder" | "caregiver" = "elder",
): Promise<void> {
  const fullName = role === "caregiver" ? "Tan Wei (test)" : "Ah Ma (test)";
  const fail = (what: string, detail: string): never => {
    throw new Error(`resetElderState(${userId}, ${role}): ${what} — ${detail}`);
  };
  const check = (what: string, error: { message: string } | null) => {
    if (error) fail(what, error.message);
  };

  // 1. Medications → archived. The app's own delete path does exactly this
  //    (medications.ts::archiveMedication), and every read filters
  //    `archived = false`, so an archived row is gone as far as the UI is
  //    concerned. Their doses/refills ride along: both are joined by
  //    medication_id off the active list.
  check("archive medications", (await supa.from("medications")
    .update({ archived: true }).eq("elder_id", userId).eq("archived", false)).error);

  // 2. Doses → back to pending. Best-effort tidying only (the rows cannot be
  //    removed and are already unreachable via step 1); done because a stray
  //    `taken` row is the difference between "no dose to undo" and "one to
  //    undo" if a future task ever reads doses directly.
  check("reset doses", (await supa.from("doses")
    .update({ status: "pending", logged_at: null, logged_by: null })
    .eq("elder_id", userId).neq("status", "pending")).error);

  // 3. Refills → no stock signal, so nothing reads as low-stock.
  check("clear refills", (await supa.from("refills")
    .update({ pills_remaining: null, threshold: null, run_out_forecast: null })
    .eq("elder_id", userId)).error);

  // 4. Doctor questions → dismissed, which is how the Reminders screen stops
  //    showing them as open.
  check("dismiss doctor questions", (await supa.from("doctor_questions")
    .update({ status: "dismissed" }).eq("elder_id", userId).neq("status", "dismissed")).error);

  // 5. care_links, EITHER side. RLS splits this in two on purpose (migration
  //    0005): the elder may drive any transition on their own row, a caregiver
  //    may only ever move one to 'revoked' — and 'revoked' is what we want from
  //    both directions, so one predicate per side covers it. RLS already limits
  //    the visible rows to ones this user is a party to.
  check("revoke care_links", (await supa.from("care_links")
    .update({ status: "revoked" }).eq("elder_id", userId).neq("status", "revoked")).error);
  check("revoke care_links (as caregiver)", (await supa.from("care_links")
    .update({ status: "revoked" }).eq("caregiver_id", userId).neq("status", "revoked")).error);

  // 6. The profile itself: role (the caregiver-shell fixture's only requirement),
  //    display name, and the jsonb blob back to empty.
  const { data: profRows, error: profErr } = await supa.from("profiles")
    .update({ role, full_name: fullName, accessibility: {} })
    .eq("id", userId)
    .select("id,role,accessibility");
  check("reset profile", profErr);
  if (!profRows || profRows.length !== 1) {
    fail("reset profile", `expected 1 updated row, got ${profRows?.length ?? 0} (RLS silently matched nothing?)`);
  }

  // ── Read-back. The whole point: an UPDATE filtered out by RLS returns
  //    success with zero rows, so only a fresh SELECT can prove the account is
  //    actually clean. A dirty account is a hard failure of the acquire, never
  //    something to hand over and hope about.
  const stillActive = await supa.from("medications").select("id,name")
    .eq("elder_id", userId).eq("archived", false);
  check("re-read medications", stillActive.error);
  if (stillActive.data?.length) {
    fail("medications still active after reset", JSON.stringify(stillActive.data));
  }

  const stillOpen = await supa.from("doctor_questions").select("id,status")
    .eq("elder_id", userId).eq("status", "open");
  check("re-read doctor_questions", stillOpen.error);
  if (stillOpen.data?.length) {
    fail("doctor_questions still open after reset", JSON.stringify(stillOpen.data));
  }

  const stillLinked = await supa.from("care_links").select("id,status,elder_id,caregiver_id")
    .neq("status", "revoked");
  check("re-read care_links", stillLinked.error);
  if (stillLinked.data?.length) {
    fail("care_links still live after reset", JSON.stringify(stillLinked.data));
  }

  const prof = profRows![0] as { role: string; accessibility: unknown };
  if (prof.role !== role) fail("profile role not applied", `got "${prof.role}", wanted "${role}"`);
  const accKeys = Object.keys((prof.accessibility ?? {}) as Record<string, unknown>);
  if (accKeys.length > 0) fail("profiles.accessibility not emptied", `keys left: ${accKeys.join(",")}`);
}

// An account from the pool, already signed in on a node-side client and already
// reset. `supa` is that client — callers that need to act AS this user (the
// caregiver-link fixture re-pending a row) use it rather than anonClient(),
// which is unauthenticated and would silently match zero rows under RLS.
export interface PooledAccount extends ElderCreds {
  supa: SupabaseClient;
  minted: boolean;
}

async function acquirePooled(bucketKey: string, role: "elder" | "caregiver", poolSize: number): Promise<PooledAccount> {
  // Two attempts: an account can disappear between runs (a project reset, a
  // manual cleanup), and the honest response to that is to drop it and try the
  // next one — not to fail a 25-task sweep on one stale credential.
  for (let attempt = 0; attempt < 2; attempt++) {
    const pool = readPool();
    const bucket = pool[bucketKey] ?? { accounts: [], cursor: 0 };
    let creds: ElderCreds;
    let minted = false;

    if (bucket.accounts.length < poolSize) {
      creds = await createThrowawayElder();
      bucket.accounts.push(creds);
      minted = true;
      poolMinted++;
    } else {
      const i = bucket.cursor % bucket.accounts.length;
      creds = bucket.accounts[i];
      bucket.cursor = i + 1;
      poolReused++;
    }
    pool[bucketKey] = bucket;
    writePool(pool);

    // Sign in to PROVE the account still exists. signUp's own session is not
    // evidence for a reused row, and a reset run against a dead account would
    // report "clean" from a client that can see nothing.
    const supa = anonClient();
    const { error } = await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
    if (error) {
      const pruned = readPool();
      const b = pruned[bucketKey];
      if (b) {
        b.accounts = b.accounts.filter(a => a.userId !== creds.userId);
        b.cursor = 0;
        writePool(pruned);
      }
      if (attempt === 1) throw new Error(`acquirePooled(${bucketKey}): sign-in failed twice — ${error.message}`);
      continue;
    }

    await resetElderState(supa, creds.userId, role);
    return { ...creds, supa, minted };
  }
  throw new Error(`acquirePooled(${bucketKey}): exhausted retries`);
}

// The drop-in replacement for createThrowawayElder() in a multi-task run.
// `role` decides what profiles.role the reset leaves behind, so a caregiver-
// shell task no longer needs its own sign-in + role flip at the call site.
export function acquirePooledElder(role: "elder" | "caregiver" = "elder", poolSize = 5): Promise<PooledAccount> {
  return acquirePooled(role, role, poolSize);
}

// Pooled counterpart of createCaregiverWithPendingLink: a real PENDING
// care_links row for `elderId`, without minting a second account per run.
//
// Its own pool bucket ("cglink") rather than the caregiver-shell one, so the
// two fixtures can never reset each other's account mid-task.
//
// Reuse makes the INSERT conditional: care_links is `unique (elder_id,
// caregiver_id)`, so the second time a given pair meets, the row already exists
// (revoked, by the reset). Only the ELDER can move it back to 'pending' —
// `care_links_update_by_caregiver` permits nothing but 'revoked' — which is why
// this takes the elder's own signed-in client.
export async function acquirePooledCaregiverLink(
  elderSupa: SupabaseClient,
  elderId: string,
  poolSize = 2,
): Promise<{ caregiverId: string }> {
  const cg = await acquirePooled("cglink", "caregiver", poolSize);
  const permissions = { requested_by_name: "Tan Wei (test)", relationship: "son" };

  const { error: insErr } = await cg.supa.from("care_links").insert({
    elder_id: elderId,
    caregiver_id: cg.userId,
    relationship: "son",
    status: "pending",
    permissions,
  });
  if (insErr) {
    // 23505 = unique_violation: this pair has met before. Re-pend it as the elder.
    const duplicate = (insErr as { code?: string }).code === "23505" || /duplicate key/i.test(insErr.message);
    if (!duplicate) throw new Error(`care_links insert failed: ${insErr.message}`);
    const { error: upErr } = await elderSupa.from("care_links")
      .update({ status: "pending", relationship: "son", permissions })
      .eq("elder_id", elderId).eq("caregiver_id", cg.userId);
    if (upErr) throw new Error(`care_links re-pend failed: ${upErr.message}`);
  }

  // Read back as the CAREGIVER (a party to the row either way) — same reason as
  // resetElderState's read-backs: a filtered-out write is not an error.
  const { data, error } = await cg.supa.from("care_links")
    .select("id,status,permissions").eq("elder_id", elderId).eq("caregiver_id", cg.userId);
  if (error) throw new Error(`care_links re-read failed: ${error.message}`);
  const row = data?.[0] as { status?: string; permissions?: { requested_by_name?: string } } | undefined;
  if (!row || row.status !== "pending") {
    throw new Error(`care_links fixture did not land pending (got ${JSON.stringify(row ?? null)})`);
  }
  if (!row.permissions?.requested_by_name) {
    throw new Error("care_links fixture has no permissions.requested_by_name — the elder's Accept card reads the caregiver's name from there");
  }
  return { caregiverId: cg.userId };
}

// Put the BROWSER back to first-visit state. Two things make this mandatory
// once accounts are reused across tasks in one page:
//   1. supabase-js persists its session in localStorage, so goto("/") restores
//      the PREVIOUS task's account and the app routes straight into the app —
//      signIn's "I already have an account" button never appears, and (with no
//      actionTimeout configured) that click waits forever.
//   2. `dosewise:accessibility` holds walkthroughCompletionCount, which is
//      device-local: it survives an account switch, and once it crosses
//      TRUST_MODE_THRESHOLD the walkthrough's gating changes underneath the
//      run. `dosewise:app-mode:{userId}` (lib/sessionState.ts) is the same
//      class of problem for a reused account that has been both shells.
export async function resetBrowserState(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.context().clearCookies();
  await page.goto("/");
}

// signIn, but from a guaranteed-clean browser and with EXPLICIT per-action
// timeouts. pw configs here set no `actionTimeout` (Playwright's default is "no
// timeout"), so an unbounded click on a screen that never appears is consumed
// silently by whatever outer budget exists and reported as a nameless timeout.
// This fails in seconds, saying which control it was waiting for.
export async function signInAfterReset(page: Page, creds: ElderCreds, timeout = 30_000): Promise<void> {
  await resetBrowserState(page);
  const step = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (err) {
      throw new Error(`signInAfterReset: ${what} — ${(err as Error).message.split("\n")[0]}`);
    }
  };
  await step("welcome screen never offered \"I already have an account\"",
    () => page.getByRole("button", { name: "I already have an account" }).click({ timeout }));
  await step("email field never appeared",
    () => page.locator('input[type="email"]').fill(creds.email, { timeout }));
  await step("password field never appeared",
    () => page.locator('input[type="password"]').fill(creds.password, { timeout }));
  await step("Sign in button never appeared",
    () => page.getByRole("button", { name: "Sign in" }).click({ timeout }));
  await step("app never mounted (no __dwStartWalkthrough)",
    () => page.waitForFunction(
      () => typeof (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough === "function",
      null, { timeout },
    ));
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

// Tap "I'm still here, continue" if the IdleTimeout popup is up. A no-op when
// it isn't, which is the common case.
export async function dismissIdlePopupIfOpen(page: Page): Promise<void> {
  const popup = page.locator('[data-walk="walk-idle-popup"]');
  if (!(await popup.isVisible().catch(() => false))) return;
  await popup.getByRole("button", { name: /continue/i }).click({ timeout: 5_000 }).catch(() => {});
  await popup.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
}

export async function tapWalkthroughNext(page: Page, timeout = 30_000): Promise<void> {
  const before = await walkthroughStep(page);
  await page.getByText(READY_COPY, { exact: false })
    .waitFor({ state: "visible", timeout })
    .catch(() => { /* fall through: assert on the counter below, not on copy */ });
  // A spec with real assertions/screenshots between taps genuinely idles past
  // IDLE_TIMEOUT_MS (20s), and the "still there?" popup's full-screen backdrop
  // then swallows this click. That popup is the product working as designed, so
  // clear it the way a person would — here, at the exact point of contention,
  // rather than with a background poller that could race the tap itself.
  await dismissIdlePopupIfOpen(page);
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

// ── IdleTimeout (Item 6) harness helper ─────────────────────────────────────
// Any spec that taps through several sequential walkthrough steps with real
// assertions/logging between the taps can genuinely idle past IDLE_TIMEOUT_MS
// (20s), at which point the "still there?" popup's full-screen backdrop
// intercepts the next .click() — Playwright reports it as
// `<div ... walk-idle-popup ...> subtree intercepts pointer events`. That is
// the product working as designed, not a regression, so the fix belongs in
// the spec: dismiss it the way a real person would. Returns a stop function;
// call it before the test ends so the poll doesn't outlive the page.
export function autoDismissIdlePopup(page: Page): () => void {
  let stop = false;
  void (async () => {
    while (!stop) {
      const popup = page.locator('[data-walk="walk-idle-popup"]');
      if (await popup.isVisible().catch(() => false)) {
        await popup.getByRole("button", { name: /continue/i }).click({ timeout: 2_000 }).catch(() => {});
      }
      await page.waitForTimeout(400).catch(() => {});
    }
  })();
  return () => { stop = true; };
}
