import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

// The attached "what changed" caption bubble, shared by ChangeHighlight (fed by
// backend committed_actions) and the walkthrough Reveal (client-driven writes),
// so both prove a change the same way: an emerald pill glued to the highlighted
// element with a bold verb + specifics ("Updated: dose time …").
//
// Placement is collision-aware: the pill straddles the element's own top edge,
// centered horizontally over the element. It's clamped horizontally so it can't
// run off the frame edge, and centered over the element so it doesn't jut
// sideways over neighbouring controls.
//
// IMPORTANT: the app renders a CENTERED, fixed-width phone frame (a device
// mockup), not a full-viewport page. The pill therefore positions and clamps
// against the FRAME's rect, not window.innerWidth — clamping to the whole
// viewport lets the pill drift off the element on the wide desktop demo.
const PILL_H_FALLBACK = 30; // used only for the first layout frame, before measure

export function HighlightCaption({ rect, verb, text }: { rect: DOMRect; verb: string; text: string }) {
  const pillRef = useRef<HTMLDivElement>(null);
  const [pillH, setPillH] = useState(0);

  // Measure the pill's REAL height (font scaling / longer text change it) so the
  // vertical straddle is exact instead of assuming a hardcoded 30px. Mirrors the
  // measured-height pattern in SpotlightCallout. useLayoutEffect + ResizeObserver
  // reports before paint, so the fallback height is never actually painted.
  useLayoutEffect(() => {
    const el = pillRef.current;
    if (!el) return;
    const report = () => setPillH(el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const vw = typeof window !== "undefined" ? window.innerWidth : 430;
  const frame = findFrameBounds(rect);
  const fLeft = frame ? frame.left : 0;
  const fRight = frame ? frame.right : vw;
  const fWidth = fRight - fLeft;

  const MARGIN = 8;
  const h = pillH || PILL_H_FALLBACK;

  // Straddle the element's OWN top edge (half over the element, half in the gap
  // above): centered horizontally, the pill overlaps only the subject it labels.
  const top = Math.round(rect.top - h / 2);

  // Center on the element; the wrapper spans the FRAME so the inner pill sizes to
  // its own content, justified to the element's centre and clamped inside the
  // frame edges (not the viewport).
  const center = rect.left + rect.width / 2;
  const frameCentre = fLeft + fWidth / 2;

  return createPortal(
    <div
      className="fixed z-[60] pointer-events-none flex"
      style={{
        left: Math.round(fLeft + MARGIN),
        right: Math.round(vw - fRight + MARGIN),
        top,
        justifyContent: "center",
      }}
      data-testid="change-highlight-caption"
    >
      {/* Shift the centred pill to sit over the element's centre, clamped so it
          can't leave the frame. translateX is clamped to keep it inside. */}
      <div
        ref={pillRef}
        className="inline-flex items-center gap-1.5 bg-accent text-white text-xs font-semibold px-3 py-1.5 rounded-full shadow-lg whitespace-nowrap"
        style={{ transform: `translateX(${clampShift(center, frameCentre, fWidth, MARGIN)}px)`, maxWidth: "100%" }}
      >
        <Check size={12} strokeWidth={3} className="shrink-0" />
        <span className="truncate">
          <span className="font-bold">{verb}:</span> {text}
        </span>
      </div>
    </div>,
    document.body,
  );
}

// Locate the centered phone-frame's viewport rect so the pill clamps to the
// device mockup, not window.innerWidth. Start from the highlighted element (found
// by hit-testing the rect's centre — the caption itself is pointer-events-none so
// it's transparent to elementFromPoint — falling back to the ring/pulse class the
// callers add), then walk UP the offsetParent chain to the outermost positioned
// ancestor below <body>: that's the phone-frame `relative` container. Works
// identically for BOTH callers (no special-casing). Returns null → caller falls
// back to viewport bounds.
function findFrameBounds(rect: DOMRect): { left: number; right: number } | null {
  if (typeof document === "undefined") return null;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const start =
    (document.elementFromPoint(cx, cy) as HTMLElement | null) ??
    document.querySelector<HTMLElement>(".change-highlight, .walk-reveal-pulse");
  let node: HTMLElement | null = start;
  let frame: HTMLElement | null = null;
  while (node && node.offsetParent instanceof HTMLElement && node.offsetParent !== document.body) {
    node = node.offsetParent;
    frame = node;
  }
  if (!frame) return null;
  const r = frame.getBoundingClientRect();
  return { left: r.left, right: r.right };
}

// How far to nudge the centred pill so its midpoint lands over the element's
// centre. The flex wrapper centres the pill in the frame (midpoint = frameCentre);
// shift by (elementCentre − frameCentre), clamped to ±(frameWidth/2 − margin) so
// the pill can't run off either FRAME edge.
export function clampShift(center: number, frameCentre: number, frameWidth: number, margin: number): number {
  const maxShift = Math.max(0, frameWidth / 2 - margin);
  return Math.max(-maxShift, Math.min(center - frameCentre, maxShift));
}
