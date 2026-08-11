import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FastForward } from "lucide-react";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";
import { onWalkthroughEvent, WALK_PHASE_EVENT } from "../lib/walkthrough/bus";
import { canGoBack, computeHoldGate } from "../lib/walkthrough/gating";
import { runActStep } from "../lib/walkthrough/orchestrate";
import { createPaceController } from "../lib/walkthrough/pace";
import { calloutPlacement, targetLiftPx } from "../lib/walkthrough/placement";
import { IDLE_TIMEOUT_MS, PACING } from "../lib/walkthrough/pacing";
import { SpotlightCallout } from "./SpotlightCallout";
import { WalkthroughIdlePrompt } from "./WalkthroughIdlePrompt";
import { WalkthroughReview, readValues } from "./WalkthroughReview";
import type { PaceController, PacePhaseState } from "../lib/walkthrough/pace";
import type { ReviewField, RevealDirective, VerifyDirective, WalkthroughScreen, WalkthroughStep } from "../lib/walkthrough/types";
import type { WalkthroughRisk } from "../lib/hermes";

interface Rect { top: number; left: number; width: number; height: number }

// How long to keep looking for a step's spotlight target before admitting we
// can't find it. Matches lib/walkthrough/actor.ts's waitForEl budget on purpose.
const MEASURE_TIMEOUT_MS = 4000;
// How often to re-query a waitFor step's DOM anchor while it's still absent.
const WAITFOR_POLL_MS = 120;

// Confirm phase (decision B, Item 5) — the live-DOM half of "a blank field
// forces the tap path". Passed into orchestrate.ts as PhaseHandlers.
// hasBlankReviewField (keeping that file DOM-free/unit-testable) and reused
// here for the SAME decision when deciding what the action row shows —
// one function, two call sites, so they can never disagree.
const hasBlankReviewField = (fields: ReviewField[]): boolean => readValues(fields).some(v => !v);

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
  onBack,
  onExit,
  onVerify,
  onReveal,
  onVerifyFailed,
  risk,
  requireExplicitAdvance = true,
  autoNavDefault = true,
  onTalkToMei,
}: {
  steps: WalkthroughStep[];
  stepIndex: number;
  currentScreen: WalkthroughScreen;
  onNavigate: (screen: WalkthroughScreen) => void;
  onAdvance: () => void; // called once this step's real waitFor condition fires
  // Step back one, for when something went wrong on the step just finished.
  // Only ever called when lib/walkthrough/gating.ts's canGoBack allows it —
  // never across a committed write, and never back into a click act that would
  // re-fire on re-entry. Absent for hosts that haven't wired it (the button
  // then just doesn't render, mirroring onTalkToMei below).
  onBack?: () => void;
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
  // The RiskClassifier's result for THIS walkthrough instance (services/hermes
  // tools/risk.py, threaded from the Hermes /agent/turn response). Per-
  // instance, not baked into the step file, and only read by the Confirm
  // phase (decision B): risk.flagged forces an explicit tap there regardless
  // of trust level. Undefined for spotlight-only walkthroughs and any dev/e2e
  // launch that bypassed a real Hermes turn (no risk assessment ran).
  risk?: WalkthroughRisk | null;
  // TrustMode (Item 2, decision C): computed by the host from
  // AccessibilitySettings (`walkthroughManualMode ||
  // walkthroughCompletionCount < TRUST_MODE_THRESHOLD`, lib/walkthrough/
  // pacing.ts) — this file stays ignorant of WHERE the signal comes from,
  // only what to do with it (mirrors the `risk` prop above). Defaults to
  // `true` (today's always-tap-gated behaviour) so any caller that hasn't
  // been threaded yet — Walkthrough.test.tsx has none of the accessibility
  // context — keeps the safe, unconditional gate rather than silently
  // auto-advancing.
  requireExplicitAdvance?: boolean;
  // AutoNav: the STARTING position of the callout's Auto/Step-by-step switch,
  // which the person can then flip for this walkthrough only. Auto is the
  // default — someone watching Mei work shouldn't have to tap Next after
  // every step she completes — so hosts pass `!walkthroughManualMode`: the
  // persistent "always guide me step by step" setting still decides where the
  // switch starts, nothing else does. Same "this file doesn't know where the
  // signal comes from" treatment as requireExplicitAdvance above.
  autoNavDefault?: boolean;
  // IdleTimeout (Item 6): "Talk to Mei" hands off to the chat surface — host-
  // owned (exit the walkthrough + navigate to chat) since this file has no
  // notion of screens/tabs beyond WalkthroughScreen. Absent for any host that
  // hasn't wired a handoff (e.g. tests): the button just doesn't render.
  onTalkToMei?: () => void;
}) {
  const { language } = useLanguage();
  const [rect, setRect] = useState<Rect | null>(null);
  const [navRect, setNavRect] = useState<Rect | null>(null);
  // A SECOND cutout, opened when the person taps "Change" on the review card.
  // Without it they'd be retyping into a field sitting under the dark mask
  // (taps reach it — the overlay is pointer-events-none — but you can't read
  // what you're typing). The mask already does exactly this for navRect.
  //
  // Stored as a SELECTOR, measured by the same per-frame recompute() that keeps
  // rect/navRect glued. It used to be a one-shot rect captured at the moment of
  // the Change tap and never re-measured — but tapping Change is precisely what
  // reflows the sheet (the review card grows, the field moves), so the hole was
  // left behind on the very interaction that opened it.
  const [changeRect, setChangeRect] = useState<Rect | null>(null);
  const changeSelRef = useRef<string | null>(null);
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
  // Bottom-of-viewport target repositioning (see the effect below): which real
  // DOM element (if any) currently carries the lift transform, so it can be
  // reset the moment the step changes.
  const liftedElRef = useRef<HTMLElement | null>(null);
  // Confirm phase (decision B): which of THIS step's review fields currently
  // read blank (fed live by WalkthroughReview's own poll — see its
  // onBlankChange) and whether the phase this step just entered needed an
  // explicit tap at all. The latter is a ref, not state: it's read by the
  // render below but decided once, synchronously, at the same moment
  // orchestrate.ts makes the SAME decision (the effect further down) — a
  // state write there would lag a render behind.
  const [blankFields, setBlankFields] = useState<ReviewField[]>([]);
  const confirmTapRequiredRef = useRef(false);
  // Whether the CURRENT step's terminal "ready" gate is a real tap-wait, as
  // decided when the step started. Read only by the "turning Auto on releases
  // the gate" effect, so it can tell a gate that is genuinely waiting for a tap
  // from one that is already auto-elapsing on READY_AUTO_MS.
  const readyIsTapGatedRef = useRef(false);
  // AutoNav: per-walkthrough-session, deliberately NOT persisted — the ask was
  // "turn it on or off in different walkthrough sessions", and this component
  // mounts once per walkthrough, so plain state IS that scope. Auto means the
  // terminal "tap Next to continue" gates auto-continue; it never touches a
  // waitFor step, so the real Save and consent taps stay the person's own in
  // both modes.
  const [autoNav, setAutoNav] = useState(autoNavDefault);
  // What the orchestrator (and the Confirm decision below) actually sees.
  // Switching Auto OFF restores the tap gates even for a veteran whose
  // trust-derived requireExplicitAdvance is false — an explicit choice has to
  // beat an inferred one, in the direction of MORE care.
  const tapGated = !autoNav || requireExplicitAdvance;
  const step = steps[stepIndex];
  // Autonomous = Mei acts (or an act-less verify/reveal/confirm tail step).
  // waitFor steps are user-driven and never get pace controls.
  const autonomous = !!(step.act || (!step.waitFor && (step.verify || step.reveal || step.confirm)));
  // The commit button on the final step finishes the walkthrough, so it reads
  // "Done" rather than promising a next step that doesn't exist.
  const isLastStep = stepIndex === steps.length - 1;

  // Confirm phase (decision B): blocked while ANY field reads blank — the
  // clarifying question replaces the plain gate button, and (per decision B)
  // a blank field forces this regardless of trust/risk, so
  // `confirmTapRequiredRef` is true whenever this is. Computed here (not
  // inline at its render site below) so IdleTimeout's `waitingOnUser` and the
  // render-time gate share the SAME value.
  const confirmBlocked = paceState.phase === "confirm" && blankFields.length > 0;

  // IdleTimeout (Item 6, decision D): true exactly while the CURRENT state is
  // a genuine wait for a real user action — never a hardcoded phase-name
  // allowlist, since whether "ready"/"confirm" are real waits at all depends
  // on TrustMode's requireExplicitAdvance for THIS user. Four cases,
  // matching the plan's own four bullets (the 4th is a subset of the 3rd,
  // kept as its own clause so a future change to confirmTapRequiredRef's
  // logic can't silently stop covering it):
  //   1. a waitFor-typed step — ALWAYS a real wait (Submit/consent taps):
  //      only a real user action on the real target can ever satisfy it.
  //   2. the terminal "ready" gate, while Auto navigation is OFF and it is
  //      not the LAST step — an auto-elapsing "ready" (READY_AUTO_MS) is not
  //      a wait at all, and neither is the final step's timed
  //      FINAL_AUTOCLOSE_MS window (the run ends by itself there, so the
  //      idle popup must never arm on it).
  //   3. the Confirm phase, but only when IT is tap-gated (risk-flagged,
  //      requireExplicitAdvance, or a blank review field) — the auto-
  //      elapsing recap a trusted, low-risk user gets (CONFIRM_MIN_MS) is
  //      not a wait either.
  //   4. the blocked clarifying question specifically (confirmBlocked).
  // Excluded whenever the step is stalled/errored: the callout is already
  // showing "couldn't find it" / "timed out" / "couldn't verify" — a SECOND
  // popup on top of that is confusing, and (per Skip's own safety comment
  // below) offering a bypass there would be actively dangerous, not helpful.
  const waitingOnUser = !phaseError && stalled === null && (
    !!step.waitFor ||
    (paceState.phase === "ready" && !autoNav && !isLastStep) ||
    (paceState.phase === "confirm" && confirmTapRequiredRef.current) ||
    confirmBlocked
  );

  // Enter the step: ask the host to navigate first (mirrors GuidedTour's
  // onEnter — this component never owns the Screen/ElderlyTab state itself).
  useEffect(() => {
    if (step.onEnter) onNavigate(step.onEnter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  // Let the callout LAND on a new step rather than gliding to it. Its
  // `transition-[top] duration-300` is right within a step (following a target
  // that is itself moving) and wrong across one: the cutout jumps to the new
  // target next frame while the card is still travelling, and for that window
  // it can sit across the thing it is describing. Measured live at 33-186ms per
  // step change on add_prescription_auto. Two frames, not one: the first
  // commits the new `top` with no transition declared, the second re-enables
  // it, so a within-step move still glides.
  const [animateTop, setAnimateTop] = useState(false);
  useEffect(() => {
    setAnimateTop(false);
    let inner = 0;
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setAnimateTop(true)); });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
  }, [stepIndex]);

  // Replay press acknowledgement. A press during the reveal's uncuttable
  // floor is registered but produces nothing visible until the floor elapses
  // (up to REVEAL_PULSE_MS) — this styles the button as "queued" until the
  // re-run's own paced() re-entry publishes canAdvance true→false, i.e. the
  // moment the replay actually starts.
  const [replayQueued, setReplayQueued] = useState(false);
  const prevCanAdvanceRef = useRef(paceState.canAdvance);
  useEffect(() => {
    const prev = prevCanAdvanceRef.current;
    prevCanAdvanceRef.current = paceState.canAdvance;
    if (replayQueued && prev && !paceState.canAdvance) setReplayQueued(false);
  }, [paceState.canAdvance, replayQueued]);
  useEffect(() => setReplayQueued(false), [stepIndex]);

  // Measure + spotlight the target, retrying a few frames in case the screen
  // this step needs hasn't finished mounting yet. Then keep the cutout GLUED to
  // the target while the screen scrolls WITHIN a step (e.g. the save→verify→
  // reveal scroll) — recompute on scroll/resize WITHOUT re-scrolling, so we don't
  // fight the programmatic scroll and the cutout never lags onto the wrong row.
  useEffect(() => {
    setRect(null);
    setNavRect(null);
    setChangeRect(null);
    changeSelRef.current = null;
    setStalled(null);
    const startedAt = Date.now();
    let raf = 0;
    let tick = 0;
    let watchRaf = 0;
    let disposed = false;
    // Last values actually pushed to state, so the per-frame watcher below can
    // re-measure continuously while only re-rendering when something MOVED.
    let lastRect: Rect | null = null;
    let lastNavRect: Rect | null = null;
    let lastChangeRect: Rect | null = null;
    let lastContainerHeight = 0;
    const sameBox = (a: Rect | null, b: Rect) =>
      !!a && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5
      && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

    const recompute = (doScroll: boolean): boolean => {
      // Measure THIS element's own box, not its parentElement's — see
      // GuidedTour's measure() for why: the parent's border (e.g. the desktop
      // phone-bezel frame) sits outside position:absolute's containing block,
      // so getBoundingClientRect() on the parent over-reports by the border
      // width. This element is already position:absolute; inset:0 in that
      // same parent, so its own rect IS the correct (0,0) origin.
      const targetEl = document.querySelector(step.selector);
      if (!rootRef.current || !targetEl) return false;
      // origin is measured AFTER the scroll, not before: scrollIntoView can
      // move an ancestor shared with the overlay root itself (not just an
      // inner list), which shifts origin too — reading it beforehand mixes
      // two different scroll positions into one offset and throws the cutout
      // off by exactly that scroll delta. See GuidedTour's measure() for the
      // same fix.
      if (doScroll) targetEl.scrollIntoView({ block: "center" });
      const origin = rootRef.current.getBoundingClientRect();
      const r = targetEl.getBoundingClientRect();
      const next = { top: r.top - origin.top, left: r.left - origin.left, width: r.width, height: r.height };
      // Only push state when the box actually changed — this runs every frame
      // (see the watcher below), and an unconditional setState would re-render
      // the overlay 60 times a second for the whole step.
      if (!sameBox(lastRect, next)) {
        lastRect = next;
        setRect(next);
      }
      if (Math.abs(lastContainerHeight - origin.height) >= 0.5) {
        lastContainerHeight = origin.height;
        setContainerHeight(origin.height);
      }
      const navEl = step.navSelector ? document.querySelector(step.navSelector) : null;
      if (navEl) {
        const n = navEl.getBoundingClientRect();
        const nextNav = { top: n.top - origin.top, left: n.left - origin.left, width: n.width, height: n.height };
        if (!sameBox(lastNavRect, nextNav)) {
          lastNavRect = nextNav;
          setNavRect(nextNav);
        }
      }
      // The "Change" hole, once one has been opened, tracked on the same terms
      // as the two above. Read from a ref rather than a dep so opening it never
      // re-runs this effect (which would re-scroll and restart the 4s budget).
      const changeEl = changeSelRef.current ? document.querySelector(changeSelRef.current) : null;
      if (changeEl) {
        const c = changeEl.getBoundingClientRect();
        const nextChange = { top: c.top - origin.top, left: c.left - origin.left, width: c.width, height: c.height };
        if (!sameBox(lastChangeRect, nextChange)) {
          lastChangeRect = nextChange;
          setChangeRect(nextChange);
        }
      } else if (lastChangeRect) {
        lastChangeRect = null;
        setChangeRect(null);
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
      if (recompute(true)) {
        watch(); // found it — from here on, stay glued to it
        return;
      }
      if (Date.now() - startedAt < MEASURE_TIMEOUT_MS) {
        raf = requestAnimationFrame(measure);
      } else {
        setStalled(prev => prev ?? "target");
      }
    };

    // Keep the cutout on the target for the WHOLE step, not just across
    // scrolls. The target genuinely moves and resizes mid-step and none of it
    // fires scroll or resize: actor.ts's .walk-field-prehighlight translates it
    // -3px around every fill/click (theme.css, `both` fill holds the risen end
    // state), the lift effect below animates it up to ~330px, and containers
    // expand/collapse underneath it. Measured live before this existed: every
    // field step's cutout sat 3px off its field, an expanding profile section
    // left an 84px-too-tall hole, and the step after a lifted one was ~300px
    // out. Enumerating the movers (a MutationObserver per class/style, a
    // transitionend per element) kept missing cases — notably the lift, which
    // transforms an ANCESTOR ([data-walk] group), so neither an attribute
    // observer nor a bubbling listener on the target itself ever sees it. A
    // rect diff makes "glued" true by construction instead: one
    // getBoundingClientRect on one element per frame, and recompute() above
    // only re-renders when the box actually moved.
    const watch = () => {
      if (disposed) return;
      recompute(false);
      watchRaf = requestAnimationFrame(watch);
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
      cancelAnimationFrame(watchRaf);
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  // New step: undo any lift transform the previous one left on the DOM (a
  // stale translateY would otherwise leave that field permanently shifted
  // after the walkthrough has moved past it).
  useEffect(() => {
    return () => {
      if (liftedElRef.current) {
        // Clear the TRANSITION first, then the transform. The other order
        // leaves `transform 320ms` still declared at the moment the transform
        // is removed, so the element ANIMATES ~330px back down — and the next
        // step's first measurement (a requestAnimationFrame away) lands
        // mid-flight, stranding that step's cutout where the lifted element
        // used to be. Measured live on the Save step of edit_profile_auto and
        // travel_mode_auto: the highlight was drawn 292px / 329px above the
        // Save button the callout was telling the person to tap.
        liftedElRef.current.style.transition = "";
        liftedElRef.current.style.transform = "";
        liftedElRef.current = null;
      }
    };
  }, [stepIndex]);

  // Deliberately NO separate "reset blankFields on stepIndex change" effect
  // here. React fires a CHILD's effects (WalkthroughReview's own, below)
  // before the ENCLOSING component's — so a reset declared as one of
  // Walkthrough's own top-level effects would run AFTER WalkthroughReview's
  // fresh onBlankChange report for the very step it's meant to describe,
  // clobbering it back to empty on every single step entry. Safe without one:
  // `confirmBlocked` below is ALSO gated on `paceState.phase === "confirm"`,
  // which the driver effect already resets to null synchronously on every
  // step change — so stale blankFields from an earlier step can never surface
  // as a clarifying question on a step that isn't itself a blocked Confirm.

  // Bottom-of-viewport TARGET repositioning (placement.ts::targetLiftPx —
  // calloutTop only ever repositions the CALLOUT).
  //
  // This used to be decided exactly ONCE per step, because re-deriving it from
  // a LATER (already-lifted) rect would see the room the lift just freed up
  // and immediately undo it, oscillating forever. But a one-shot loses the
  // moment the layout moves AFTERWARDS: on the Confirm step the review card
  // renders and reflows the sheet, so a target lifted to the top of the band
  // slid ~320px back down and ended up underneath the very callout the lift
  // existed to clear (measured live: callout 295-722, target 421-472).
  //
  // So it re-derives, but from the UN-LIFTED position rather than the current
  // one — which is what makes it stable instead of oscillating. The un-lifted
  // top is recovered exactly by subtracting the transform the browser is
  // CURRENTLY RENDERING (not the value we asked for), so it stays constant
  // even mid-transition: as the element animates up, `rect.top` falls by the
  // same amount the rendered translate grows. Identical input ⇒ identical
  // `targetLiftPx` ⇒ no write ⇒ no oscillation. Only a real layout shift
  // underneath the target changes the answer, which is exactly when the lift
  // should be corrected.
  useEffect(() => {
    if (!rect || !containerHeight) return;
    const targetEl = document.querySelector<HTMLElement>(step.selector);
    // Lift the nearest [data-walk] field group rather than just the bare
    // control, so a field's own <label> ("caption") moves WITH it instead of
    // staying behind while the input scoots up on its own.
    const liftEl = targetEl?.closest<HTMLElement>("[data-walk]") ?? targetEl;
    if (!liftEl) return;
    const renderedLift = -new DOMMatrixReadOnly(getComputedStyle(liftEl).transform).m42;
    const unlifted = { ...rect, top: rect.top + renderedLift };
    const wanted = targetLiftPx(unlifted, containerHeight, calloutHeight);
    // 1px of slack: sub-pixel layout jitter must not restart the transition.
    if (Math.abs(wanted - renderedLift) <= 1) return;
    if (wanted <= 0) {
      // Nothing to clear any more — put it back rather than leaving a stale
      // offset behind (transition first, then transform: see the step-change
      // cleanup for why that order matters).
      if (liftedElRef.current === liftEl) {
        liftEl.style.transition = "";
        liftEl.style.transform = "";
        liftedElRef.current = null;
      }
      return;
    }
    liftedElRef.current = liftEl;
    liftEl.style.transition = `transform ${PACING.TARGET_LIFT_MS}ms ease-out`;
    liftEl.style.transform = `translateY(-${wanted}px)`;
    // No bespoke tracking loop here any more: the measure effect's own
    // per-frame rect watcher already keeps the cutout on the target through
    // this transition (and through everything else that moves it). The loop
    // that used to live here covered only TARGET_LIFT_MS and stopped a frame
    // or two early, leaving the cutout 2-7px above the settled target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, containerHeight, calloutHeight]);

  // Autonomous "act" steps (Guided Auto-Navigation): Mei performs the action
  // herself, visibly animated, then the step auto-advances — no user action.
  // Only runs for steps that declare `act`; highlight-only steps keep their
  // waitFor below. Guarded to fire exactly once per step, and cancels if the
  // overlay unmounts (Exit) mid-animation so it never drives a torn-down screen.
  const actedRef = useRef(false);
  // A step that ERRORED or STALLED must stop its own driver, not merely paint
  // an error over one that keeps running: the measure effect (which raises
  // `stalled`) and the driver effect below are independent, so a stalled FINAL
  // step would otherwise sail through its timed FINAL_AUTOCLOSE_MS gate, call
  // onAdvance, and record a completion — TrustMode credit for a run that
  // failed, contradicting the errored-Done rule further down. Read through a
  // ref because runActStep holds ONE closure for the whole step.
  // Only ever RAISES the flag; the driver effect below clears it per step (it
  // runs after this one in the same commit, so a step change can't leave the
  // previous step's failure latched).
  const failedRef = useRef(false);
  useEffect(() => {
    if (phaseError || stalled !== null) failedRef.current = true;
  }, [phaseError, stalled]);
  useEffect(() => {
    actedRef.current = false;
    failedRef.current = false;
    setPhaseError(false);
    setPaceState({ phase: null, canAdvance: false });
    // Autonomous path: an `act` step, OR an act-less step that carries
    // verify/reveal/confirm and is NOT user-driven (no waitFor) — e.g. the
    // caregiver-link flow's post-consent verify step, or the new Confirm
    // recap step. Plain highlight-only steps have a waitFor and stay
    // user-driven (handled by the effect below).
    if (!autonomous) return;
    let cancelled = false;
    // One PaceController per autonomous step: it floors every phase at the
    // PACING minimums and carries the user's Next/Replay requests.
    const pace = createPaceController({ stepId: step.id });
    paceRef.current = pace;
    // A step gates (waits for a real Next tap) unless its SHAPE says it can
    // flow straight on — a field fill mid-run, or the click that opens the
    // surface the next step fills. Decided by the pure computeHoldGate
    // (lib/walkthrough/gating.ts, unit tested there); see orchestrate.ts's
    // `holdGate` for what each value does. Orthogonal to TrustMode's
    // requireExplicitAdvance below: holdGate is a STEP-SHAPE relaxation;
    // requireExplicitAdvance is a USER-HISTORY one. orchestrate.ts checks
    // holdGate first.
    //
    // `autoNav` is passed so that turning the fast-forward toggle OFF really
    // does mean a tap per step: it suppresses the collapse of a consecutive
    // field run (a convenience) while leaving the click-that-opens-a-sheet case
    // (a correctness fix — see gating.ts) alive in both modes. Read here at
    // step start for the same reason `autoAdvance` is, below.
    const holdGate = computeHoldGate(steps, stepIndex, autoNav);
    // Confirm phase gating (decision B): decided once, synchronously, right as
    // this step starts — orchestrate.ts makes the identical check itself via
    // hasBlankReviewField below (kept as an injected callback so that file
    // stays DOM-free/unit-testable); this copy only drives which action-row
    // control renders (the plain gate button vs the clarifying question) for
    // that SAME decision, so it must never diverge from what orchestrate.ts
    // actually does.
    confirmTapRequiredRef.current = !!step.confirm && (
      tapGated || !!risk?.flagged || (!!step.review && hasBlankReviewField(step.review))
    );
    // Whether this step's TERMINAL gate will be a real tap-wait — the same
    // branching orchestrate.ts's own `ready` gate takes, mirrored here for
    // the "turning Auto on releases the gate" effect further down. Recorded at
    // step start because that is when orchestrate decides it; re-deriving later
    // would not change what the running step is actually awaiting.
    // The LAST step is NOT tap-gated any more: its gate is the timed
    // FINAL_AUTOCLOSE_MS window (orchestrate.ts's isFinalStep branch), which
    // elapses on its own — releasing it early via the AutoNav toggle would
    // cut the one beat that lets someone read the finale.
    readyIsTapGatedRef.current = holdGate !== false && !isLastStep && !(autoNav || requireExplicitAdvance === false);
    void (async () => {
      // (Navigate) → Act → (Verify) → (Confirm) → (Reveal) → advance. A
      // failed Verify STOPS here and shows an error — never advances, so
      // success is never implied.
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
        shouldCancel: () => cancelled || failedRef.current,
        holdGate,
        requireExplicitAdvance: tapGated,
        // Read once, when the step starts — flipping the switch mid-step
        // applies from the NEXT step, because re-deriving it here would mean
        // re-running the driver effect, and that re-runs the step's act.
        autoAdvance: autoNav,
        riskFlagged: !!risk?.flagged,
        hasBlankReviewField,
        isFinalStep: isLastStep,
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
          // The selector can match SEVERAL controls (the wizard's gender
          // buttons, the relationship chips) and any of them satisfies the
          // step — so listen on every match. querySelector alone armed only
          // the FIRST button, and tapping any sibling left the step hanging.
          const els = Array.from(document.querySelectorAll(selector));
          els.forEach(e => e.addEventListener("click", advance, { once: true }));
          detach = () => els.forEach(e => e.removeEventListener("click", advance));
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

  // IdleTimeout (Item 6): the "still there?" popup. Armed only while
  // waitingOnUser is true; ANY interaction resets it; disarmed the moment
  // waitingOnUser goes false (including on Exit, which unmounts this
  // component and runs the same cleanup).
  const [idlePopupOpen, setIdlePopupOpen] = useState(false);
  // Read by the capture-phase window listener below. Deliberately a ref, not
  // the state value itself: using idlePopupOpen as an effect dependency would
  // tear the listeners down and rebuild them on every open/close, and — the
  // real bug this guards — a capture-phase pointerdown fires BEFORE the
  // tapped element's own onClick, so an ungated listener would dismiss the
  // popup out from under a tap on one of its own buttons, turning every
  // popup action into a no-op that just closes it.
  const idlePopupOpenRef = useRef(false);
  useEffect(() => { idlePopupOpenRef.current = idlePopupOpen; }, [idlePopupOpen]);
  // Exposes the SAME arm() the effect below owns to onClick handlers declared
  // outside it (requestNext's two call sites, focusFirstReviewField) — the
  // ask's "hook the reset there" half, on top of the generic listeners below.
  const resetIdleTimerRef = useRef<() => void>(() => {});
  const resetIdleTimer = () => resetIdleTimerRef.current();

  useEffect(() => {
    if (!waitingOnUser) {
      setIdlePopupOpen(false);
      return;
    }
    // A waitFor step's own timeoutMs (the "give up, show walk.timedOut"
    // budget) can equal IDLE_TIMEOUT_MS exactly (accept_caregiver_link's
    // consent tap, emergency_contact_tour's Call button both use 20000) —
    // two setTimeouts racing at the identical delay, with no defined winner.
    // The popup's whole point is to reach a stuck person BEFORE the honest
    // dead-end, so it must win outright, not by accident of effect-
    // registration order: fire at least 1s ahead of timeoutMs when the step
    // declares one shorter than or equal to the default.
    const delayMs = step.waitFor && step.timeoutMs
      ? Math.min(IDLE_TIMEOUT_MS, Math.max(0, step.timeoutMs - 1000))
      : IDLE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setIdlePopupOpen(true), delayMs);
    };
    resetIdleTimerRef.current = () => {
      setIdlePopupOpen(false);
      arm();
    };
    const onInteract = () => {
      if (idlePopupOpenRef.current) return; // let the popup's own buttons resolve first
      resetIdleTimerRef.current();
    };
    arm();
    // capture:true matches the existing scroll listener above (the measure
    // effect) — a real interaction can land inside a nested overflow
    // container (a scrollable form body), or on the actual spotlighted
    // target itself, which lives OUTSIDE this component's own
    // pointer-events-none subtree entirely, so window-level capture is the
    // only place that sees tap/keypress/scroll regardless of where it lands.
    window.addEventListener("pointerdown", onInteract, true);
    window.addEventListener("keydown", onInteract, true);
    window.addEventListener("scroll", onInteract, true);
    return () => {
      clearTimeout(timer);
      resetIdleTimerRef.current = () => {};
      window.removeEventListener("pointerdown", onInteract, true);
      window.removeEventListener("keydown", onInteract, true);
      window.removeEventListener("scroll", onInteract, true);
    };
  }, [waitingOnUser, stepIndex]);

  const dismissIdlePopup = () => {
    setIdlePopupOpen(false);
    resetIdleTimer();
  };

  // Turning Auto ON while the run is already parked releases the gate it is
  // parked at, instead of stranding the person until they tap Next once more.
  //
  // Three conditions, each load-bearing:
  //   - phase === "ready". That phase is the END of a step: its act has already
  //     run, so resolving it is exactly what the Next button beside it does and
  //     re-runs nothing. This is why the "flipping mid-step applies from the
  //     NEXT step" rule — which exists because re-deriving at step START
  //     re-runs the act — does not need to cover it. Deliberately NOT the
  //     Confirm phase: that gate is decided by risk, trust and blank review
  //     fields, and a nav preference must never be able to release it.
  //     `waitFor` steps never reach `ready` at all, so the real Save and
  //     consent taps are untouched.
  //   - readyIsTapGatedRef. Without it this also fires on a gate that is
  //     ALREADY auto-elapsing, cutting PACING.READY_AUTO_MS's deliberate beat
  //     to nothing on every auto run — a silent pacing regression rather than
  //     the intended "release what the person is stuck on".
  //   - the ref is cleared on release, so this can only ever fire once per gate.
  //     (The FINAL step's timed FINAL_AUTOCLOSE_MS gate is never tap-gated, so
  //     the ref alone keeps this from cutting the finale short.)
  useEffect(() => {
    if (!autoNav || paceState.phase !== "ready" || !readyIsTapGatedRef.current) return;
    readyIsTapGatedRef.current = false;
    paceRef.current?.requestNext();
  }, [autoNav, paceState.phase]);

  // "End walkthrough" from the idle popup — the same onExit the callout's own
  // Exit button uses. This is the ONLY way out offered here, and deliberately
  // so: the popup used to also carry "Skip this step" and "Explain this step
  // again", and both were removed (2026-08-07).
  //
  // Skip was the actively wrong one. It called paceRef.requestNext(), which on
  // a Confirm phase resolves that phase's gate rather than skipping the step —
  // so a button labelled "skip this step" did something else entirely. And on
  // the steps where a stuck person most wants out (a waitFor tap they can't
  // find) it was correctly absent, which meant it was missing exactly when it
  // was wanted and misleading the rest of the time. Leaving is safe on every
  // step by construction — exiting writes nothing back (see the hosts'
  // handleWalkthroughExit) — so one honest exit beats two partial ones.
  const endWalkthrough = () => {
    setIdlePopupOpen(false);
    onExit();
  };

  // Step back one. Rendered only when gating.ts's canGoBack agrees AND the host
  // wired onBack; the host owns the index, exactly as it does for onAdvance.
  const stepBack = () => {
    resetIdleTimer();
    onBack?.();
  };
  const backAvailable = !!onBack && canGoBack(steps, stepIndex);

  const talkToMei = () => {
    // Not dismissIdlePopup(): re-arming a timer immediately before the host
    // (by contract) exits/unmounts this component is pointless busywork —
    // just close the popup and hand off.
    setIdlePopupOpen(false);
    onTalkToMei?.();
  };

  const placement = calloutPlacement(rect, containerHeight, calloutHeight);
  const top = placement.top;

  // (confirmBlocked is computed above, next to waitingOnUser — see its comment.)
  // The plain "your turn" gate — shown for the terminal ready gate always, and
  // for a Confirm phase only when it actually needed a tap (never for the
  // auto-elapsing veteran fast path, where no tap was ever asked for).
  const showConfirmGate = paceState.phase === "confirm" && confirmTapRequiredRef.current && !confirmBlocked;

  // "Change" on the review card: put the caret in the field and cut a hole in
  // the mask over it. Prefers the first BLANK field (the clarifying
  // question's "Add it" path) so tapping it lands where the person actually
  // needs to type, falling back to the first reviewed field otherwise. It
  // SAVES NOTHING — the step's waitFor stays bound to the real Save button on
  // the FOLLOWING step, so no amount of editing here can commit anything.
  const focusFirstReviewField = () => {
    resetIdleTimer();
    const first = blankFields[0] ?? step.review?.[0];
    if (!first) return;
    const el = document.querySelector<HTMLInputElement>(first.selector);
    if (!el || !rootRef.current) return;
    el.scrollIntoView({ block: "center" });
    el.focus();
    // input[type=number|date|...] THROWS InvalidStateError on setSelectionRange
    // (the DOM spec limits the selection APIs to text/search/URL/tel/password)
    // — travel_mode_auto's date fields and edit_profile_auto's weight field
    // (Phase B) are the first review fields to hit this. Guard rather than let
    // a Change tap on one of them abort before setChangeRect below ever runs.
    try { el.setSelectionRange?.(el.value.length, el.value.length); } catch { /* selection API unsupported for this input type */ }
    // Hand the SELECTOR to the measure effect's per-frame watcher rather than
    // measuring here. Tapping Change is what reflows the sheet — the review
    // card grows, the field slides — so a rect captured at this instant was
    // stale by the time the person looked at it.
    changeSelRef.current = first.selector;
  };

  return (
    // Click-through by default so a REAL user tap reaches the spotlighted element
    // beneath (the consent flows and every highlight-only waitFor step depend on
    // this; the autonomous actor uses programmatic .click() and is unaffected).
    // The callout re-enables pointer events so Exit stays tappable.
    <div
      ref={rootRef}
      className="absolute inset-0 z-[200] pointer-events-none"
      // Reported, not just handled: "0" means no placement could keep the
      // callout off its own target (a target taller than the usable band, or a
      // callout inflated past it by its review card). placement.ts minimises
      // the overlap, but the real resolution is shorter copy or a smaller
      // target in the step file — so the geometry sweep reads this and lists
      // the steps that need one.
      data-walk-callout-cleared={placement.cleared ? "1" : "0"}
    >
      {/* Dim the page outside the spotlight. GuidedTour.tsx (the older passive
          onboarding tour) uses a heavier /75 here; a Guided Auto-Navigation
          step is something the person is meant to actually READ (the callout,
          the review card), and a full 75% scrim over that read too dark/
          oppressive. The unmeasured fallback below was already lightened to
          40% for this reason — the masked cutout underneath had been left at
          the old 0.75 by oversight, so the two disagreed the moment a target
          WAS found. Both are 40% now, on purpose. */}
      {!rect && <div className="absolute inset-0 bg-black/40" />}
      {rect && (
        <>
          {/* Lightened from 0.75 to 0.4 (matching the unmeasured fallback above)
              so the real screen behind the overlay reads as DIMMED, not hidden —
              the form is still legible through it, which is the point: showing
              what Mei is doing, not blacking it out. */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ transition: "opacity 200ms" }}>
            <defs>
              <mask id="walkthrough-cutout">
                <rect x="0" y="0" width="100%" height="100%" fill="white" />
                <rect x={rect.left - 6} y={rect.top - 6} width={rect.width + 12} height={rect.height + 12} rx="16" fill="black" />
                {navRect && (
                  <rect x={navRect.left - 4} y={navRect.top - 4} width={navRect.width + 8} height={navRect.height + 8} rx="16" fill="black" />
                )}
                {changeRect && (
                  <rect x={changeRect.left - 6} y={changeRect.top - 6} width={changeRect.width + 12} height={changeRect.height + 12} rx="16" fill="black" />
                )}
              </mask>
            </defs>
            <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.4)" mask="url(#walkthrough-cutout)" />
          </svg>
          {/* A soft coloured glow around the spotlighted field, replacing the
              scrim's hard cutout edge as the "this is what matters" cue — a drop
              shadow rather than a binary mask boundary. Uses --ring, so it stays
              legible (and becomes a solid ring, per that mode's own philosophy)
              under contrast-max without a separate override. */}
          <div
            // Keyed per step so the wait variant restarts its cycle on each new
            // waitFor step rather than carrying the previous one's phase over.
            key={`glow-${stepIndex}`}
            className={`absolute dw-spotlight-glow ${!autonomous ? "dw-spotlight-glow-wait" : ""}`}
            style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }}
          />
          {/* The nav-bar tab for the step's page gets its own glow too, not
              just an undimmed cutout — matches GuidedTour.tsx's same change. */}
          {navRect && (
            <div
              className="absolute dw-spotlight-glow"
              style={{ top: navRect.top - 4, left: navRect.left - 4, width: navRect.width + 8, height: navRect.height + 8 }}
            />
          )}
          {/* The "Change" hole gets a glow too. It was the only one of the three
              cutouts without one, so the field someone had just been sent to
              edit was the least visually marked thing on screen. */}
          {changeRect && (
            <div
              className="absolute dw-spotlight-glow"
              style={{ top: changeRect.top - 6, left: changeRect.left - 6, width: changeRect.width + 12, height: changeRect.height + 12 }}
            />
          )}
        </>
      )}

      {/* ALWAYS rendered — never gated on the spotlight having been measured.
          This card is the only host of the Exit button, so gating it on `rect`
          meant that any step whose target was missing, renamed, or slow to
          mount left the person on an opaque scrim with no instruction and no
          way out but a page reload. GuidedTour.tsx already renders its callout
          unconditionally for exactly this reason; this is that decision,
          applied to the surface where it mattered more. */}
      <SpotlightCallout
        // Only steps that actually navigate (onEnter set) get a fresh key —
        // the screen swap itself is instant (a host state change, outside
        // this component's control), so this is what makes the Navigate
        // phase read as an arrival instead of an instant swap with a timing
        // floor tacked on after it. Steps without onEnter keep the same key
        // (undefined) as their neighbours and just update in place, same as
        // before.
        key={step.onEnter ? `nav-${stepIndex}` : undefined}
        animateIn={!!step.onEnter}
        animateTop={animateTop}
        stepIndex={stepIndex}
        stepCount={steps.length}
        body={t(
          language,
          phaseError ? "walk.verifyFailed"
            : stalled === "timeout" ? "walk.timedOut"
            : stalled === "target" ? "walk.cannotFind"
            : paceState.phase === "verify" ? "walk.checking"
            // Blank-field clarifying question (decision B) — takes priority
            // over the plain recap copy for as long as Confirm stays blocked.
            : confirmBlocked ? "walk.confirm.blankPrompt"
            // Name the button that is actually on screen. "Tap Next" under a
            // button reading "Done" is the kind of small mismatch that makes
            // someone hesitate at precisely the moment they must act.
            : paceState.phase === "ready" ? (isLastStep ? "walk.readyLast" : "walk.ready")
            : step.instructionKey,
          confirmBlocked ? { label: t(language, blankFields[0].labelKey) } : undefined,
        )}
        error={phaseError || stalled !== null}
        top={top}
        counterKey="walk.stepCounter"
        labelKey="walk.meiLabel"
        onHeight={setCalloutHeight}
        // NOTE: rendered outside the `autonomous` block below on purpose. Both
        // the plain waitFor Submit step AND the new autonomous Confirm step
        // (which IS `autonomous` now) can carry `review` — gating the card on
        // autonomy would hide it on whichever of the two doesn't happen to be.
        panel={
          step.review && !phaseError && stalled === null
            ? <WalkthroughReview fields={step.review} onChange={focusFirstReviewField} onBlankChange={setBlankFields} />
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
          {/* Back: undo the last step when something went wrong. Offered on
              user-driven and autonomous steps alike (unlike the pace controls
              below), because "that field is wrong" happens either way — but
              only where gating.ts::canGoBack proves re-entering the previous
              step is safe: never across a committed write, never back into a
              click that would re-fire. data-walk tags it so the consent
              invariant's "the only advance-shaped control is Exit" filter can
              exclude it the same way it excludes the idle popup. */}
          {backAvailable && !phaseError && stalled === null && (
            <button
              onClick={stepBack}
              data-walk="walk-back"
              aria-label={t(language, "walk.back")}
              className="min-h-[44px] px-3 py-2 rounded-xl border border-border bg-card text-sm font-semibold text-foreground dw-press inline-flex items-center gap-1"
            >
              <ChevronLeft size={16} strokeWidth={3} className="shrink-0" />
              {t(language, "walk.back")}
            </button>
          )}
          {/* Pace controls exist ONLY on autonomous steps — never on waitFor
              steps (the consent taps must stay entirely user-performed). Next
              now COMMITS the step (nothing advances on its own); during a phase
              it still only shortens dwell/animation and never performs the
              action. */}
          {/* User-driven step: the action row stays empty — the strengthened
              spotlight glow on the target itself (.dw-spotlight-glow-wait) is
              the "tap THIS" signal now, where the old "Waiting for you" pill
              named the control in words while the control stayed quietly lit.
              Consent taps stay entirely the user's own. */}
          {/* Errored/stalled step, at ANY index: the run cannot finish, but the
              person must still get a first-class way back to the app — a lone
              grey Exit read as "abandon", which is why "sometimes it doesn't
              close". This used to be gated on isLastStep, which left the shape
              that actually strands people uncovered: a stalled MIDDLE step is
              user-driven (waitFor), so the autonomous row below is dark too and
              the action row was completely empty (2026-08-10 — the add-
              prescription Save step). Done here calls onExit, NEVER onAdvance:
              a failed run must not record a completion or earn TrustMode
              credit. */}
          {(phaseError || stalled !== null) && (
            <>
              <div className="flex-1" />
              <button
                onClick={onExit}
                className="min-h-[44px] px-5 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold dw-press"
              >
                {t(language, "walk.done")}
              </button>
            </>
          )}
          {autonomous && !phaseError && stalled === null && (
            <>
              <div className="flex-1" />
              {/* Replay stays through the "ready" gate that follows the
                  reveal — a tap landing just after the phase flipped used to
                  be silently dropped while the button was still on screen.
                  `replayQueued` acknowledges a press during the reveal's
                  uncuttable floor (nothing visible happens for up to
                  REVEAL_PULSE_MS otherwise), clearing when the re-run
                  actually starts. */}
              {step.reveal && (paceState.phase === "reveal" || paceState.phase === "ready") && (
                <button
                  onClick={() => { resetIdleTimer(); setReplayQueued(true); paceRef.current?.requestReplay(); }}
                  className={`min-h-[44px] px-4 py-2 rounded-xl border text-sm font-semibold dw-press ${replayQueued ? "border-ring bg-secondary text-secondary-foreground ring-2 ring-ring" : "border-border bg-card text-foreground"}`}
                >
                  {t(language, "walk.replay")}
                </button>
              )}
              {/* Confirm phase, blocked (decision B): the plain gate button
                  below is replaced entirely by the escape hatch — "Add it" is
                  the review panel's existing "Change something" button
                  (already focuses the first BLANK field, above), so only the
                  second option needs its own control here. */}
              {confirmBlocked ? (
                <button
                  disabled={!paceState.canAdvance}
                  onClick={() => { resetIdleTimer(); paceRef.current?.requestNext(); }}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-border bg-card text-sm font-semibold text-foreground disabled:opacity-40 dw-press"
                >
                  {t(language, "walk.confirm.continueWithout")}
                </button>
              ) : (
                // Rendered on EVERY autonomous phase, not just the commit
                // gate — disabled until that phase's own floor elapses, which
                // is what lets Next fast-forward a still-running field/click/
                // verify. At the commit gate (ready, or a tap-required
                // confirm) it's the ONLY way forward, so its arrival there
                // gets a one-shot beat + resting ring (theme.css's
                // .dw-gate-ready) — enabled-but-otherwise-identical was too
                // quiet a signal for "your turn now". Keyed on whether it's
                // currently a gate so arriving at one replays the beat.
                <button
                  key={(paceState.phase === "ready" || showConfirmGate) ? "gate" : "phase"}
                  disabled={!paceState.canAdvance}
                  onClick={() => { resetIdleTimer(); paceRef.current?.requestNext(); }}
                  className={`min-h-[44px] px-5 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-40 dw-press inline-flex items-center gap-1.5 ${(paceState.phase === "ready" || showConfirmGate) ? "dw-gate-ready" : ""}`}
                >
                  {t(language, isLastStep ? "walk.done" : "walk.next")}
                  {(paceState.phase === "ready" || showConfirmGate) && <ChevronRight size={16} strokeWidth={3} className="shrink-0" />}
                </button>
              )}
            </>
          )}
      </SpotlightCallout>

      {/* AutoNav toggle — a fast-forward button pinned to the overlay's own top
          right, NOT a row inside the callout where it used to live (below the
          review card, where it was easy to miss entirely).

          Pinned to the OVERLAY rather than the callout on purpose: the callout
          is repositioned every step by placement.ts, so a control riding along
          with it moves around the screen; this one is in the same place for the
          whole run.

          Height against placement.ts's HEADER_RESERVE (100 since 2026-08-08,
          when the iOS status bar grew and pushed both headers down): 12 + 44 + 4
          + label ≈ 79px on a one-line label, ~92px when the label wraps to two
          (ms, ta, or any locale at --dw-text 1.25). Both now fit under the
          reserve, so the column no longer meets the callout at its highest
          placement at all.

          The reserve was NOT raised for this control — it was raised because
          both shells' headers moved down by the same 12px. That distinction is
          worth keeping: placement.ts is shared with GuidedTour, which has no
          toggle, so raising the reserve to make room for one would be a tax on
          the other.

          The wrapper's width is FIXED, and that is the whole point. It used to
          be shrink-to-fit with items-center, so the container was as wide as
          whichever label was showing — "Auto" (~38px) gave a 44px box with the
          button flush right, "Step by step" (clamped to 76px) gave a 76px box
          that re-centred the same 44px button 16px further in. The button never
          resized; the column under it did, and the button visibly hopped on
          every toggle. A constant w-[84px] pins the centring axis so both
          states land on the same pixel, and the label is w-full so its own pill
          can't shrink either. Sized for the worst case rather than English: ms
          is "Langkah demi langkah" (20 chars) and ta "படிப்படியாக" — both wrap
          to two lines here, which is fine because the label is the last thing
          in the column and pushes nothing.

          right-4, not right-3, so its right edge lines up with the callout card
          (left-4 right-4) instead of sitting 4px outside it.

          Shown on every step, not just autonomous ones: it is a mode for the
          whole walkthrough, and hiding it on the waitFor steps would make it
          blink in and out as the run progresses. Hidden on the stalled/error
          states, where the copy is already saying something went wrong and a
          mode switch is just noise.

          rounded-full, not rounded-xl: Walkthrough.test.tsx's consent invariant
          ("the only advance-shaped control in the walkthrough root is Exit")
          filters on rounded-xl. data-walk tags it as well, the same carve-out
          walk-back and walk-idle-popup already use, so the filter can exclude
          it explicitly rather than depending on a class name. */}
      {!phaseError && stalled === null && (
        <div className="absolute top-3 right-4 w-[84px] flex flex-col items-center gap-1 pointer-events-auto">
          <button
            data-walk="walk-autonav"
            aria-pressed={autoNav}
            aria-label={`${t(language, "walk.autoNav.label")}: ${t(language, autoNav ? "walk.autoNav.auto" : "walk.autoNav.manual")}`}
            onClick={() => { resetIdleTimer(); setAutoNav(v => !v); }}
            className={`w-11 h-11 rounded-full border-2 shadow-lg flex items-center justify-center transition-colors dw-press shrink-0 ${
              autoNav
                ? "bg-primary border-primary text-primary-foreground"
                : "bg-card border-border text-muted-foreground"
            }`}
          >
            <FastForward size={18} strokeWidth={2.5} className="shrink-0" fill="currentColor" />
          </button>
          {/* Filled vs outline is the state cue, deliberately not a tint or an
              opacity: under .contrast-max the card/muted/background variables
              all collapse to white and muted-foreground to black, so anything
              softer than a fill inversion reads as no state at all. */}
          <span className="w-full px-1 py-0.5 rounded-full bg-card/90 border border-border text-[calc(10px*var(--dw-text,1))] font-bold text-foreground text-center leading-tight">
            {t(language, autoNav ? "walk.autoNav.auto" : "walk.autoNav.manual")}
          </span>
        </div>
      )}

      {/* IdleTimeout (Item 6) popup — layered above the callout (later in the
          DOM, same z-[200] stacking context) and given its own pointer-events
          override, mirroring the callout's. */}
      {idlePopupOpen && (
        <WalkthroughIdlePrompt
          onTalkToMei={onTalkToMei ? talkToMei : undefined}
          onEndWalkthrough={endWalkthrough}
          onContinue={dismissIdlePopup}
        />
      )}
    </div>
  );
}
