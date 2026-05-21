const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

export interface VoiceNote {
  id: string;
  fid: number;
  duration_ms: number;
  audio_url: string;
  waveform_peaks: number[] | null;
  transcript: string | null;
  caption: string | null;
  created_at: string;
  cast_hash?: string | null;
}

export interface Author {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
}

export interface VoiceNoteDetail {
  voice_note: VoiceNote;
  author: Author;
  reaction_counts: Record<string, number>;
  play_count: number;
}

export async function getVoiceNote(
  id: string,
): Promise<VoiceNoteDetail | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/v1/voice-notes/${id}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export interface VoiceNoteFeedResponse {
  voice_notes: VoiceNoteDetail[];
  next_cursor: string | null;
}

export async function getRecentVoiceNotes(
  cursor?: string,
  limit: number = 20,
): Promise<VoiceNoteFeedResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`${API_BASE_URL}/v1/voice-notes/recent?${params}`);
  if (!res.ok) throw new Error("Failed to fetch recent voice notes");
  return res.json();
}

export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}:${remainSecs.toString().padStart(2, "0")}`;
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
