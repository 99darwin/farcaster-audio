import { encodePathSegment } from "@/lib/api-path";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

export interface Recording {
  // Segment UUID — populated on the multi-recording backend. Optional
  // so older backend builds (and rows from before the migration) still
  // parse cleanly. When present, use this as the canonical link/route
  // key; otherwise fall back to room_id.
  id?: string;
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
  // The route's `id` slug may be either a recording UUID (new format,
  // for individual segments of a multi-segment space) OR a room UUID
  // (legacy format for shared links that pre-date the recordings
  // migration). Both UUID shapes are identical so we try the canonical
  // per-segment lookup first, then fall back to the legacy room
  // lookup which the backend resolves to "the most recent segment for
  // that room".
  const segment = encodePathSegment(id);
  if (!segment) return null;
  try {
    const segRes = await fetch(
      `${API_BASE_URL}/v1/recordings/by-id/${segment}`,
      { next: { revalidate: 60 } },
    );
    if (segRes.ok) return segRes.json();
    if (segRes.status !== 404) return null;
  } catch {
    // Network/parse error — fall through and try the legacy path.
  }
  try {
    const roomRes = await fetch(`${API_BASE_URL}/v1/recordings/${segment}`, {
      next: { revalidate: 60 },
    });
    if (!roomRes.ok) return null;
    return roomRes.json();
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
