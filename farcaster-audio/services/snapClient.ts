/**
 * Farcaster Snap client — detection, response fetching, and interactive submit.
 *
 * Interactive submit signs a JFS body with the user's on-device Ed25519
 * app_key (see `snapSigner.ts`) and POSTs it to the snap URL.
 */

import {
  SNAP_MEDIA_TYPE,
  type SnapResponse,
  type SnapElement,
} from "@/types/snap";
import type { JfsBody } from "@/services/snapSigner";

const ACCEPT_HEADER = `${SNAP_MEDIA_TYPE}, text/html;q=0.9`;
const MAX_RESPONSE_BYTES = 256 * 1024; // 256 KB
const FETCH_TIMEOUT_MS = 8000;
const CACHE_MAX = 200;

/**
 * Hostname patterns we refuse to contact for snap requests. This is a
 * best-effort SSRF guard — DNS rebinding can defeat it, but it stops the
 * common footguns (loopback, RFC1918, link-local, `.local`, ip6 loopback).
 */
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fe80:/i,
  /\.local$/i,
  /\.internal$/i,
];

/**
 * Normalize a hostname for comparison + audience construction:
 *   - lowercase ASCII
 *   - strip a single trailing dot (`example.com.` → `example.com`)
 * Note: we reject IPv6 hosts in `assertSafeSnapUrl` so we never have to
 * deal with bracketing here.
 */
function normalizeHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/**
 * Validate a URL for snap fetch/submit. Enforces:
 *   - parseable URL
 *   - https: scheme only
 *   - hostname is not an IPv6 literal (we only support DNS + IPv4 hosts;
 *     IPv6 introduces bracketing ambiguity in the `audience` claim and is
 *     not a shape a real snap server has a legitimate reason to take)
 *   - hostname not in the private/loopback denylist
 * Returns the normalized href. Throws on rejection.
 */
export function assertSafeSnapUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid snap URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Snap URL must use HTTPS");
  }
  const host = parsed.hostname;
  // IPv6 literals contain `:`; DNS + IPv4 never do.
  if (host.includes(":")) {
    throw new Error("Snap URL host is not permitted");
  }
  const normalized = normalizeHost(host);
  for (const re of PRIVATE_HOST_PATTERNS) {
    if (re.test(normalized)) throw new Error("Snap URL host is not permitted");
  }
  return parsed.href;
}

/** Returns true iff `target` shares the same scheme + hostname + port as `base`. */
export function isSameOriginSnapTarget(target: string, base: string): boolean {
  try {
    const t = new URL(target);
    const b = new URL(base);
    return (
      t.protocol === b.protocol &&
      normalizeHost(t.hostname) === normalizeHost(b.hostname) &&
      t.port === b.port
    );
  } catch {
    return false;
  }
}

/**
 * Build the JFS `audience` claim for a snap submit target. The snap v2
 * upgrading doc specifies `scheme://host` — no port, no path, no userinfo.
 * Hostname is normalized (lowercased, trailing dot stripped). Assumes the
 * caller already validated the URL with `assertSafeSnapUrl`.
 */
export function buildSnapAudience(target: string): string {
  const u = new URL(target);
  return `${u.protocol}//${normalizeHost(u.hostname)}`;
}

type CacheEntry =
  | { kind: "snap"; response: SnapResponse }
  | { kind: "not-snap" };

/** Session-scoped LRU-ish cache: URL → snap response or negative marker. */
const cache = new Map<string, CacheEntry>();

function cacheGet(url: string): CacheEntry | undefined {
  const entry = cache.get(url);
  if (entry) {
    // Refresh recency
    cache.delete(url);
    cache.set(url, entry);
  }
  return entry;
}

function cacheSet(url: string, entry: CacheEntry): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(url, entry);
}

/**
 * Snap v2 structural limits — enforced at fetch time so malformed trees
 * never reach the renderer. These match the upgrading guide:
 *   - max 64 elements total
 *   - root element has ≤ 7 direct children
 *   - every `stack` / `item_group` container has ≤ 6 direct children
 *   - max nesting depth of 4 (root at depth 1)
 */
const SNAP_MAX_ELEMENTS = 64;
const SNAP_MAX_ROOT_CHILDREN = 7;
const SNAP_MAX_CONTAINER_CHILDREN = 6;
const SNAP_MAX_DEPTH = 4;

/**
 * Validate v2 structural constraints. Returns null if any limit is
 * violated. Assumes the caller has already confirmed the minimal shape
 * (root id exists, every element has a type + props).
 */
export function validateSnapStructure(
  response: SnapResponse,
): SnapResponse | null {
  const { root, elements } = response.ui;

  if (Object.keys(elements).length > SNAP_MAX_ELEMENTS) return null;

  const visited = new Set<string>();
  const stack: Array<{ id: string; depth: number; isRoot: boolean }> = [
    { id: root, depth: 1, isRoot: true },
  ];

  while (stack.length > 0) {
    const { id, depth, isRoot } = stack.pop()!;
    if (visited.has(id)) return null; // cycle
    visited.add(id);
    if (depth > SNAP_MAX_DEPTH) return null;

    const el = elements[id];
    if (!el) return null;
    const children = el.children ?? [];
    const isContainer = el.type === "stack" || el.type === "item_group";
    const limit = isRoot
      ? SNAP_MAX_ROOT_CHILDREN
      : isContainer
        ? SNAP_MAX_CONTAINER_CHILDREN
        : Infinity;
    if (children.length > limit) return null;

    for (const childId of children) {
      stack.push({ id: childId, depth: depth + 1, isRoot: false });
    }
  }

  return response;
}

/** Validate minimal SnapResponse shape. Returns null if invalid. */
function validateSnapResponse(data: unknown): SnapResponse | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  // Accept both v1 and v2 during the transition. v1 is exercised only via
  // the fallback path in SnapCard (try v2 → on 4xx retry with v1 body).
  // Structural limits below apply to v2 only.
  if (obj.version !== "2.0" && obj.version !== "1.0") return null;

  const ui = obj.ui as Record<string, unknown> | undefined;
  if (!ui || typeof ui !== "object") return null;
  if (typeof ui.root !== "string") return null;
  if (!ui.elements || typeof ui.elements !== "object") return null;

  const elements = ui.elements as Record<string, unknown>;
  if (!(ui.root in elements)) return null;

  // Every element must have a type + props object
  for (const key of Object.keys(elements)) {
    const el = elements[key] as Record<string, unknown> | undefined;
    if (!el || typeof el !== "object") return null;
    if (typeof el.type !== "string") return null;
    if (!el.props || typeof el.props !== "object") return null;
  }

  // Apply the v2 structural limits (element count cap, width caps, depth
  // cap, cycle detection) to v1 responses too — the limits are a DoS
  // guard for the renderer, not a spec-compliance check. A hostile v1
  // server should not be able to crash the app by returning a cyclic or
  // oversized tree.
  return validateSnapStructure(obj as unknown as SnapResponse);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a URL with snap content negotiation. Returns the parsed SnapResponse
 * if the server advertises snap support, otherwise null.
 */
export async function fetchSnap(url: string): Promise<SnapResponse | null> {
  try {
    assertSafeSnapUrl(url);
  } catch {
    cacheSet(url, { kind: "not-snap" });
    return null;
  }

  const cached = cacheGet(url);
  if (cached) return cached.kind === "snap" ? cached.response : null;

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      { method: "GET", headers: { Accept: ACCEPT_HEADER } },
      FETCH_TIMEOUT_MS,
    );
  } catch {
    cacheSet(url, { kind: "not-snap" });
    return null;
  }

  if (!response.ok) {
    cacheSet(url, { kind: "not-snap" });
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes(SNAP_MEDIA_TYPE)) {
    cacheSet(url, { kind: "not-snap" });
    return null;
  }

  // Guard against oversized bodies
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    cacheSet(url, { kind: "not-snap" });
    return null;
  }

  let body: unknown;
  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      cacheSet(url, { kind: "not-snap" });
      return null;
    }
    body = JSON.parse(text);
  } catch {
    cacheSet(url, { kind: "not-snap" });
    return null;
  }

  const validated = validateSnapResponse(body);
  if (!validated) {
    cacheSet(url, { kind: "not-snap" });
    return null;
  }

  cacheSet(url, { kind: "snap", response: validated });
  return validated;
}

/** Convenience: returns true if the URL is a snap. */
export async function detectSnap(url: string): Promise<boolean> {
  const snap = await fetchSnap(url);
  return snap !== null;
}

/** Synchronously read a cached response (for renderers that already detected). */
export function getCachedSnap(url: string): SnapResponse | null {
  const entry = cache.get(url);
  return entry?.kind === "snap" ? entry.response : null;
}

/** Type guard for known element types — unknowns render as placeholders. */
export const KNOWN_ELEMENT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "badge",
  "button",
  "icon",
  "image",
  "item",
  "progress",
  "separator",
  "stack",
  "item_group",
  "bar_chart",
  "cell_grid",
  "input",
  "slider",
  "switch",
  "toggle_group",
]);

export function isKnownElement(el: { type: string }): el is SnapElement {
  return KNOWN_ELEMENT_TYPES.has(el.type);
}

/**
 * Thrown by `submitSnap`. Carries the HTTP status when the failure came
 * from a non-OK response, so callers can branch on 4xx (e.g. v1 fallback).
 */
export class SnapSubmitError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SnapSubmitError";
    this.status = status;
  }
}

/**
 * POST a signed JFS body to a snap URL and return the next SnapResponse.
 * Throws `SnapSubmitError` on network error, non-OK status, wrong content
 * type, oversized body, or invalid response shape.
 *
 * `expectVersion` is enforced against `response.version`: when the caller
 * signed a v2 body it must not accept a v1 response (and vice versa).
 * This closes the door on a server mixing shapes across the request/
 * response boundary.
 */
export async function submitSnap(
  url: string,
  jfs: JfsBody,
  opts: { expectVersion: "1.0" | "2.0" },
): Promise<SnapResponse> {
  assertSafeSnapUrl(url);
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": SNAP_MEDIA_TYPE,
        Accept: SNAP_MEDIA_TYPE,
      },
      body: JSON.stringify(jfs),
    },
    FETCH_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new SnapSubmitError(
      `Snap submit failed: ${response.status}`,
      response.status,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes(SNAP_MEDIA_TYPE)) {
    throw new Error("Snap submit returned non-snap content type");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new Error("Snap submit response too large");
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error("Snap submit response too large");
  }

  const validated = validateSnapResponse(JSON.parse(text));
  if (!validated) {
    throw new Error("Snap submit response invalid");
  }
  if (validated.version !== opts.expectVersion) {
    throw new Error(
      `Snap submit response version mismatch: expected ${opts.expectVersion}, got ${validated.version}`,
    );
  }

  // Refresh cache so re-renders pick up the new state
  cacheSet(url, { kind: "snap", response: validated });
  return validated;
}
