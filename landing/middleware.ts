import { NextResponse, type NextRequest } from "next/server";

// Shipped in report-only mode for the first week so any broken resource
// shows up in the browser console without blocking real users. Flip the
// header name to `Content-Security-Policy` after monitoring confirms no
// legitimate asset is blocked. TODO(security): enforce after 2026-04-29.
const CSP_HEADER = "Content-Security-Policy-Report-Only";

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

// /embed/* is the SDK entrypoint — third-party sites embed it via iframe.
// Backend enforces the per-app `allowed_origins` on every authenticated
// API call from inside the iframe, so the browser-level frame-ancestors
// is left permissive. To tighten this to a per-app dynamic policy we'd
// need to link rooms → apps (rooms.created_by_app_id), then look up the
// app's allowed_origins here. Tracked as a follow-up.
const FRAME_ANCESTORS_EMBED = "frame-ancestors *";

export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const isEmbed = request.nextUrl.pathname.startsWith("/embed/");
  const frameAncestors = isEmbed
    ? FRAME_ANCESTORS_EMBED
    : FRAME_ANCESTORS_DEFAULT;
  response.headers.set(CSP_HEADER, [...CSP_BASE, frameAncestors].join("; "));
  return response;
}

export const config = {
  // Skip Next.js internals and static assets — CSP on those does nothing
  // useful and would add latency.
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
