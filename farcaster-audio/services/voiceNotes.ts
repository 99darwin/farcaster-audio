import { apiClient } from "@/services/api";
import type {
  VoiceNote,
  VoiceNoteDetail,
  VoiceNoteFeedResponse,
  UploadUrlResponse,
} from "@/types/voiceNote";

// --- Upload ---

export async function getUploadUrl(
  durationMs: number,
  contentType: string = "audio/mp4",
): Promise<UploadUrlResponse> {
  const { data } = await apiClient.post<UploadUrlResponse>(
    "/v1/voice-notes/upload-url",
    { duration_ms: durationMs, content_type: contentType },
  );
  return data;
}

export function uploadAudioFile(
  uploadUrl: string,
  filePath: string,
): Promise<void> {
  // React Native's fetch(localPath).blob() often produces empty/corrupt blobs.
  // Use XMLHttpRequest which handles file:// URIs reliably on iOS.
  const fileUri = filePath.startsWith("file://") ? filePath : `file://${filePath}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", "audio/mp4");
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed with status ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Upload network error"));
    xhr.send({ uri: fileUri } as any);
  });
}

// --- CRUD ---

export async function createVoiceNote(params: {
  upload_id: string;
  duration_ms: number;
  audio_size: number;
  post_to_farcaster: boolean;
  cast_text: string;
}): Promise<VoiceNote> {
  const { data } = await apiClient.post("/v1/voice-notes/", params);
  return data;
}

export async function getVoiceNote(id: string): Promise<VoiceNoteDetail> {
  const { data } = await apiClient.get<VoiceNoteDetail>(
    `/v1/voice-notes/${id}`,
  );
  return data;
}

export async function deleteVoiceNote(id: string): Promise<void> {
  await apiClient.delete(`/v1/voice-notes/${id}`);
}

// --- Feed ---

export async function getVoiceNoteFeed(
  limit: number = 20,
  cursor?: string,
): Promise<VoiceNoteFeedResponse> {
  const params: Record<string, string | number> = { limit };
  if (cursor) params.cursor = cursor;
  const { data } = await apiClient.get<VoiceNoteFeedResponse>(
    "/v1/voice-notes/feed",
    { params },
  );
  return data;
}

export async function getUserVoiceNotes(
  fid: number,
  limit: number = 20,
  cursor?: string,
): Promise<VoiceNoteFeedResponse> {
  const params: Record<string, string | number> = { limit };
  if (cursor) params.cursor = cursor;
  const { data } = await apiClient.get<VoiceNoteFeedResponse>(
    `/v1/voice-notes/user/${fid}`,
    { params },
  );
  return data;
}

// --- Plays ---

export async function recordPlay(
  id: string,
  listenedMs: number,
  completed: boolean,
): Promise<void> {
  await apiClient.post(`/v1/voice-notes/${id}/plays`, {
    listened_ms: listenedMs,
    completed,
  });
}

// --- Reactions ---

export async function addReaction(
  id: string,
  reactionType: "like" | "recast",
): Promise<void> {
  await apiClient.post(`/v1/voice-notes/${id}/reactions`, {
    reaction_type: reactionType,
  });
}

export async function removeReaction(
  id: string,
  reactionType: "like" | "recast",
): Promise<void> {
  await apiClient.delete(`/v1/voice-notes/${id}/reactions/${reactionType}`);
}
