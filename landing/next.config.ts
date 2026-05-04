import type { NextConfig } from "next";

// Shipped in report-only mode for the first week so any broken resource
// shows up in the browser console without blocking real users. Flip the
// header name to `Content-Security-Policy` after monitoring confirms no
// legitimate asset is blocked. TODO(security): enforce after 2026-04-29.
const CSP_DIRECTIVES = [
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
  // Allow embedding only inside the Warpcast / Farcaster miniapp hosts.
  "frame-ancestors https://warpcast.com https://*.warpcast.com https://client.farcaster.xyz https://*.farcaster.xyz",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  async headers() {
    return [
      {
        source: "/.well-known/apple-app-site-association",
        headers: [{ key: "Content-Type", value: "application/json" }],
      },
      {
        source: "/.well-known/farcaster.json",
        headers: [{ key: "Content-Type", value: "application/json" }],
      },
      {
        // Apply CSP to every route. `.well-known` responses above are
        // emitted before this rule and are JSON-only so CSP has no effect
        // on them in practice.
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy-Report-Only",
            value: CSP_DIRECTIVES,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
