/**
 * Layout math for the windowed (virtualized) message list.
 *
 * Rows have variable, measured heights. The list keeps a map of measured
 * heights keyed by row key (so prepending older pages doesn't invalidate
 * anything) and falls back to an estimate for rows not yet measured.
 *
 * Scroll anchoring works on the same data: before a layout change we remember
 * one row's key and its distance from the viewport top; after the change we
 * recompute that row's offset and restore the distance. That keeps the view
 * still when older pages are prepended or estimates are corrected by real
 * measurements above the viewport.
 */

export interface RowLayout {
  /** offsets[i] is the top of row i; offsets[rowCount] is the total height. */
  offsets: number[];
  totalHeight: number;
}

export function computeLayout(
  keys: readonly string[],
  sizes: ReadonlyMap<string, number>,
  estimate: (index: number) => number,
): RowLayout {
  const offsets = new Array<number>(keys.length + 1);
  let top = 0;
  for (let i = 0; i < keys.length; i += 1) {
    offsets[i] = top;
    top += sizes.get(keys[i]) ?? estimate(i);
  }
  offsets[keys.length] = top;
  return { offsets, totalHeight: top };
}

/** Index of the row containing `offset` (binary search over row tops). */
export function rowIndexAtOffset(offsets: readonly number[], offset: number): number {
  const rowCount = offsets.length - 1;
  if (rowCount <= 0) return -1;
  if (offset <= 0) return 0;
  let low = 0;
  let high = rowCount - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

export interface VisibleRange {
  start: number;
  /** Exclusive. */
  end: number;
}

/** Rows intersecting `[scrollTop - overscan, scrollTop + viewport + overscan]`. */
export function visibleRange(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): VisibleRange {
  const rowCount = offsets.length - 1;
  if (rowCount <= 0) return { start: 0, end: 0 };
  const start = rowIndexAtOffset(offsets, scrollTop - overscan);
  const last = rowIndexAtOffset(offsets, scrollTop + viewportHeight + overscan);
  return { start: Math.max(0, start), end: Math.min(rowCount, last + 1) };
}

export interface ScrollAnchor {
  key: string;
  /** Row top minus scrollTop at capture time. */
  delta: number;
}

/** Capture the first row whose bottom is below the viewport top. */
export function captureAnchor(
  keys: readonly string[],
  offsets: readonly number[],
  scrollTop: number,
): ScrollAnchor | null {
  const index = rowIndexAtOffset(offsets, scrollTop);
  if (index < 0 || index >= keys.length) return null;
  return { key: keys[index], delta: offsets[index] - scrollTop };
}

/**
 * scrollTop that puts the anchor row back at its captured distance from the
 * viewport top, or null when the anchor row is gone.
 */
export function restoreAnchor(
  anchor: ScrollAnchor,
  keys: readonly string[],
  offsets: readonly number[],
): number | null {
  const index = keys.indexOf(anchor.key);
  if (index === -1) return null;
  return Math.max(0, offsets[index] - anchor.delta);
}

/** scrollTop that vertically centers row `index` (clamped to the content). */
export function centeredScrollTop(
  offsets: readonly number[],
  index: number,
  viewportHeight: number,
): number {
  const rowCount = offsets.length - 1;
  if (index < 0 || index >= rowCount) return 0;
  const rowTop = offsets[index];
  const rowHeight = offsets[index + 1] - rowTop;
  const maxScroll = Math.max(0, offsets[rowCount] - viewportHeight);
  const target = rowTop - (viewportHeight - rowHeight) / 2;
  return Math.min(maxScroll, Math.max(0, target));
}
