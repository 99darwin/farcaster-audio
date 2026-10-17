/**
 * Type definitions mirroring Farcaster's native audio-room API
 * (`client.farcaster.xyz/v1/audio-room*`).
 *
 * NAMING CONVENTION — IMPORTANT:
 *   These types use camelCase, not Juke's usual snake_case. Reason:
 *   they shadow the RAW wire format spoken by client.farcaster.xyz,
 *   which is camelCase. The companion file `services/farcasterSpacesClient.ts`
 *   talks directly to that endpoint and consumes/produces these
 *   shapes verbatim — no serializer in between. Juke's own room
 *   types (see `types/space.ts` — `Room`, `Participant`) remain
 *   snake_case because they ride Juke's REST API.
 *
 *   When mapping these into Juke's UI state, do the snake_case
 *   translation at the boundary (typically inside `useSpace.ts`),
 *   not here.
 */

/**
 * Bundle-shape for a Farcaster user (subset used by the audio-room
 * payloads). The full server-side shape is larger; we keep only what
 * the UI reads to stay tolerant of additions.
 */
export interface SpaceUser {
  fid: number;
  username?: string;
  displayName?: string;
  pfp?: { url?: string };
  /** Some endpoints denormalize the pfp url onto the root, so accept both. */
  pfpUrl?: string;
}

export type SpaceRole = "host" | "cohost" | "speaker" | "listener";

/**
 * Per-participant pending stage invite. Set when a host has invited
 * this user to the stage; cleared by accept/decline.
 */
export interface PendingStageInvite {
  role: SpaceRole;
  inviterFid: number;
}

export interface AudioRoomParticipant {
  user: SpaceUser;
  role: SpaceRole;
  pendingInvite?: PendingStageInvite | null;
  /** Listener-side: whether this participant has their hand up. */
  handRaised?: boolean;
  joinedAt?: string;
}

export interface AudioRoom {
  id: string;
  title?: string;
  description?: string;
  /**
   * Denormalized host user — rendered directly via
   * `room.host.displayName` / `room.host.pfp.url`.
   */
  host: SpaceUser;
  state: "scheduled" | "live" | "ended" | string;
  /** ISO timestamp. Present once the room transitions to `live`. */
  startedAt?: string;
  /** ISO timestamp. Present for `scheduled` rooms. */
  scheduledAt?: string;
  endedAt?: string;
  listenerCount?: number;
  /** Channel key when the space is hosted inside a channel. */
  channelKey?: string;
  /**
   * Hash of the cast that hosts the space embed. Direct replies to
   * this cast are the space's chat thread; sending chat = posting a
   * reply to it. Surfaced on the snapshot regardless of how the user
   * reached the space (cast embed OR discovery strip).
   */
  rootCastHash?: string;
  /**
   * FID of the cast author — same as `host.fid` in practice but
   * surfaced separately by the server.
   */
  rootCastFid?: number;
}

export interface AudioRoomJoinResult {
  /**
   * LiveKit cloud signaling URL (`wss://<host>.livekit.cloud`),
   * served at `result.wsUrl`.
   */
  wsUrl: string;
  /** Short-lived JWT for the LiveKit room (`result.token`). */
  token: string;
  /** Role the server assigned us — usually 'listener' on first join. */
  role: SpaceRole;
  room: AudioRoom;
  /**
   * The viewer's own FID, surfaced for telemetry / participant
   * matching. Optional because not all server builds return it.
   */
  viewerFid?: number;
}

/**
 * Read-only chat history entry for an audio room. Chat is a read-only
 * surface server-side: messages can be fetched via GET, but there is
 * no HTTP send endpoint, so callers poll.
 */
export interface AudioRoomChatMessage {
  id?: string;
  fid?: number;
  /** Denormalized user — present on some responses. */
  user?: SpaceUser;
  text: string;
  createdAt?: string | number;
}

/**
 * Host-only: update room metadata. All fields are optional; the
 * server merges over the existing record.
 */
export interface AudioRoomUpdateFields {
  title?: string;
  description?: string;
  scheduledAt?: string;
  /**
   * `null` explicitly clears the channel attachment; `undefined`
   * leaves it untouched.
   */
  channelKey?: string | null;
}

/**
 * Create a new audio room. `scheduledAt` makes it a scheduled room;
 * omit to start immediately.
 */
export interface AudioRoomCreateFields {
  title: string;
  description?: string;
  scheduledAt?: string;
  channelKey?: string;
}
