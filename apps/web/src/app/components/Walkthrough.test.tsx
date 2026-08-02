import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { LanguageProvider } from "../lib/languageContext";
import { Walkthrough } from "./Walkthrough";
import type { WalkthroughStep } from "../lib/walkthrough/types";

// The advancement invariant, from the UI side: pace controls (Next/Replay)
// exist ONLY on autonomous steps. A waitFor step — the consent taps — must
// never render a Next button, because its completion has to be the user's own
// real action on the real target.

// jsdom implements none of these (layout APIs); they're irrelevant to what
// these tests assert, so stub them (same pattern as ChangeHighlight.test.tsx).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  document.elementFromPoint = () => null;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const ON_HOME = { mode: "elderly", tab: "home" } as const;

function mountTarget(testid: string, tag: "button" | "input" = "button"): HTMLElement {
  const el = document.createElement(tag);
  el.setAttribute("data-testid", testid);
  document.body.appendChild(el);
  return el;
}

function step(overrides: Partial<WalkthroughStep>): WalkthroughStep {
  return {
    id: "t.step",
    screen: ON_HOME,
    selector: '[data-testid="wt-target"]',
    // A real walk.* key whose text collides with nothing else in the callout.
    instructionKey: "walk.autoRx.name",
    ...overrides,
  };
}

// A filler step so the step under test isn't the LAST one — the last step's
// commit button reads "Done", not "Next".
const FILLER = step({ id: "t.filler" });

function renderWalkthrough(s: WalkthroughStep | WalkthroughStep[], stepIndex = 0) {
  const steps = Array.isArray(s) ? s : [s, FILLER];
  return render(
    <LanguageProvider>
      <div style={{ position: "relative", height: 800 }}>
        <Walkthrough
          steps={steps}
          stepIndex={stepIndex}
          currentScreen={ON_HOME}
          onNavigate={vi.fn()}
          onAdvance={vi.fn()}
          onExit={vi.fn()}
          onVerify={vi.fn(async () => true)}
          onReveal={vi.fn()}
        />
      </div>
    </LanguageProvider>,
  );
}

describe("Walkthrough — pace controls", () => {
  it("NEVER renders Next on a waitFor (user-driven) step — consent taps stay the user's own", async () => {
    mountTarget("wt-target");
    const { queryByText } = renderWalkthrough(
      step({ waitFor: { type: "click", source: "dom" } }),
    );
    // Callout appears once the spotlight target is measured.
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    expect(queryByText("Next")).toBeNull();
    expect(queryByText("Done")).toBeNull();
    expect(queryByText("Replay")).toBeNull();
  });

  it("renders Next on an autonomous act step, disabled until the phase minimum", async () => {
    mountTarget("wt-target", "input");
    const { queryByText } = renderWalkthrough(
      step({ act: { kind: "fill", selector: '[data-testid="wt-target"]', value: "Metformin" } }),
    );
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    const next = queryByText("Next") as HTMLButtonElement | null;
    expect(next).not.toBeNull();
    // The fill phase's FIELD_MIN_MS floor hasn't elapsed — Next can't rush it.
    expect(next!.disabled).toBe(true);
  });

  it("the LAST step's commit button reads Done, not Next", async () => {
    mountTarget("wt-target", "input");
    const act = step({ act: { kind: "fill", selector: '[data-testid="wt-target"]', value: "Metformin" } });
    const { queryByText } = renderWalkthrough([FILLER, act], 1);
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    expect(queryByText("Done")).not.toBeNull();
    expect(queryByText("Next")).toBeNull();
  });
});

describe("Walkthrough — review card", () => {
  // The card lives on the manual-Save confirm step, which is a waitFor step —
  // so `autonomous` is FALSE for it. If this ever gets moved inside the
  // `autonomous && …` block that guards Next/Replay, it silently never renders.
  it("renders on a waitFor step, reading the live form values", async () => {
    const field = mountTarget("rx-name", "input") as HTMLInputElement;
    field.value = "Metformin";
    mountTarget("wt-target");

    const { queryByText } = renderWalkthrough(
      step({
        waitFor: { type: "click", source: "dom" },
        review: [{ labelKey: "wizard.medicationName", selector: '[data-testid="rx-name"]' }],
      }),
    );

    await waitFor(() => expect(queryByText("Please check these details")).not.toBeNull());
    expect(queryByText("Medication name")).not.toBeNull();
    expect(queryByText("Metformin")).not.toBeNull();
    // Still a consent step: no Next, and the way out is still there.
    expect(queryByText("Next")).toBeNull();
    expect(queryByText("Exit walkthrough")).not.toBeNull();
  });

  it("is absent on a step that declares no review fields", async () => {
    mountTarget("wt-target");
    const { queryByText } = renderWalkthrough(step({ waitFor: { type: "click", source: "dom" } }));
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    expect(queryByText("Please check these details")).toBeNull();
  });
});

// The defect this overlay was rewritten to make impossible: the callout is the
// only host of the Exit button, so gating it on a measured spotlight left a
// person stranded on an opaque scrim with no instruction and no way out. Any
// change that reintroduces a `rect` gate on the callout must fail here.
describe("Walkthrough — never strands the user", () => {
  it("renders the callout AND a working Exit even when the target never mounts", async () => {
    // Deliberately mount nothing: the step's selector matches no element.
    const { queryByText, getByRole } = renderWalkthrough(
      step({ selector: '[data-testid="does-not-exist"]', waitFor: { type: "click", source: "dom" } }),
    );

    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    const exit = getByRole("button", { name: "Exit walkthrough" });
    expect(exit).not.toBeNull();
    // Real button chrome, not bare clickable text.
    expect(exit.className).toContain("min-h-[44px]");
    expect(exit.className).toContain("border");
  });
});

// The consent-frame contract: a user-driven step must show the SAME action row
// as an autonomous one — but the indicator must never be a control Mei (or a
// test) can press to advance past consent.
describe("Walkthrough — wait pill on user-driven steps", () => {
  it("names the real control, derived from the target's accessible name", async () => {
    const btn = mountTarget("wt-target") as HTMLButtonElement;
    btn.textContent = "Add Lisinopril";
    const { queryByText } = renderWalkthrough(step({ waitFor: { type: "click", source: "dom" } }));

    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    await waitFor(() => expect(queryByText("Waiting for you: Add Lisinopril")).not.toBeNull());
  });

  it("prefers aria-label over text, so icon-only buttons still read", async () => {
    const btn = mountTarget("wt-target");
    btn.setAttribute("aria-label", "Call Mary Tan");
    btn.textContent = "";
    const { queryByText } = renderWalkthrough(step({ waitFor: { type: "acknowledge", source: "dom" } }));
    await waitFor(() => expect(queryByText("Waiting for you: Call Mary Tan")).not.toBeNull());
  });

  // A <select>'s textContent is every option concatenated; a wrapper's is its
  // whole subtree. Both would render garbage, so both are guarded.
  it("never dumps a select's options into the pill", async () => {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-testid", "wt-target");
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", "Language");
    for (const o of ["English", "Mandarin", "Hokkien"]) {
      const opt = document.createElement("option");
      opt.textContent = o;
      sel.appendChild(opt);
    }
    wrap.appendChild(sel);
    document.body.appendChild(wrap);

    const { queryByText } = renderWalkthrough(step({ waitFor: { type: "select-change", source: "dom" } }));
    await waitFor(() => expect(queryByText("Waiting for you: Language")).not.toBeNull());
    expect(queryByText(/EnglishMandarin/)).toBeNull();
  });

  it("falls back to type-specific copy when the target has no name (a bare toggle)", async () => {
    const btn = mountTarget("wt-target");
    btn.textContent = "";
    const { queryByText } = renderWalkthrough(step({ waitFor: { type: "toggle", source: "dom" } }));
    await waitFor(() => expect(queryByText("Waiting for the switch")).not.toBeNull());
  });

  // THE invariant. Every spec that proves consent steps can't be auto-advanced
  // asserts on the button role; the pill must stay outside it forever.
  it("is NOT a button — Mei can never advance a consent step", async () => {
    const btn = mountTarget("wt-target");
    btn.textContent = "Accept";
    const { queryByText, queryAllByRole } = renderWalkthrough(step({ waitFor: { type: "click", source: "dom" } }));

    await waitFor(() => expect(queryByText("Waiting for you: Accept")).not.toBeNull());
    // The pill must not sit inside a <button>. A disabled button would still be
    // matched by getByRole("button"), which is exactly what the consent specs
    // (s10/s22/s24/s26) use to prove no advance control exists on these steps.
    expect(queryByText("Waiting for you: Accept")!.closest("button")).toBeNull();
    // The only control in the callout is Exit.
    const inCallout = queryAllByRole("button").filter(b => b.className.includes("rounded-xl"));
    expect(inCallout.map(b => b.textContent?.trim())).toEqual(["Exit walkthrough"]);
  });

  it("is absent on autonomous steps (they have Next instead)", async () => {
    mountTarget("wt-target", "input");
    const { queryByText } = renderWalkthrough(
      step({ act: { kind: "fill", selector: '[data-testid="wt-target"]', value: "x" } }),
    );
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    expect(queryByText(/^Waiting for/)).toBeNull();
  });
});
