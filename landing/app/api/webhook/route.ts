import { NextRequest, NextResponse } from "next/server";

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8000";
const WEBHOOK_SECRET = process.env.MINIAPP_WEBHOOK_SECRET || "";

/**
 * Farcaster miniapp webhook handler.
 *
 * Receives signed server events from Farcaster clients. The body is a JFS
 * (JSON Farcaster Signature) envelope:
 *   { header: string, payload: string, signature: string }
 *
 * - `header` is base64url-encoded JSON containing { fid, type, key }
 * - `payload` is base64url-encoded JSON containing the event
 * - `signature` is an ed25519 signature (verification TODO with key registry)
 *
 * Events: miniapp_added, miniapp_removed, notifications_enabled, notifications_disabled
 */
export async function POST(request: NextRequest) {
  let body: { header?: string; payload?: string; signature?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.header || !body.payload) {
    return NextResponse.json({ error: "Missing signature envelope" }, { status: 400 });
  }

  // Decode the header to extract FID
  let fid: number;
  try {
    const headerJson = JSON.parse(
      Buffer.from(body.header, "base64url").toString("utf-8"),
    );
    fid = headerJson.fid;
    if (!fid || typeof fid !== "number") {
      return NextResponse.json({ error: "Invalid FID in header" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid header encoding" }, { status: 400 });
  }

  // Decode the payload to get the event
  let event: { event: string; notificationDetails?: { url: string; token: string } };
  try {
    event = JSON.parse(
      Buffer.from(body.payload, "base64url").toString("utf-8"),
    );
  } catch {
    return NextResponse.json({ error: "Invalid payload encoding" }, { status: 400 });
  }

  // TODO: Verify ed25519 signature against Farcaster key registry

  // Forward to backend for persistence
  try {
    await fetch(`${API_BASE_URL}/v1/webhooks/miniapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        fid,
        event: event.event,
        notification_url: event.notificationDetails?.url ?? null,
        notification_token: event.notificationDetails?.token ?? null,
      }),
    });
  } catch {
    // Don't fail the webhook if backend is temporarily down
  }

  return NextResponse.json({ success: true });
}
