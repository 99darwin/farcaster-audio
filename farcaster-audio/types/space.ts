export type RoomStatus = 'active' | 'ended' | 'cancelled';
export type ParticipantRole = 'host' | 'co_host' | 'speaker' | 'listener';

export interface Room {
  id: string;
  title: string;
  host_fid: number;
  host: import('./user').UserProfile;
  status: RoomStatus;
  started_at: string;
  ended_at: string | null;
  speaker_count: number;
  listener_count: number;
  recording: boolean;
  cast_hash: string | null;
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

export interface RoomEvent {
  type:
    | 'participant_joined'
    | 'participant_left'
    | 'role_changed'
    | 'hand_raised'
    | 'hand_lowered'
    | 'mute_changed'
    | 'room_ended'
    | 'recording_started'
    | 'recording_stopped';
  fid?: number;
  role?: ParticipantRole;
  old_role?: ParticipantRole;
  is_muted?: boolean;
}
