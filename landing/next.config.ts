import type { NextConfig } from "next";

// CSP is set in landing/middleware.ts so we can vary frame-ancestors per
// route (SDK embed routes need to be framed by third-party sites, the
// rest of Juke must only be framed inside a Farcaster client).

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
    ];
  },
};

export default nextConfig;
