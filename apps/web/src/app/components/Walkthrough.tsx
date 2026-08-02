import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";
import { onWalkthroughEvent, WALK_PHASE_EVENT } from "../lib/walkthrough/bus";
import { runActStep } from "../lib/walkthrough/orchestrate";
import { createPaceController } from "../lib/walkthrough/pace";
import { calloutTop } from "../lib/walkthrough/placement";
import { SpotlightCallout } from "./SpotlightCallout";
import { WalkthroughReview } from "./WalkthroughReview";
import { WalkthroughWaitPill } from "./WalkthroughWaitPill";
import type { PaceController, PacePhaseState } from "../lib/walkthrough/pace";
import type { RevealDirective, VerifyDirective, WalkthroughScreen, WalkthroughStep } from "../lib/walkthrough/types";

interface Rect { top: number; left: number; width: number; height: number }

// How long to keep looking for a step's spotlight target before admitting we
// can't find it. Matches lib/walkthrough/actor.ts's waitForEl budget on purpose.
const MEASURE_TIMEOUT_MS = 4000;
// How often to re-query a waitFor step's DOM anchor while it's still absent.
const WAITFOR_POLL_MS = 120;

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
 * NO LONGER auto-advance: Mei performs the action at the PACING minimums
 * (lib/walkthrough/pacing.ts via their step's PaceController) and then the step
 * HOLDS until the person taps Next. Within a phase, a Next after that phase's
 * minimum still shortens dwell/animation — but it never performs or fakes the
 * step's action, and a running Verify always waits for its real result.
 *
 * The callout is rendered unconditionally. It hosts Exit, so anything that
 * gates it (a target that never measures) would strand the user with no way
 * out — the defect this overlay was rewritten to make impossible.
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
  // A SECOND cutout, opened when the person taps "Change" on the review card.
  // Without it they'd be retyping into a field sitting under the dark mask
  // (taps reach it — the overlay is pointer-events-none — but you can't read
  // what you're typing). The mask already does exactly this for navRect.
  const [changeRect, setChangeRect] = useState<Rect | null>(null);
  const [containerHeight, setContainerHeight] = useState(0);
  const [phaseError, setPhaseError] = useState(false);
  // The step's target could not be found at all (or its completion signal never
  // arrived). Surfaced as honest copy in the callout instead of the old silent
  // black screen — see the render note on why the callout is now unconditional.
  const [stalled, setStalled] = useState<null | "target" | "timeout">(null);
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
  // The commit button on the final step finishes the walkthrough, so it reads
  // "Done" rather than promising a next step that doesn't exist.
  const isLastStep = stepIndex === steps.length - 1;

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
    setChangeRect(null);
    setStalled(null);
    const startedAt = Date.now();
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

    // Retry on a TIME budget, not a frame count. The old 40-frame cap was ~667ms
    // at 60fps, which loses the race against any target behind an async fetch
    // (the caregiver-link accept button) or a screen that mounts slowly — and
    // the actor's own waitForEl polls for 4000ms, so Mei could successfully
    // drive an element the spotlight had already given up on. Same budget now,
    // so the two can't disagree.
    const measure = () => {
      if (disposed) return;
      if (recompute(true)) return;
      if (Date.now() - startedAt < MEASURE_TIMEOUT_MS) {
        raf = requestAnimationFrame(measure);
      } else {
        setStalled(prev => prev ?? "target");
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
      if (cancelled) return;
      if (outcome === "verify-failed") {
        setPhaseError(true);
        if (step.verify) onVerifyFailed?.(step.verify);
      } else if (outcome === "act-failed") {
        // Mei could not perform this step's action at all. Say so and stop —
        // advancing anyway is what used to make a tour appear to "guide halfway
        // and then do the wrong thing".
        console.error(`[dosewise] walkthrough step "${step.id}" could not act on ${step.act?.selector}`);
        setStalled(prev => prev ?? "target");
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
    // Seed from the controller's CURRENT state before subscribing. An act-less
    // verify tail (the "did it really save?" step) reaches paced("verify")
    // SYNCHRONOUSLY inside the driver effect above — which runs before this one
    // — so its broadcast lands with no listener attached, and the callout sat on
    // the step's own copy for the whole check instead of saying "Checking…".
    const current = paceRef.current?.state();
    if (current) setPaceState(current);
    return onWalkthroughEvent(WALK_PHASE_EVENT, detail => {
      setPaceState(detail as PacePhaseState);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  // The one thing that must never regress: detect the step's completion
  // condition without ever triggering it ourselves. Skipped for autonomous
  // `act` steps (handled above) and any step without a waitFor.
  //
  // The DOM branch POLLS until its anchor exists. It used to bail on a single
  // `if (!el) return`, and the old comment claimed the `rect` dependency
  // re-armed it — it didn't, because `rect` only changes on a SUCCESSFUL
  // measure, so a target that mounted late (anything behind a Supabase fetch)
  // was never listened to and the step hung forever with no way to satisfy it.
  useEffect(() => {
    const waitFor = step.waitFor;
    if (step.act || !waitFor) return;

    // `timeoutMs` was declared on WalkthroughStep but read by NOTHING — and it
    // is set on exactly the two steps most likely to never fire (the QR-camera
    // decode, the agent-action commit). Honour it: on expiry stop pretending
    // we're still waiting, and say so, so the person can retry or Exit.
    const armTimeout = (): ReturnType<typeof setTimeout> | null =>
      step.timeoutMs
        ? setTimeout(() => setStalled(prev => prev ?? "timeout"), step.timeoutMs)
        : null;

    if (waitFor.source === "dom") {
      const selector = "selector" in waitFor && waitFor.selector ? waitFor.selector : step.selector;
      const advance = () => onAdvance();
      let detach: (() => void) | null = null;
      let poll: ReturnType<typeof setInterval> | null = null;
      let deadline: ReturnType<typeof setTimeout> | null = null;

      const attach = (): boolean => {
        const el = document.querySelector(selector);
        if (!el) return false;

        if (waitFor.type === "click" || waitFor.type === "acknowledge") {
          el.addEventListener("click", advance, { once: true });
          detach = () => el.removeEventListener("click", advance);
          return true;
        }
        if (waitFor.type === "input") {
          // Tolerate a selector pointing at a WRAPPER rather than the control
          // itself: `.value` on a <div> is undefined, which used to make the
          // check silently unsatisfiable (the text-size slider step). The event
          // still bubbles from the inner control, so read the value from there.
          const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
            ? el
            : el.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
          if (!field) return false;
          const check = () => {
            const value = field.value ?? "";
            if (waitFor.validate === "nonEmpty" || !waitFor.validate) {
              if (value.trim().length > 0) advance();
            } else if (new RegExp(waitFor.validate.pattern).test(value.trim())) {
              advance();
            }
          };
          el.addEventListener(waitFor.on, check);
          detach = () => el.removeEventListener(waitFor.on, check);
          return true;
        }
        if (waitFor.type === "select-change") {
          el.addEventListener("change", advance, { once: true });
          detach = () => el.removeEventListener("change", advance);
          return true;
        }
        if (waitFor.type === "toggle") {
          const observer = new MutationObserver(() => {
            const pressed = el.getAttribute("aria-pressed") === "true";
            if (waitFor.expected === undefined || pressed === waitFor.expected) advance();
          });
          observer.observe(el, { attributes: true, attributeFilter: ["aria-pressed"] });
          detach = () => observer.disconnect();
          return true;
        }
        return false;
      };

      if (!attach()) {
        poll = setInterval(() => {
          if (attach() && poll) {
            clearInterval(poll);
            poll = null;
          }
        }, WAITFOR_POLL_MS);
      }
      deadline = armTimeout();

      return () => {
        if (poll) clearInterval(poll);
        if (deadline) clearTimeout(deadline);
        detach?.();
      };
    }
    // Bus-backed waits. These attach regardless of the DOM, so they never need
    // the poll above — but they DO need the timeout, since a signal that never
    // arrives is exactly how these steps hang.
    let off: () => void;
    if (waitFor.type === "agent-action-committed") {
      // Fixed bus event name; the host emits it once per turn with the tool
      // names Hermes's committed_actions actually contains (never tools_used/
      // actions alone — CONTEXT.md's propose-vs-commit distinction).
      off = onWalkthroughEvent("agent-action-committed", detail => {
        if ((detail as { tools: string[] } | undefined)?.tools.includes(waitFor.tool)) onAdvance();
      });
    } else if (waitFor.type === "step-transition") {
      // Several steps can share one emitted event name (e.g. the wizard's
      // "wizard-step-changed" fires from every Continue button) — only the
      // transition this specific step is waiting for should satisfy it.
      off = onWalkthroughEvent(waitFor.event, detail => {
        if ((detail as { toStep?: string } | undefined)?.toStep === waitFor.toStep) onAdvance();
      });
    } else {
      // app-event: value-change, automatic-detection, write-committed — all
      // emitted explicitly by instrumented app code via lib/walkthrough/bus.ts,
      // only when the real thing actually happened (never on the triggering
      // click alone).
      off = onWalkthroughEvent(waitFor.event, () => onAdvance());
    }
    const busDeadline = armTimeout();
    return () => {
      off();
      if (busDeadline) clearTimeout(busDeadline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);


  const top = calloutTop(rect, containerHeight, calloutHeight);

  // "Change" on the review card: put the caret in the first reviewed field and
  // cut a hole in the mask over it. It SAVES NOTHING — the step's waitFor stays
  // bound to the real Save button, so no amount of editing can commit anything.
  const focusFirstReviewField = () => {
    const first = step.review?.[0];
    if (!first) return;
    const el = document.querySelector<HTMLInputElement>(first.selector);
    const parent = rootRef.current?.parentElement;
    if (!el || !parent) return;
    el.scrollIntoView({ block: "center" });
    el.focus();
    el.setSelectionRange?.(el.value.length, el.value.length);
    const p = parent.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setChangeRect({ top: r.top - p.top, left: r.left - p.left, width: r.width, height: r.height });
  };

  return (
    // Click-through by default so a REAL user tap reaches the spotlighted element
    // beneath (the consent flows and every highlight-only waitFor step depend on
    // this; the autonomous actor uses programmatic .click() and is unaffected).
    // The callout re-enables pointer events so Exit stays tappable.
    <div ref={rootRef} className="absolute inset-0 z-[200] pointer-events-none">
      {/* Unmeasured target: dim, but far more lightly than a spotlit step. A
          full bg-black/75 over a screen with no cutout and (previously) no
          callout was the "black screen with no way out" the whole engine fix
          exists to remove — the card below now always renders on top of it. */}
      {!rect && <div className="absolute inset-0 bg-black/40" />}
      {rect && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ transition: "opacity 200ms" }}>
          <defs>
            <mask id="walkthrough-cutout">
              <rect x="0" y="0" width="100%" height="100%" fill="white" />
              <rect x={rect.left - 6} y={rect.top - 6} width={rect.width + 12} height={rect.height + 12} rx="16" fill="black" />
              {navRect && (
                <rect x={navRect.left - 4} y={navRect.top - 4} width={navRect.width + 8} height={navRect.height + 8} rx="16" fill="black" />
              )}
              {changeRect && (
                <rect x={changeRect.left - 6} y={changeRect.top - 6} width={changeRect.width + 12} height={changeRect.height + 12} rx="12" fill="black" />
              )}
            </mask>
          </defs>
          <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.75)" mask="url(#walkthrough-cutout)" />
        </svg>
      )}

      {/* ALWAYS rendered — never gated on the spotlight having been measured.
          This card is the only host of the Exit button, so gating it on `rect`
          meant that any step whose target was missing, renamed, or slow to
          mount left the person on an opaque scrim with no instruction and no
          way out but a page reload. GuidedTour.tsx already renders its callout
          unconditionally for exactly this reason; this is that decision,
          applied to the surface where it mattered more. */}
      <SpotlightCallout
        stepIndex={stepIndex}
        stepCount={steps.length}
        body={t(
          language,
          phaseError ? "walk.verifyFailed"
            : stalled === "timeout" ? "walk.timedOut"
            : stalled === "target" ? "walk.cannotFind"
            : paceState.phase === "verify" ? "walk.checking"
            // Name the button that is actually on screen. "Tap Next" under a
            // button reading "Done" is the kind of small mismatch that makes
            // someone hesitate at precisely the moment they must act.
            : paceState.phase === "ready" ? (isLastStep ? "walk.readyLast" : "walk.ready")
            : step.instructionKey,
        )}
        error={phaseError || stalled !== null}
        top={top}
        counterKey="walk.stepCounter"
        labelKey="walk.meiLabel"
        onHeight={setCalloutHeight}
        // NOTE: rendered outside the `autonomous` block below on purpose. The
        // step that carries `review` is the manual-Save confirm step, which is
        // a waitFor step — so `autonomous` is false for it and gating the card
        // on autonomy would mean it never appears at all.
        panel={
          step.review && !phaseError && stalled === null
            ? <WalkthroughReview fields={step.review} onChange={focusFirstReviewField} />
            : undefined
        }
      >
          <button
            onClick={onExit}
            aria-label={t(language, "walk.exit")}
            className="min-h-[44px] px-4 py-2 rounded-xl border border-border bg-card text-sm font-semibold text-muted-foreground dw-press"
          >
            {t(language, "walk.exit")}
          </button>
          {/* Pace controls exist ONLY on autonomous steps — never on waitFor
              steps (the consent taps must stay entirely user-performed). Next
              now COMMITS the step (nothing advances on its own); during a phase
              it still only shortens dwell/animation and never performs the
              action. */}
          {/* User-driven step: same action-row slot, but a non-interactive
              indicator naming the real control. Consent taps stay the user's
              own — this only tells them what the app is waiting for, which the
              empty row never did. Not shown on the stalled states: their copy
              already says Mei couldn't find the thing. */}
          {!autonomous && !phaseError && stalled === null && (
            <>
              <div className="flex-1" />
              <WalkthroughWaitPill step={step} />
            </>
          )}
          {autonomous && !phaseError && stalled === null && (
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
              {/* At the commit gate this button is the ONLY way forward, so its
                  arrival gets a one-shot beat + a resting ring (theme.css's
                  .dw-gate-ready). Enabled-but-otherwise-identical was too quiet
                  a signal for "your turn now", and a step sitting silently at
                  the gate is exactly what reads as the walkthrough being stuck.
                  Keyed on the phase so re-entering `ready` replays the beat. */}
              <button
                key={paceState.phase === "ready" ? "gate" : "phase"}
                disabled={!paceState.canAdvance}
                onClick={() => paceRef.current?.requestNext()}
                className={`min-h-[44px] px-5 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-40 dw-press inline-flex items-center gap-1.5 ${paceState.phase === "ready" ? "dw-gate-ready" : ""}`}
              >
                {t(language, isLastStep ? "walk.done" : "walk.next")}
                {paceState.phase === "ready" && <ChevronRight size={16} strokeWidth={3} className="shrink-0" />}
              </button>
            </>
          )}
      </SpotlightCallout>
    </div>
  );
}
