import { describe, it, expect, afterEach } from "vitest";
import type { AgentAction } from "./hermes";
import {
  ENTITY_TARGETS,
  describeBatch,
  describeChange,
  firstHighlightable,
  findEntityElement,
  highlightableEntities,
  isHighlightable,
  targetFor,
  testIdFor,
} from "./changeHighlight";

// The exact bulk shape the backend emits for resolve_missed_doses: entities[]
// with NO top-level entity_type/entity_id; each entity_id is the MEDICATION id.
function bulkAction(n = 3): AgentAction {
  return {
    tool: "resolve_missed_doses",
    summary: `${n} missed doses marked taken`,
    entities: Array.from({ length: n }, (_, i) => ({
      entity_type: "dose",
      entity_id: `med-uuid-${i + 1}`,
      changed_fields: { status: { before: null, after: "taken" } },
      dose_id: `dose-uuid-${i + 1}`,
      slot: "08:00",
      name: `Med ${i + 1}`,
    })),
    dose_ids: Array.from({ length: n }, (_, i) => `dose-uuid-${i + 1}`),
  } as AgentAction;
}

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

  it("a dose-time change reads as Updated with 12h times, before → after", () => {
    const a: AgentAction = {
      tool: "set_medication_reminder",
      summary: "Metformin at 20:00",
      entity_type: "schedule_entry",
      entity_id: "med-1",
      changed_fields: { times: { before: ["18:00"], after: ["20:00"] } },
    };
    expect(describeChange(a)).toEqual({ verb: "Updated", text: "dose time 6:00 PM → 8:00 PM" });
  });

  it("a refill count change reads as supply before → after with pluralized units", () => {
    const a: AgentAction = {
      tool: "log_refill",
      summary: "Metformin: 30 pills",
      entity_type: "refill_request",
      entity_id: "med-1",
      changed_fields: { pills_remaining: { before: 5, after: 30 } },
    };
    expect(describeChange(a).text).toBe("supply 5 pills → 30 pills");
  });

  it("pluralizes a single-unit supply as '1 pill'", () => {
    const a: AgentAction = {
      tool: "log_refill",
      entity_type: "refill_request",
      entity_id: "med-1",
      changed_fields: { pills_remaining: { before: 2, after: 1 } },
    };
    expect(describeChange(a).text).toBe("supply 2 pills → 1 pill");
  });

  it("an unmapped backend field is humanized, never leaked as a raw snake_case key", () => {
    const a: AgentAction = {
      tool: "set_reminder",
      summary: "reminder set",
      entity_type: "schedule_entry",
      entity_id: "med-1",
      changed_fields: { snooze_minutes: { before: 5, after: 15 } },
    };
    const { text } = describeChange(a);
    expect(text).not.toContain("snooze_minutes");
    expect(text).toBe("Snooze minutes 5 → 15");
  });

  it("formats a bare HH:MM value (not wrapped in an array) as 12h", () => {
    const a: AgentAction = {
      tool: "set_reminder",
      entity_type: "schedule_entry",
      entity_id: "med-1",
      changed_fields: { reminder_at: { before: "08:00", after: "13:30" } },
    };
    expect(describeChange(a).text).toBe("reminder time 8:00 AM → 1:30 PM");
  });

  it("a lone dosage change drops the 'dose' label and reads as value → value", () => {
    const a: AgentAction = {
      tool: "update_medication",
      summary: "Metformin dose changed",
      entity_type: "medication",
      entity_id: "med-1",
      changed_fields: { dosage: { before: "500mg", after: "1000mg" } },
    };
    expect(describeChange(a)).toEqual({ verb: "Updated", text: "500mg → 1000mg" });
  });

  it("a logged dose reads as Taken with the med name, not a status field diff", () => {
    const a: AgentAction = {
      tool: "log_dose",
      summary: "Metformin",
      name: "Metformin",
      entity_type: "dose",
      entity_id: "med-1",
      changed_fields: { status: { before: "pending", after: "taken" } },
    };
    expect(describeChange(a)).toEqual({ verb: "Taken", text: "Metformin" });
  });

  it("empty summary with no visible change never yields a dangling 'Updated:'", () => {
    const a: AgentAction = {
      tool: "touch",
      entity_type: "medication",
      entity_id: "med-1",
      changed_fields: { name: { before: "Metformin", after: "Metformin" } },
    };
    const { verb, text } = describeChange(a);
    expect(verb).toBe("Updated");
    expect(text.trim()).not.toBe("");
    expect(text).toBe("no changes");
  });

  it("caps a many-field change and collapses the tail to '+k more'", () => {
    const a: AgentAction = {
      tool: "update_medication",
      entity_type: "medication",
      entity_id: "med-1",
      changed_fields: {
        name: { before: "A", after: "B" },
        frequency: { before: "1", after: "2" },
        purpose: { before: "x", after: "y" },
        status: { before: "active", after: "paused" },
        reason: { before: "old", after: "new" },
      },
    };
    const { text } = describeChange(a);
    expect(text.split(";")).toHaveLength(4); // 3 fields + the "+k more" segment
    expect(text).toContain("+2 more");
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

  it("a bulk action with resolvable entities is highlightable despite no top-level ids", () => {
    const a = bulkAction(3);
    expect(a.entity_type).toBeUndefined();
    expect(isHighlightable(a)).toBe(true);
    expect(firstHighlightable([{ tool: "list_medications" }, a])).toBe(a);
  });

  it("a bulk action with zero resolvable entities is NOT highlightable", () => {
    const a: AgentAction = {
      tool: "bulk_thing",
      entities: [
        { entity_type: "unknown_kind", entity_id: "1" },
        { entity_type: "dose", entity_id: "" },
      ],
    };
    expect(isHighlightable(a)).toBe(false);
    expect(firstHighlightable([a])).toBeNull();
  });
});

describe("bulk helpers — highlightableEntities / targetFor", () => {
  it("a single action yields a 1-element array from its own fields", () => {
    const a: AgentAction = {
      tool: "log_dose",
      entity_type: "dose",
      entity_id: "med-1",
      changed_fields: { status: { before: "pending", after: "taken" } },
    };
    expect(highlightableEntities(a)).toEqual([
      { entity_type: "dose", entity_id: "med-1", changed_fields: { status: { before: "pending", after: "taken" } } },
    ]);
  });

  it("a bulk action yields its entities filtered to the resolvable ones", () => {
    const a = bulkAction(3);
    a.entities!.push({ entity_type: "unknown_kind", entity_id: "x" });
    const ents = highlightableEntities(a);
    expect(ents).toHaveLength(3);
    expect(ents.map(e => e.entity_id)).toEqual(["med-uuid-1", "med-uuid-2", "med-uuid-3"]);
  });

  it("targetFor a dose bulk routes to the elder Home screen via the first entity", () => {
    expect(targetFor(bulkAction(3))).toBe(ENTITY_TARGETS.dose);
    expect(targetFor(bulkAction(3))?.elderly).toBe("home");
  });
});

describe("describeBatch — batch caption, no raw field names", () => {
  it("a 3-dose resolve_missed_doses batch reads Taken with the backend summary", () => {
    expect(describeBatch(bulkAction(3))).toEqual({ verb: "Taken", text: "3 missed doses marked taken" });
  });

  it("falls back to a clean count when the backend summary is missing", () => {
    const a = bulkAction(3);
    a.summary = undefined;
    expect(describeBatch(a)).toEqual({ verb: "Taken", text: "3 doses marked taken" });
  });

  it("a 1-entity bulk action falls back to the single describeChange path on that entity's fields", () => {
    const a: AgentAction = {
      tool: "bulk_update",
      summary: "1 schedule updated",
      entities: [{
        entity_type: "schedule_entry",
        entity_id: "med-1",
        changed_fields: { times: { before: ["18:00"], after: ["20:00"] } },
      }],
    };
    // Same caption the equivalent single action produces — built from the
    // entity's changed_fields, not a count.
    expect(describeBatch(a)).toEqual({ verb: "Updated", text: "dose time 6:00 PM → 8:00 PM" });
  });

  it("a 1-dose bulk reads Taken with the med name, like a single log_dose", () => {
    const a = bulkAction(1);
    a.summary = undefined;
    expect(describeBatch(a)).toEqual({ verb: "Taken", text: "Med 1" });
  });

  it("a non-bulk action passes through describeChange unchanged", () => {
    const a: AgentAction = {
      tool: "update_medication",
      entity_type: "medication",
      entity_id: "med-1",
      changed_fields: { dosage: { before: "500mg", after: "1000mg" } },
    };
    expect(describeBatch(a)).toEqual(describeChange(a));
  });

  it("a generic bulk without a taken-status never leaks raw field names", () => {
    const a: AgentAction = {
      tool: "bulk_update",
      entities: [
        { entity_type: "medication", entity_id: "m1", changed_fields: { pills_remaining: { before: 5, after: 30 } } },
        { entity_type: "medication", entity_id: "m2", changed_fields: { snooze_minutes: { before: 5, after: 15 } } },
      ],
    };
    const { verb, text } = describeBatch(a);
    expect(verb).toBe("Updated");
    expect(text).toBe("2 items updated");
    expect(text).not.toContain("pills_remaining");
    expect(text).not.toContain("snooze_minutes");
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
