import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVerifyRunner, pollVerify } from "./verify";
import type { VerifyDeps } from "./verify";
import type { Medication } from "../../types";

// The ONE verification mechanism: pollVerify's retry loop (formerly five
// copy-pasted 12×400 loops in ElderlyApp) and buildVerifyRunner's switch over
// every VerifyDirective kind, driven purely by injected fakes — no Supabase.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function med(name: string, time: string, status: Medication["status"], medicationId?: string): Medication {
  return { id: 1, medicationId, name, dose: "", time, status, purpose: "", colour: "#000" };
}

function deps(over: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    elderId: "elder-1",
    fetchElderMedications: async () => [
      med("Metformin", "8:00 AM", "taken", "med-1"),
      med("Metformin", "8:00 PM", "taken", "med-1"),
      med("Aspirin", "9:00 AM", "upcoming", "med-2"),
    ],
    fetchProfile: async () => ({
      fullName: "Tan Ah Ma",
      details: {
        weightKg: 62,
        conditions: ["High blood pressure"],
        travelPlan: { startDate: "2026-08-01", endDate: "2026-08-14", timezone: "Asia/Tokyo" },
      },
    }),
    hasActiveCareLink: async () => true,
    fetchArchivedMedications: async () => [{ name: "Simvastatin" }],
    fetchAccessibility: async () => ({
      travelPlan: { startDate: "2026-08-01", endDate: "2026-08-14", timezone: "Asia/Tokyo" },
      wakeTime: "07:00",
    }),
    ...over,
  };
}

describe("pollVerify", () => {
  it("resolves true immediately when the first check passes", async () => {
    const check = vi.fn(async () => true);
    await expect(pollVerify(check)).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("keeps polling until the check flips true", async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 900);
    const p = pollVerify(async () => ready);
    await vi.advanceTimersByTimeAsync(1300); // checks at 0/400/800 fail, 1200 passes
    await expect(p).resolves.toBe(true);
  });

  it("gives up false at the timeout (default 4800ms = the old 12×400 loops)", async () => {
    const check = vi.fn(async () => false);
    let result: boolean | undefined;
    void pollVerify(check).then(r => { result = r; });
    await vi.advanceTimersByTimeAsync(4400);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(result).toBe(false);
  });
});

describe("buildVerifyRunner", () => {
  it("medication-exists matches case-insensitively", async () => {
    const run = buildVerifyRunner(deps());
    await expect(run({ kind: "medication-exists", name: "  metformin " })).resolves.toBe(true);
  });

  it("travel-plan-saved / profile-field / profile-list-includes / care-link-active keep their old checks", async () => {
    const run = buildVerifyRunner(deps());
    await expect(run({ kind: "travel-plan-saved" })).resolves.toBe(true);
    await expect(run({ kind: "profile-field", field: "weightKg", value: "62" })).resolves.toBe(true);
    await expect(run({ kind: "profile-list-includes", field: "conditions", value: "high blood pressure" })).resolves.toBe(true);
    await expect(run({ kind: "care-link-active" })).resolves.toBe(true);
  });

  it("dose-status checks the medication's re-queried dose state", async () => {
    const run = buildVerifyRunner(deps());
    await expect(run({ kind: "dose-status", medicationId: "med-1", status: "taken" })).resolves.toBe(true);

    let failed: boolean | undefined;
    void run({ kind: "dose-status", medicationId: "med-2", status: "taken" }).then(r => { failed = r; });
    await vi.advanceTimersByTimeAsync(5200);
    expect(failed).toBe(false);
  });

  it("medication-archived checks the archived list by name", async () => {
    const run = buildVerifyRunner(deps());
    await expect(run({ kind: "medication-archived", name: "simvastatin" })).resolves.toBe(true);
  });

  it("accessibility-path-equals walks a dot-path into the accessibility jsonb", async () => {
    const run = buildVerifyRunner(deps());
    await expect(
      run({ kind: "accessibility-path-equals", path: "travelPlan.timezone", value: "Asia/Tokyo" }),
    ).resolves.toBe(true);

    let wrong: boolean | undefined;
    void run({ kind: "accessibility-path-equals", path: "travelPlan.timezone", value: "Asia/Seoul" })
      .then(r => { wrong = r; });
    await vi.advanceTimersByTimeAsync(5200);
    expect(wrong).toBe(false);
  });

  it("reminder-times requires the slot set to match exactly (any order)", async () => {
    const run = buildVerifyRunner(deps());
    await expect(
      run({ kind: "reminder-times", name: "Metformin", times: ["20:00", "08:00"] }),
    ).resolves.toBe(true);

    let incomplete: boolean | undefined;
    void run({ kind: "reminder-times", name: "Metformin", times: ["08:00"] }).then(r => { incomplete = r; });
    await vi.advanceTimersByTimeAsync(5200);
    expect(incomplete).toBe(false);
  });

  it("polls: an initially-missing medication verifies once the refetch surfaces it", async () => {
    let calls = 0;
    const run = buildVerifyRunner(deps({
      fetchElderMedications: async () => (++calls >= 3 ? [med("Losartan", "8:00 AM", "upcoming")] : []),
    }));
    const p = run({ kind: "medication-exists", name: "Losartan" });
    await vi.advanceTimersByTimeAsync(1300);
    await expect(p).resolves.toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});
