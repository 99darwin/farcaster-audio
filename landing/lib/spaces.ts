import { encodePathSegment } from "@/lib/api-path";
import { getJwt } from "@/lib/auth/session";

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

/**
 * Auth headers for the `/v1/farcaster-spaces/*` discovery endpoints, which all
 * require a first-party JWT (`Depends(get_current_user)`). Without this the
 * bare fetches 401 and every caller silently degrades to empty — which is why
 * native discovery + participant hydration were failing on web. Returns an
 * empty object when there's no session (anonymous / SSR) so the fetch still
 * degrades gracefully rather than throwing.
 */
function authHeaders(): Record<string, string> {
  const jwt = getJwt();
  return jwt ? { Authorization: `Bearer ${jwt}` } : {};
}

const PUBLIC_BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "http://localhost:3000";

if (
  typeof process !== "undefined" &&
  process.env.NODE_ENV !== "production" &&
  !process.env.NEXT_PUBLIC_API_BASE_URL
) {
  // Not fatal — preview deploys may intentionally rely on the fallback —
  // but it is almost always a misconfiguration in local dev.
  // eslint-disable-next-line no-console
  console.warn(
    "[spaces] NEXT_PUBLIC_API_BASE_URL is unset; falling back to http://localhost:8000",
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
  /**
   * True when this Juke row mirrors a Farcaster-native room. Present on the
   * wire (see backend `_build_room_response`) but historically untyped here.
   */
  is_farcaster_native?: boolean;
  /**
   * Upstream Farcaster room id for native mirrors — lets the discovery merge
   * correlate a Juke mirror with the same room fetched from the Farcaster live
   * list and de-duplicate them.
   */
  farcaster_room_id?: string | null;
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
  expires_at?: string | null;
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
  const segment = encodePathSegment(id);
  if (!segment) return null;
  try {
    const res = await fetch(`${API_BASE_URL}/v1/rooms/${segment}`, {
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

/**
 * Grace window applied when deciding whether a scheduled space is still worth
 * showing under "Upcoming". A space whose start time slipped past `now` but is
 * still within this window is kept (it may have just gone live, or the host is
 * about to start); anything older is treated as stale and dropped.
 */
export const UPCOMING_SCHEDULED_GRACE_MS = 60 * 60 * 1000;

/**
 * True when `scheduledAt` is a *known* timestamp older than `now - grace`.
 *
 * Used to prune long-past scheduled rooms that some upstreams (notably the
 * Farcaster-native scheduled proxy) keep returning forever. A missing or
 * unparseable timestamp returns `false` — we only drop items we can positively
 * prove are stale, never ones with an unknown start time.
 */
export function isStalePastScheduled(
  scheduledAt: string | null | undefined,
  graceMs: number = UPCOMING_SCHEDULED_GRACE_MS,
): boolean {
  if (!scheduledAt) return false;
  const ms = new Date(scheduledAt).getTime();
  if (!Number.isFinite(ms)) return false;
  return ms < Date.now() - graceMs;
}

export interface FormatScheduledTimeOptions {
  /** IANA timezone identifier (e.g., "UTC", "America/New_York"). When provided,
   *  the date/time is rendered in that zone rather than the viewer's local zone. */
  timeZone?: string;
  /** When true and `timeZone` is set, appends the short timezone abbreviation
   *  (e.g., " UTC") to the formatted string. */
  showTimezone?: boolean;
}

/**
 * Format a scheduled space's `scheduled_at` ISO timestamp for display.
 *
 * - Current-year dates:  "Fri, May 22, 9:02 PM"
 * - Other-year dates:    "Fri, May 22, 2027, 9:02 PM"
 * - Invalid / missing:   "—"
 *
 * Always renders in `en-US` locale so output is stable across server-side
 * renders (where system locale can differ) and in tests.
 *
 * @param options.timeZone     IANA tz identifier — when provided the time is
 *   rendered in that zone instead of the viewer's local zone.
 * @param options.showTimezone When true (and `timeZone` is set), appends the
 *   short tz abbreviation to the result, e.g. "Fri, May 22, 9:02 PM UTC".
 */
export function formatScheduledTime(
  iso: string | null | undefined,
  options?: FormatScheduledTimeOptions,
): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";

  const { timeZone, showTimezone } = options ?? {};
  const isCurrentYear = d.getFullYear() === new Date().getFullYear();

  const formatted = d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(isCurrentYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });

  if (showTimezone && timeZone) {
    const tzAbbr =
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
        .formatToParts(d)
        .find((p) => p.type === "timeZoneName")?.value ?? timeZone;
    return `${formatted} ${tzAbbr}`;
  }

  return formatted;
}

function escapeICalText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function formatICalDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
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
 * Join a space as a listener. Requires a miniapp JWT (obtained via Protocol Auth).
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
  const segment = encodePathSegment(id);
  if (!segment) return null;
  try {
    const res = await fetch(`${API_BASE_URL}/v1/rooms/${segment}/join`, {
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

// ---------------------------------------------------------------------------
// Farcaster-native audio space discovery (read-only).
//
// Juke proxies Farcaster's `client.farcaster.xyz/v1/audio-room*` API behind
// `/v1/farcaster-spaces/*` so the landing/SDK never has to talk to Farcaster
// directly. These types mirror the backend Pydantic response shape (snake_case
// on the wire, consistent with the existing `Space` interface above).
//
// Routes (proxied by backend):
//   GET /v1/farcaster-spaces/live
//   GET /v1/farcaster-spaces/scheduled
//   GET /v1/farcaster-spaces/{id}
//   GET /v1/farcaster-spaces/{id}/participants
//   GET /v1/farcaster-spaces/{id}/chat
// ---------------------------------------------------------------------------

export interface FarcasterNativeSpaceUser {
  fid: number;
  username?: string;
  display_name?: string;
  pfp_url?: string;
}

export type FarcasterNativeSpaceState =
  | "scheduled"
  | "live"
  | "ended"
  | (string & {});

export interface FarcasterNativeSpace {
  /** UUID v4 or v7 (Farcaster issues lowercase v7). */
  id: string;
  title?: string;
  description?: string;
  host: FarcasterNativeSpaceUser;
  state: FarcasterNativeSpaceState;
  /** ISO timestamp set when the space transitions to `live`. */
  started_at?: string;
  /** ISO timestamp for scheduled spaces. */
  scheduled_at?: string;
  ended_at?: string;
  listener_count?: number;
  channel_key?: string;
  root_cast_hash?: string;
  root_cast_fid?: number;
}

export type FarcasterNativeSpaceRole =
  | "host"
  | "cohost"
  | "speaker"
  | "listener";

export interface FarcasterNativeSpaceParticipant {
  user: FarcasterNativeSpaceUser;
  role: FarcasterNativeSpaceRole;
  hand_raised?: boolean;
  joined_at?: string;
}

export interface FarcasterNativeSpaceChatMessage {
  id?: string;
  fid?: number;
  user?: FarcasterNativeSpaceUser;
  text: string;
  /** ISO timestamp or epoch ms; Farcaster has historically returned both. */
  created_at?: string | number;
}

/**
 * Discriminated union for mixed discovery feeds (Juke-hosted + Farcaster-
 * native). Callers can narrow with `if (s.isFarcasterNative)`.
 *
 * The existing `Space` interface is preserved as-is for backwards compatibility;
 * wrap an instance in `{ isFarcasterNative: false, space }` (or use the
 * `asJukeHostedDiscoverySpace` helper) when building mixed feeds.
 */
export interface JukeHostedDiscoverySpace {
  isFarcasterNative: false;
  space: Space;
}

export interface FarcasterDiscoverySpace {
  isFarcasterNative: true;
  space: FarcasterNativeSpace;
}

export type DiscoverySpace = JukeHostedDiscoverySpace | FarcasterDiscoverySpace;

export function asJukeHostedDiscoverySpace(
  space: Space,
): JukeHostedDiscoverySpace {
  return { isFarcasterNative: false, space };
}

export function asFarcasterDiscoverySpace(
  space: FarcasterNativeSpace,
): FarcasterDiscoverySpace {
  return { isFarcasterNative: true, space };
}

/** Canonical deeplink to a Farcaster-native space on farcaster.xyz. */
export function farcasterSpaceUrl(id: string): string {
  return `https://farcaster.xyz/~/spaces/${encodeURIComponent(id)}`;
}

// Same regex as the mobile client (`farcaster-audio/services/parseSpaceUrl.ts`)
// — the only gate between an arbitrary cast-embed URL and the in-Juke
// mirror-and-join flow. Matches UUID v4 and v7 (Farcaster issues lowercase v7),
// farcaster.xyz only (no warpcast.com, no subdomains beyond `www.`).
const SPACE_URL_RE =
  /^https?:\/\/(?:www\.)?farcaster\.xyz\/~\/spaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/**
 * Parse a `https://farcaster.xyz/~/spaces/<uuid>` URL into its canonical
 * lowercase space id, or `null` when the URL is anything else.
 */
export function parseFarcasterSpaceUrl(
  url: string | undefined,
): { id: string } | null {
  if (!url) return null;
  const match = url.match(SPACE_URL_RE);
  return match ? { id: match[1].toLowerCase() } : null;
}

interface FarcasterSpaceListResponse {
  rooms?: FarcasterNativeSpace[];
  next_cursor?: string | null;
}

async function fetchFarcasterSpaceList(
  path: "live" | "scheduled",
  limit: number,
): Promise<FarcasterNativeSpace[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  try {
    const res = await fetch(
      `${API_BASE_URL}/v1/farcaster-spaces/${path}?${params}`,
      { cache: "no-store", headers: authHeaders() },
    );
    // 503 = service not configured (no Farcaster auth on this Juke instance).
    // Treat any non-2xx as empty so discovery degrades gracefully.
    if (!res.ok) return [];
    const body = (await res.json()) as
      | FarcasterSpaceListResponse
      | FarcasterNativeSpace[];
    if (Array.isArray(body)) return body;
    return body.rooms ?? [];
  } catch {
    return [];
  }
}

/**
 * List currently-live Farcaster-native audio spaces.
 * Backend: `GET /v1/farcaster-spaces/live?limit=...`.
 */
export async function fetchLiveFarcasterSpaces(
  limit = 30,
): Promise<FarcasterNativeSpace[]> {
  return fetchFarcasterSpaceList("live", limit);
}

/**
 * List upcoming scheduled Farcaster-native audio spaces.
 * Backend: `GET /v1/farcaster-spaces/scheduled?limit=...`.
 */
export async function fetchScheduledFarcasterSpaces(
  limit = 30,
): Promise<FarcasterNativeSpace[]> {
  return fetchFarcasterSpaceList("scheduled", limit);
}

/**
 * Fetch a single Farcaster-native space by id. Returns `null` on 404 or any
 * non-2xx (including 503 service-not-configured) so callers can render an
 * empty state without surfacing infra errors.
 * Backend: `GET /v1/farcaster-spaces/{id}`.
 */
export async function fetchFarcasterSpace(
  id: string,
): Promise<FarcasterNativeSpace | null> {
  try {
    const res = await fetch(
      `${API_BASE_URL}/v1/farcaster-spaces/${encodeURIComponent(id)}`,
      { cache: "no-store", headers: authHeaders() },
    );
    if (!res.ok) return null;
    return (await res.json()) as FarcasterNativeSpace;
  } catch {
    return null;
  }
}

/**
 * Fetch participant list for a Farcaster-native space.
 * Backend: `GET /v1/farcaster-spaces/{id}/participants`.
 */
export async function fetchFarcasterSpaceParticipants(
  id: string,
): Promise<FarcasterNativeSpaceParticipant[]> {
  try {
    const res = await fetch(
      `${API_BASE_URL}/v1/farcaster-spaces/${encodeURIComponent(id)}/participants`,
      { cache: "no-store", headers: authHeaders() },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as
      | { participants?: FarcasterNativeSpaceParticipant[] }
      | FarcasterNativeSpaceParticipant[];
    if (Array.isArray(body)) return body;
    return body.participants ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch chat history for a Farcaster-native space.
 * Backend: `GET /v1/farcaster-spaces/{id}/chat`.
 */
export async function fetchFarcasterSpaceChat(
  id: string,
): Promise<FarcasterNativeSpaceChatMessage[]> {
  try {
    const res = await fetch(
      `${API_BASE_URL}/v1/farcaster-spaces/${encodeURIComponent(id)}/chat`,
      { cache: "no-store", headers: authHeaders() },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as
      | { messages?: FarcasterNativeSpaceChatMessage[] }
      | FarcasterNativeSpaceChatMessage[];
    if (Array.isArray(body)) return body;
    return body.messages ?? [];
  } catch {
    return [];
  }
}
