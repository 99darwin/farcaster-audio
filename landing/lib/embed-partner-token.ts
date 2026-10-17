/**
 * Partner-token transport for `/embed/{id}`.
 *
 * Recommended: `/embed/{id}#token=<jwt>`. A URL fragment is never sent to
 * the server, so the JWT stays out of edge/access logs, server analytics and
 * `Referer` headers; the embed reads it client-side and strips it at once.
 *
 * Still accepted (deprecated): `?token=<jwt>`. It is stripped from the
 * address bar on mount, and {@link scrubAnalyticsUrl} keeps it out of
 * analytics events regardless of timing.
 */

/** URL parameter (query or fragment) that carries the partner JWT. */
export const PARTNER_TOKEN_PARAM = "token";

/**
 * Query parameters that carry credentials somewhere on juke.audio and must
 * never reach analytics.
 */
const SENSITIVE_QUERY_PARAMS: readonly string[] = [
  PARTNER_TOKEN_PARAM,
  "access_token",
  "refresh_token",
  "jwt",
  "prepare_id",
];

/** The partner token from a `#token=...` fragment, or null. */
export function readPartnerTokenFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const token = new URLSearchParams(raw).get(PARTNER_TOKEN_PARAM);
  return token && token.length > 0 ? token : null;
}

/**
 * `href` without the partner token in either the query or the fragment.
 * Other query/fragment parameters (e.g. `audio=off`) are preserved.
 */
export function stripPartnerToken(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(PARTNER_TOKEN_PARAM);
  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (fragment) {
    const params = new URLSearchParams(fragment);
    if (params.has(PARTNER_TOKEN_PARAM)) {
      params.delete(PARTNER_TOKEN_PARAM);
      const rest = params.toString();
      url.hash = rest ? `#${rest}` : "";
    }
  }
  return url.toString();
}

/**
 * Analytics-safe version of a page URL: credential-bearing query parameters
 * removed and the fragment dropped entirely (fragments are client-only state
 * and may carry tokens). Unparseable input yields null so the event is
 * discarded rather than sent raw.
 */
export function scrubAnalyticsUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  for (const param of SENSITIVE_QUERY_PARAMS) url.searchParams.delete(param);
  url.hash = "";
  return url.toString();
}
