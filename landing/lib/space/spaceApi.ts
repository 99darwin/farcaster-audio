"use client";

/**
 * Authenticated Juke room REST for the web app, ported from
 * `farcaster-audio/services/api.ts`. Every call goes through `apiFetch`, which
 * attaches the in-memory Bearer JWT, rides the HttpOnly refresh cookie
 * (`credentials: "include"`), and transparently retries once on 401 after a
 * silent refresh.
 *
 * Read-only discovery + the anonymous listener join live in `@/lib/spaces`;
 * they are re-exported here so consumers have a single import surface.
 *
 * Stream E (host/create) imports `createRoom`, `endRoom`, `startRecording`,
 * `stopRecording` from this module — keep those signatures stable.
 */

import { apiFetch } from "@/lib/api/client";
import type { Space, JoinSpaceResponse } from "@/lib/spaces";
import {
  getSpaceDetail,
  joinSpaceAsListener,
  type SpaceDetailResponse,
} from "@/lib/spaces";

export { getSpaceDetail, joinSpaceAsListener };
export type { SpaceDetailResponse, JoinSpaceResponse };

// ---------------------------------------------------------------------------
// Wire shapes (mirror backend Pydantic; snake_case).
// ---------------------------------------------------------------------------

export interface StatusResponse {
  status: string;
}

export interface RoomCreateRequest {
  title: string;
  announce_cast?: boolean;
  scheduled_at?: string;
}

export interface RoomCreateResponse {
  room: Space;
  livekit_token: string | null;
  livekit_ws_url: string | null;
  expires_at?: string | null;
}

export interface RoomGoLiveResponse {
  room: Space;
  livekit_token: string;
  livekit_ws_url: string;
  expires_at?: string | null;
}

export interface TokenRefreshResponse {
  livekit_token: string;
  expires_at: string;
}

export interface RaiseHandResponse {
  hand_raised: boolean;
  queue_position: number | null;
}

export interface PromoteResponse {
  fid: number;
  role: string;
}

export interface BanRequest {
  reason?: string;
  duration_hours?: number;
}

export interface BanResponse {
  fid: number;
  status: string;
  expires_at: string | null;
}

export interface RecordingResponse {
  status?: string;
  recording_id?: string;
  recording?: boolean;
}

function roomPath(roomId: string, suffix = ""): string {
  return `/v1/rooms/${encodeURIComponent(roomId)}${suffix}`;
}

function participantPath(roomId: string, fid: number, action: string): string {
  return `${roomPath(roomId)}/participants/${encodeURIComponent(String(fid))}/${action}`;
}

// ---------------------------------------------------------------------------
// Lifecycle (create / start / end) — Stream E owns the UI; API lives here.
// ---------------------------------------------------------------------------

export function createRoom(body: RoomCreateRequest): Promise<RoomCreateResponse> {
  return apiFetch<RoomCreateResponse>("/v1/rooms", { method: "POST", body });
}

/** Take a scheduled Juke room live. Backend: `POST /v1/rooms/{id}/start`. */
export function startRoom(roomId: string): Promise<RoomGoLiveResponse> {
  return apiFetch<RoomGoLiveResponse>(roomPath(roomId, "/start"), {
    method: "POST",
  });
}

/** End a room for everyone. Backend: `DELETE /v1/rooms/{id}`. */
export function endRoom(roomId: string): Promise<StatusResponse> {
  return apiFetch<StatusResponse>(roomPath(roomId), { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Participation
// ---------------------------------------------------------------------------

/** Leave a room. Backend: `POST /v1/rooms/{id}/leave`. */
export function leaveRoom(roomId: string): Promise<StatusResponse> {
  return apiFetch<StatusResponse>(roomPath(roomId, "/leave"), {
    method: "POST",
  });
}

/** Raise/lower hand. Backend: `POST /v1/rooms/{id}/raise-hand`. */
export function raiseHand(
  roomId: string,
  raised: boolean,
): Promise<RaiseHandResponse> {
  return apiFetch<RaiseHandResponse>(roomPath(roomId, "/raise-hand"), {
    method: "POST",
    body: { raised },
  });
}

/** Mint a fresh LiveKit token. Backend: `POST /v1/rooms/{id}/token`. */
export function refreshRoomToken(
  roomId: string,
): Promise<TokenRefreshResponse> {
  return apiFetch<TokenRefreshResponse>(roomPath(roomId, "/token"), {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Host / moderation
// ---------------------------------------------------------------------------

export function promoteParticipant(
  roomId: string,
  fid: number,
): Promise<PromoteResponse> {
  return apiFetch<PromoteResponse>(participantPath(roomId, fid, "promote"), {
    method: "POST",
  });
}

export function demoteParticipant(
  roomId: string,
  fid: number,
): Promise<PromoteResponse> {
  return apiFetch<PromoteResponse>(participantPath(roomId, fid, "demote"), {
    method: "POST",
  });
}

export function muteParticipant(
  roomId: string,
  fid: number,
): Promise<StatusResponse> {
  return apiFetch<StatusResponse>(participantPath(roomId, fid, "mute"), {
    method: "POST",
  });
}

export function kickParticipant(
  roomId: string,
  fid: number,
): Promise<StatusResponse> {
  return apiFetch<StatusResponse>(participantPath(roomId, fid, "kick"), {
    method: "POST",
  });
}

export function banParticipant(
  roomId: string,
  fid: number,
  body: BanRequest = {},
): Promise<BanResponse> {
  return apiFetch<BanResponse>(participantPath(roomId, fid, "ban"), {
    method: "POST",
    body,
  });
}

// ---------------------------------------------------------------------------
// Recording — Stream E's HostPanel toggles these.
// ---------------------------------------------------------------------------

export function startRecording(roomId: string): Promise<RecordingResponse> {
  return apiFetch<RecordingResponse>(roomPath(roomId, "/recording/start"), {
    method: "POST",
  });
}

export function stopRecording(roomId: string): Promise<RecordingResponse> {
  return apiFetch<RecordingResponse>(roomPath(roomId, "/recording/stop"), {
    method: "POST",
  });
}
