export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://your-api-host.example.com";

const PUBLIC_BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://juke.audio";

if (
  typeof process !== "undefined" &&
  process.env.NODE_ENV !== "production" &&
  !process.env.NEXT_PUBLIC_API_BASE_URL
) {
  // Not fatal — preview deploys may intentionally rely on the fallback —
  // but it is almost always a misconfiguration in local dev.
  // eslint-disable-next-line no-console
  console.warn(
    "[spaces] NEXT_PUBLIC_API_BASE_URL is unset; falling back to https://your-api-host.example.com",
  );
}

export interface SpaceUser {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
}

export interface RsvpSummary {
  count: number;
  users: Array<{ fid: number; display_name: string; pfp_url: string | null }>;
  is_going: boolean;
}

export interface Space {
  id: string;
  title: string;
  host_fid: number;
  host: SpaceUser;
  status: string;
  started_at: string;
  ended_at: string | null;
  scheduled_at: string | null;
  speaker_count: number;
  listener_count: number;
  recording: boolean;
  cast_hash: string | null;
  allow_agents: boolean;
  rsvp_summary: RsvpSummary | null;
}

export interface SpaceParticipant {
  fid: number;
  role: string;
  is_muted: boolean;
  hand_raised: boolean;
  display_name: string;
  pfp_url: string | null;
}

export interface SpaceListResponse {
  rooms: Space[];
  next_cursor: string | null;
}

export interface SpaceDetailResponse {
  room: Space;
  participants: SpaceParticipant[];
  hand_queue: number[];
}

export interface JoinSpaceResponse {
  livekit_token: string;
  livekit_ws_url: string;
  role: string;
  room: Space;
  participants: SpaceParticipant[];
}

/**
 * List active spaces (rooms with `status=active`).
 * Backend: `GET /v1/rooms?status=active&limit=20`.
 */
export async function getActiveSpaces(
  cursor?: string,
  limit: number = 20,
): Promise<SpaceListResponse> {
  const params = new URLSearchParams({
    status: "active",
    limit: String(limit),
  });
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`${API_BASE_URL}/v1/rooms?${params}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to fetch active spaces");
  return res.json();
}

/**
 * Fetch a single space's full detail including participant list.
 * Backend: `GET /v1/rooms/{id}`.
 */
export async function getSpaceDetail(
  id: string,
): Promise<SpaceDetailResponse | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/v1/rooms/${id}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export function isUpcomingScheduledSpace(room: Space): boolean {
  if (room.status !== "scheduled" || !room.scheduled_at) return false;
  const scheduledAtMs = new Date(room.scheduled_at).getTime();
  return Number.isFinite(scheduledAtMs) && scheduledAtMs > Date.now();
}

function escapeICalText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function formatICalDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function foldICalLine(line: string): string {
  const maxLength = 75;
  if (line.length <= maxLength) return line;

  const chunks: string[] = [];
  let remaining = line;
  chunks.push(remaining.slice(0, maxLength));
  remaining = remaining.slice(maxLength);

  while (remaining.length > 0) {
    chunks.push(` ${remaining.slice(0, maxLength - 1)}`);
    remaining = remaining.slice(maxLength - 1);
  }

  return chunks.join("\r\n");
}

export function buildSpaceCalendarEvent(room: Space): string | null {
  if (!isUpcomingScheduledSpace(room)) return null;

  const startsAt = new Date(room.scheduled_at as string);
  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
  const encodedRoomId = encodeURIComponent(room.id);
  const spaceUrl = `${PUBLIC_BASE_URL}/space/${encodedRoomId}`;
  const description = `Hosted by ${room.host.display_name} on Juke. Open the space: ${spaceUrl}`;
  const uidRoomId = room.id.replace(/[^a-zA-Z0-9_-]/g, "-");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Juke//Scheduled Spaces//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:juke-space-${uidRoomId || "scheduled-space"}@juke.audio`,
    `DTSTAMP:${formatICalDate(new Date())}`,
    `DTSTART:${formatICalDate(startsAt)}`,
    `DTEND:${formatICalDate(endsAt)}`,
    `SUMMARY:${escapeICalText(room.title)}`,
    `DESCRIPTION:${escapeICalText(description)}`,
    `URL:${spaceUrl}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return `${lines.map(foldICalLine).join("\r\n")}\r\n`;
}

export function buildGoogleCalendarUrl(room: Space): string | null {
  if (!isUpcomingScheduledSpace(room)) return null;

  const startsAt = new Date(room.scheduled_at as string);
  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
  const encodedRoomId = encodeURIComponent(room.id);
  const spaceUrl = `${PUBLIC_BASE_URL}/space/${encodedRoomId}`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: room.title,
    dates: `${formatICalDate(startsAt)}/${formatICalDate(endsAt)}`,
    details: `Hosted by ${room.host.display_name} on Juke. Open the space: ${spaceUrl}`,
    location: spaceUrl,
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function getSpaceCalendarFilename(id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  return `juke-space-${safeId || "scheduled-space"}.ics`;
}

/**
 * Join a space as a listener. Requires a miniapp JWT (obtained via SIWF).
 * The backend issues a listener-scoped LiveKit token
 * (`can_publish=false, can_subscribe=true`) by default — see
 * `backend/app/services/livekit_service.py:52`.
 *
 * Backend: `POST /v1/rooms/{id}/join`.
 */
export async function joinSpaceAsListener(
  id: string,
  token: string,
): Promise<JoinSpaceResponse | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/v1/rooms/${id}/join`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
