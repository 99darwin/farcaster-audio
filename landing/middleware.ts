import { NextResponse, type NextRequest } from "next/server";

// Enforced CSP. Set NEXT_PUBLIC_CSP_REPORT_ONLY=1 to drop back to
// report-only locally while debugging a blocked asset.
const CSP_HEADER =
  process.env.NEXT_PUBLIC_CSP_REPORT_ONLY === "1"
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
const LIVEKIT_WS_URL = process.env.NEXT_PUBLIC_LIVEKIT_WS_URL ?? "";

// Build connect-src from env-derived origins. Empty entries are filtered
// out so they cannot accidentally widen the policy (an empty string in a
// CSP source list is silently ignored by browsers but we strip it
// defensively). The wildcard `wss://*.livekit.cloud` is kept so
// self-hosted LiveKit on the default Cloud subdomain still works.
const connectSrc = [
  "'self'",
  API_BASE_URL,
  LIVEKIT_WS_URL,
  "wss://*.livekit.cloud",
  "https://*.livekit.cloud",
]
  .filter(Boolean)
  .join(" ");

const CSP_BASE = [
  "default-src 'self'",
  // Next.js injects inline bootstrap scripts; we keep 'unsafe-inline' for
  // now but should migrate to nonces when we move to strict CSP.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // API + LiveKit SFU. Origins come from NEXT_PUBLIC_API_BASE_URL and
  // NEXT_PUBLIC_LIVEKIT_WS_URL so self-hosted deployments can point at
  // their own infra without patching this file.
  `connect-src ${connectSrc}`,
  "img-src 'self' https: data:",
  "media-src 'self' blob: https:",
  "base-uri 'self'",
  "form-action 'self'",
];

// Default: Juke pages can only be framed inside a Farcaster client.
// Warpcast (now farcaster.xyz) is the canonical host.
const FRAME_ANCESTORS_DEFAULT =
  "frame-ancestors https://client.farcaster.xyz https://*.farcaster.xyz";

// Permissive embed gate used ONLY when the room's owning developer app
// has explicitly published `allowed_origins: null` (anonymous-listener
// rooms — iOS-created spaces, rooms whose owning app was deleted, etc.).
// Backend authorization is still the real gate; this only relaxes the
// browser-level frame-ancestors check.
const FRAME_ANCESTORS_EMBED_PERMISSIVE = "frame-ancestors *";

// Used when `/embed/*` policy lookup outright fails (Hub/backend down,
// 5xx, network error). Fail closed: refuse framing rather than fall
// open to `*`, which would let an attacker race a backend outage to
// embed a room with no allowlist.
const FRAME_ANCESTORS_EMBED_DENY = "frame-ancestors 'none'";

// Non-spaceId children of `/embed/*` that aren't subject to the per-app
// policy lookup (callbacks, demo). Treated as permissive.
const RESERVED_EMBED_SEGMENTS = new Set(["auth", "demo"]);

type EmbedPolicy = { allowed_origins: string[] | null };

type EmbedPolicyResult =
  | { kind: "policy"; allowed_origins: string[] | null }
  | { kind: "error" };

async function fetchEmbedPolicy(spaceId: string): Promise<EmbedPolicyResult> {
  try {
    const res = await fetch(
      `${API_BASE_URL}/v1/rooms/${encodeURIComponent(spaceId)}/embed-policy`,
      {
        // Edge runtime honors `next.revalidate`. Kept short so a
        // developer app's suspension or origin change propagates
        // quickly — the backend's Cache-Control is similarly tight.
        next: { revalidate: 60 },
      },
    );
    if (!res.ok) return { kind: "error" };
    const body = (await res.json()) as EmbedPolicy;
    return { kind: "policy", allowed_origins: body.allowed_origins };
  } catch {
    return { kind: "error" };
  }
}

function buildEmbedFrameAncestors(origins: string[]): string {
  // Each origin must be a valid URL origin (scheme://host[:port]). The
  // backend `_validate_allowed_origins` already rejects paths, query,
  // fragments, `*`, and `null`, so we trust the contents here.
  return `frame-ancestors ${origins.join(" ")}`;
}

function extractEmbedSpaceId(pathname: string): string | null {
  // /embed/[spaceId] or /embed/[spaceId]/anything
  const match = pathname.match(/^\/embed\/([^/]+)/);
  if (!match) return null;
  const segment = decodeURIComponent(match[1]);
  if (RESERVED_EMBED_SEGMENTS.has(segment)) return null;
  return segment;
}

export async function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const pathname = request.nextUrl.pathname;

  let frameAncestors: string;

  if (pathname.startsWith("/embed/")) {
    const spaceId = extractEmbedSpaceId(pathname);
    if (!spaceId) {
      // Reserved segments (`/embed/auth`, `/embed/demo`) — these are
      // not per-room and don't have a policy to look up. They're
      // intentionally embeddable anywhere as utility pages.
      frameAncestors = FRAME_ANCESTORS_EMBED_PERMISSIVE;
    } else {
      const result = await fetchEmbedPolicy(spaceId);
      if (result.kind === "error") {
        // Backend / network failure — fail closed.
        frameAncestors = FRAME_ANCESTORS_EMBED_DENY;
      } else if (result.allowed_origins && result.allowed_origins.length > 0) {
        frameAncestors = buildEmbedFrameAncestors(result.allowed_origins);
      } else {
        // Explicit `allowed_origins: null` from the backend = the room
        // has opted into embed-anywhere (anonymous-listener model).
        frameAncestors = FRAME_ANCESTORS_EMBED_PERMISSIVE;
      }
    }
  } else {
    frameAncestors = FRAME_ANCESTORS_DEFAULT;
  }

  response.headers.set(
    CSP_HEADER,
    [...CSP_BASE, frameAncestors].join("; "),
  );
  return response;
}

export const config = {
  // Skip Next.js internals and static assets — CSP on those does nothing
  // useful and would add latency.
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
