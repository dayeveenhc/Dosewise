import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

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
