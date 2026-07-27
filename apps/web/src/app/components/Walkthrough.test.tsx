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

function renderWalkthrough(s: WalkthroughStep) {
  return render(
    <LanguageProvider>
      <div style={{ position: "relative", height: 800 }}>
        <Walkthrough
          steps={[s]}
          stepIndex={0}
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
});
