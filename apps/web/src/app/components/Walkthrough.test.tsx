import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { LanguageProvider } from "../lib/languageContext";
import { IDLE_TIMEOUT_MS, PACING } from "../lib/walkthrough/pacing";
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

function renderWalkthrough(
  s: WalkthroughStep | WalkthroughStep[],
  stepIndex = 0,
  extraProps: Partial<Parameters<typeof Walkthrough>[0]> = {},
) {
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
          {...extraProps}
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
    // The only ADVANCE-shaped control in the callout is... none; Exit is all
    // that's left. Controls that provably cannot advance a consent step are
    // excluded BY data-walk rather than by class, so the invariant can't be
    // silently satisfied by someone styling a new control differently:
    //   walk-back    — stepping BACKWARDS is the opposite of advancing, and
    //                  gating.ts::canGoBack already refuses to cross a commit.
    //   walk-autonav — the Auto/Step-by-step toggle. AutoNav relaxes only the
    //                  terminal `ready` gate on AUTONOMOUS steps; no waitFor
    //                  step (i.e. every consent tap) ever auto-fires in either
    //                  mode, which is what makes it safe here.
    const NON_ADVANCING = new Set(["walk-back", "walk-autonav"]);
    const inCallout = queryAllByRole("button")
      .filter(b => !NON_ADVANCING.has(b.getAttribute("data-walk") ?? ""))
      .filter(b => b.className.includes("rounded-xl") || b.className.includes("rounded-full"));
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

// IdleTimeout (Item 6, decision D): waitingOnUser — not a phase-name
// allowlist — decides whether the 20s "still there?" popup can ever arm.
// `shouldAdvanceTime: true` is required, not optional: the initial callout's
// appearance depends on a real requestAnimationFrame loop (Walkthrough.tsx's
// measure effect), which plain (non-auto-advancing) fake timers never pump —
// every `await waitFor(...)` below would hang forever. The explicit
// `advanceTimersByTimeAsync` calls still turn each real PACING/IDLE_TIMEOUT_MS
// floor into a near-instant jump rather than a real multi-second wait; a
// FOLLOW-UP `await waitFor(...)` (never a bare synchronous `expect`) on every
// POSITIVE assertion gives React's own state flush a chance to land before
// the check runs, since shouldAdvanceTime's background real-time ticking
// means the DOM update isn't guaranteed to have committed synchronously the
// instant advanceTimersByTimeAsync's promise resolves.
describe("Walkthrough — IdleTimeout (Item 6)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The autonomous phases are SHORT by construction — the whole field phase is
  // floored at FIELD_MIN_MS (1.8s), so it is not possible to be both "mid-fill"
  // and "past IDLE_TIMEOUT_MS" (20s). This test used to advance
  // IDLE_TIMEOUT_MS + 5000 and assert no popup while calling that "still
  // mid-field"; it only passed because nothing was pumping the actor's own
  // timers far enough for the step to reach its terminal gate. Once the
  // measure effect's per-frame rect watcher (added when the cutout was found
  // sitting 3-330px off its target) kept React flushing, the step really did
  // reach the tap-gated "ready" state — where the popup arming after 20s of
  // no interaction is exactly what Item 6 is FOR (waitingOnUser case 2).
  //
  // So this now asserts the thing it always meant: while the autonomous phase
  // is genuinely still running, the idle timer is not armed at all.
  it("arms only once the autonomous phase ENDS — silent mid-fill, then fires at the tap gate", async () => {
    mountTarget("wt-target", "input");
    const { queryByText } = renderWalkthrough(
      step({ act: { kind: "fill", selector: '[data-testid="wt-target"]', value: "Metformin" } }),
      0,
      // autoNavDefault false = the callout's Auto switch starts on "Step by
      // step", which is what makes the terminal "ready" gate a real wait at
      // all. With Auto on (the default) it auto-elapses and there is nothing
      // to be idle AT — covered by the veteran test below.
      { requireExplicitAdvance: true, autoNavDefault: false },
    );
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());

    // Mid-fill (inside FIELD_MIN_MS): Mei is working, nobody is being waited
    // on, so the idle timer must not be armed.
    await vi.advanceTimersByTimeAsync(PACING.FIELD_MIN_MS - 400);
    expect(queryByText("Still there?")).toBeNull();

    // Same step, same uninterrupted run: once it reaches the tap-gated ready
    // state the SAME idle timer must arm and fire. Asserting both halves in
    // one run is what pins the popup to the phase rather than to wall-clock
    // time since the step started.
    await vi.advanceTimersByTimeAsync(PACING.FIELD_MIN_MS);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 5000);
    await waitFor(() => expect(queryByText("Still there?")).not.toBeNull());
  });

  it("does NOT fire for a veteran's auto-elapsing ready gate — requireExplicitAdvance=false is not a wait", async () => {
    mountTarget("wt-target", "input");
    const { queryByText } = renderWalkthrough(
      step({ act: { kind: "fill", selector: '[data-testid="wt-target"]', value: "x" } }),
      0,
      { requireExplicitAdvance: false },
    );
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    // Clear the field floor, then the veteran's auto-elapsing ready floor —
    // both real PACING constants, not guesses — landing on "ready" with
    // requireExplicitAdvance false. The popup must still never arm, because
    // "ready" here was never a real wait.
    await vi.advanceTimersByTimeAsync(PACING.FIELD_MIN_MS + PACING.READY_AUTO_MS);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 5000);
    expect(queryByText("Still there?")).toBeNull();
  });

  it("DOES fire for a step-by-step tap-gated ready gate", async () => {
    mountTarget("wt-target", "input");
    const { queryByText } = renderWalkthrough(
      step({ act: { kind: "fill", selector: '[data-testid="wt-target"]', value: "x" } }),
      0,
      { requireExplicitAdvance: true, autoNavDefault: false },
    );
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    // Clear the field floor — the terminal gate is awaitNext("ready") here
    // (Auto off), so it holds with zero further elapsing until
    // IDLE_TIMEOUT_MS fires the popup.
    await vi.advanceTimersByTimeAsync(PACING.FIELD_MIN_MS);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 5000);
    await waitFor(() => expect(queryByText("Still there?")).not.toBeNull());
  });

  it("DOES fire on a genuine waitFor step (a real Submit/consent tap), and offers no way past it", async () => {
    mountTarget("wt-target");
    const { queryByText } = renderWalkthrough(step({ waitFor: { type: "click", source: "dom" } }));
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1000);
    await waitFor(() => expect(queryByText("Still there?")).not.toBeNull());
    // The one invariant this whole feature must never violate: a waitFor step
    // is a real user action with no synthetic substitute (mirrors the
    // "NEVER renders Next on a waitFor step" test above). "Skip this step" was
    // the only control that could have come close, and it no longer exists
    // anywhere — kept asserted so re-adding one has to come past this test.
    expect(queryByText("Skip this step")).toBeNull();
    // No onTalkToMei wired in this harness — the button must not render.
    expect(queryByText("Talk to Mei")).toBeNull();
    // Leaving is the only way out, and it exits rather than advancing.
    expect(queryByText("End the walkthrough")).not.toBeNull();
    expect(queryByText("I'm still here, continue")).not.toBeNull();
  });

  it("resets on interaction — no popup if the person acts before the timeout elapses", async () => {
    mountTarget("wt-target");
    const { queryByText } = renderWalkthrough(step({ waitFor: { type: "click", source: "dom" } }));
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1000);
    expect(queryByText("Still there?")).toBeNull();

    // A real interaction ANYWHERE on the page (not just inside the overlay) —
    // window-level capture is what makes this reach the real spotlighted
    // target, which lives outside this component's own DOM subtree.
    window.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));

    // Past the ORIGINAL deadline: the reset must have held.
    await vi.advanceTimersByTimeAsync(1500);
    expect(queryByText("Still there?")).toBeNull();

    // Past the NEW deadline (counted from the interaction): now it fires.
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    await waitFor(() => expect(queryByText("Still there?")).not.toBeNull());
  });

  it('"I\'m still here, continue" dismisses the popup and re-arms the timer — a tap on the popup itself is never swallowed', async () => {
    mountTarget("wt-target");
    const { queryByText, getByText } = renderWalkthrough(step({ waitFor: { type: "click", source: "dom" } }));
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 500);
    await waitFor(() => expect(queryByText("Still there?")).not.toBeNull());

    // A real tap dispatches pointerdown (capture phase) BEFORE click — the
    // window-level listener must not dismiss the popup out from under this,
    // or the button's own onClick would never get a chance to run.
    const button = getByText("I'm still here, continue");
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    await waitFor(() => expect(queryByText("Still there?")).toBeNull());

    // Re-armed from THIS moment, not stuck permanently closed.
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1000);
    expect(queryByText("Still there?")).toBeNull();
    await vi.advanceTimersByTimeAsync(1500);
    await waitFor(() => expect(queryByText("Still there?")).not.toBeNull());
  });

  it('"Talk to Mei" is offered when the host wires a handoff, and invokes it', async () => {
    mountTarget("wt-target");
    const onTalkToMei = vi.fn();
    const { queryByText, getByText } = renderWalkthrough(
      step({ waitFor: { type: "click", source: "dom" } }),
      0,
      { onTalkToMei },
    );
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 500);
    await waitFor(() => expect(queryByText("Talk to Mei")).not.toBeNull());
    fireEvent.click(getByText("Talk to Mei"));
    expect(onTalkToMei).toHaveBeenCalledTimes(1);
  });

  it("disarms the moment the step is exited — no popup lingers after unmount", async () => {
    mountTarget("wt-target");
    const { queryByText, unmount } = renderWalkthrough(step({ waitFor: { type: "click", source: "dom" } }));
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    unmount();
    // Would throw (act warning / state update on unmounted component) if the
    // timer or its listeners outlived the component.
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1000);
  });

  // Real steps this collides with: accept_caregiver_link's consent tap and
  // emergency_contact_tour's Call button both carry timeoutMs: 20000 — the
  // EXACT same value as IDLE_TIMEOUT_MS. Without the 1s-ahead adjustment,
  // whichever setTimeout happens to fire first (an effect-registration-order
  // accident, not a designed outcome) wins, and on these two steps the popup
  // could lose the race to the step's own honest "give up" message — the
  // exact dead-end the popup exists to head off.
  it("wins the race against a step's own timeoutMs when they'd otherwise collide", async () => {
    mountTarget("wt-target");
    const { queryByText } = renderWalkthrough(
      step({ waitFor: { type: "acknowledge", source: "dom" }, timeoutMs: IDLE_TIMEOUT_MS }),
    );
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    // 1s before the step's own timeoutMs deadline: the popup must already be
    // up, and the step must NOT have given up yet (walk.timedOut copy absent).
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 900);
    await waitFor(() => expect(queryByText("Still there?")).not.toBeNull());
    expect(queryByText(/I didn't see that happen/)).toBeNull();
  });
});

// The idle popup's action set, asserted as a WHOLE rather than button by
// button. It carried five actions and now carries three: "Explain this step
// again" and "Skip this step" were removed (2026-08-07). Skip was the actively
// wrong one — it called requestNext(), which on a Confirm phase resolves that
// phase's gate rather than skipping the step, so the label described something
// the button did not do. Explain was the only consumer WalkthroughStep.voiceKey
// ever had, and that field went with it.
describe("Walkthrough — IdleTimeout: the popup's action set", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("offers exactly Talk to Mei, End the walkthrough, and Continue — nothing that advances", async () => {
    mountTarget("wt-target", "input");
    const onTalkToMei = vi.fn();
    const { queryByText, getByText } = renderWalkthrough(
      step({ act: { kind: "fill", selector: '[data-testid="wt-target"]', value: "x" } }),
      0,
      { requireExplicitAdvance: true, autoNavDefault: false, onTalkToMei },
    );
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    await vi.advanceTimersByTimeAsync(PACING.FIELD_MIN_MS);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 5000);
    await waitFor(() => expect(queryByText("Still there?")).not.toBeNull());

    const popup = document.querySelector('[data-walk="walk-idle-popup"]')!;
    expect([...popup.querySelectorAll("button")].map(b => b.textContent?.trim()).filter(Boolean))
      .toEqual(["Talk to Mei", "End the walkthrough", "I'm still here, continue"]);
    // Both removed actions stay asserted absent: re-adding either has to come
    // past this test, and Skip in particular must never reappear on a waitFor
    // step (see the invariant test above).
    expect(queryByText("Explain this step again")).toBeNull();
    expect(queryByText("Skip this step")).toBeNull();

    // Talk to Mei hands off to the host — it must not silently just close.
    fireEvent.click(getByText("Talk to Mei"));
    expect(onTalkToMei).toHaveBeenCalledOnce();
  });
});

// Back (the "something went wrong, take me one step back" control) and the
// AutoNav toggle. Both are rendered by the overlay, so both are asserted here
// rather than only through gating.ts's own unit tests — the point is that the
// SAFE cases actually reach the screen and the unsafe ones never do.
describe("Walkthrough — Back", () => {
  const fill = (id: string) => step({
    id,
    act: { kind: "fill", selector: '[data-testid="wt-target"]', value: "x" },
  });

  it("is offered when the previous step was a field fill", async () => {
    mountTarget("wt-target", "input");
    const onBack = vi.fn();
    const { queryByText, getByLabelText } = renderWalkthrough(
      [fill("a"), fill("b"), fill("c")],
      1,
      { onBack },
    );
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    fireEvent.click(getByLabelText("Back"));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("is NOT offered when going back would re-fire a click act", async () => {
    mountTarget("wt-target", "input");
    const { queryByText, queryByLabelText } = renderWalkthrough(
      [step({ id: "open", act: { kind: "click", selector: '[data-testid="wt-target"]' } }), fill("b")],
      1,
      { onBack: vi.fn() },
    );
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    expect(queryByLabelText("Back")).toBeNull();
  });

  it("is NOT offered once a write has been committed", async () => {
    mountTarget("wt-target", "input");
    const steps = [
      fill("a"),
      step({ id: "submit", waitFor: { type: "click", source: "dom" } }),
      step({ id: "verify", verify: { kind: "care-link-active" } }),
      fill("after"),
    ];
    const { queryByText, queryByLabelText } = renderWalkthrough(steps, 3, { onBack: vi.fn() });
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    expect(queryByLabelText("Back")).toBeNull();
  });

  it("is absent when the host never wired it", async () => {
    mountTarget("wt-target", "input");
    const { queryByText, queryByLabelText } = renderWalkthrough([fill("a"), fill("b")], 1);
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    expect(queryByLabelText("Back")).toBeNull();
  });
});

// One fast-forward toggle pinned to the overlay's top right, replacing the
// two-button "Auto | Step by step" segmented row that used to sit inside the
// callout below the review card. Located by data-walk, since its label is
// localized AND changes with its own state.
describe("Walkthrough — AutoNav toggle", () => {
  const toggle = () => document.querySelector('[data-walk="walk-autonav"]') as HTMLButtonElement;

  it("starts on Auto by default and toggles to Step by step", async () => {
    mountTarget("wt-target");
    const { queryByText } = renderWalkthrough(step({ waitFor: { type: "click", source: "dom" } }));
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(queryByText("Auto")).not.toBeNull();

    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(queryByText("Step by step")).not.toBeNull();
    expect(queryByText("Auto")).toBeNull();

    // Round-trips: it is a toggle, not a one-way switch.
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
  });

  it("starts on Step by step when the host says the person asked for that", async () => {
    mountTarget("wt-target");
    const { queryByText } = renderWalkthrough(
      step({ waitFor: { type: "click", source: "dom" } }),
      0,
      { autoNavDefault: false },
    );
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(queryByText("Step by step")).not.toBeNull();
  });

  it("is on every step, including user-driven ones — it is a mode for the whole run", async () => {
    mountTarget("wt-target", "input");
    const { queryByText } = renderWalkthrough(
      step({ act: { kind: "fill", selector: '[data-testid="wt-target"]', value: "x" } }),
    );
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());
    expect(toggle()).not.toBeNull();
  });

  // jsdom does no layout, so this asserts the MECHANISM rather than pixels: the
  // column that positions the button must carry a fixed width and must not
  // shrink to whichever label is showing. It used to be shrink-to-fit with
  // items-center, so "Auto" (~38px) and "Step by step" (clamped to 76px) gave
  // containers of different widths and the same 44px button was re-centred
  // ~16px inward on every toggle.
  it("keeps a fixed footprint, so the button cannot move when the label changes", async () => {
    mountTarget("wt-target");
    const { queryByText } = renderWalkthrough(step({ waitFor: { type: "click", source: "dom" } }));
    await waitFor(() => expect(queryByText("Exit walkthrough")).not.toBeNull());

    const column = () => toggle().parentElement as HTMLElement;
    const widthClasses = (el: HTMLElement) =>
      el.className.split(/\s+/).filter(c => /^w-|^max-w-|^min-w-/.test(c));

    const autoOn = widthClasses(column());
    expect(autoOn).toContain("w-[84px]");

    fireEvent.click(toggle());
    expect(queryByText("Step by step")).not.toBeNull();
    // Same classes in both states — nothing about the width is state-derived.
    expect(widthClasses(column())).toEqual(autoOn);
    // The label fills that fixed column rather than sizing to its own text.
    const label = column().querySelector("span") as HTMLElement;
    expect(label.className).toContain("w-full");
  });
});
