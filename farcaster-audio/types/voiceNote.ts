export interface VoiceNoteAuthor {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
}

export interface VoiceNote {
  id: string;
  fid: number;
  duration_ms: number;
  audio_url: string;
  audio_size: number;
  waveform_peaks: number[] | null;
  transcript: string | null;
  transcript_lang: string | null;
  transcript_words: Array<{
    word: string;
    start_ms: number;
    end_ms: number;
  }> | null;
  cast_hash: string | null;
  cast_url: string | null;
  parent_cast_hash: string | null;
  caption: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface VoiceNoteDetail {
  voice_note: VoiceNote;
  author: VoiceNoteAuthor;
  reaction_counts: Record<string, number>;
  viewer_reactions: string[];
  play_count: number;
}

export interface VoiceNoteFeedResponse {
  voice_notes: VoiceNoteDetail[];
  next_cursor: string | null;
}

export interface UploadUrlResponse {
  upload_id: string;
  upload_url: string;
  expires_at: string;
}

/** Union type for mixed feed items (cast or voice note) */
export type FeedItem =
  | { type: "cast"; data: import("@/types/neynar").NeynarCast }
  | { type: "voice_note"; data: VoiceNoteDetail };
