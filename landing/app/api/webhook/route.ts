import { createPublicKey, verify } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8000";
const WEBHOOK_SECRET = process.env.MINIAPP_WEBHOOK_SECRET || "";
const FARCASTER_HUB_URL = process.env.FARCASTER_HUB_URL || "";
const ENVIRONMENT = process.env.ENVIRONMENT || "development";

const ALLOWED_EVENTS = new Set([
  "frame_added",
  "frame_removed",
  "notifications_enabled",
  "notifications_disabled",
  // Legacy aliases — some clients still send the pre-rename names.
  "miniapp_added",
  "miniapp_removed",
]);

const HUB_TIMEOUT_MS = 5000;

// SPKI DER prefix for an ed25519 public key. Concatenated with the raw 32-byte
// public key it forms a valid SubjectPublicKeyInfo that `createPublicKey` can
// import — avoids pulling in a wider crypto lib just to wrap raw ed25519 keys.
const SPKI_ED25519_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

type JfsHeader = { fid: number; type: string; key: string };

function decodeJfsHeader(header: string): JfsHeader | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(header, "base64url").toString("utf-8"),
    ) as Partial<JfsHeader>;
    if (
      typeof parsed.fid !== "number" ||
      !Number.isInteger(parsed.fid) ||
      parsed.fid <= 0
    ) {
      return null;
    }
    if (parsed.type !== "app_key") return null;
    if (
      typeof parsed.key !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(parsed.key)
    ) {
      return null;
    }
    return parsed as JfsHeader;
  } catch {
    return null;
  }
}

function verifyEd25519(
  header: string,
  payload: string,
  signatureB64: string,
  pubkeyHex: string,
): boolean {
  let sigBytes: Buffer;
  let pubkeyBytes: Buffer;
  try {
    sigBytes = Buffer.from(signatureB64, "base64url");
    pubkeyBytes = Buffer.from(pubkeyHex.slice(2), "hex");
  } catch {
    return false;
  }
  if (sigBytes.length !== 64 || pubkeyBytes.length !== 32) return false;

  const spki = Buffer.concat([SPKI_ED25519_PREFIX, pubkeyBytes]);
  let pubKey;
  try {
    pubKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    return false;
  }
  const signingInput = Buffer.from(`${header}.${payload}`, "utf-8");
  try {
    return verify(null, signingInput, pubKey, sigBytes);
  } catch {
    return false;
  }
}

async function isKeyRegisteredToFid(fid: number, key: string): Promise<boolean> {
  // Without a Hub URL we cannot prove the key belongs to the claimed FID.
  // Local dev opts in to skipping this check (see route handler); production
  // refuses to run unsigned-by-fid events.
  if (!FARCASTER_HUB_URL) return false;
  try {
    const res = await fetch(
      `${FARCASTER_HUB_URL}/v1/onChainSignersByFid?fid=${fid}&signer=${key}`,
      { signal: AbortSignal.timeout(HUB_TIMEOUT_MS) },
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { events?: unknown[] };
    return Array.isArray(data.events) && data.events.length > 0;
  } catch {
    return false;
  }
}

/**
 * Farcaster miniapp webhook handler.
 *
 * Receives server events forwarded by a Farcaster client (Warpcast, etc.). The
 * body is a JSON Farcaster Signature (JFS) envelope:
 *   { header: string, payload: string, signature: string }
 *
 * - `header`    — base64url JSON `{ fid, type: "app_key", key }`; `key` is
 *                 the 0x-prefixed hex of the user's app key public key.
 * - `payload`   — base64url JSON containing `{ event, notificationDetails? }`.
 * - `signature` — base64url ed25519 signature over `${header}.${payload}`.
 *
 * The handler:
 *   1. Requires the envelope fields and validates their shape.
 *   2. Verifies the ed25519 signature against the header's `key`.
 *   3. Verifies via Farcaster Hub that the `key` is currently registered to
 *      the claimed `fid` — without this an attacker can mint their own
 *      keypair and sign events for arbitrary FIDs.
 *   4. Validates the event name against an allowlist.
 *   5. Forwards to the backend and returns the backend's status — so a
 *      backend rejection surfaces to Farcaster instead of being swallowed.
 *
 * Configure `FARCASTER_HUB_URL` (e.g. https://hub-api.neynar.com) for the
 * registry check in non-development environments.
 */
export async function POST(request: NextRequest) {
  let body: { header?: string; payload?: string; signature?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.header || !body.payload || !body.signature) {
    return NextResponse.json(
      { error: "Missing JFS envelope fields" },
      { status: 400 },
    );
  }

  const header = decodeJfsHeader(body.header);
  if (!header) {
    return NextResponse.json({ error: "Invalid header" }, { status: 400 });
  }

  if (!verifyEd25519(body.header, body.payload, body.signature, header.key)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Bind the signing key to the claimed FID via the Farcaster Key Registry.
  // In non-development we require this. Local dev can skip when no Hub is
  // configured, so contributors can exercise the path without infra.
  if (FARCASTER_HUB_URL) {
    const registered = await isKeyRegisteredToFid(header.fid, header.key);
    if (!registered) {
      return NextResponse.json(
        { error: "Key not registered to FID" },
        { status: 401 },
      );
    }
  } else if (ENVIRONMENT !== "development") {
    return NextResponse.json(
      { error: "FARCASTER_HUB_URL not configured" },
      { status: 500 },
    );
  }

  let event: { event?: string; notificationDetails?: { url: string; token: string } };
  try {
    event = JSON.parse(
      Buffer.from(body.payload, "base64url").toString("utf-8"),
    );
  } catch {
    return NextResponse.json({ error: "Invalid payload encoding" }, { status: 400 });
  }

  if (typeof event.event !== "string" || !ALLOWED_EVENTS.has(event.event)) {
    return NextResponse.json({ error: "Unsupported event" }, { status: 400 });
  }

  let backendResponse: Response;
  try {
    backendResponse = await fetch(`${API_BASE_URL}/v1/webhooks/miniapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        fid: header.fid,
        event: event.event,
        notification_url: event.notificationDetails?.url ?? null,
        notification_token: event.notificationDetails?.token ?? null,
      }),
    });
  } catch {
    return NextResponse.json({ error: "Backend unreachable" }, { status: 502 });
  }

  if (!backendResponse.ok) {
    return NextResponse.json(
      { error: "Backend rejected event" },
      { status: 502 },
    );
  }

  return NextResponse.json({ success: true });
}
