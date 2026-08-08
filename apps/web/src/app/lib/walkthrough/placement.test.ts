import { describe, expect, it } from "vitest";
import { calloutPlacement, calloutTop, targetLiftPx, GAP, NAV_RESERVE, HEADER_RESERVE } from "./placement";

// These exercise targetLiftPx/calloutPlacement against the SAME boundary
// conditions the real branches use. The constants are IMPORTED, not mirrored as
// literals: they were mirrored, and a legitimate HEADER_RESERVE change (84 ->
// 100, when the iOS status bar grew and pushed the header down) then showed up
// as two failures that looked like placement bugs rather than a stale copy.

describe("targetLiftPx", () => {
  it("returns 0 when there's room BELOW the target for the callout", () => {
    // spaceBelow = 800 - 110 - (200+40) = 450 >= calloutHeight(150)+GAP(16)
    const rect = { top: 200, left: 0, width: 300, height: 40 };
    expect(targetLiftPx(rect, 800, 150)).toBe(0);
  });

  it("returns 0 when there's room ABOVE the target for the callout, even with none below", () => {
    // A target near the bottom of a tall container: no room below, but ample
    // room above — calloutTop's own "place above" branch already handles
    // this, so the target must NOT move.
    const rect = { top: 700, left: 0, width: 300, height: 40 };
    expect(targetLiftPx(rect, 800, 150)).toBe(0);
  });

  it("lifts the target when NEITHER side has room (calloutTop's else/bottomFloor branch)", () => {
    // A short container with a tall callout and a target sitting mid-screen,
    // deliberately failing both sides' room check (see the math below).
    const rect = { top: 260, left: 0, width: 300, height: 40 };
    const containerHeight = 500;
    const calloutHeight = 300;
    // spaceBelow = 500-110-(260+40) = 90 < 316; spaceAbove = 260-HEADER_RESERVE < 316.
    const lift = targetLiftPx(rect, containerHeight, calloutHeight);
    expect(lift).toBeGreaterThan(0);
    // Lifts exactly to just clear the header band.
    expect(rect.top - lift).toBe(HEADER_RESERVE + GAP);
  });

  it("never returns a negative lift (target already within the header band)", () => {
    const rect = { top: 50, left: 0, width: 300, height: 400 };
    const lift = targetLiftPx(rect, 500, 300);
    expect(lift).toBeGreaterThanOrEqual(0);
  });

  it("is additive to calloutTop, not a replacement for it — calloutTop's own behaviour is unchanged", () => {
    const rect = { top: 200, left: 0, width: 300, height: 40 };
    // Same call shape/return type as before this change; no new required args.
    expect(typeof calloutTop(rect, 800, 150)).toBe("number");
  });
});

// calloutPlacement's own branches had NO direct coverage until now — the one
// assertion above only checked calloutTop returned a number, so every real
// decision it makes (and the clamp) was exercised solely by the e2e geometry
// sweep. Same mirrored constants: GAP = 16, NAV_RESERVE = 110, HEADER_RESERVE = 84.
describe("calloutPlacement", () => {
  const target = (top: number, height = 40) => ({ top, left: 0, width: 300, height });

  it("places BELOW the target when there is room, and reports it cleared", () => {
    // spaceBelow = 800 - 110 - 240 = 450 >= 150 + 16
    expect(calloutPlacement(target(200), 800, 150)).toEqual({ top: 256, cleared: true });
  });

  it("places ABOVE the target when only that side has room", () => {
    // spaceBelow = 800 - 110 - 740 = -50; spaceAbove = 700 - HEADER_RESERVE >= 166
    expect(calloutPlacement(target(700), 800, 150)).toEqual({ top: 534, cleared: true });
  });

  it("falls back to the bottom of the band when there is no target at all", () => {
    // bottomFloor = 800 - 110 - 150 = 540
    expect(calloutPlacement(null, 800, 150)).toEqual({ top: 540, cleared: true });
  });

  it("reports cleared:false for a target taller than the usable band", () => {
    // The band is 800 - HEADER_RESERVE - 110; this target is 500 tall next to a 300
    // callout, so no placement can clear it. That is arithmetic, not a bug —
    // the point is that it SAYS so rather than silently overlapping.
    const p = calloutPlacement(target(200, 500), 800, 300);
    expect(p.cleared).toBe(false);
    expect(p.top).toBe(HEADER_RESERVE); // clamp(200 - 300 - 16) -> HEADER_RESERVE
  });

  // The regression this branch exists for, measured live on
  // add_prescription_auto's Confirm step: a 427px callout (inflated by its
  // review card) next to the Save button, in a 940px container.
  it("picks the placement that covers LESS of the target when neither clears", () => {
    const rect = target(424, 51);
    const p = calloutPlacement(rect, 940, 427);
    expect(p.cleared).toBe(false);

    // Both candidates are computed the same way placement.ts does, then
    // compared on overlap — the property, not a hardcoded coordinate.
    const bottomFloor = Math.max(HEADER_RESERVE, 940 - NAV_RESERVE - 427);
    const clamp = (x: number) => Math.min(Math.max(x, HEADER_RESERVE), bottomFloor);
    const overlap = (pos: number) =>
      Math.max(0, Math.min(pos + 427, rect.top + rect.height) - Math.max(pos, rect.top));
    const chosen = overlap(p.top);
    expect(chosen).toBeLessThanOrEqual(overlap(clamp(rect.top + rect.height + 16)));
    expect(chosen).toBeLessThanOrEqual(overlap(clamp(rect.top - 427 - 16)));
  });

  it("beats the old unconditional bottomFloor on a target low in the band", () => {
    // The specific shape "roomier side" got wrong: plenty of room BELOW by the
    // arithmetic (355px), but not enough for the card, so clamping used to drag
    // it back up across the target.
    const rect = target(600, 51);
    const p = calloutPlacement(rect, 940, 300);
    const overlap = (pos: number) =>
      Math.max(0, Math.min(pos + 300, rect.top + rect.height) - Math.max(pos, rect.top));
    const oldBehaviour = Math.max(HEADER_RESERVE, 940 - NAV_RESERVE - 300);
    expect(overlap(p.top)).toBeLessThanOrEqual(overlap(oldBehaviour));
  });

  it("never places outside the band, in either direction", () => {
    for (const top of [-200, 0, HEADER_RESERVE, 400, 900, 2000]) {
      const { top: pos } = calloutPlacement(target(top, 300), 800, 300);
      expect(pos).toBeGreaterThanOrEqual(HEADER_RESERVE);
      expect(pos).toBeLessThanOrEqual(Math.max(HEADER_RESERVE, 800 - NAV_RESERVE - 300));
    }
  });

  it("agrees with calloutTop, which is just its .top", () => {
    const rect = target(200);
    expect(calloutTop(rect, 800, 150)).toBe(calloutPlacement(rect, 800, 150).top);
    expect(calloutTop(null, 800, 150)).toBe(calloutPlacement(null, 800, 150).top);
  });
});
