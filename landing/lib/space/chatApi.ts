"use client";

/**
 * FIP-2 space chat REST for the web app, ported from
 * the mobile app's feed + `services/api.ts` clients. A space's chat is
 * the Farcaster conversation threaded under `Room.cast_hash`: every message is
 * a cast whose `parent` is that root hash, fetched/published through the
 * backend's Hypersnap proxy (`/v1/feed/*`, Bearer JWT required).
 */

import { apiFetch } from "@/lib/api/client";
import type { Space } from "@/lib/spaces";

export interface ChatCastAuthor {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
}

export interface ChatCast {
  hash: string;
  author: ChatCastAuthor;
  text: string;
  timestamp: string;
  parent_hash?: string | null;
  is_spam?: boolean;
  direct_replies?: ChatCast[];
}

export interface CastThreadResponse {
  conversation: { cast: ChatCast };
}

const THREAD_REPLY_DEPTH = 5;

/**
 * Fetch the conversation under a space's root cast.
 * Backend: `GET /v1/feed/cast/thread` (proxies Hypersnap cast/conversation).
 */
export function fetchCastThread(castHash: string): Promise<CastThreadResponse> {
  const params = new URLSearchParams({
    hash: castHash,
    reply_depth: String(THREAD_REPLY_DEPTH),
  });
  return apiFetch<CastThreadResponse>(`/v1/feed/cast/thread?${params}`);
}

/**
 * Publish a chat message as a reply cast under the space's root cast.
 * Backend: `POST /v1/feed/cast` (signs with the viewer's app signer and submits to Hypersnap).
 * Returns the created cast's hash when the upstream response includes it.
 */
export async function publishChatReply(
  text: string,
  parentHash: string,
): Promise<{ hash: string | null }> {
  const data = await apiFetch<{ cast?: { hash?: string } }>("/v1/feed/cast", {
    method: "POST",
    body: { text, parent: parentHash },
  });
  return { hash: data?.cast?.hash ?? null };
}

/**
 * Ensure the room has a FIP-2 chat root cast, minting the @jukeaudio fallback
 * cast if needed. Requires the caller to be an active Juke participant, so only
 * call this from a live session (and never for Farcaster-native rooms — their
 * root cast is mirrored from upstream).
 * Backend: `POST /v1/rooms/{id}/chat-target`.
 */
export function ensureRoomChatTarget(roomId: string): Promise<Space> {
  return apiFetch<Space>(
    `/v1/rooms/${encodeURIComponent(roomId)}/chat-target`,
    { method: "POST" },
  );
}
