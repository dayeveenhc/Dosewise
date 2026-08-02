import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";
import { calloutTop } from "../lib/walkthrough/placement";
import { SpotlightCallout } from "./SpotlightCallout";

export interface TourStep {
  target: string; // CSS selector for the element to spotlight
  navTarget?: string; // CSS selector for the matching bottom-nav icon — gets its own cutout
  title: string;
  body: string;
  onEnter?: () => void; // e.g. switch tabs before this step's target exists
}

interface Rect { top: number; left: number; width: number; height: number }

// A spotlight walkthrough: dims everything except the current step's target
// (via a giant box-shadow around a box positioned over it — simpler and more
// reliable than an SVG mask), with a callout card driving Next/Skip/Back.
// Steps can switch tabs themselves (onEnter), so this measures its target
// fresh on every step change, retrying a few frames in case the new tab's
// content hasn't mounted yet.
export function GuidedTour({ steps, onFinish }: { steps: TourStep[]; onFinish: () => void }) {
  const { language } = useLanguage();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [navRect, setNavRect] = useState<Rect | null>(null);
  const [containerHeight, setContainerHeight] = useState(0);
  const [calloutHeight, setCalloutHeight] = useState(165);
  const rootRef = useRef<HTMLDivElement>(null);
  const step = steps[index];

  useEffect(() => {
    step.onEnter?.();
    setRect(null);
    setNavRect(null);
    let attempts = 0;
    let raf = 0;
    const measure = () => {
      // Measure THIS element's own box, not its parentElement's — the parent
      // may have a border (e.g. the desktop phone-bezel frame's md:border-6),
      // and position:absolute's containing block is the parent's PADDING edge
      // while getBoundingClientRect() on the parent reports its BORDER edge.
      // That mismatch used to shift every cutout down-right by the border
      // width; this element (itself position:absolute; inset:0 in that same
      // parent) already sits exactly at the padding edge, so its own rect IS
      // the correct (0,0) origin with no border-width math needed.
      const origin = rootRef.current?.getBoundingClientRect();
      const targetEl = document.querySelector(step.target);
      if (origin && targetEl) {
        // Scroll first — measuring before the scroll settles captures stale
        // coordinates that don't match where the element ends up on screen.
        targetEl.scrollIntoView({ block: "center" });
        const t = targetEl.getBoundingClientRect();
        setRect({ top: t.top - origin.top, left: t.left - origin.left, width: t.width, height: t.height });
        setContainerHeight(origin.height);
        const navEl = step.navTarget ? document.querySelector(step.navTarget) : null;
        if (navEl) {
          const n = navEl.getBoundingClientRect();
          setNavRect({ top: n.top - origin.top, left: n.left - origin.left, width: n.width, height: n.height });
        }
      } else if (attempts < 20) {
        attempts++;
        raf = requestAnimationFrame(measure);
      }
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const isLast = index === steps.length - 1;
  const next = () => isLast ? onFinish() : setIndex(i => i + 1);
  const back = () => setIndex(i => Math.max(0, i - 1));

  // Hug the callout right next to the target (shared placement helper), using
  // the callout's measured height so it never overlaps the target or nav.
  const top = calloutTop(rect, containerHeight, calloutHeight);

  return (
    // pointer-events-none so the spotlighted control underneath stays tappable
    // (the callout re-enables events for its own buttons) — without this the
    // whole tour reads as a locked dark screen: e.g. the font-size step dimmed
    // the slider but swallowed every tap, so "change text size" did nothing.
    // Matches the autonomous Walkthrough overlay (components/Walkthrough.tsx).
    <div ref={rootRef} className="absolute inset-0 z-[200] pointer-events-none">
      {!rect && <div className="absolute inset-0 bg-black/75" />}
      {rect && (
        // A single mask with both holes — two independent 9999px box-shadow
        // cutouts would each darken the other's hole, since each one's
        // shadow covers the entire screen except its own box.
        <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ transition: "opacity 200ms" }}>
          <defs>
            <mask id="tour-cutout">
              <rect x="0" y="0" width="100%" height="100%" fill="white" />
              <rect
                x={rect.left - 6} y={rect.top - 6} width={rect.width + 12} height={rect.height + 12}
                rx="16" fill="black"
              />
              {navRect && (
                <rect
                  x={navRect.left - 4} y={navRect.top - 4} width={navRect.width + 8} height={navRect.height + 8}
                  rx="16" fill="black"
                />
              )}
            </mask>
          </defs>
          <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.75)" mask="url(#tour-cutout)" />
        </svg>
      )}

      {/* Always shown (unlike the autonomous walkthrough): this tour is
          user-advanced, so Next/Skip must stay reachable even if a target is
          briefly unmeasured. */}
      <SpotlightCallout
        stepIndex={index}
        stepCount={steps.length}
        title={step.title}
        body={step.body}
        top={top}
        counterKey="tour.stepCounter"
        labelKey="tour.meiLabel"
        onHeight={setCalloutHeight}
      >
        {/* Real button chrome, not bare clickable text — the way out of a tour
            has to look like something you can press. Matches Back's treatment
            while staying visually secondary to Next. */}
        <button onClick={onFinish} className="h-9 px-3 rounded-xl border border-border bg-card text-muted-foreground text-xs font-semibold shrink-0">
          {t(language, "tour.skip")}
        </button>
        {index > 0 && (
          <button onClick={back} className="h-9 px-3 rounded-xl border border-border text-foreground text-xs font-semibold shrink-0">
            {t(language, "tour.back")}
          </button>
        )}
        <button onClick={next} className="flex-1 h-9 rounded-xl bg-primary text-primary-foreground text-xs font-semibold">
          {isLast ? t(language, "tour.done") : t(language, "tour.next")}
        </button>
      </SpotlightCallout>
    </div>
  );
}
