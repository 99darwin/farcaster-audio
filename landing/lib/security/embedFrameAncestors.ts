/**
 * `frame-ancestors` resolution for `/embed/*` (used by `middleware.ts`).
 *
 * The backend's `GET /v1/rooms/{id}/embed-policy` answers with the owning
 * developer app's `allowed_origins`:
 *   - `null`  — legacy room with no owning app: no enforcement intent, so any
 *               site may frame it (the backend APIs remain the real gate);
 *   - `[]`    — the owning app is suspended/deleted (or lists no origins): an
 *               explicit block;
 *   - `[...]` — only those origins may frame it.
 *
 * Anything else — a non-2xx, a timeout, a network error, a malformed body —
 * FAILS CLOSED to `'none'`. Failing open would let an attacker who can make
 * the lookup fail (or race a backend outage) frame a suspended app's room.
 *
 * Pure apart from the injected `fetch`, so jest can cover every branch.
 */

import { encodePathSegment } from "@/lib/api-path";
import { FRAME_ANCESTORS_NONE } from "@/lib/security/csp";

/** Any site may frame a legacy room that has no owning developer app. */
export const FRAME_ANCESTORS_EMBED_PERMISSIVE: readonly string[] = ["*"];

/** Lookup budget. The middleware blocks the response on it, so keep it tight. */
export const EMBED_POLICY_TIMEOUT_MS = 3000;

// Non-spaceId children of `/embed/*` that aren't subject to the per-app
// policy lookup (the demo page). Treated as permissive.
const RESERVED_EMBED_SEGMENTS: ReadonlySet<string> = new Set(["demo"]);

const EMBED_PATH_PATTERN = /^\/embed\/([^/]+)/;

export type EmbedPolicyLookup =
  | { readonly status: "ok"; readonly allowedOrigins: readonly string[] | null }
  | { readonly status: "failed" };

const LOOKUP_FAILED: EmbedPolicyLookup = { status: "failed" };

/**
 * Normalize one stored `allowed_origins` entry to a CSP source, or `null`
 * when it isn't an http(s) origin. The backend stores entries as typed
 * (case, an optional trailing `/`), so they're canonicalized through
 * `URL.origin` — which also guarantees nothing that could smuggle extra
 * directives (`;`, whitespace, paths, wildcards) reaches the header.
 */
export function toFrameAncestorSource(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
  if (parsed.hostname.includes("*")) return null;
  return parsed.origin;
}

/**
 * Validate the backend's JSON body. An unexpected shape is a failure;
 * individual entries that aren't origins are dropped (so a list of only
 * invalid entries becomes an explicit block).
 */
export function parseEmbedPolicy(body: unknown): EmbedPolicyLookup {
  if (typeof body !== "object" || body === null) return LOOKUP_FAILED;
  if (!("allowed_origins" in body)) return LOOKUP_FAILED;
  const origins = (body as { allowed_origins: unknown }).allowed_origins;
  if (origins === null) return { status: "ok", allowedOrigins: null };
  if (!Array.isArray(origins)) return LOOKUP_FAILED;
  const sources = origins
    .map(toFrameAncestorSource)
    .filter((source): source is string => source !== null);
  return { status: "ok", allowedOrigins: [...new Set(sources)] };
}

/** Map a lookup result to the `frame-ancestors` source list. */
export function frameAncestorsForEmbedPolicy(
  lookup: EmbedPolicyLookup,
): readonly string[] {
  if (lookup.status === "failed") return FRAME_ANCESTORS_NONE;
  const { allowedOrigins } = lookup;
  if (allowedOrigins === null) return FRAME_ANCESTORS_EMBED_PERMISSIVE;
  if (allowedOrigins.length === 0) return FRAME_ANCESTORS_NONE;
  return allowedOrigins;
}

export interface FetchEmbedPolicyOptions {
  readonly apiBaseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Fetch and validate a room's embed policy. Never throws. */
export async function fetchEmbedPolicy(
  spaceId: string,
  {
    apiBaseUrl,
    fetchImpl = fetch,
    timeoutMs = EMBED_POLICY_TIMEOUT_MS,
  }: FetchEmbedPolicyOptions,
): Promise<EmbedPolicyLookup> {
  const segment = encodePathSegment(spaceId);
  if (!segment) return LOOKUP_FAILED;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(
      `${apiBaseUrl}/v1/rooms/${segment}/embed-policy`,
      {
        signal: controller.signal,
        // Edge runtime honors `next.revalidate`. Kept short so a developer
        // app's suspension or origin change propagates quickly — the
        // backend's Cache-Control is similarly tight.
        next: { revalidate: 60 },
      } as RequestInit,
    );
    if (!res.ok) return LOOKUP_FAILED;
    return parseEmbedPolicy(await res.json());
  } catch {
    return LOOKUP_FAILED;
  } finally {
    clearTimeout(timer);
  }
}

export type EmbedPathTarget =
  | { readonly kind: "space"; readonly spaceId: string }
  | { readonly kind: "reserved" }
  | { readonly kind: "invalid" };

/** Classify an `/embed/...` pathname. */
export function parseEmbedPath(pathname: string): EmbedPathTarget {
  const match = pathname.match(EMBED_PATH_PATTERN);
  if (!match) return { kind: "invalid" };
  let segment: string;
  try {
    segment = decodeURIComponent(match[1]);
  } catch {
    // Malformed percent-encoding: no such room, and no reason to frame it.
    return { kind: "invalid" };
  }
  if (RESERVED_EMBED_SEGMENTS.has(segment)) return { kind: "reserved" };
  return { kind: "space", spaceId: segment };
}

/** `frame-ancestors` for a pathname under `/embed/`. */
export async function resolveEmbedFrameAncestors(
  pathname: string,
  options: FetchEmbedPolicyOptions,
): Promise<readonly string[]> {
  const target = parseEmbedPath(pathname);
  if (target.kind === "reserved") return FRAME_ANCESTORS_EMBED_PERMISSIVE;
  if (target.kind === "invalid") return FRAME_ANCESTORS_NONE;
  return frameAncestorsForEmbedPolicy(
    await fetchEmbedPolicy(target.spaceId, options),
  );
}
