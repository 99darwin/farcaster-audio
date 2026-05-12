import { NextResponse, type NextRequest } from "next/server";

// Shipped in report-only mode so any broken resource shows up in the
// browser console without blocking real users. Flip the header name to
// `Content-Security-Policy` after a monitoring window confirms no
// legitimate asset is blocked. TODO(security): enforce.
const CSP_HEADER = "Content-Security-Policy-Report-Only";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://your-api-host.example.com";

const CSP_BASE = [
  "default-src 'self'",
  // Next.js injects inline bootstrap scripts; we keep 'unsafe-inline' for
  // now but should migrate to nonces when we move to strict CSP.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // API + LiveKit SFU. Backend config defaults to wss://*.livekit.cloud
  // (see backend/app/config.py); tighten to a single host if we pin one.
  "connect-src 'self' https://your-api-host.example.com wss://*.livekit.cloud https://*.livekit.cloud",
  "img-src 'self' https: data:",
  "media-src 'self' blob: https:",
  "base-uri 'self'",
  "form-action 'self'",
];

// Default: Juke pages can only be framed inside a Farcaster client.
// Warpcast (now farcaster.xyz) is the canonical host.
const FRAME_ANCESTORS_DEFAULT =
  "frame-ancestors https://client.farcaster.xyz https://*.farcaster.xyz";

// Fallback for `/embed/*` when the room has no owning developer app —
// for example iOS-created rooms, or rooms whose app was deleted. The
// backend's anonymous-listener and authenticated APIs are still the
// real authorization layer; this just opens the browser-level gate.
const FRAME_ANCESTORS_EMBED_PERMISSIVE = "frame-ancestors *";

// Non-spaceId children of `/embed/*` that aren't subject to the per-app
// policy lookup (callbacks, demo). Treated as permissive.
const RESERVED_EMBED_SEGMENTS = new Set(["auth", "demo"]);

type EmbedPolicy = { allowed_origins: string[] | null };

async function fetchEmbedPolicy(spaceId: string): Promise<EmbedPolicy | null> {
  try {
    const res = await fetch(
      `${API_BASE_URL}/v1/rooms/${encodeURIComponent(spaceId)}/embed-policy`,
      {
        // Edge runtime honors `next.revalidate`; the room → app linkage
        // is immutable once set, so caching is safe and cheap.
        next: { revalidate: 300 },
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as EmbedPolicy;
  } catch {
    return null;
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
      frameAncestors = FRAME_ANCESTORS_EMBED_PERMISSIVE;
    } else {
      const policy = await fetchEmbedPolicy(spaceId);
      const origins = policy?.allowed_origins;
      frameAncestors =
        origins && origins.length > 0
          ? buildEmbedFrameAncestors(origins)
          : FRAME_ANCESTORS_EMBED_PERMISSIVE;
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
