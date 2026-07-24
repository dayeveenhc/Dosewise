// Shared spotlight-callout placement, used by both the Guided Auto-Nav
// walkthrough and the passive product tour. Hugs the callout next to the
// spotlighted target — below it when there's room clear of the bottom nav, else
// above it clear of the header — instead of snapping to a fixed position that
// can overlap the thing it describes. Takes the callout's MEASURED height (not a
// guess), which is what fixes the old overlap/gap bug.

interface Rect { top: number; left: number; width: number; height: number }

const GAP = 16; // breathing room between the callout and the spotlighted target
const NAV_RESERVE = 110; // keep clear of the bottom nav + Ask-Mei FAB
const HEADER_RESERVE = 84; // keep clear of the app header when placed above

export function calloutTop(
  rect: Rect | null,
  containerHeight: number,
  calloutHeight: number,
): number {
  // The band in which the callout is fully visible (below the header, above the
  // nav). Everything is clamped into it so the card can never clip off the top
  // or bottom of the phone frame, even mid-transition.
  const bottomFloor = Math.max(HEADER_RESERVE, containerHeight - NAV_RESERVE - calloutHeight);
  if (!rect) return bottomFloor;
  const spaceBelow = containerHeight - NAV_RESERVE - (rect.top + rect.height);
  const pos = spaceBelow >= calloutHeight + GAP
    ? rect.top + rect.height + GAP
    : rect.top - calloutHeight - GAP;
  return Math.min(Math.max(pos, HEADER_RESERVE), bottomFloor);
}
