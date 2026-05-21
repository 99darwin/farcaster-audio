import type { Metadata } from "next";
import Image from "next/image";
import {
  buildGoogleCalendarUrl,
  getSpaceDetail,
  isUpcomingScheduledSpace,
  type SpaceDetailResponse,
} from "@/lib/spaces";

const TESTFLIGHT_URL = process.env.NEXT_PUBLIC_APP_DOWNLOAD_URL ?? "";

async function fetchRoom(id: string): Promise<SpaceDetailResponse | null> {
  return getSpaceDetail(id);
}

function formatScheduledTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }) + " UTC";
}

function getRelativeTime(iso: string): string {
  const now = Date.now();
  const target = new Date(iso).getTime();
  const diffMs = target - now;
  if (diffMs <= 0) return 'starting soon';
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `in ${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
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
  const isScheduled = room.status === "scheduled";

  const description = isScheduled
    ? `Hosted by ${room.host.display_name} · Starts ${room.scheduled_at ? formatScheduledTime(room.scheduled_at) + " · " + getRelativeTime(room.scheduled_at) : "soon"}`
    : `Hosted by ${room.host.display_name} · ${room.speaker_count + room.listener_count} listening on Juke`;

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
  const isLive = room.status === "active";
  const isScheduled = room.status === "scheduled";
  const showAddToCalendar = isUpcomingScheduledSpace(room);
  const googleCalendarUrl = showAddToCalendar
    ? buildGoogleCalendarUrl(room)
    : null;

  return (
    <main className="min-h-screen flex items-center justify-center bg-juke-navy px-6 py-16">
      <div className="w-full max-w-md text-center sm:max-w-2xl">
        {/* Host avatar */}
        {room.host.pfp_url && (
          <Image
            src={room.host.pfp_url!}
            alt={room.host.display_name}
            width={72}
            height={72}
            className="mx-auto mb-6 h-[72px] w-[72px] rounded-full object-cover ring-2 ring-juke-border"
            unoptimized
          />
        )}

        {/* Status badge */}
        {isLive && (
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-juke-orange/20 px-3 py-1">
            <span className="h-2 w-2 rounded-full bg-juke-orange animate-pulse" />
            <span className="text-sm font-semibold text-juke-orange">Live</span>
          </div>
        )}
        {isScheduled && (
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-juke-purple/20 px-3 py-1.5">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-juke-purple"
            >
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <span className="text-sm font-semibold text-juke-purple">Scheduled</span>
          </div>
        )}

        {/* Title */}
        <h1 className="text-3xl font-bold text-juke-text-on-dark mb-2 sm:text-4xl">
          {room.title}
        </h1>

        {/* Host + listeners / scheduled time */}
        <p className="mx-auto mb-10 max-w-xl text-balance text-juke-text-on-dark-secondary">
          Hosted by{" "}
          <span className="font-semibold text-juke-text-on-dark">
            {room.host.display_name}
          </span>
          {isScheduled && room.scheduled_at ? (
            <> · Starts {formatScheduledTime(room.scheduled_at)}{" "}
              <span className="text-juke-text-on-dark-tertiary">· {getRelativeTime(room.scheduled_at)}</span>
            </>
          ) : (
            <> · {count} {count === 1 ? "person" : "people"} listening</>
          )}
        </p>

        {/* RSVP avatars */}
        {isScheduled && room.rsvp_summary && room.rsvp_summary.count > 0 && (
          <div className="mb-8 flex items-center justify-center gap-2" role="group" aria-label={`${room.rsvp_summary.count} people going to this space`}>
            <div className="flex -space-x-2">
              {room.rsvp_summary.users.slice(0, 5).map((user) => (
                user.pfp_url ? (
                  <Image
                    key={user.fid}
                    src={user.pfp_url}
                    alt={user.display_name}
                    width={28}
                    height={28}
                    className="rounded-full ring-2 ring-juke-navy"
                    unoptimized
                  />
                ) : (
                  <div
                    key={user.fid}
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-juke-surface ring-2 ring-juke-navy text-xs font-bold text-juke-text-on-dark"
                  >
                    {user.display_name[0]?.toUpperCase()}
                  </div>
                )
              ))}
            </div>
            <span className="text-sm text-juke-text-on-dark-secondary">
              {room.rsvp_summary.count} going
            </span>
          </div>
        )}

        {/* CTAs */}
        <div className="mx-auto flex w-full max-w-sm flex-col items-stretch gap-3 sm:max-w-none sm:items-center">
          <a
            href={`juke://space/${id}`}
            className="inline-flex min-h-12 items-center justify-center whitespace-nowrap rounded-full bg-juke-purple px-8 text-base font-bold text-white transition-colors hover:bg-juke-purple-hover sm:px-10"
          >
            Open in Juke
          </a>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            {showAddToCalendar && (
              <>
                <a
                  href={`/space/${id}/calendar.ics`}
                  download={`juke-space-${id}.ics`}
                  type="text/calendar"
                  className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-full border border-juke-purple/70 px-6 text-sm font-bold text-juke-text-on-dark transition-colors hover:bg-juke-purple/15 sm:text-base"
                >
                  Apple/Outlook
                </a>
                {googleCalendarUrl && (
                  <a
                    href={googleCalendarUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-full border border-juke-purple/70 px-6 text-sm font-bold text-juke-text-on-dark transition-colors hover:bg-juke-purple/15 sm:text-base"
                  >
                    Google Calendar
                  </a>
                )}
              </>
            )}
            <a
              href={TESTFLIGHT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-full border border-juke-border px-6 text-sm font-bold text-juke-text-on-dark-secondary transition-colors hover:bg-juke-surface hover:text-juke-text-on-dark sm:text-base"
            >
              Get Juke on TestFlight
            </a>
          </div>
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
