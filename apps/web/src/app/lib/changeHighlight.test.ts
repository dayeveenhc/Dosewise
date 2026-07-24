import { describe, it, expect, afterEach } from "vitest";
import type { AgentAction } from "./hermes";
import { describeChange, firstHighlightable, findEntityElement, isHighlightable, testIdFor } from "./changeHighlight";

afterEach(() => { document.body.innerHTML = ""; });

describe("describeChange — caption is built from changed_fields, never hardcoded", () => {
  it("a new record reads as Added with the summary", () => {
    const a: AgentAction = {
      tool: "add_prescription",
      summary: "Metformin 500mg — 08:00 (daily)",
      entity_type: "medication",
      entity_id: "med-1",
      changed_fields: {
        name: { before: null, after: "Metformin" },
        times: { before: null, after: ["08:00"] },
      },
    };
    expect(describeChange(a)).toEqual({ verb: "Added", text: "Metformin 500mg — 08:00 (daily)" });
  });

  it("a dose-time change reads as Updated with before → after from changed_fields", () => {
    const a: AgentAction = {
      tool: "set_medication_reminder",
      summary: "Metformin at 20:00",
      entity_type: "schedule_entry",
      entity_id: "med-1",
      changed_fields: { times: { before: ["18:00"], after: ["20:00"] } },
    };
    expect(describeChange(a)).toEqual({ verb: "Updated", text: "dose time 18:00 → 20:00" });
  });

  it("a refill count change reads as supply before → after", () => {
    const a: AgentAction = {
      tool: "log_refill",
      summary: "Metformin: 30 pills",
      entity_type: "refill_request",
      entity_id: "med-1",
      changed_fields: { pills_remaining: { before: 5, after: 30 } },
    };
    expect(describeChange(a).text).toBe("supply 5 → 30");
  });

  it("long free-text (medical profile) collapses to just the field label", () => {
    const long = "x".repeat(60);
    const a: AgentAction = {
      tool: "update_medical_profile",
      summary: "medical profile",
      entity_type: "profile_field",
      entity_id: "medical_profile",
      changed_fields: { medical_profile: { before: long, after: long + " and penicillin allergy" } },
    };
    expect(describeChange(a)).toEqual({ verb: "Updated", text: "medical profile" });
  });
});

describe("isHighlightable / firstHighlightable", () => {
  it("requires entity_type, entity_id, and a known target", () => {
    expect(isHighlightable({ tool: "x" })).toBe(false);
    expect(isHighlightable({ tool: "x", entity_type: "medication", entity_id: "1" })).toBe(true);
    expect(isHighlightable({ tool: "x", entity_type: "unknown_kind", entity_id: "1" })).toBe(false);
  });

  it("firstHighlightable skips non-highlightable actions", () => {
    const actions: AgentAction[] = [
      { tool: "list_medications" },
      { tool: "add_prescription", entity_type: "medication", entity_id: "abc" },
    ];
    expect(firstHighlightable(actions)?.entity_id).toBe("abc");
  });
});

describe("findEntityElement — exact then suffix-by-id fallback", () => {
  it("finds the exact data-testid", () => {
    document.body.innerHTML = `<div data-testid="medication-uuid-1">card</div>`;
    const a: AgentAction = { tool: "add_prescription", entity_type: "medication", entity_id: "uuid-1" };
    expect(testIdFor(a)).toBe("medication-uuid-1");
    expect(findEntityElement(a)).not.toBeNull();
  });

  it("a schedule_entry change to the same id finds the medication card via suffix", () => {
    document.body.innerHTML = `<div data-testid="medication-uuid-9">card</div>`;
    const a: AgentAction = { tool: "set_medication_reminder", entity_type: "schedule_entry", entity_id: "uuid-9" };
    // exact "schedule_entry-uuid-9" is absent; suffix "-uuid-9" resolves the card.
    expect(findEntityElement(a)?.getAttribute("data-testid")).toBe("medication-uuid-9");
  });

  it("returns null when nothing matches", () => {
    document.body.innerHTML = `<div data-testid="medication-other">card</div>`;
    const a: AgentAction = { tool: "x", entity_type: "medication", entity_id: "missing" };
    expect(findEntityElement(a)).toBeNull();
  });
});
