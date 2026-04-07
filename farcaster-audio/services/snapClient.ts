/**
 * Farcaster Snap client — detection, response fetching, and interactive submit.
 *
 * Interactive submit signs a JFS body with the user's on-device Ed25519
 * app_key (see `snapSigner.ts`) and POSTs it to the snap URL.
 */

import { SNAP_MEDIA_TYPE, type SnapResponse, type SnapElement } from '@/types/snap';
import type { JfsBody } from '@/services/snapSigner';

const ACCEPT_HEADER = `${SNAP_MEDIA_TYPE}, text/html;q=0.9`;
const MAX_RESPONSE_BYTES = 256 * 1024; // 256 KB
const FETCH_TIMEOUT_MS = 8000;
const CACHE_MAX = 200;

type CacheEntry =
  | { kind: 'snap'; response: SnapResponse }
  | { kind: 'not-snap' };

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

/** Validate minimal SnapResponse shape. Returns null if invalid. */
function validateSnapResponse(data: unknown): SnapResponse | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

  if (obj.version !== '1.0') return null;

  const ui = obj.ui as Record<string, unknown> | undefined;
  if (!ui || typeof ui !== 'object') return null;
  if (typeof ui.root !== 'string') return null;
  if (!ui.elements || typeof ui.elements !== 'object') return null;

  const elements = ui.elements as Record<string, unknown>;
  if (!(ui.root in elements)) return null;

  // Every element must have a type + props object
  for (const key of Object.keys(elements)) {
    const el = elements[key] as Record<string, unknown> | undefined;
    if (!el || typeof el !== 'object') return null;
    if (typeof el.type !== 'string') return null;
    if (!el.props || typeof el.props !== 'object') return null;
  }

  return obj as unknown as SnapResponse;
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
  const cached = cacheGet(url);
  if (cached) return cached.kind === 'snap' ? cached.response : null;

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      { method: 'GET', headers: { Accept: ACCEPT_HEADER } },
      FETCH_TIMEOUT_MS,
    );
  } catch {
    cacheSet(url, { kind: 'not-snap' });
    return null;
  }

  if (!response.ok) {
    cacheSet(url, { kind: 'not-snap' });
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes(SNAP_MEDIA_TYPE)) {
    cacheSet(url, { kind: 'not-snap' });
    return null;
  }

  // Guard against oversized bodies
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    cacheSet(url, { kind: 'not-snap' });
    return null;
  }

  let body: unknown;
  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      cacheSet(url, { kind: 'not-snap' });
      return null;
    }
    body = JSON.parse(text);
  } catch {
    cacheSet(url, { kind: 'not-snap' });
    return null;
  }

  const validated = validateSnapResponse(body);
  if (!validated) {
    cacheSet(url, { kind: 'not-snap' });
    return null;
  }

  cacheSet(url, { kind: 'snap', response: validated });
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
  return entry?.kind === 'snap' ? entry.response : null;
}

/** Type guard for known element types — unknowns render as placeholders. */
export const KNOWN_ELEMENT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'badge',
  'button',
  'icon',
  'image',
  'item',
  'progress',
  'separator',
  'stack',
  'item_group',
  'bar_chart',
  'cell_grid',
  'input',
  'slider',
  'switch',
  'toggle_group',
]);

export function isKnownElement(el: { type: string }): el is SnapElement {
  return KNOWN_ELEMENT_TYPES.has(el.type);
}

/**
 * POST a signed JFS body to a snap URL and return the next SnapResponse.
 * Throws on network error, non-OK status, wrong content type, oversized body,
 * or invalid response shape.
 */
export async function submitSnap(url: string, jfs: JfsBody): Promise<SnapResponse> {
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': SNAP_MEDIA_TYPE,
        Accept: SNAP_MEDIA_TYPE,
      },
      body: JSON.stringify(jfs),
    },
    FETCH_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new Error(`Snap submit failed: ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes(SNAP_MEDIA_TYPE)) {
    throw new Error('Snap submit returned non-snap content type');
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new Error('Snap submit response too large');
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error('Snap submit response too large');
  }

  const validated = validateSnapResponse(JSON.parse(text));
  if (!validated) {
    throw new Error('Snap submit response invalid');
  }

  // Refresh cache so re-renders pick up the new state
  cacheSet(url, { kind: 'snap', response: validated });
  return validated;
}
