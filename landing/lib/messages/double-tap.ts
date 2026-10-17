/**
 * Double-tap detection for the Telegram-style quick reaction on touch.
 *
 * Browsers don't reliably fire `dblclick` for touch (and `touch-action: pan-y`
 * on the bubble changes that further), so touch taps are paired here; mouse
 * input uses the native `dblclick`.
 */

/** The reaction a double-tap / double-click toggles. */
export const QUICK_TOGGLE_REACTION = "❤️";
/** Max gap between the two taps. */
export const DOUBLE_TAP_MS = 300;
/** Max distance between the two taps. */
export const DOUBLE_TAP_SLOP_PX = 24;

export interface Tap {
  time: number;
  x: number;
  y: number;
}

/** True when `current` completes a double-tap started by `previous`. */
export function isDoubleTap(previous: Tap | null, current: Tap): boolean {
  if (!previous) return false;
  const elapsed = current.time - previous.time;
  if (elapsed < 0 || elapsed > DOUBLE_TAP_MS) return false;
  return (
    Math.abs(current.x - previous.x) <= DOUBLE_TAP_SLOP_PX &&
    Math.abs(current.y - previous.y) <= DOUBLE_TAP_SLOP_PX
  );
}
