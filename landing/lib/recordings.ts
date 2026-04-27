const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://your-api-host.example.com";

export interface Recording {
  room_id: string;
  title: string;
  recording_url: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
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
