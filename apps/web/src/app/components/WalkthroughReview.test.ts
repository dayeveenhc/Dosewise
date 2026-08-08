import { afterEach, describe, expect, it } from "vitest";
import { readValues } from "./WalkthroughReview";

afterEach(() => { document.body.innerHTML = ""; });

// readValues is the ONE place that knows how to read a ReviewField — the review
// card and orchestrate.ts's Confirm phase both go through it, so a wrong answer
// here doesn't just mis-render, it blocks the Confirm gate on a clarifying
// question about a field the person really did fill.
describe("readValues", () => {
  it("reads an input's value, trimmed", () => {
    document.body.innerHTML = `<input data-walk="f" value="  Metformin  " />`;
    expect(readValues([{ labelKey: "x", selector: '[data-walk="f"]' }])).toEqual(["Metformin"]);
  });

  it("reports an EMPTY input as blank, without falling through to its text", () => {
    // The regression guard for the textContent fallback: an <input> always has
    // `.value === ""` when empty (never undefined), so `??` must not reach the
    // fallback for it — otherwise a genuinely blank field would read as filled.
    document.body.innerHTML = `<input data-walk="f" value="" />`;
    expect(readValues([{ labelKey: "x", selector: '[data-walk="f"]' }])).toEqual([""]);
  });

  it("falls back to textContent for a control that isn't an input", () => {
    // A chosen preset or a derived summary line — e.g. the course length, which
    // is a <p>, not a field anyone types into.
    document.body.innerHTML = `<p data-walk="f">Ends in 13 days</p>`;
    expect(readValues([{ labelKey: "x", selector: '[data-walk="f"]' }])).toEqual(["Ends in 13 days"]);
  });

  it("reports a missing element as blank rather than throwing", () => {
    expect(readValues([{ labelKey: "x", selector: '[data-walk="nope"]' }])).toEqual([""]);
  });
});
