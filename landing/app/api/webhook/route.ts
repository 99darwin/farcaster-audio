import { NextRequest, NextResponse } from "next/server";
import {
  MAX_MINIAPP_WEBHOOK_BYTES,
  parseJfsEnvelope,
  proxyStatusFor,
} from "@/lib/security/miniappWebhook";
import {
  clientIpFromHeaders,
  createFixedWindowLimiter,
} from "@/lib/security/rateLimit";

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8000";
const WEBHOOK_SECRET = process.env.MINIAPP_WEBHOOK_SECRET || "";
const BACKEND_TIMEOUT_MS = 10_000;
// Events come from Farcaster clients' servers (Warpcast, Base), so all of a
// client's users share a few source IPs: keep this well above their burst
// rate. Per-IP, per-instance; the backend enforces the authoritative limit.
const REQUESTS_PER_IP_PER_MINUTE = 600;
// Read by the backend (only alongside a valid secret) to key its per-sender
// rate limit and failed-auth budget on the real sender, not our egress IP.
const SENDER_IP_HEADER = "X-Juke-Sender-Ip";
const ONE_MINUTE_MS = 60_000;
const MAX_TRACKED_IPS = 10_000;

const limiter = createFixedWindowLimiter({
  limit: REQUESTS_PER_IP_PER_MINUTE,
  windowMs: ONE_MINUTE_MS,
  maxKeys: MAX_TRACKED_IPS,
});

/**
 * Farcaster Mini App webhook proxy.
 *
 * Farcaster clients POST signed server events (miniapp_added,
 * miniapp_removed, notifications_enabled, notifications_disabled) as a JFS
 * (JSON Farcaster Signature) envelope:
 *   { header: string, payload: string, signature: string }
 *
 * The envelope is forwarded unchanged to the backend, which verifies the
 * Ed25519 signature and that `header.key` is an active app key of
 * `header.fid` before trusting anything in it. This route only rate-limits,
 * size-caps and shape-checks; it never decodes or trusts the FID itself.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const senderIp = clientIpFromHeaders(request.headers);
  if (!limiter.isAllowed(senderIp)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_MINIAPP_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  // Re-checked after reading: content-length is optional (chunked bodies).
  const raw = await request.text();
  if (raw.length > MAX_MINIAPP_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const envelope = parseJfsEnvelope(parsed);
  if (!envelope) {
    return NextResponse.json(
      { error: "Missing signature envelope" },
      { status: 400 },
    );
  }

  if (!WEBHOOK_SECRET) {
    console.error("[miniapp-webhook] MINIAPP_WEBHOOK_SECRET is not configured");
    return NextResponse.json(
      { error: "Webhook not configured" },
      { status: 503 },
    );
  }

  let backendStatus: number;
  try {
    const response = await fetch(`${API_BASE_URL}/v1/webhooks/miniapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": WEBHOOK_SECRET,
        [SENDER_IP_HEADER]: senderIp,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
    backendStatus = response.status;
  } catch {
    // Backend unreachable: 502 so the Farcaster client retries the event.
    return NextResponse.json(
      { error: "Upstream unavailable" },
      { status: 502 },
    );
  }

  const status = proxyStatusFor(backendStatus);
  if (status === 200) return NextResponse.json({ success: true });
  return NextResponse.json({ error: "Webhook rejected" }, { status });
}
