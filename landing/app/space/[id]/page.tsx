import type { Metadata } from "next";

const API_BASE_URL =
  "https://your-api-host.example.com";
const TESTFLIGHT_URL = "https://testflight.apple.com/join/YOUR_TESTFLIGHT_CODE";

type RoomData = {
  room: {
    id: string;
    title: string;
    status: string;
    host_fid: number;
    host: {
      display_name: string;
      username: string;
      pfp_url: string | null;
    };
    speaker_count: number;
    listener_count: number;
  };
};

async function fetchRoom(id: string): Promise<RoomData | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/v1/rooms/${id}`, {
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const data = await fetchRoom(id);

  if (!data) {
    return {
      title: "Space Not Found — Juke",
      description: "This space doesn't exist or has ended.",
    };
  }

  const { room } = data;
  const count = room.speaker_count + room.listener_count;
  const description = `Hosted by ${room.host.display_name} · ${count} listening on Juke`;

  return {
    title: `${room.title} — Juke`,
    description,
    openGraph: {
      title: `${room.title} — Juke`,
      description,
      url: `https://juke.audio/space/${id}`,
      siteName: "Juke",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: `${room.title} — Juke`,
      description,
    },
  };
}

export default async function SpacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await fetchRoom(id);

  if (!data) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-juke-navy px-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-juke-text-on-dark mb-4">
            Space not found
          </h1>
          <p className="text-juke-text-on-dark-secondary mb-8">
            This space doesn&apos;t exist or has ended.
          </p>
          <a
            href="https://juke.audio"
            className="inline-block rounded-full bg-juke-purple px-8 py-3.5 text-lg font-bold text-white transition-colors hover:bg-juke-purple-hover"
          >
            Go to Juke
          </a>
        </div>
      </main>
    );
  }

  const { room } = data;
  const count = room.speaker_count + room.listener_count;
  const isLive = room.status === "live";

  return (
    <main className="min-h-screen flex items-center justify-center bg-juke-navy px-6">
      <div className="w-full max-w-md text-center">
        {/* Host avatar */}
        {room.host.pfp_url && (
          <img
            src={room.host.pfp_url}
            alt={room.host.display_name}
            width={72}
            height={72}
            className="mx-auto mb-6 rounded-full ring-2 ring-juke-border"
          />
        )}

        {/* Status badge */}
        {isLive && (
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-juke-orange/20 px-3 py-1">
            <span className="h-2 w-2 rounded-full bg-juke-orange animate-pulse" />
            <span className="text-sm font-semibold text-juke-orange">Live</span>
          </div>
        )}

        {/* Title */}
        <h1 className="text-3xl font-bold text-juke-text-on-dark mb-2 sm:text-4xl">
          {room.title}
        </h1>

        {/* Host + listeners */}
        <p className="text-juke-text-on-dark-secondary mb-10">
          Hosted by{" "}
          <span className="font-semibold text-juke-text-on-dark">
            {room.host.display_name}
          </span>{" "}
          · {count} {count === 1 ? "person" : "people"} listening
        </p>

        {/* CTAs */}
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <a
            href={`juke://space/${id}`}
            className="inline-block rounded-full bg-juke-purple px-8 py-3.5 text-lg font-bold text-white transition-colors hover:bg-juke-purple-hover"
          >
            Open in Juke
          </a>
          <a
            href={TESTFLIGHT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block rounded-full border border-juke-border px-8 py-3.5 text-lg font-bold text-juke-text-on-dark transition-colors hover:bg-juke-surface"
          >
            Get Juke on TestFlight
          </a>
        </div>

        {/* Branding */}
        <p className="mt-16 text-sm text-juke-text-on-dark-tertiary">
          Live audio on{" "}
          <a
            href="https://www.farcaster.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 transition-colors hover:text-juke-text-on-dark-secondary"
          >
            Farcaster
          </a>
        </p>
      </div>
    </main>
  );
}
