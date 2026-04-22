const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://your-api-host.example.com";

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
