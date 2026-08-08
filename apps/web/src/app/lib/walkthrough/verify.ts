// The ONE runtime verification mechanism for walkthrough Verify directives:
// pollVerify (the shared poll-until-true loop that used to be copy-pasted five
// times in ElderlyApp) + buildVerifyRunner (the switch over every
// VerifyDirective kind). Data access is INJECTED (VerifyDeps) — this module
// must import nothing that transitively imports lib/supabase, whose
// module-load throw breaks the vitest import graph (same reason
// changeHighlight.ts keeps a local hhmmTo12h — see that file). Type-only
// imports are erased at build time, so they're safe.

import { hhmmTo12h } from "../changeHighlight";
import type { Medication } from "../../types";
import type { ProfileDetails } from "../profile";
import type { VerifyDirective } from "./types";

export interface PollVerifyOpts {
  timeoutMs?: number;
  intervalMs?: number;
}

// Poll `check` until it returns true or the timeout elapses. Defaults match the
// old inline loops (12 attempts × 400ms): the sheet's write is async and Verify
// fires right after Mei taps Save, so the first re-queries can race the write.
export async function pollVerify(check: () => Promise<boolean>, opts?: PollVerifyOpts): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 4800;
  const intervalMs = opts?.intervalMs ?? 400;
  const startedAt = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - startedAt >= timeoutMs) return false;
    await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
  }
}

// Injected data fetchers — the host (ElderlyApp) passes its real Supabase-backed
// imports; tests pass fakes. All take the elder's id explicitly so the deps can
// be the module functions themselves, unbound.
export interface VerifyDeps {
  elderId: string;
  fetchElderMedications: (elderId: string) => Promise<Medication[]>;
  fetchProfile: (elderId: string) => Promise<{ fullName: string | null; details: ProfileDetails } | null>;
  hasActiveCareLink: (elderId: string) => Promise<boolean>;
  fetchArchivedMedications: (elderId: string) => Promise<{ name: string }[]>;
  // The raw profiles.accessibility jsonb (ProfileDetails), for dot-path checks.
  fetchAccessibility: (elderId: string) => Promise<unknown>;
  fetchDoctorQuestions: (elderId: string) => Promise<{ question: string }[]>;
}

const norm = (s: string) => s.trim().toLowerCase();

function atPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// Build the host's onVerify: one switch over ALL VerifyDirective kinds, each a
// pollVerify over a real re-query. Behaviour for the pre-existing kinds is
// identical to the old inline ElderlyApp loops.
export function buildVerifyRunner(deps: VerifyDeps): (verify: VerifyDirective) => Promise<boolean> {
  const { elderId } = deps;
  return (verify: VerifyDirective): Promise<boolean> => {
    switch (verify.kind) {
      case "medication-exists":
        return pollVerify(async () => {
          const meds = await deps.fetchElderMedications(elderId);
          return meds.some(m => norm(m.name) === norm(verify.name));
        });
      case "travel-plan-saved":
        return pollVerify(async () => {
          const plan = (await deps.fetchProfile(elderId))?.details.travelPlan;
          // Every field, not just startDate. Checking startDate alone meant a
          // travel plan saved with a BLANKED timezone (what an unmatched
          // <select> value leaves behind) verified as a success, and Mei told
          // the elder it had saved correctly. A partial plan is a failed plan.
          return !!plan?.startDate && !!plan.endDate && !!plan.timezone?.trim();
        });
      case "profile-field":
        return pollVerify(async () => {
          const profile = await deps.fetchProfile(elderId);
          const actual = profile?.details[verify.field as keyof ProfileDetails];
          return actual !== undefined && actual !== null && String(actual) === verify.value.trim();
        });
      case "profile-list-includes":
        return pollVerify(async () => {
          const profile = await deps.fetchProfile(elderId);
          const list = profile?.details[verify.field as keyof ProfileDetails];
          // Entries may be plain strings OR promoted {name, ...} objects (the
          // allergies list once set_allergy_severity graded one) — match by name.
          const nameOf = (v: unknown): string =>
            v !== null && typeof v === "object" && "name" in v
              ? String((v as { name: unknown }).name ?? "")
              : String(v);
          return Array.isArray(list) && list.some(v => norm(nameOf(v)) === norm(verify.value));
        });
      case "care-link-active":
        return pollVerify(() => deps.hasActiveCareLink(elderId));
      case "doctor-question-exists":
        return pollVerify(async () => {
          const rows = await deps.fetchDoctorQuestions(elderId);
          return rows.some(r => norm(r.question) === norm(verify.question));
        });
      case "dose-status":
        return pollVerify(async () => {
          const meds = await deps.fetchElderMedications(elderId);
          return meds.some(m => m.medicationId === verify.medicationId && m.status === verify.status);
        });
      case "medication-archived":
        return pollVerify(async () => {
          const past = await deps.fetchArchivedMedications(elderId);
          return past.some(m => norm(m.name) === norm(verify.name));
        });
      case "accessibility-path-equals":
        return pollVerify(async () => {
          const actual = atPath(await deps.fetchAccessibility(elderId), verify.path);
          return actual !== undefined && actual !== null && String(actual) === verify.value;
        });
      case "reminder-times":
        return pollVerify(async () => {
          const meds = await deps.fetchElderMedications(elderId);
          // fetchElderMedications explodes one row per schedule slot; collect
          // this medication's slots (12h labels) and compare as a set against
          // the expected HH:MM times.
          const slots = meds.filter(m => norm(m.name) === norm(verify.name)).map(m => m.time);
          // Explicit arrow, NOT point-free: hhmmTo12h now takes an optional
          // CaptionOptions second argument, and Array.map would hand it the
          // index. Deliberately called with NO options here — this compares
          // against the app's own stored 12h labels, so a localized/24h
          // rendering would never match.
          const expected = verify.times.map(t => hhmmTo12h(t));
          return expected.length > 0
            && expected.length === slots.length
            && expected.every(t => slots.includes(t));
        });
    }
  };
}
