import { createPortal } from "react-dom";
import { Check } from "lucide-react";

// The attached "what changed" caption bubble, shared by ChangeHighlight (fed by
// backend committed_actions) and the walkthrough Reveal (client-driven writes),
// so both prove a change the same way: an emerald pill glued to the highlighted
// element with a bold verb + specifics ("Updated: dose time …").
//
// Placement is collision-aware: elements near the TOP of the frame get the pill
// BELOW them (so it never covers the header/action buttons sitting above, e.g.
// "Add Prescription"), everything else gets it above. It's clamped horizontally
// so it can't run off the frame edge, and centered over the element so it doesn't
// jut sideways over neighbouring controls.
const PILL_H = 30; // approximate rendered pill height (py-1.5 + text)

export function HighlightCaption({ rect, verb, text }: { rect: DOMRect; verb: string; text: string }) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 430;

  // Straddle the element's OWN top edge (half over the highlighted element, half
  // in the gap above): centered horizontally, the pill overlaps only the subject
  // it's labelling — never a neighbouring field's label or button below it. This
  // is what avoids the "pill covering the Weight (kg) label / safety text / next
  // field" collisions a fully-above or fully-below placement caused.
  const top = Math.round(rect.top - PILL_H / 2);

  // Center on the element; the wrapper spans the frame so the inner pill sizes to
  // its own content (no premature truncation), justified to the element's centre
  // and clamped inside an 8px margin by the wrapper's own bounds.
  const MARGIN = 8;
  const center = Math.round(rect.left + rect.width / 2);

  return createPortal(
    <div
      className="fixed z-[60] pointer-events-none flex"
      style={{ left: MARGIN, right: MARGIN, top, justifyContent: "center" }}
      data-testid="change-highlight-caption"
    >
      {/* Shift the centred pill to sit over the element's centre, clamped so it
          can't leave the frame. translateX is clamped to keep it on-screen. */}
      <div
        className="inline-flex items-center gap-1.5 bg-accent text-white text-xs font-semibold px-3 py-1.5 rounded-full shadow-lg whitespace-nowrap"
        style={{ transform: `translateX(${clampShift(center, vw, MARGIN)}px)`, maxWidth: `calc(100% )` }}
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

// How far to nudge the centred pill so its midpoint lands over the element's
// centre, without knowing the pill's width up front. The flex wrapper already
// centres the pill in the frame (midpoint = vw/2); shift by (elementCentre −
// frameCentre), which keeps it visually attached while the wrapper's margins
// stop it running off either edge.
function clampShift(center: number, vw: number, margin: number): number {
  const frameCentre = vw / 2;
  const maxShift = vw / 2 - margin;
  return Math.max(-maxShift, Math.min(center - frameCentre, maxShift));
}
