import {
  captureAnchor,
  centeredScrollTop,
  computeLayout,
  restoreAnchor,
  rowIndexAtOffset,
  visibleRange,
} from "@/lib/messages/windowing";

const estimate = () => 50;

describe("computeLayout", () => {
  it("uses measured sizes and falls back to the estimate", () => {
    const layout = computeLayout(["a", "b", "c"], new Map([["b", 100]]), estimate);
    expect(layout.offsets).toEqual([0, 50, 150, 200]);
    expect(layout.totalHeight).toBe(200);
  });

  it("handles empty lists", () => {
    expect(computeLayout([], new Map(), estimate)).toEqual({ offsets: [0], totalHeight: 0 });
  });
});

describe("rowIndexAtOffset / visibleRange", () => {
  const { offsets } = computeLayout(["a", "b", "c", "d"], new Map(), estimate);

  it("finds the row containing an offset", () => {
    expect(rowIndexAtOffset(offsets, -10)).toBe(0);
    expect(rowIndexAtOffset(offsets, 0)).toBe(0);
    expect(rowIndexAtOffset(offsets, 49)).toBe(0);
    expect(rowIndexAtOffset(offsets, 50)).toBe(1);
    expect(rowIndexAtOffset(offsets, 10_000)).toBe(3);
    expect(rowIndexAtOffset([0], 0)).toBe(-1);
  });

  it("returns the rows intersecting the overscanned viewport", () => {
    expect(visibleRange(offsets, 60, 40, 0)).toEqual({ start: 1, end: 3 });
    expect(visibleRange(offsets, 60, 40, 100)).toEqual({ start: 0, end: 4 });
    expect(visibleRange([0], 0, 100, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe("scroll anchoring", () => {
  it("keeps the anchor row still when older rows are prepended", () => {
    const keys = ["c", "d", "e"];
    const before = computeLayout(keys, new Map(), estimate);
    const anchor = captureAnchor(keys, before.offsets, 70);
    expect(anchor).toEqual({ key: "d", delta: -20 });

    const nextKeys = ["a", "b", ...keys];
    const after = computeLayout(nextKeys, new Map([["a", 120]]), estimate);
    // "d" moved from 50 to 220; scrollTop moves by the same 170.
    expect(restoreAnchor(anchor!, nextKeys, after.offsets)).toBe(240);
  });

  it("returns null when the anchor row is gone", () => {
    expect(restoreAnchor({ key: "x", delta: 0 }, ["a"], [0, 50])).toBeNull();
    expect(captureAnchor([], [0], 0)).toBeNull();
  });
});

describe("centeredScrollTop", () => {
  const { offsets } = computeLayout(["a", "b", "c", "d", "e"], new Map(), estimate);

  it("centers a row and clamps to the content", () => {
    expect(centeredScrollTop(offsets, 2, 100)).toBe(75);
    expect(centeredScrollTop(offsets, 0, 100)).toBe(0);
    expect(centeredScrollTop(offsets, 4, 100)).toBe(150);
    expect(centeredScrollTop(offsets, 9, 100)).toBe(0);
  });
});
