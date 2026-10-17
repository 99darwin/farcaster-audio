import { NextResponse, type NextRequest } from "next/server";
import { toHypersnapConnectSource } from "@/lib/hypersnap/config";
import {
  CSP_HEADER,
  FRAME_ANCESTORS_NONE,
  NONCE_HEADER,
  REPORTING_ENDPOINTS_HEADER,
  REPORTING_ENDPOINTS_VALUE,
  buildContentSecurityPolicy,
  createNonce,
  isUnframeablePath,
} from "@/lib/security/csp";
import { resolveEmbedFrameAncestors } from "@/lib/security/embedFrameAncestors";

// Enforced, per-request-nonce CSP for every HTML route (policy and rationale
// in `lib/security/csp.ts`). Next.js reads the nonce from the request's
// `Content-Security-Policy` header and stamps it on its inline bootstrap
// scripts — only for dynamically rendered pages, which is why the root layout
// opts every page into dynamic rendering.

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

// Resolved once per isolate: a malformed configured URL throws here, failing
// requests loudly instead of shipping a policy that silently breaks sign-in.
const HYPERSNAP_CONNECT_SOURCE = toHypersnapConnectSource();
const IS_DEVELOPMENT = process.env.NODE_ENV === "development";

// Default for pages opened inside a Farcaster client (`/miniapp/**`, share
// and marketing pages). `/app/**`, `/auth/**` and `/developers/**` get `'none'`.
// Warpcast (now farcaster.xyz) is the canonical host.
const FRAME_ANCESTORS_DEFAULT: readonly string[] = [
  "https://client.farcaster.xyz",
  "https://*.farcaster.xyz",
];

async function resolveFrameAncestors(
  pathname: string,
): Promise<readonly string[]> {
  if (isUnframeablePath(pathname)) return FRAME_ANCESTORS_NONE;
  if (!pathname.startsWith("/embed/")) return FRAME_ANCESTORS_DEFAULT;
  // Per-room developer-app policy; fails closed (`lib/security/embedFrameAncestors.ts`).
  return resolveEmbedFrameAncestors(pathname, { apiBaseUrl: API_BASE_URL });
}

export async function middleware(request: NextRequest) {
  const nonce = createNonce();
  const policy = buildContentSecurityPolicy({
    nonce,
    frameAncestors: await resolveFrameAncestors(request.nextUrl.pathname),
    apiBaseUrl: API_BASE_URL,
    hypersnapConnectSource: HYPERSNAP_CONNECT_SOURCE,
    isDevelopment: IS_DEVELOPMENT,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set(CSP_HEADER, policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(CSP_HEADER, policy);
  response.headers.set(REPORTING_ENDPOINTS_HEADER, REPORTING_ENDPOINTS_VALUE);
  return response;
}

export const config = {
  // Skip Next.js internals and static assets — CSP on those does nothing
  // useful and would add latency.
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
