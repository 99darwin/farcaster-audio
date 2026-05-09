export interface DraftCastAuthor {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
}

export interface DraftCastSnapshot {
  hash: string;
  author: DraftCastAuthor;
  text: string;
}

export interface DraftQuoteCast {
  fid: number;
  hash: string;
  author?: DraftCastAuthor | null;
  text: string;
}

export interface DraftMediaEmbed {
  url: string;
  type: "image" | "video" | "gif" | "url";
  source: "uploaded" | "giphy" | "url";
  preview_url?: string | null;
}

export interface DraftVoiceMetadata {
  duration_ms: number;
  audio_size: number;
  content_type: "audio/mp4" | "audio/aac" | "audio/mp3";
  waveform_peaks?: number[] | null;
}

export interface ComposeDraftPayload {
  text: string;
  channel_id?: string | null;
  parent_cast_hash?: string | null;
  parent_cast?: DraftCastSnapshot | null;
  quote_cast?: DraftQuoteCast | null;
  media_embeds?: DraftMediaEmbed[];
  voice_metadata?: DraftVoiceMetadata | null;
  post_to_farcaster?: boolean;
}

export interface ComposeDraft extends ComposeDraftPayload {
  id: string;
  fid: number;
  media_embeds: DraftMediaEmbed[];
  post_to_farcaster: boolean;
  created_at: string;
  updated_at: string;
}

export interface ComposeDraftListResponse {
  drafts: ComposeDraft[];
}

export interface DraftVoiceUploadUrlResponse {
  upload_url: string;
  expires_at: string;
  voice_metadata: DraftVoiceMetadata;
}
