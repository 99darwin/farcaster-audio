export type RoomStatus = "active" | "ended" | "cancelled" | "scheduled";
export type ParticipantRole = "host" | "co_host" | "speaker" | "listener";

export interface Room {
  id: string;
  title: string;
  host_fid: number;
  host: import("./user").UserProfile;
  status: RoomStatus;
  started_at: string;
  ended_at: string | null;
  scheduled_at: string | null;
  speaker_count: number;
  listener_count: number;
  recording: boolean;
  cast_hash: string | null;
  rsvp_summary?: RsvpSummary | null;
  /**
   * When this Juke Room is a thin wrapper around a Farcaster-native space,
   * `farcaster_room_id` is the UUID of the corresponding `audio-room` on
   * `client.farcaster.xyz`. All RPC for these rooms (join/leave/heartbeat
   * /reactions/host actions) goes to Farcaster directly via
   * `services/farcasterSpacesClient`; the Juke backend only stores the
   * mapping so we can render the room in discovery and link it to its
   * cast.
   */
  farcaster_room_id?: string | null;
  /**
   * True iff `farcaster_room_id` is set and the lifecycle is governed by
   * Farcaster. Mirrors the backend `is_farcaster_native` column.
   */
  is_farcaster_native?: boolean;
}

export interface Participant {
  fid: number;
  role: ParticipantRole;
  is_muted: boolean;
  is_speaking: boolean;
  hand_raised: boolean;
  display_name: string;
  pfp_url: string | null;
}

export interface SpaceState {
  room: Room;
  participants: Participant[];
  hand_queue: number[];
  my_role: ParticipantRole;
  is_connected: boolean;
}

export interface RsvpUser {
  fid: number;
  display_name: string;
  pfp_url: string | null;
}

export interface RsvpSummary {
  count: number;
  users: RsvpUser[];
  is_going: boolean;
}

/**
 * Discriminated union for mixed discovery feeds (Juke-hosted +
 * Farcaster-native). Callers can narrow with `if (s.isFarcasterNative)`.
 *
 * Mirrors `landing/lib/spaces.ts:DiscoverySpace` so SDK and mobile stay
 * shape-compatible.
 */
export interface JukeHostedDiscoverySpace {
  isFarcasterNative: false;
  space: Room;
}

export interface FarcasterDiscoverySpace {
  isFarcasterNative: true;
  space: import("@/services/api").FarcasterNativeSpace;
}

export type DiscoverySpace = JukeHostedDiscoverySpace | FarcasterDiscoverySpace;

export interface RoomEvent {
  type:
    | "participant_joined"
    | "participant_left"
    | "role_changed"
    | "hand_raised"
    | "hand_lowered"
    | "mute_changed"
    | "room_ended"
    | "recording_started"
    | "recording_stopped";
  fid?: number;
  role?: ParticipantRole;
  old_role?: ParticipantRole;
  is_muted?: boolean;
}
