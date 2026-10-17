/**
 * Backend calls for Farcaster-NATIVE audio-room writes. Every write mints a
 * fresh JFS bearer (signed with the on-device Ed25519 app key) and sends it as
 * `user_jfs_bearer`; the backend cross-checks the fid and forwards it to
 * `client.farcaster.xyz`. All are also JWT-gated via `apiFetch`.
 *
 * Callers must have ensured the app key is approved first (see
 * `appKeyApproval.ts`) — an unapproved key produces a bearer Farcaster rejects.
 */

import { apiFetch } from "@/lib/api/client";
import { signFarcasterClientBearer } from "@/lib/native/appKey";
import type { Space } from "@/lib/spaces";

/**
 * Upsert a Juke `Room` mirror for an upstream-discovered Farcaster space so the
 * web player can resolve/join it. Idempotent — repeat calls return the existing
 * row. Returns the Juke room (its `id` is what the space page + native-join use).
 * POST /v1/rooms/native/mirror
 */
export function mirrorNativeSpace(params: {
  farcaster_room_id: string;
  title?: string;
  state?: string;
  host_fid: number;
}): Promise<Space> {
  return apiFetch<Space>("/v1/rooms/native/mirror", {
    method: "POST",
    body: {
      farcaster_room_id: params.farcaster_room_id,
      title: params.title ?? "",
      state: params.state ?? "live",
      host_fid: params.host_fid,
    },
  });
}

/** Native join → connect creds for Farcaster's own LiveKit project. */
export interface NativeJoinResponse {
  ws_url: string;
  token: string;
  role?: string;
  participants?: unknown[];
}

/** POST /v1/rooms/{id}/native-join */
export async function nativeJoin(
  roomId: string,
  fid: number,
): Promise<NativeJoinResponse> {
  const user_jfs_bearer = await signFarcasterClientBearer(fid);
  return apiFetch<NativeJoinResponse>(
    `/v1/rooms/${encodeURIComponent(roomId)}/native-join`,
    { method: "POST", body: { user_jfs_bearer } },
  );
}

/** POST /v1/rooms/{id}/native-raise-hand */
export async function nativeRaiseHand(
  roomId: string,
  fid: number,
  raised: boolean,
): Promise<void> {
  const user_jfs_bearer = await signFarcasterClientBearer(fid);
  await apiFetch(`/v1/rooms/${encodeURIComponent(roomId)}/native-raise-hand`, {
    method: "POST",
    body: { user_jfs_bearer, raised },
  });
}

/**
 * Report the local user as an active speaker so Farcaster doesn't auto-end the
 * space for host inactivity. Sent every ~30s while publishing audio. The
 * backend credits only the signer's own fid. POST /v1/rooms/{id}/native-heartbeat
 */
export async function nativeHeartbeat(
  roomId: string,
  fid: number,
): Promise<void> {
  const user_jfs_bearer = await signFarcasterClientBearer(fid);
  await apiFetch(`/v1/rooms/${encodeURIComponent(roomId)}/native-heartbeat`, {
    method: "POST",
    body: { user_jfs_bearer },
    // Best-effort keepalive — don't trigger the session-refresh/retry machinery.
    skipAuthRefresh: true,
  });
}

/** POST /v1/rooms/{id}/native-accept-speaker (host promotes target_fid). */
export async function nativeAcceptSpeaker(
  roomId: string,
  fid: number,
  targetFid: number,
): Promise<void> {
  const user_jfs_bearer = await signFarcasterClientBearer(fid);
  await apiFetch(
    `/v1/rooms/${encodeURIComponent(roomId)}/native-accept-speaker`,
    { method: "POST", body: { user_jfs_bearer, target_fid: targetFid } },
  );
}

/** POST /v1/rooms/{id}/native-remove-speaker (host demotes target_fid). */
export async function nativeRemoveSpeaker(
  roomId: string,
  fid: number,
  targetFid: number,
): Promise<void> {
  const user_jfs_bearer = await signFarcasterClientBearer(fid);
  await apiFetch(
    `/v1/rooms/${encodeURIComponent(roomId)}/native-remove-speaker`,
    { method: "POST", body: { user_jfs_bearer, target_fid: targetFid } },
  );
}

/** POST /v1/rooms/{id}/native-accept-stage-invite */
export async function nativeAcceptStageInvite(
  roomId: string,
  fid: number,
): Promise<void> {
  const user_jfs_bearer = await signFarcasterClientBearer(fid);
  await apiFetch(
    `/v1/rooms/${encodeURIComponent(roomId)}/native-accept-stage-invite`,
    { method: "POST", body: { user_jfs_bearer } },
  );
}

/** POST /v1/rooms/{id}/native-decline-stage-invite */
export async function nativeDeclineStageInvite(
  roomId: string,
  fid: number,
): Promise<void> {
  const user_jfs_bearer = await signFarcasterClientBearer(fid);
  await apiFetch(
    `/v1/rooms/${encodeURIComponent(roomId)}/native-decline-stage-invite`,
    { method: "POST", body: { user_jfs_bearer } },
  );
}

export interface NativeCreateRequest {
  title: string;
  scheduled_at?: string;
}

/**
 * POST /v1/rooms/native (user-hosted native room). Returns the created room.
 * NOTE: the backend responds with the RoomResponse directly (id at top level),
 * unlike the Juke-hosted POST /v1/rooms which wraps it as { room, ... }.
 */
export async function nativeCreate(
  fid: number,
  body: NativeCreateRequest,
): Promise<{ id: string } & Record<string, unknown>> {
  const user_jfs_bearer = await signFarcasterClientBearer(fid);
  return apiFetch("/v1/rooms/native", {
    method: "POST",
    body: { ...body, user_jfs_bearer },
  });
}

/** POST /v1/rooms/{id}/native-start (host goes live on a scheduled room). */
export async function nativeStart(
  roomId: string,
  fid: number,
): Promise<NativeJoinResponse> {
  const user_jfs_bearer = await signFarcasterClientBearer(fid);
  return apiFetch<NativeJoinResponse>(
    `/v1/rooms/${encodeURIComponent(roomId)}/native-start`,
    { method: "POST", body: { user_jfs_bearer } },
  );
}

/** POST /v1/rooms/{id}/end (native, host ends the room). */
export async function nativeEnd(roomId: string, fid: number): Promise<void> {
  const user_jfs_bearer = await signFarcasterClientBearer(fid);
  await apiFetch(`/v1/rooms/${encodeURIComponent(roomId)}/end`, {
    method: "POST",
    body: { user_jfs_bearer },
  });
}
