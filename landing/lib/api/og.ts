/**
 * OG metadata API wrapper + pure URL extraction helpers.
 *
 * The `getOgMetadata` function wraps GET /v1/feed/og?url=..., which scrapes
 * Open Graph tags server-side (keeps the user's IP off third-party servers
 * and avoids CORS restrictions).
 *
 * The URL extraction helpers (`extractUrls`, `extractFirstUrl`, `cleanUrl`)
 * are ported directly from farcaster-audio/hooks/useOgPreview.ts and are
 * pure/synchronous — suitable for use in jest tests without mocks.
 *
 * A 600 ms debounce is recommended at the call-site (not enforced here) to
 * avoid hammering the backend on every keystroke; see the plan note in B.
 */

import { apiFetch } from "@/lib/api/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OgMetadata {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  site_name?: string | null;
}

// ---------------------------------------------------------------------------
// Pure URL helpers (no network — safe to test without mocks)
// ---------------------------------------------------------------------------

/** Matches http(s) URLs in text. */
const URL_RE = /https?:\/\/[^\s<)}\]]+/g;

/**
 * Strip trailing punctuation that is likely sentence-level (not part of the
 * URL itself). Mirrors the logic in useOgPreview.ts.
 */
export function cleanUrl(raw: string): string {
  return raw.replace(/[.,;:!?)}\]]+$/, "");
}

/**
 * Extract all URLs from `text`, with trailing sentence punctuation stripped.
 */
export function extractUrls(text: string): string[] {
  return (text.match(URL_RE) ?? []).map(cleanUrl);
}

/**
 * Extract the first URL from `text`, or null if none found.
 */
export function extractFirstUrl(text: string): string | null {
  const match = text.match(URL_RE);
  return match ? cleanUrl(match[0]) : null;
}

// ---------------------------------------------------------------------------
// API wrapper
// ---------------------------------------------------------------------------

/**
 * Fetch Open Graph metadata for `url` via the Juke backend.
 *
 * Maps to GET /v1/feed/og?url=<encoded-url>
 * Auth required (per backend rate-limit: Depends(get_current_user)).
 *
 * Returns null when:
 *  - `url` does not start with http:// or https:// (scheme guard — prevents
 *    accidentally forwarding javascript:, data:, or file: URIs to the backend).
 *  - The backend returns no meaningful metadata (title/description/image absent).
 *
 * Callers should treat null as "no preview to show" rather than an error.
 */
export async function getOgMetadata(url: string): Promise<OgMetadata | null> {
  // Scheme guard: only forward safe, absolute HTTP(S) URLs to the backend.
  if (!/^https?:\/\//i.test(url)) return null;

  const params = new URLSearchParams({ url });
  const data = await apiFetch<OgMetadata | undefined>(`/v1/feed/og?${params}`);

  // Guard against empty/204 responses and return null when there is nothing
  // worth rendering — callers treat null as "no preview".
  if (!data) return null;
  const hasMeta = data.title || data.description || data.image;
  return hasMeta ? data : null;
}
