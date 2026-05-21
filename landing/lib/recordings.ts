const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

export interface Recording {
  room_id: string;
  title: string;
  recording_url: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  cast_hash?: string | null;
}

export interface RecordingHost {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
}

export interface RecordingFeedItem {
  recording: Recording;
  host: RecordingHost;
}

export interface RecordingFeedResponse {
  items: RecordingFeedItem[];
  next_cursor: string | null;
}

export async function getRecentRecordings(
  cursor?: string,
  limit: number = 20,
): Promise<RecordingFeedResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`${API_BASE_URL}/v1/recordings/recent?${params}`);
  if (!res.ok) throw new Error("Failed to fetch recent recordings");
  return res.json();
}

export async function getRecording(
  id: string,
): Promise<RecordingFeedItem | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/v1/recordings/${id}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export function formatRecordingDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const mins = Math.floor(seconds / 60);
  const remainSecs = seconds % 60;
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hours}:${remainMins.toString().padStart(2, "0")}:${remainSecs
      .toString()
      .padStart(2, "0")}`;
  }
  return `${mins}:${remainSecs.toString().padStart(2, "0")}`;
}
