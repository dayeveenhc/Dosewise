import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

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
  const rootRef = useRef<HTMLDivElement>(null);
  const step = steps[index];

  useEffect(() => {
    step.onEnter?.();
    setRect(null);
    setNavRect(null);
    let attempts = 0;
    let raf = 0;
    const measure = () => {
      const parent = rootRef.current?.parentElement;
      const targetEl = document.querySelector(step.target);
      if (parent && targetEl) {
        // Scroll first — measuring before the scroll settles captures stale
        // coordinates that don't match where the element ends up on screen.
        targetEl.scrollIntoView({ block: "center" });
        const p = parent.getBoundingClientRect();
        const t = targetEl.getBoundingClientRect();
        setRect({ top: t.top - p.top, left: t.left - p.left, width: t.width, height: t.height });
        setContainerHeight(p.height);
        const navEl = step.navTarget ? document.querySelector(step.navTarget) : null;
        if (navEl) {
          const n = navEl.getBoundingClientRect();
          setNavRect({ top: n.top - p.top, left: n.left - p.left, width: n.width, height: n.height });
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

  // Hug the callout right next to the target — below it if there's room clear
  // of the bottom nav, otherwise above it clear of the header — instead of
  // snapping to a fixed top/bottom position that can end up far from (or
  // overlapping) the thing it's describing.
  const GAP = 12;
  const CALLOUT_HEIGHT = 165;
  const NAV_RESERVE = 110;
  const HEADER_RESERVE = 84;
  let calloutTop = containerHeight - NAV_RESERVE - CALLOUT_HEIGHT;
  if (rect) {
    const spaceBelow = containerHeight - NAV_RESERVE - (rect.top + rect.height);
    if (spaceBelow >= CALLOUT_HEIGHT) {
      calloutTop = rect.top + rect.height + GAP;
    } else {
      calloutTop = Math.max(HEADER_RESERVE, rect.top - CALLOUT_HEIGHT - GAP);
    }
  }

  return (
    <div ref={rootRef} className="absolute inset-0 z-[200]">
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

      <div className="absolute left-4 right-4 bg-card rounded-2xl p-3.5 shadow-2xl transition-all duration-300" style={{ top: calloutTop }}>
        <div className="flex gap-1 mb-2.5">
          {steps.map((_, i) => (
            <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i <= index ? "bg-primary" : "bg-muted"}`} />
          ))}
        </div>
        <h3 className="font-['Fraunces'] text-base font-semibold text-foreground mb-1">{step.title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-3">{step.body}</p>
        <div className="flex items-center gap-1.5">
          <button onClick={onFinish} className="text-xs text-muted-foreground font-medium px-2 py-2 shrink-0">
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
        </div>
      </div>
    </div>
  );
}
