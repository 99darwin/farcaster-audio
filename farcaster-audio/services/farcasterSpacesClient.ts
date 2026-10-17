/**
 * DORMANT — no active call sites as of the backend-orchestrated
 * Farcaster-native spaces rollout. The Mini App custody-bearer path
 * is dead (Warpcast can't sign as custody), so every Farcaster-native
 * surface now goes through Juke's backend / a Warpcast deep-link
 * instead of this client. Kept as a known-good reference for the day
 * Warpcast ships a sign-as-custody primitive.
 *
 * HTTP client for Farcaster-native audio spaces.
 *
 * Talks directly to `client.farcaster.xyz/v1/audio-room*` using the
 * custody bearer minted by the Juke sync Mini App (see
 * `services/farcasterBearer.ts`). Endpoint paths, body field names
 * (`roomId`, `targetFid`, `raised`, `activeSpeakerFids`) and response
 * envelopes (`{ result: ... }`) are derived from authenticated network
 * traces against `client.farcaster.xyz`.
 *
 * SCOPE GUARANTEE:
 *   This is the ONLY place in `farcaster-audio/` that constructs
 *   `client.farcaster.xyz` URLs. Any future audit of Farcaster-native
 *   API surface only needs to look here. If you find yourself wanting
 *   to call `client.farcaster.xyz` from somewhere else, add the method
 *   here instead.
 *
 * CONVENTIONS (easy to get wrong):
 *   - POST bodies use `roomId`, NOT `id`.
 *   - GET params use `roomId` (query string) for room-scoped fetches.
 *   - Snapshot envelope is `result.room` / `result.rooms` /
 *     `result.participants` / `result.messages`.
 *   - Types are camelCase to mirror the wire format (see
 *     `types/farcasterSpace.ts` for rationale).
 *
 * REDACTION:
 *   The bearer secret and any signed payload MUST never appear in
 *   thrown errors or logs. We surface only HTTP status + a generic
 *   path tag. Callers branch on `FarcasterSpacesError.status` for
 *   401 → re-sync, 5xx → retry, etc.
 */

import {
  clearFarcasterBearer,
  getFarcasterBearer,
} from "@/services/farcasterBearer";
import { useAuthStore } from "@/stores/authStore";
import type {
  AudioRoom,
  AudioRoomChatMessage,
  AudioRoomCreateFields,
  AudioRoomJoinResult,
  AudioRoomParticipant,
  AudioRoomUpdateFields,
} from "@/types/farcasterSpace";

const BASE_URL = "https://client.farcaster.xyz";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Base error for all failures originating from this client. Carries
 * the HTTP status code when available so callers can branch (401 →
 * re-sync, 5xx → retry). Messages are deliberately generic —
 * specifically, they never include the bearer secret, the signature
 * that minted it, or the raw upstream response body (which can echo
 * either of those).
 */
export class FarcasterSpacesError extends Error {
  public readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "FarcasterSpacesError";
    this.status = status;
  }
}

/**
 * Thrown when no valid Farcaster bearer is cached. Callers should
 * branch on `instanceof NoBearerError` and route the user to
 * `useFarcasterSync().openMiniAppSync()` rather than treating this as
 * a generic network failure.
 */
export class NoBearerError extends FarcasterSpacesError {
  constructor() {
    super("farcasterSpacesClient: no Farcaster bearer available");
    this.name = "NoBearerError";
  }
}

// ---------------------------------------------------------------------------
// Internal: auth + HTTP plumbing
// ---------------------------------------------------------------------------

interface AuthedBearer {
  secret: string;
  fid: number;
}

/**
 * Pull the bearer out of secure storage. `getFarcasterBearer()`
 * already filters expired blobs (it deletes them and returns null),
 * so a null return here is a hard NoBearerError, not a soft expiry.
 *
 * We emit a single `console.warn` on the missing-bearer path because
 * a re-sync UX trigger that fires silently is much harder to debug
 * than one with a single breadcrumb. We do NOT log on every call.
 */
async function authed(): Promise<AuthedBearer> {
  const bearer = await getFarcasterBearer();
  if (!bearer) {
    if (__DEV__) {
      console.warn(
        "[farcasterSpacesClient] no bearer; user must re-sync via Mini App",
      );
    }
    throw new NoBearerError();
  }
  // A bearer for any fid other than the signed-in Juke user would make
  // every heartbeat / reaction act as someone else (or leak the user's
  // presence into an attacker's account). Discard it rather than use it.
  const sessionFid = useAuthStore.getState().user?.fid;
  if (!sessionFid || bearer.fid !== sessionFid) {
    await clearFarcasterBearer();
    if (__DEV__) {
      console.warn(
        "[farcasterSpacesClient] bearer fid != session fid; cleared",
      );
    }
    throw new NoBearerError();
  }
  return { secret: bearer.secret, fid: bearer.fid };
}

function commonHeaders(secret: string): Record<string, string> {
  return {
    accept: "*/*",
    "content-type": "application/json; charset=utf-8",
    authorization: `Bearer ${secret}`,
    origin: "https://farcaster.xyz",
    referer: "https://farcaster.xyz/",
  };
}

/** Extract a tag for thrown errors without leaking the query string. */
function pathTag(path: string): string {
  const q = path.indexOf("?");
  return q === -1 ? path : path.slice(0, q);
}

/** Standard response envelope used by every audio-room endpoint. */
interface Envelope<T> {
  result: T;
}

async function getEnvelope<T>(path: string): Promise<T> {
  const bearer = await authed();
  const url = `${BASE_URL}${path}`;
  const tag = pathTag(path);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: commonHeaders(bearer.secret),
    });
  } catch {
    // Drop the underlying error — RN's fetch error can include the
    // request URL/body in some platforms; the bearer is in our
    // headers. Surface only a generic network tag.
    throw new FarcasterSpacesError(`GET ${tag}: network error`);
  }

  if (!res.ok) {
    // Drain & discard the body so the socket can be reused. NEVER
    // include the body text in the thrown error — it may echo
    // credentials or signed payloads.
    try {
      await res.text();
    } catch {
      // ignore
    }
    throw new FarcasterSpacesError(`GET ${tag}: ${res.status}`, res.status);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new FarcasterSpacesError(`GET ${tag}: non-JSON response`);
  }

  if (!body || typeof body !== "object" || !("result" in body)) {
    throw new FarcasterSpacesError(`GET ${tag}: malformed envelope`);
  }

  return (body as Envelope<T>).result;
}

async function postEnvelope<T>(
  path: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const bearer = await authed();
  const url = `${BASE_URL}${path}`;
  const tag = pathTag(path);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: commonHeaders(bearer.secret),
      body: JSON.stringify(payload),
    });
  } catch {
    throw new FarcasterSpacesError(`POST ${tag}: network error`);
  }

  if (!res.ok) {
    try {
      await res.text();
    } catch {
      // ignore
    }
    throw new FarcasterSpacesError(`POST ${tag}: ${res.status}`, res.status);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new FarcasterSpacesError(`POST ${tag}: non-JSON response`);
  }

  if (!body || typeof body !== "object" || !("result" in body)) {
    throw new FarcasterSpacesError(`POST ${tag}: malformed envelope`);
  }

  return (body as Envelope<T>).result;
}

// ---------------------------------------------------------------------------
// Read-side
// ---------------------------------------------------------------------------

/** Room snapshot. 404 → null (room expired or never existed). */
export async function fetchAudioRoom(
  roomId: string,
): Promise<AudioRoom | null> {
  try {
    const result = await getEnvelope<{ room?: AudioRoom }>(
      `/v1/audio-room?roomId=${encodeURIComponent(roomId)}`,
    );
    return result?.room ?? null;
  } catch (e) {
    if (e instanceof FarcasterSpacesError && e.status === 404) {
      return null;
    }
    throw e;
  }
}

/**
 * Live participants. Does NOT swallow errors — a failed call surfaces
 * the diagnostic to the caller (which usually has more context about
 * why it was called).
 */
export async function listAudioRoomParticipants(
  roomId: string,
): Promise<AudioRoomParticipant[]> {
  const result = await getEnvelope<{ participants?: AudioRoomParticipant[] }>(
    `/v1/audio-room/participants?roomId=${encodeURIComponent(roomId)}`,
  );
  return result?.participants ?? [];
}

/**
 * Currently-live rooms (the discovery list). Errors return `[]` so
 * the discovery surface degrades to "no rooms" rather than crashing.
 */
export async function listLiveAudioRooms(limit = 30): Promise<AudioRoom[]> {
  try {
    const result = await getEnvelope<{ rooms?: AudioRoom[] }>(
      `/v1/audio-rooms?limit=${limit}`,
    );
    return result?.rooms ?? [];
  } catch {
    return [];
  }
}

/** Upcoming (scheduled) rooms. Same error policy as `listLiveAudioRooms`. */
export async function listScheduledAudioRooms(
  limit = 30,
): Promise<AudioRoom[]> {
  try {
    const result = await getEnvelope<{ rooms?: AudioRoom[] }>(
      `/v1/audio-rooms/scheduled?limit=${limit}`,
    );
    return result?.rooms ?? [];
  } catch {
    return [];
  }
}

/**
 * Chat history. Read-only on server side — there is no HTTP send
 * endpoint, so chat is "send a reply to rootCastHash" via the
 * regular cast API. We poll this for the in-room transcript.
 */
export async function getAudioRoomChat(
  roomId: string,
): Promise<AudioRoomChatMessage[]> {
  try {
    const result = await getEnvelope<{ messages?: AudioRoomChatMessage[] }>(
      `/v1/audio-room/chat?roomId=${encodeURIComponent(roomId)}`,
    );
    return result?.messages ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Write-side: lifecycle
// ---------------------------------------------------------------------------

/**
 * Join a room. Throws if the server returned a partial result (no
 * wsUrl / token / room) — the LiveKit connect path can't recover
 * from that and we'd rather fail loud at the boundary.
 */
export async function joinAudioRoom(
  roomId: string,
): Promise<AudioRoomJoinResult> {
  const result = await postEnvelope<Partial<AudioRoomJoinResult>>(
    "/v1/audio-room/join",
    { roomId },
  );
  if (!result?.wsUrl || !result?.token) {
    throw new FarcasterSpacesError(
      "POST /v1/audio-room/join: missing wsUrl/token",
    );
  }
  if (!result.room) {
    throw new FarcasterSpacesError(
      "POST /v1/audio-room/join: missing room payload",
    );
  }
  return {
    wsUrl: result.wsUrl,
    token: result.token,
    role: result.role ?? "listener",
    room: result.room,
    viewerFid: result.viewerFid,
  };
}

export async function leaveAudioRoom(roomId: string): Promise<void> {
  await postEnvelope("/v1/audio-room/leave", { roomId });
}

/**
 * Heartbeat. Ticked every 10s; carries the FIDs of the participants
 * we're currently hearing so the server can drive listener-side
 * active-speaker rendering for clients without a direct LiveKit feed.
 */
export async function heartbeatAudioRoom(
  roomId: string,
  activeSpeakerFids: number[],
): Promise<void> {
  await postEnvelope("/v1/audio-room/heartbeat", {
    roomId,
    activeSpeakerFids,
  });
}

/**
 * Host-only: end the room for everyone. Returns the final room
 * snapshot (with `state === 'ended'`); returns null on failure so
 * the caller's host-side UI can still tear down LiveKit even if the
 * server side errors.
 */
export async function endAudioRoom(roomId: string): Promise<AudioRoom | null> {
  try {
    const result = await postEnvelope<{ room?: AudioRoom }>(
      "/v1/audio-room/end",
      { roomId },
    );
    return result?.room ?? null;
  } catch {
    return null;
  }
}

/**
 * Host-only: start a previously-scheduled room (flip state from
 * `scheduled` to `live`).
 */
export async function startScheduledAudioRoom(
  roomId: string,
): Promise<AudioRoom | null> {
  try {
    const result = await postEnvelope<{ room?: AudioRoom }>(
      "/v1/audio-room/start-scheduled",
      { roomId },
    );
    return result?.room ?? null;
  } catch {
    return null;
  }
}

/** Host-only: merge metadata onto an existing room. */
export async function updateAudioRoom(
  roomId: string,
  fields: AudioRoomUpdateFields,
): Promise<AudioRoom | null> {
  try {
    const result = await postEnvelope<{ room?: AudioRoom }>(
      "/v1/audio-room/update",
      { roomId, ...fields },
    );
    return result?.room ?? null;
  } catch {
    return null;
  }
}

/** Create a new audio room. */
export async function createAudioRoom(
  fields: AudioRoomCreateFields,
): Promise<AudioRoom | null> {
  try {
    const result = await postEnvelope<{ room?: AudioRoom }>("/v1/audio-rooms", {
      ...fields,
    });
    return result?.room ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write-side: listener actions
// ---------------------------------------------------------------------------

export async function raiseHand(
  roomId: string,
  raised: boolean,
): Promise<void> {
  await postEnvelope("/v1/audio-room/raise-hand", { roomId, raised });
}

export async function sendReaction(
  roomId: string,
  emoji: string,
): Promise<void> {
  await postEnvelope("/v1/audio-room/reaction", { roomId, emoji });
}

/**
 * RSVP / un-RSVP to a scheduled room. Body field name `rsvped`
 * follows the same toggle-flag convention as `raised` on `raise-hand`.
 */
export async function rsvpAudioRoom(
  roomId: string,
  rsvped: boolean,
): Promise<void> {
  await postEnvelope("/v1/audio-room/rsvp", { roomId, rsvped });
}

// ---------------------------------------------------------------------------
// Write-side: stage-invite handshake
// ---------------------------------------------------------------------------

/**
 * Listener-side: accept the host's stage invite. The next snapshot
 * will show our role as the invited role (`speaker` or `cohost`) and
 * the LiveKit room will publish-enable our local participant.
 */
export async function acceptStageInvite(roomId: string): Promise<void> {
  await postEnvelope("/v1/audio-room/accept-stage-invite", { roomId });
}

export async function declineStageInvite(roomId: string): Promise<void> {
  await postEnvelope("/v1/audio-room/decline-stage-invite", { roomId });
}

// ---------------------------------------------------------------------------
// Write-side: host actions
// ---------------------------------------------------------------------------

/**
 * Host-only: invite or accept a user onto the speaker stage. When the
 * target has raised their hand, this accepts; when they haven't, it
 * fires an unsolicited invite that the target accepts/declines via
 * the listener-side endpoints.
 */
export async function acceptSpeaker(
  roomId: string,
  targetFid: number,
): Promise<void> {
  await postEnvelope("/v1/audio-room/accept-speaker", { roomId, targetFid });
}

/** Host-only: rescind a pending stage invite before the target acts. */
export async function cancelStageInvite(
  roomId: string,
  targetFid: number,
): Promise<void> {
  await postEnvelope("/v1/audio-room/cancel-stage-invite", {
    roomId,
    targetFid,
  });
}

/** Host-only: demote a speaker back to the audience. */
export async function removeSpeaker(
  roomId: string,
  targetFid: number,
): Promise<void> {
  await postEnvelope("/v1/audio-room/remove-speaker", { roomId, targetFid });
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/**
 * LiveKit identities are formatted as `fid:<n>`. This helper extracts
 * the numeric fid, tolerating either the prefixed form or a bare
 * numeric string (which some older clients emit). Returns null for
 * anything else.
 */
export function fidFromIdentity(identity: string | undefined): number | null {
  if (!identity) return null;
  const raw = identity.startsWith("fid:") ? identity.slice(4) : identity;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Re-export the types so callers can `import type { AudioRoom } from
// "@/services/farcasterSpacesClient"` without having to know that the
// types live in a separate module.
export type {
  AudioRoom,
  AudioRoomChatMessage,
  AudioRoomCreateFields,
  AudioRoomJoinResult,
  AudioRoomParticipant,
  AudioRoomUpdateFields,
  PendingStageInvite,
  SpaceRole,
  SpaceUser,
} from "@/types/farcasterSpace";

// Internal exports used by tests only.
export const __TEST_BASE_URL__ = BASE_URL;
