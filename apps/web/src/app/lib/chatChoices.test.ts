import { describe, it, expect } from "vitest";
import { buttonsFor, lastInteractiveIndex } from "./chatChoices";
import { t } from "./language";
import type { ChoiceCarrier } from "./chatChoices";

const agent = (over: Partial<ChoiceCarrier> = {}): ChoiceCarrier => ({ role: "agent", ...over });
const user = (): ChoiceCarrier => ({ role: "user" });

describe("buttonsFor", () => {
  it("returns the agent's own choices verbatim, ignoring awaitingConfirmation", () => {
    // offer_choices labels are context-specific ("Yes, save it") and already
    // localized by the agent — they must win over the generic synthesized pair.
    const choices = [{ label: "Yes, save it", value: "Yes, save it" }];
    expect(buttonsFor(agent({ choices, awaitingConfirmation: true }), "en")).toEqual(choices);
  });

  it("synthesizes a Yes/No pair when a confirm is pending and the agent offered none", () => {
    const out = buttonsFor(agent({ awaitingConfirmation: true }), "en");
    expect(out).toHaveLength(2);
    // label === value: the button text IS the message sent, so the person's own
    // bubble matches what they tapped.
    for (const c of out) expect(c.label).toBe(c.value);
  });

  it("localizes the synthesized pair — the reason the CLIENT owns this text", () => {
    for (const lang of ["en", "zh", "hokkien", "yue", "ta", "ms"] as const) {
      const [yes, no] = buttonsFor(agent({ awaitingConfirmation: true }), lang);
      expect(yes.label).toBe(t(lang, "ai.confirmYes"));
      expect(no.label).toBe(t(lang, "ai.confirmNo"));
      // A missing key would make t() return the key itself — never ship that
      // as a button someone is meant to tap to save a medication.
      expect(yes.label).not.toContain("ai.confirm");
    }
    expect(buttonsFor(agent({ awaitingConfirmation: true }), "ta")[0].label)
      .not.toBe(buttonsFor(agent({ awaitingConfirmation: true }), "en")[0].label);
  });

  it("returns nothing for a plain reply or for the person's own message", () => {
    expect(buttonsFor(agent(), "en")).toEqual([]);
    expect(buttonsFor(user(), "en")).toEqual([]);
    expect(buttonsFor(agent({ choices: [] }), "en")).toEqual([]);
  });
});

describe("lastInteractiveIndex", () => {
  it("finds the message with buttons even when a confirmation chip follows it", () => {
    // THE regression: a turn that both commits a routable write and asks a
    // follow-up appends its "opening your medicines…" chip AFTER the reply, so
    // the old `i === messages.length - 1` gate hid the buttons entirely.
    const messages = [
      user(),
      agent({ choices: [{ label: "Yes", value: "Yes" }] }),
      agent(), // the confirmation chip
    ];
    expect(lastInteractiveIndex(messages)).toBe(1);
  });

  it("prefers the most recent interactive message when several exist", () => {
    const messages = [
      agent({ awaitingConfirmation: true }),
      user(),
      agent({ choices: [{ label: "Yes", value: "Yes" }] }),
    ];
    expect(lastInteractiveIndex(messages)).toBe(2);
  });

  it("returns -1 for an all-plain thread", () => {
    expect(lastInteractiveIndex([user(), agent(), user()])).toBe(-1);
    expect(lastInteractiveIndex([])).toBe(-1);
  });
});
