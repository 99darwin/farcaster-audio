import { JukeSpaceEmbed } from "@/components/juke-space-embed";
import type { SpaceDetailResponse } from "@/lib/spaces";

const demoSpace: SpaceDetailResponse = {
  room: {
    id: "00000000-0000-0000-0000-000000000001",
    title: "Builder radio: shipping miniapps live",
    host_fid: 1,
    host: {
      fid: 1,
      username: "juke",
      display_name: "Juke",
      pfp_url: null,
    },
    status: "active",
    started_at: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
    ended_at: null,
    scheduled_at: null,
    speaker_count: 4,
    listener_count: 128,
    recording: false,
    cast_hash: null,
    allow_agents: false,
    rsvp_summary: null,
  },
  participants: [
    {
      fid: 1,
      role: "host",
      is_muted: false,
      hand_raised: false,
      display_name: "Juke",
      pfp_url: null,
    },
    {
      fid: 2,
      role: "speaker",
      is_muted: false,
      hand_raised: false,
      display_name: "Nick",
      pfp_url: null,
    },
    {
      fid: 3,
      role: "speaker",
      is_muted: true,
      hand_raised: false,
      display_name: "Maya",
      pfp_url: null,
    },
    {
      fid: 4,
      role: "co_host",
      is_muted: false,
      hand_raised: false,
      display_name: "Theo",
      pfp_url: null,
    },
    {
      fid: 5,
      role: "listener",
      is_muted: true,
      hand_raised: false,
      display_name: "Ari",
      pfp_url: null,
    },
  ],
  hand_queue: [5],
};

export default function EmbedDemoPage() {
  return <JukeSpaceEmbed spaceId={demoSpace.room.id} initialData={demoSpace} />;
}
