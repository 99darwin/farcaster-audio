import { DOUBLE_TAP_MS, DOUBLE_TAP_SLOP_PX, QUICK_TOGGLE_REACTION, isDoubleTap } from "@/lib/messages/double-tap";

describe("isDoubleTap", () => {
  const first = { time: 1_000, x: 100, y: 200 };

  it("pairs two quick taps in the same spot", () => {
    expect(isDoubleTap(first, { time: 1_000 + DOUBLE_TAP_MS, x: 110, y: 190 })).toBe(true);
  });

  it("rejects a first tap, slow taps, far-apart taps and out-of-order times", () => {
    expect(isDoubleTap(null, first)).toBe(false);
    expect(isDoubleTap(first, { ...first, time: 1_000 + DOUBLE_TAP_MS + 1 })).toBe(false);
    expect(isDoubleTap(first, { ...first, time: 1_100, x: 100 + DOUBLE_TAP_SLOP_PX + 1 })).toBe(false);
    expect(isDoubleTap(first, { ...first, time: 1_100, y: 200 - DOUBLE_TAP_SLOP_PX - 1 })).toBe(false);
    expect(isDoubleTap(first, { ...first, time: 900 })).toBe(false);
  });

  it("toggles a heart", () => {
    expect(QUICK_TOGGLE_REACTION).toBe("❤️");
  });
});
