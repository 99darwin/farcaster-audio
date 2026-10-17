/**
 * Encode an untrusted value (a route slug, a query value) as exactly one
 * path segment of a backend URL.
 *
 * `encodeURIComponent` escapes `/`, `?`, `#` and `%`, but leaves `.` alone,
 * and the WHATWG URL parser that `fetch` uses collapses `.` / `..` segments —
 * so `/v1/rooms/..` would resolve to `/v1/`. Those, and the empty string, are
 * rejected outright.
 *
 * @returns the encoded segment, or `null` when `value` can't be one.
 */
export function encodePathSegment(value: string): string | null {
  if (typeof value !== "string") return null;
  if (value === "" || value === "." || value === "..") return null;
  return encodeURIComponent(value);
}
