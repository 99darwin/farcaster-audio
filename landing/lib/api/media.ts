/**
 * Media upload for the Juke web app (`juke.audio/app`).
 *
 * Web replacement for mobile `services/api.ts` `uploadImage` / `uploadVideo` —
 * instead of an `expo-image-picker` uri, we send a browser `File` from an
 * `<input type="file">`. The multipart request rides through the shared
 * `apiFetch` client: it already detects a `FormData` body and leaves the
 * `Content-Type` unset so the browser appends the multipart boundary itself,
 * and it attaches the `Authorization: Bearer` header + `credentials: "include"`
 * (so the request is authenticated and survives a 401→refresh retry).
 */

import { apiFetch } from "@/lib/api/client";

/** Mirrors the backend `/v1/media/upload` response (snake_case on the wire). */
export interface MediaUploadResponse {
  url: string;
  asset_url?: string;
  embed_url?: string;
  media_type?: "image" | "video";
}

/** Max image upload size accepted by the backend (10 MB). Fail fast client-side. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Max video upload size accepted by the backend (50 MB). Fail fast client-side. */
export const MAX_VIDEO_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Video MIME types the backend accepts (`ALLOWED_VIDEO_TYPES` in
 * `backend/app/routers/media.py`). The server is authoritative and re-validates
 * via magic bytes; this is only a fail-fast client guard.
 */
const ALLOWED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

/** POST a validated `File` to `/v1/media/upload` and return its hosted URL. */
async function postUpload(
  file: File,
  pickUrl: (r: MediaUploadResponse) => string | undefined,
): Promise<string> {
  const form = new FormData();
  form.append("file", file, file.name);

  const response = await apiFetch<MediaUploadResponse>("/v1/media/upload", {
    method: "POST",
    body: form,
  });

  const url = pickUrl(response);
  if (!url) {
    throw new Error("Upload did not return a URL.");
  }
  return url;
}

/**
 * Upload one image file and return its hosted URL (usable as a cast embed).
 *
 * @throws {Error} when the file is empty, not an image, or exceeds the size cap
 *   — surfaced inline by the composer before any network call.
 */
export async function uploadMedia(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Only image files can be attached.");
  }
  if (file.size === 0) {
    throw new Error("That file is empty.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("Image is too large (max 10 MB).");
  }

  // Prefer the raw asset URL for images (matches mobile `uploadImage`).
  return postUpload(file, (r) => r.url ?? r.embed_url ?? r.asset_url);
}

/**
 * Upload one video file and return its hosted embed URL (an HLS `.m3u8` stream
 * when the backend transcodes it). Mirrors mobile `uploadVideo`.
 *
 * @throws {Error} when the file is empty, not a supported video type, or
 *   exceeds the 50 MB cap — surfaced inline by the composer before any network
 *   call so a 2-minute upload is never wasted on an invalid file.
 */
export async function uploadVideo(file: File): Promise<string> {
  if (!file.type.startsWith("video/") || !ALLOWED_VIDEO_TYPES.has(file.type)) {
    throw new Error("Only MP4, MOV, or WebM videos can be attached.");
  }
  if (file.size === 0) {
    throw new Error("That file is empty.");
  }
  if (file.size > MAX_VIDEO_UPLOAD_BYTES) {
    throw new Error("Video is too large (max 50 MB).");
  }

  // Prefer the HLS embed URL for video (matches mobile `uploadVideo`), so the
  // feed's HLS player path renders it inline.
  return postUpload(file, (r) => r.embed_url ?? r.url ?? r.asset_url);
}
