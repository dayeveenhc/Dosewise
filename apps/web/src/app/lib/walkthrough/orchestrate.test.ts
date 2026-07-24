import { afterEach, describe, expect, it, vi } from "vitest";
import { runActStep } from "./orchestrate";
import type { WalkthroughStep } from "./types";

// The safety-critical guarantee: a failed Verify STOPS the step — it must not
// Reveal and must not advance, so the walkthrough can never imply a success it
// couldn't prove against real re-queried state.

const ON_AI = { mode: "elderly", tab: "ai" } as const;

// A minimal act target so performAct resolves (it clicks a real DOM button).
function mountButton(id: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.setAttribute("data-testid", id);
  document.body.appendChild(btn);
  return btn;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function baseStep(overrides: Partial<WalkthroughStep>): WalkthroughStep {
  return {
    id: "t.step",
    screen: ON_AI,
    selector: '[data-testid="target"]',
    instructionKey: "walk.exit",
    act: { kind: "click", selector: '[data-testid="target"]' },
    ...overrides,
  };
}

function handlers(over: Partial<Parameters<typeof runActStep>[1]> = {}) {
  return {
    onVerify: vi.fn(async () => true),
    onReveal: vi.fn(),
    onNavigate: vi.fn(),
    onAdvance: vi.fn(),
    shouldCancel: () => false,
    ...over,
  };
}

describe("runActStep", () => {
  it("act → verify pass → reveal → advance", async () => {
    mountButton("target");
    const h = handlers({ onVerify: vi.fn(async () => true) });
    const step = baseStep({ verify: { kind: "medication-exists", name: "Metformin" }, reveal: { screen: ON_AI, selector: "#row" } });

    const outcome = await runActStep(step, h);

    expect(outcome).toBe("advanced");
    expect(h.onVerify).toHaveBeenCalledOnce();
    expect(h.onReveal).toHaveBeenCalledOnce();
    expect(h.onAdvance).toHaveBeenCalledOnce();
  });

  it("act → verify FAIL → does NOT reveal, does NOT advance", async () => {
    mountButton("target");
    const h = handlers({ onVerify: vi.fn(async () => false) });
    const step = baseStep({ verify: { kind: "medication-exists", name: "Ghost" }, reveal: { screen: ON_AI, selector: "#row" } });

    const outcome = await runActStep(step, h);

    expect(outcome).toBe("verify-failed");
    expect(h.onReveal).not.toHaveBeenCalled();
    expect(h.onAdvance).not.toHaveBeenCalled();
  });

  it("no verify declared → reveals and advances", async () => {
    mountButton("target");
    const h = handlers();
    const step = baseStep({ reveal: { screen: ON_AI, selector: "#row" } });

    const outcome = await runActStep(step, h);

    expect(outcome).toBe("advanced");
    expect(h.onVerify).not.toHaveBeenCalled();
    expect(h.onReveal).toHaveBeenCalledOnce();
    expect(h.onAdvance).toHaveBeenCalledOnce();
  });

  it("a step with no act and no verify/reveal just advances", async () => {
    const h = handlers();
    const step = baseStep({ act: undefined });

    const outcome = await runActStep(step, h);

    expect(outcome).toBe("advanced");
    expect(h.onAdvance).toHaveBeenCalledOnce();
    expect(h.onVerify).not.toHaveBeenCalled();
  });

  it("an ACT-LESS step with verify still runs Verify (post-consent verify step)", async () => {
    const h = handlers({ onVerify: vi.fn(async () => true) });
    const step = baseStep({ act: undefined, verify: { kind: "care-link-active" }, reveal: { screen: ON_AI, selector: "#n" } });

    const outcome = await runActStep(step, h);

    expect(outcome).toBe("advanced");
    expect(h.onVerify).toHaveBeenCalledOnce();
    expect(h.onReveal).toHaveBeenCalledOnce();
    expect(h.onAdvance).toHaveBeenCalledOnce();
  });

  it("an act-less step whose Verify FAILS does not advance", async () => {
    const h = handlers({ onVerify: vi.fn(async () => false) });
    const step = baseStep({ act: undefined, verify: { kind: "care-link-active" } });

    const outcome = await runActStep(step, h);

    expect(outcome).toBe("verify-failed");
    expect(h.onAdvance).not.toHaveBeenCalled();
  });
});
