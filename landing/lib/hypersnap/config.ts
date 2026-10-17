/**
 * Browser-visible Hypersnap node config. Kept dependency-free so the edge
 * middleware (CSP `connect-src`) and the sign-in flow read the same value
 * without pulling viem into the middleware bundle.
 */

const DEFAULT_HYPERSNAP_HTTP_URL = "https://haatz.quilibrium.com";

/** Public Hypersnap node the browser reads from (no API key). */
export const HYPERSNAP_HTTP_URL =
  process.env.NEXT_PUBLIC_HYPERSNAP_HTTP_URL || DEFAULT_HYPERSNAP_HTTP_URL;

/**
 * The CSP source for a Hypersnap base URL — its origin only. Throws on a
 * malformed URL, or plain HTTP to anything but a loopback dev node, so a bad
 * `NEXT_PUBLIC_HYPERSNAP_HTTP_URL` fails the deploy loudly instead of silently
 * breaking username sign-in.
 */
export function toHypersnapConnectSource(
  baseUrl: string = HYPERSNAP_HTTP_URL,
): string {
  const url = new URL(baseUrl);
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new TypeError(`Hypersnap URL must be https: ${url.origin}`);
  }
  return url.origin;
}
