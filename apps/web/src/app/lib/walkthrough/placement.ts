// Shared spotlight-callout placement, used by both the Guided Auto-Nav
// walkthrough and the passive product tour. Hugs the callout next to the
// spotlighted target — below it when there's room clear of the bottom nav, else
// above it clear of the header — instead of snapping to a fixed position that
// can overlap the thing it describes. Takes the callout's MEASURED height (not a
// guess), which is what fixes the old overlap/gap bug.

interface Rect { top: number; left: number; width: number; height: number }

// Exported so placement.test.ts can assert RELATIONSHIPS rather than mirroring
// these as literals — it used to, and a legitimate HEADER_RESERVE change then
// surfaced as two unrelated-looking test failures.
export const GAP = 16; // breathing room between the callout and the spotlighted target
export const NAV_RESERVE = 110; // keep clear of the bottom nav + Ask-Mei FAB
// Keep clear of the app header when placed above. Measured, not guessed: the
// overlay is inset-0 of the phone frame, so this is counted from the status
// bar's top edge, and the elder header's bottom now sits at ~99px (it was
// ~87px, i.e. already marginally over the old 84, before the status bar grew
// from 28 to 40px for the iOS restyle).
//
// Raised for BOTH consumers, which is why this is a different call from the
// 2026-08-08 AutoNav decision that deliberately left it alone: there, raising
// it would have shrunk GuidedTour's usable band to make room for a toggle
// GuidedTour doesn't have — a tax on one consumer for the other's benefit.
// Here the header moved down by the same amount in every shell, so the reserve
// is just tracking a real shift. Cost is 16px of band (746 -> 730 at the real
// frame height). The two known "no placement clears the target" cases (688px
// and 657px targets) are UNAFFECTED — they could not clear at 746 either, and
// still cannot; they need shorter copy or a smaller selector, not geometry.
export const HEADER_RESERVE = 100;

export interface Placement {
  top: number;
  // False when NO placement could keep the callout clear of its own target —
  // i.e. the card is knowingly overlapping the thing it describes. Not a
  // failure to handle at runtime (there is nothing better to do); a SIGNAL that
  // this step needs shorter copy or a smaller target. See the third branch.
  cleared: boolean;
}

export function calloutPlacement(
  rect: Rect | null,
  containerHeight: number,
  calloutHeight: number,
): Placement {
  // The band in which the callout is fully visible (below the header, above the
  // nav). Everything is clamped into it so the card can never clip off the top
  // or bottom of the phone frame, even mid-transition.
  const bottomFloor = Math.max(HEADER_RESERVE, containerHeight - NAV_RESERVE - calloutHeight);
  const clamp = (p: number) => Math.min(Math.max(p, HEADER_RESERVE), bottomFloor);
  if (!rect) return { top: bottomFloor, cleared: true };
  const spaceBelow = containerHeight - NAV_RESERVE - (rect.top + rect.height);
  const spaceAbove = rect.top - HEADER_RESERVE;
  if (spaceBelow >= calloutHeight + GAP) return { top: clamp(rect.top + rect.height + GAP), cleared: true };
  if (spaceAbove >= calloutHeight + GAP) return { top: clamp(rect.top - calloutHeight - GAP), cleared: true };
  // Neither side fully clears the target — a target taller than the usable band
  // (the Ask Mei categories list, a 456px settings section), or a short one
  // sitting next to a callout inflated by its review card. For a target that
  // tall NO `top` both stays in-band and clears it: that is arithmetic, not a
  // bug to fix here, and targetLiftPx can't rescue it either (it only clears
  // the target's TOP edge).
  //
  // This used to return `bottomFloor` unconditionally, which meant the card
  // reliably landed ON the target whenever the target sat in the lower half of
  // the band — measured live on add_prescription_auto's Confirm step, where a
  // 427px callout was painted straight over the Save button it was naming.
  //
  // Instead, evaluate BOTH candidates after clamping and keep whichever covers
  // less of the target. Picking by "which side has more room" looks equivalent
  // and is not: the roomier side can still be short of `calloutHeight`, and the
  // clamp then drags the card straight back across the target — that is exactly
  // how the Confirm step scored 355px of room below and still landed on top of
  // its own Save button. Overlap is the thing that matters, so measure it.
  const overlap = (pos: number) =>
    Math.max(0, Math.min(pos + calloutHeight, rect.top + rect.height) - Math.max(pos, rect.top));
  const below = clamp(rect.top + rect.height + GAP);
  const above = clamp(rect.top - calloutHeight - GAP);
  // Ties go ABOVE: reading top-down, a card above the control it describes puts
  // the instruction before the thing, and leaves the target nearer the thumb.
  return { top: overlap(above) <= overlap(below) ? above : below, cleared: false };
}

// Unchanged contract, kept because GuidedTour (the passive product tour) only
// ever wants the number.
export function calloutTop(
  rect: Rect | null,
  containerHeight: number,
  calloutHeight: number,
): number {
  return calloutPlacement(rect, containerHeight, calloutHeight).top;
}

// Bottom-of-viewport TARGET repositioning — the counterpart calloutTop never
// does: it only ever moves the CALLOUT. When a target's rect leaves too
// little room for the callout above AND below (the same condition calloutTop's
// own `else` branch detects), the callout has nowhere to go without clipping
// or overlapping the very thing it describes — e.g. a tall review card next to
// a target sitting deep in a short viewport. Rather than let that happen, the
// caller (Walkthrough.tsx) nudges the TARGET itself upward into a safely
// visible band near the top of the usable area, which then gives calloutTop
// plenty of room below it on the next measurement.
//
// Deliberately a SEPARATE function, not a change to calloutTop above:
// calloutTop is shared with GuidedTour (the passive onboarding tour), which
// never moves its target, so this stays additive and opt-in per caller.
// Returns 0 when no lift is needed — calloutTop already handles that case.
export function targetLiftPx(
  rect: Rect,
  containerHeight: number,
  calloutHeight: number,
): number {
  const spaceBelow = containerHeight - NAV_RESERVE - (rect.top + rect.height);
  const spaceAbove = rect.top - HEADER_RESERVE;
  if (spaceBelow >= calloutHeight + GAP || spaceAbove >= calloutHeight + GAP) return 0;
  // Move the target to just clear the header band, with the same breathing
  // room the callout itself uses next to a target — freeing up the rest of
  // the usable height below it for the callout's normal "place below" branch.
  const desiredTop = HEADER_RESERVE + GAP;
  return Math.max(0, Math.round(rect.top - desiredTop));
}
