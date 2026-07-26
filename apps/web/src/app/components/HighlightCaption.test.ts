import { describe, it, expect } from "vitest";
import { clampShift } from "./HighlightCaption";

// clampShift nudges the frame-centred pill onto the element's centre without
// letting it leave the FRAME (not the viewport) edges. Frame: left=100, width=390
// → frameCentre=295, maxShift = 390/2 - 8 = 187.
describe("clampShift (frame-relative pill offset)", () => {
  const FRAME_CENTRE = 295;
  const FRAME_WIDTH = 390;
  const MARGIN = 8;
  const MAX = FRAME_WIDTH / 2 - MARGIN; // 187

  it("does not shift when the element is centred in the frame", () => {
    expect(clampShift(FRAME_CENTRE, FRAME_CENTRE, FRAME_WIDTH, MARGIN)).toBe(0);
  });

  it("shifts toward an off-centre element inside the frame", () => {
    expect(clampShift(FRAME_CENTRE + 50, FRAME_CENTRE, FRAME_WIDTH, MARGIN)).toBe(50);
    expect(clampShift(FRAME_CENTRE - 50, FRAME_CENTRE, FRAME_WIDTH, MARGIN)).toBe(-50);
  });

  it("clamps to the frame edge when the element centre is past it", () => {
    // Element centre way off to the right (e.g. a wide desktop viewport): the pill
    // must stop at the frame edge, never drift out over empty desktop.
    expect(clampShift(2000, FRAME_CENTRE, FRAME_WIDTH, MARGIN)).toBe(MAX);
    expect(clampShift(-2000, FRAME_CENTRE, FRAME_WIDTH, MARGIN)).toBe(-MAX);
  });

  it("never produces a positive maxShift for a degenerate (zero-width) frame", () => {
    expect(clampShift(500, 0, 0, MARGIN)).toBe(0);
  });
});
