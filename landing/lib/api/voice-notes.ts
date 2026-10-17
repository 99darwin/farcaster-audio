/**
 * Voice-note recording/upload client for the Juke web app (`juke.audio/app`).
 *
 * Web parity for mobile `services/voiceNotes.ts`. A published voice note is a
 * Farcaster cast whose embed is the voice note itself — so on submit the
 * composer runs THIS flow *instead of* `POST /v1/feed/cast` (never both).
 *
 * Backend contract (`backend/app/routers/voice_notes.py`) — a THREE-step flow,
 * NOT a single multipart request:
 *   1. `POST /v1/voice-notes/upload-url` `{ duration_ms, content_type }`
 *        → `{ upload_id, upload_url, expires_at }`.
 *      `content_type` MUST match `^audio/(mp4|aac|mp3)$`; `duration_ms` is
 *      `> 0` and `<= 60000` (60s hard cap).
 *   2. `PUT` the raw audio bytes to the returned presigned `upload_url` with a
 *      matching `Content-Type` header. This goes DIRECT to object storage — not
 *      through `apiFetch` (no `API_BASE_URL` prefix, no `Authorization`, no
 *      credentials).
 *   3. `POST /v1/voice-notes/` `{ upload_id, duration_ms, audio_size,
 *        post_to_farcaster, cast_text, parent_cast_hash?, channel_id? }`
 *        → the finalized `VoiceNote` (and, when `post_to_farcaster`, the cast).
 */

import { apiFetch } from "@/lib/api/client";
import type { VoiceNote } from "@/lib/voice-notes";

/** Hard cap enforced by the backend (`duration_ms <= 60000`). */
export const MAX_RECORDING_MS = 60_000;

/** Below this a recording is treated as an accidental tap, not a note. */
export const MIN_RECORDING_MS = 500;

/** Content types the backend `upload-url` schema accepts (`audio/(mp4|aac|mp3)`). */
export type VoiceUploadContentType = "audio/mp4" | "audio/aac" | "audio/mp3";

/** A finalized in-memory recording ready to attach + upload. */
export interface RecordedVoiceNote {
  blob: Blob;
  durationMs: number;
  contentType: VoiceUploadContentType;
}

/**
 * Candidate `MediaRecorder` mime types, most-preferred first.
 *
 * `audio/mp4` is prioritised because it is the ONLY format the backend accepts
 * that also decodes end-to-end (Safari + recent Chromium record it natively).
 * `audio/webm`/`ogg` fall back for Firefox/older Chromium so recording still
 * works, but their bytes are uploaded under an `audio/mp4` content type the
 * backend accepts — see the caveat in `pickRecorderMimeType`.
 */
const RECORDER_MIME_CANDIDATES: ReadonlyArray<{
  mimeType: string;
  uploadContentType: VoiceUploadContentType;
}> = [
  { mimeType: "audio/mp4", uploadContentType: "audio/mp4" },
  { mimeType: "audio/mp4;codecs=mp4a.40.2", uploadContentType: "audio/mp4" },
  { mimeType: "audio/aac", uploadContentType: "audio/aac" },
  { mimeType: "audio/mpeg", uploadContentType: "audio/mp3" },
  { mimeType: "audio/webm;codecs=opus", uploadContentType: "audio/mp4" },
  { mimeType: "audio/webm", uploadContentType: "audio/mp4" },
  { mimeType: "audio/ogg;codecs=opus", uploadContentType: "audio/mp4" },
];

/**
 * Pick the best `MediaRecorder` mime type this browser supports, paired with a
 * backend-accepted upload content type.
 *
 * Pure: takes `isTypeSupported` (inject `MediaRecorder.isTypeSupported`) so it
 * is unit-testable without a DOM. Returns `null` when nothing is supported —
 * callers should hide the recording affordance in that case.
 */
export function pickRecorderMimeType(
  isTypeSupported: (type: string) => boolean,
): { mimeType: string; uploadContentType: VoiceUploadContentType } | null {
  for (const candidate of RECORDER_MIME_CANDIDATES) {
    if (isTypeSupported(candidate.mimeType)) {
      return {
        mimeType: candidate.mimeType,
        uploadContentType: candidate.uploadContentType,
      };
    }
  }
  return null;
}

/**
 * Coerce a raw elapsed time into the backend's valid `duration_ms` window
 * (integer, `> 0`, `<= 60000`). Guards against a sub-millisecond or NaN
 * duration that would 422 the upload-url request.
 */
export function clampDurationMs(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  return Math.min(MAX_RECORDING_MS, Math.round(durationMs));
}

interface UploadUrlResponse {
  upload_id: string;
  upload_url: string;
  expires_at: string;
}

export interface UploadVoiceNoteParams {
  blob: Blob;
  durationMs: number;
  contentType: VoiceUploadContentType;
  /** Optional caption / cast body (max 1024 chars, enforced backend-side). */
  castText?: string;
  /** Whether to broadcast the note as a Farcaster cast. Defaults to `true`. */
  postToFarcaster?: boolean;
  /** Reply target hash (`0x…40 hex`) when composing a voice reply. */
  parentCastHash?: string | null;
  /** Channel to post into (mutually exclusive with `parentCastHash`). */
  channelId?: string | null;
}

/** Max caption length the backend accepts (`cast_text` `max_length=1024`). */
const MAX_CAST_TEXT = 1024;

/**
 * Upload a recorded voice note through the backend's three-step flow and return
 * the finalized note.
 *
 * @throws {Error} when the presigned PUT to storage fails; `apiFetch` throws
 *   `ApiFetchError` for the upload-url / finalize calls (surfaced by the caller).
 */
export async function uploadVoiceNote(
  params: UploadVoiceNoteParams,
): Promise<VoiceNote> {
  const durationMs = clampDurationMs(params.durationMs);

  // 1. Reserve a presigned upload slot.
  const { upload_id, upload_url } = await apiFetch<UploadUrlResponse>(
    "/v1/voice-notes/upload-url",
    {
      method: "POST",
      body: { duration_ms: durationMs, content_type: params.contentType },
    },
  );

  // 2. PUT the bytes straight to object storage. Deliberately a bare `fetch`:
  //    the presigned URL is absolute and self-authorizing — adding our
  //    `Authorization` header or credentials would break the signature/CORS.
  const putResponse = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": params.contentType },
    body: params.blob,
  });
  if (!putResponse.ok) {
    throw new Error(`Voice note upload failed (${putResponse.status}).`);
  }

  // 3. Finalize: creates the row and (optionally) the Farcaster cast.
  const parentCastHash = params.parentCastHash || undefined;
  return apiFetch<VoiceNote>("/v1/voice-notes/", {
    method: "POST",
    body: {
      upload_id,
      duration_ms: durationMs,
      audio_size: params.blob.size,
      post_to_farcaster: params.postToFarcaster ?? true,
      cast_text: (params.castText ?? "").slice(0, MAX_CAST_TEXT),
      // Replies cannot target a channel (backend rejects both together).
      parent_cast_hash: parentCastHash,
      channel_id: parentCastHash ? undefined : params.channelId || undefined,
    },
  });
}
