/**
 * Content-Security-Policy builder for every HTML route on juke.audio.
 *
 * Pure and dependency-free so the edge middleware can import it and jest can
 * test it. The policy is ENFORCED (not report-only) because the browser holds
 * credentials that any same-origin script could use: the Protocol Auth
 * auth-address key (`lib/auth/authAddressStore.ts` — non-extractable, but
 * still usable by script on this origin), the session tokens, and the
 * recovery-phrase field on `/app/login`. The script policy is therefore
 * nonce-based with `'strict-dynamic'`: only scripts carrying this request's
 * nonce, plus scripts they load, may run. No `'unsafe-inline'`, and
 * `'unsafe-eval'` only in `next dev` (React Refresh needs it).
 */

/** Header name for the enforced policy. */
export const CSP_HEADER = "Content-Security-Policy";

/** Response header that names the Reporting API endpoint for `report-to`. */
export const REPORTING_ENDPOINTS_HEADER = "Reporting-Endpoints";

/**
 * Same-origin violation collector (`app/api/csp-report/route.ts`). Being
 * same-origin it needs no connect-src entry, and it keeps a signal when a
 * vendor host the policy pins (storage, LiveKit, video CDN) moves.
 */
export const CSP_REPORT_PATH = "/api/csp-report";

/** Reporting API group name used by `report-to`. */
export const CSP_REPORT_GROUP = "csp-endpoint";

/** `Reporting-Endpoints` header value pairing {@link CSP_REPORT_GROUP}. */
export const REPORTING_ENDPOINTS_VALUE = `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;

/** `frame-ancestors` that forbids framing by anyone, including same-origin. */
export const FRAME_ANCESTORS_NONE: readonly string[] = ["'none'"];

// Routes that hold credentials (recovery-phrase entry, session-bearing app
// shell, developer console, the embed's sign-in popup) and are never
// legitimately framed: the Mini App homeUrl is `/miniapp` and embeds live
// under `/embed`. The popup is a top-level window, so `/auth` loses nothing.
const UNFRAMEABLE_ROUTE_PREFIXES: readonly string[] = ["/app", "/auth", "/developers"];

/** True when `pathname` is (under) a route that must never be framed. */
export function isUnframeablePath(pathname: string): boolean {
  return UNFRAMEABLE_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Request header the middleware uses to hand the nonce to server components.
 * Next.js itself reads the nonce from the `Content-Security-Policy` request
 * header and stamps it on its own bootstrap scripts.
 */
export const NONCE_HEADER = "x-nonce";

const NONCE_BYTES = 16;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Third-party endpoints the browser really talks to, inventoried from source.
 * Add to this list only with the call site that needs it.
 */
const THIRD_PARTY_CONNECT_SOURCES: readonly string[] = [
  // LiveKit SFU signalling + region discovery. The room's ws URL comes from
  // the backend (`LIVEKIT_WS_URL`, LiveKit Cloud); tighten to one project host
  // if we pin one.
  "wss://*.livekit.cloud",
  "https://*.livekit.cloud",
  // Voice-note upload: presigned PUT straight to object storage
  // (`lib/api/voice-notes.ts`). Backend `AWS_ENDPOINT_URL` defaults to
  // Railway storage; boto3 may sign path-style or virtual-hosted URLs.
  "https://your-s3-endpoint.example.com",
  "https://*.your-s3-endpoint.example.com",
  // Cast video embeds played through hls.js (XHR, so connect-src):
  // stream.farcaster.xyz 302s manifests to signed Cloudflare Stream URLs.
  "https://stream.farcaster.xyz",
  "https://*.cloudflarestream.com",
  "https://videodelivery.net",
];

export interface ContentSecurityPolicyOptions {
  /** Per-request nonce from {@link createNonce}. */
  nonce: string;
  /** `frame-ancestors` sources (e.g. `["*"]` or a list of origins). */
  frameAncestors: readonly string[];
  /** Juke API base URL (`NEXT_PUBLIC_API_BASE_URL`). */
  apiBaseUrl: string;
  /** Hypersnap node origin (`toHypersnapConnectSource()`). */
  hypersnapConnectSource: string;
  /** True only under `next dev`: allows `'unsafe-eval'` for React Refresh. */
  isDevelopment: boolean;
}

/** A fresh base64 nonce with 128 bits of entropy (edge + node safe). */
export function createNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * HTTP and WebSocket sources for the Juke API (REST + `/v1/rooms/events`).
 * Throws on a malformed URL, or plain HTTP to anything but a loopback dev
 * API, so a bad `NEXT_PUBLIC_API_BASE_URL` fails loudly.
 */
export function toApiConnectSources(apiBaseUrl: string): string[] {
  const url = new URL(apiBaseUrl);
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:") return [url.origin, `wss://${url.host}`];
  if (url.protocol === "http:" && isLoopback) {
    return [url.origin, `ws://${url.host}`];
  }
  throw new TypeError(`API base URL must be https: ${url.origin}`);
}

/** Serialize the enforced policy for one request. */
export function buildContentSecurityPolicy(
  options: ContentSecurityPolicyOptions,
): string {
  const { nonce, frameAncestors, isDevelopment } = options;
  if (!BASE64_PATTERN.test(nonce)) {
    throw new TypeError("CSP nonce must be a non-empty base64 string");
  }
  if (frameAncestors.length === 0) {
    throw new TypeError("frame-ancestors needs at least one source");
  }

  const scriptSources = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(isDevelopment ? ["'unsafe-eval'"] : []),
  ];
  const connectSources = [
    "'self'",
    ...toApiConnectSources(options.apiBaseUrl),
    options.hypersnapConnectSource,
    ...THIRD_PARTY_CONNECT_SOURCES,
  ];

  const directives: [string, readonly string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", scriptSources],
    // React renders `style=""` attributes (framer-motion, layout) and the
    // dev server injects <style> tags; neither can carry a nonce.
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // Avatars/cast images from arbitrary hosts, QR codes (data:), composer
    // image previews (blob:).
    ["img-src", ["'self'", "https:", "data:", "blob:"]],
    // next/font self-hosts the Google font under /_next/static.
    ["font-src", ["'self'"]],
    // Recordings/voice notes (presigned https), local recording preview and
    // hls.js MediaSource (blob:).
    ["media-src", ["'self'", "https:", "blob:"]],
    ["connect-src", connectSources],
    // hls.js runs its transmuxer in a blob: worker.
    ["worker-src", ["'self'", "blob:"]],
    // Cast mini apps are user-selected HTTPS iframes, capability-restricted
    // by MiniAppBrowser's sandbox/allow attributes.
    ["frame-src", ["https:"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", frameAncestors],
    // `report-uri` for browsers without the Reporting API (Firefox); browsers
    // that support `report-to` ignore `report-uri` when both are present.
    ["report-uri", [CSP_REPORT_PATH]],
    ["report-to", [CSP_REPORT_GROUP]],
  ];

  return directives
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}
