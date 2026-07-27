import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";
import { onWalkthroughEvent, WALK_PHASE_EVENT } from "../lib/walkthrough/bus";
import { runActStep } from "../lib/walkthrough/orchestrate";
import { createPaceController } from "../lib/walkthrough/pace";
import { calloutTop } from "../lib/walkthrough/placement";
import { SpotlightCallout } from "./SpotlightCallout";
import type { PaceController, PacePhaseState } from "../lib/walkthrough/pace";
import type { RevealDirective, VerifyDirective, WalkthroughScreen, WalkthroughStep } from "../lib/walkthrough/types";

interface Rect { top: number; left: number; width: number; height: number }

function sameScreen(a: WalkthroughScreen, b: WalkthroughScreen): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === "caregiver" && b.mode === "caregiver") return a.screen === b.screen;
  if (a.mode === "elderly" && b.mode === "elderly") return a.tab === b.tab;
  return true; // both "onboarding" — the wizard's own step id is tracked separately
}

/**
 * The guided-walkthrough spotlight overlay. Reuses GuidedTour's mask/measure/
 * callout-positioning approach (this app's existing passive product tour).
 *
 * The advancement invariant: user-driven (waitFor) steps NEVER advance from
 * this component — their completion condition is a real user action on the
 * real target, detected via a native DOM listener (bypassing React's synthetic
 * events, since this component doesn't own the spotlighted node) or an
 * app-emitted event (lib/walkthrough/bus.ts; see types.ts's WaitFor doc), and
 * they get no Next button (the consent taps depend on this). Autonomous steps
 * auto-advance on the paced minimums (lib/walkthrough/pacing.ts via their
 * step's PaceController), and the user may advance them EARLIER — but never
 * before a phase's minimum — via Next, which only shortens dwell/animation and
 * never performs or fakes the step's action (a running Verify always waits for
 * its real result).
 */
export function Walkthrough({
  steps,
  stepIndex,
  currentScreen,
  onNavigate,
  onAdvance,
  onExit,
  onVerify,
  onReveal,
  onVerifyFailed,
}: {
  steps: WalkthroughStep[];
  stepIndex: number;
  currentScreen: WalkthroughScreen;
  onNavigate: (screen: WalkthroughScreen) => void;
  onAdvance: () => void; // called once this step's real waitFor condition fires
  onExit: () => void;
  // Autonomous (Guided Auto-Navigation) hooks — host re-queries real state
  // (onVerify) and shows the proof (onReveal). Absent for highlight-only
  // walkthroughs, which never carry act/verify/reveal steps.
  onVerify?: (verify: VerifyDirective) => Promise<boolean>;
  onReveal?: (reveal: RevealDirective) => void;
  // Fired when a step's Verify fails (the write couldn't be proven). The host
  // can use this to fall back — e.g. save directly instead of leaving the person
  // stuck — but it stays honest: the overlay still shows walk.verifyFailed until
  // the host clears it. Absent for walkthroughs with no fallback.
  onVerifyFailed?: (verify: VerifyDirective) => void;
}) {
  const { language } = useLanguage();
  const [rect, setRect] = useState<Rect | null>(null);
  const [navRect, setNavRect] = useState<Rect | null>(null);
  const [containerHeight, setContainerHeight] = useState(0);
  const [phaseError, setPhaseError] = useState(false);
  // Measured callout height so it's placed clear of the spotlight + nav instead
  // of guessing (was a fixed 140 that overlapped/left gaps). Seeded with a sane
  // default until the first measure lands.
  const [calloutHeight, setCalloutHeight] = useState(150);
  // Live pace telemetry for THIS step's controller (phase name + whether the
  // paced minimum has elapsed), driving the Next/Replay buttons and the
  // "checking…" label. Fed by the controller's bus events, not prop drilling.
  const [paceState, setPaceState] = useState<PacePhaseState>({ phase: null, canAdvance: false });
  const paceRef = useRef<PaceController | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const step = steps[stepIndex];
  // Autonomous = Mei acts (or an act-less verify/reveal tail step). waitFor
  // steps are user-driven and never get pace controls.
  const autonomous = !!(step.act || (!step.waitFor && (step.verify || step.reveal)));

  // Enter the step: ask the host to navigate first (mirrors GuidedTour's
  // onEnter — this component never owns the Screen/ElderlyTab state itself).
  useEffect(() => {
    if (step.onEnter) onNavigate(step.onEnter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  // Measure + spotlight the target, retrying a few frames in case the screen
  // this step needs hasn't finished mounting yet. Then keep the cutout GLUED to
  // the target while the screen scrolls WITHIN a step (e.g. the save→verify→
  // reveal scroll) — recompute on scroll/resize WITHOUT re-scrolling, so we don't
  // fight the programmatic scroll and the cutout never lags onto the wrong row.
  useEffect(() => {
    setRect(null);
    setNavRect(null);
    let attempts = 0;
    let raf = 0;
    let tick = 0;
    let disposed = false;

    const recompute = (doScroll: boolean): boolean => {
      const parent = rootRef.current?.parentElement;
      const targetEl = document.querySelector(step.selector);
      if (!parent || !targetEl) return false;
      if (doScroll) targetEl.scrollIntoView({ block: "center" });
      const p = parent.getBoundingClientRect();
      const r = targetEl.getBoundingClientRect();
      setRect({ top: r.top - p.top, left: r.left - p.left, width: r.width, height: r.height });
      setContainerHeight(p.height);
      const navEl = step.navSelector ? document.querySelector(step.navSelector) : null;
      if (navEl) {
        const n = navEl.getBoundingClientRect();
        setNavRect({ top: n.top - p.top, left: n.left - p.left, width: n.width, height: n.height });
      }
      return true;
    };

    const measure = () => {
      if (disposed) return;
      if (recompute(true)) return;
      if (attempts < 40) {
        attempts++;
        raf = requestAnimationFrame(measure);
      }
    };

    const onScrollResize = () => {
      cancelAnimationFrame(tick);
      tick = requestAnimationFrame(() => recompute(false));
    };
    // capture=true so it also catches scrolls inside the screen's own overflow
    // container, not just the window.
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    raf = requestAnimationFrame(measure);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(tick);
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  // Autonomous "act" steps (Guided Auto-Navigation): Mei performs the action
  // herself, visibly animated, then the step auto-advances — no user action.
  // Only runs for steps that declare `act`; highlight-only steps keep their
  // waitFor below. Guarded to fire exactly once per step, and cancels if the
  // overlay unmounts (Exit) mid-animation so it never drives a torn-down screen.
  const actedRef = useRef(false);
  useEffect(() => {
    actedRef.current = false;
    setPhaseError(false);
    setPaceState({ phase: null, canAdvance: false });
    // Autonomous path: an `act` step, OR an act-less step that carries
    // verify/reveal and is NOT user-driven (no waitFor) — e.g. the caregiver-
    // link flow's post-consent verify step. Plain highlight-only steps have a
    // waitFor and stay user-driven (handled by the effect below).
    if (!autonomous) return;
    let cancelled = false;
    // One PaceController per autonomous step: it floors every phase at the
    // PACING minimums and carries the user's Next/Replay requests.
    const pace = createPaceController({ stepId: step.id });
    paceRef.current = pace;
    void (async () => {
      // (Navigate) → Act → (Verify) → (Reveal) → advance. A failed Verify STOPS
      // here and shows an error — never advances, so success is never implied.
      const outcome = await runActStep(step, {
        pace,
        onVerify,
        onReveal,
        onNavigate,
        onAdvance: () => {
          if (cancelled || actedRef.current) return;
          actedRef.current = true;
          onAdvance();
        },
        shouldCancel: () => cancelled,
      });
      if (!cancelled && outcome === "verify-failed") {
        setPhaseError(true);
        if (step.verify) onVerifyFailed?.(step.verify);
      }
    })();
    return () => {
      cancelled = true;
      pace.cancel();
      if (paceRef.current === pace) paceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  // Mirror the controller's phase telemetry (bus) into render state so the
  // Next/Replay buttons and the "checking…" label track the live phase.
  useEffect(() => {
    if (!autonomous) return;
    return onWalkthroughEvent(WALK_PHASE_EVENT, detail => {
      setPaceState(detail as PacePhaseState);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  // The one thing that must never regress: detect the step's completion
  // condition without ever triggering it ourselves. Re-attaches on every
  // rAF-ish retry (via the `rect` dependency) so a target that mounts late,
  // or is replaced by a new DOM node, still gets listened to. Skipped for
  // autonomous `act` steps (handled above) and any step without a waitFor.
  useEffect(() => {
    const waitFor = step.waitFor;
    if (step.act || !waitFor) return;
    if (waitFor.source === "dom") {
      if (waitFor.type === "navigation") return; // handled by the effect below
      const selector = "selector" in waitFor && waitFor.selector ? waitFor.selector : step.selector;
      const el = document.querySelector(selector);
      if (!el) return;
      const advance = () => onAdvance();

      if (waitFor.type === "click" || waitFor.type === "acknowledge") {
        el.addEventListener("click", advance, { once: true });
        return () => el.removeEventListener("click", advance);
      }
      if (waitFor.type === "input") {
        const check = () => {
          const value = (el as HTMLInputElement | HTMLTextAreaElement).value ?? "";
          if (waitFor.validate === "nonEmpty" || !waitFor.validate) {
            if (value.trim().length > 0) advance();
          } else if (new RegExp(waitFor.validate.pattern).test(value.trim())) {
            advance();
          }
        };
        el.addEventListener(waitFor.on, check);
        return () => el.removeEventListener(waitFor.on, check);
      }
      if (waitFor.type === "select-change") {
        el.addEventListener("change", advance, { once: true });
        return () => el.removeEventListener("change", advance);
      }
      if (waitFor.type === "toggle") {
        const observer = new MutationObserver(() => {
          const pressed = el.getAttribute("aria-pressed") === "true";
          if (waitFor.expected === undefined || pressed === waitFor.expected) advance();
        });
        observer.observe(el, { attributes: true, attributeFilter: ["aria-pressed"] });
        return () => observer.disconnect();
      }
    } else if (waitFor.type === "agent-action-committed") {
      // Fixed bus event name; the host emits it once per turn with the tool
      // names Hermes's committed_actions actually contains (never tools_used/
      // actions alone — CONTEXT.md's propose-vs-commit distinction).
      return onWalkthroughEvent("agent-action-committed", detail => {
        if ((detail as { tools: string[] } | undefined)?.tools.includes(waitFor.tool)) onAdvance();
      });
    } else if (waitFor.type === "step-transition") {
      // Several steps can share one emitted event name (e.g. the wizard's
      // "wizard-step-changed" fires from every Continue button) — only the
      // transition this specific step is waiting for should satisfy it.
      return onWalkthroughEvent(waitFor.event, detail => {
        if ((detail as { toStep?: string } | undefined)?.toStep === waitFor.toStep) onAdvance();
      });
    } else {
      // app-event: value-change, step-transition, automatic-detection,
      // write-committed — all emitted explicitly by instrumented app code via
      // lib/walkthrough/bus.ts, only when the real thing actually happened
      // (never on the triggering click alone).
      return onWalkthroughEvent(waitFor.event, () => onAdvance());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex, rect]);

  // navigation-type steps: compare the host's live current screen, snapshotted
  // fresh each render — not armed until after this step's own onEnter (if any)
  // has already settled the screen, so it can't satisfy itself against our own
  // programmatic switch.
  useEffect(() => {
    if (step.waitFor?.type !== "navigation") return;
    if (sameScreen(currentScreen, step.waitFor.to) && !sameScreen(currentScreen, step.screen)) {
      onAdvance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScreen, stepIndex]);

  const top = calloutTop(rect, containerHeight, calloutHeight);

  return (
    // Click-through by default so a REAL user tap reaches the spotlighted element
    // beneath (the consent flows and every highlight-only waitFor step depend on
    // this; the autonomous actor uses programmatic .click() and is unaffected).
    // The callout re-enables pointer events so Exit stays tappable.
    <div ref={rootRef} className="absolute inset-0 z-[200] pointer-events-none">
      {!rect && <div className="absolute inset-0 bg-black/75" />}
      {rect && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ transition: "opacity 200ms" }}>
          <defs>
            <mask id="walkthrough-cutout">
              <rect x="0" y="0" width="100%" height="100%" fill="white" />
              <rect x={rect.left - 6} y={rect.top - 6} width={rect.width + 12} height={rect.height + 12} rx="16" fill="black" />
              {navRect && (
                <rect x={navRect.left - 4} y={navRect.top - 4} width={navRect.width + 8} height={navRect.height + 8} rx="16" fill="black" />
              )}
            </mask>
          </defs>
          <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.75)" mask="url(#walkthrough-cutout)" />
        </svg>
      )}

      {/* Only show the card once the target is measured (or on an error, which
          has no spotlight) so it never appears as an unanchored mid-screen modal
          before the spotlight lands. */}
      {(rect || phaseError) && (
        <SpotlightCallout
          stepIndex={stepIndex}
          stepCount={steps.length}
          body={t(
            language,
            phaseError ? "walk.verifyFailed"
              : paceState.phase === "verify" ? "walk.checking"
              : step.instructionKey,
          )}
          error={phaseError}
          top={top}
          counterKey="walk.stepCounter"
          labelKey="walk.meiLabel"
          onHeight={setCalloutHeight}
        >
          <button onClick={onExit} className="text-xs text-muted-foreground font-medium px-2 py-1.5">
            {t(language, "walk.exit")}
          </button>
          {/* Pace controls exist ONLY on autonomous steps — never on waitFor
              steps (the consent taps must stay entirely user-performed), and
              they only shorten dwell/animation, never perform the action. */}
          {autonomous && !phaseError && (
            <>
              <div className="flex-1" />
              {paceState.phase === "reveal" && (
                <button
                  onClick={() => paceRef.current?.requestReplay()}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-border bg-card text-sm font-semibold text-foreground"
                >
                  {t(language, "walk.replay")}
                </button>
              )}
              <button
                disabled={!paceState.canAdvance}
                onClick={() => paceRef.current?.requestNext()}
                className="min-h-[44px] px-5 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-40"
              >
                {t(language, "walk.next")}
              </button>
            </>
          )}
        </SpotlightCallout>
      )}
    </div>
  );
}
