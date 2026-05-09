import { apiClient } from "@/services/api";
import type {
  ComposeDraft,
  ComposeDraftListResponse,
  ComposeDraftPayload,
  DraftVoiceUploadUrlResponse,
} from "@/types/draft";

export async function listDrafts(): Promise<ComposeDraft[]> {
  const { data } = await apiClient.get<ComposeDraftListResponse>("/v1/drafts");
  return data.drafts;
}

export async function createDraft(
  payload: ComposeDraftPayload,
): Promise<ComposeDraft> {
  const { data } = await apiClient.post<ComposeDraft>("/v1/drafts", payload);
  return data;
}

export async function updateDraft(
  draftId: string,
  payload: ComposeDraftPayload,
): Promise<ComposeDraft> {
  const { data } = await apiClient.patch<ComposeDraft>(
    `/v1/drafts/${draftId}`,
    payload,
  );
  return data;
}

export async function deleteDraft(draftId: string): Promise<void> {
  await apiClient.delete(`/v1/drafts/${draftId}`);
}

export async function publishDraft(draftId: string): Promise<any> {
  const { data } = await apiClient.post(`/v1/drafts/${draftId}/publish`);
  return data;
}

export async function getDraftVoiceUploadUrl(
  draftId: string,
  params: {
    duration_ms: number;
    content_type?: "audio/mp4" | "audio/aac" | "audio/mp3";
    waveform_peaks?: number[] | null;
  },
): Promise<DraftVoiceUploadUrlResponse> {
  const { data } = await apiClient.post<DraftVoiceUploadUrlResponse>(
    `/v1/drafts/${draftId}/voice-upload-url`,
    params,
  );
  return data;
}

export function uploadDraftAudioFile(
  uploadUrl: string,
  filePath: string,
): Promise<void> {
  const fileUri = filePath.startsWith("file://")
    ? filePath
    : `file://${filePath}`;
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
