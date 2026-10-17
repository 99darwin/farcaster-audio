"use client";

/**
 * Card components for upcoming (scheduled) spaces in the SpacesPanel.
 *
 * Two variants:
 *   - `JukeUpcomingSpaceCard` — Juke-hosted scheduled `Space`. Shows title, host,
 *     formatted start time, RSVP avatar row, RSVP toggle button, and Google/ICS
 *     calendar links. Card body links to `/app/space/{id}`.
 *   - `FarcasterUpcomingSpaceCard` — native Farcaster scheduled room. Shows title,
 *     host, time, purple "Farcaster" badge, and an external link to farcaster.xyz.
 *     NO RSVP (no upstream mutation API).
 *
 * The exported `UpcomingSpaceCard` accepts a `DiscoverySpace` and dispatches to
 * the appropriate variant.
 */

import { useCallback, useState, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { safeImageUrl } from "@/lib/safe-url";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useSpacesDiscoveryStore } from "@/lib/stores/spacesDiscoveryStore";
import {
  buildGoogleCalendarUrl,
  farcasterSpaceUrl,
  formatScheduledTime,
  getSpaceCalendarFilename,
  isUpcomingScheduledSpace,
  type DiscoverySpace,
  type FarcasterNativeSpace,
  type RsvpSummary,
  type Space,
} from "@/lib/spaces";

function hostLabel(host: FarcasterNativeSpace["host"]): string {
  return host.display_name || host.username || `fid ${host.fid}`;
}

function hostHandle(host: FarcasterNativeSpace["host"]): string {
  return host.username ? `@${host.username}` : `fid ${host.fid}`;
}

// ---------------------------------------------------------------------------
// RSVP avatar row (Juke-hosted only)
// ---------------------------------------------------------------------------

const MAX_RSVP_AVATARS = 5;

function RsvpAvatarRow({ summary }: { summary: RsvpSummary }) {
  if (summary.count === 0) return null;

  return (
    <div
      className="flex items-center gap-2"
      role="group"
      aria-label={`${summary.count} ${summary.count === 1 ? "person" : "people"} going`}
    >
      <div className="flex -space-x-2">
        {summary.users.slice(0, MAX_RSVP_AVATARS).map((user) => {
          const safe = safeImageUrl(user.pfp_url);
          if (safe) {
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={user.fid}
                src={safe}
                alt={user.display_name}
                width={20}
                height={20}
                referrerPolicy="no-referrer"
                className="h-5 w-5 rounded-full object-cover ring-2 ring-juke-navy"
              />
            );
          }
          return (
            <div
              key={user.fid}
              className="flex h-5 w-5 items-center justify-center rounded-full bg-juke-surface ring-2 ring-juke-navy text-[8px] font-bold text-juke-text-on-dark"
            >
              {user.display_name[0]?.toUpperCase() ?? "?"}
            </div>
          );
        })}
      </div>
      <span className="text-[11px] text-white/40">
        {summary.count} going
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RSVP button (Juke-hosted only)
// ---------------------------------------------------------------------------

interface RsvpButtonProps {
  room: Space;
  isGoing: boolean;
}

function RsvpButton({ room, isGoing }: RsvpButtonProps) {
  const router = useRouter();
  const { status } = useAuth();
  const toggleRsvp = useSpacesDiscoveryStore((s) => s.toggleRsvp);
  const [isPending, setIsPending] = useState(false);

  const handleClick = useCallback(
    async (e: MouseEvent) => {
      // Don't navigate the card link when the button is clicked.
      e.preventDefault();
      e.stopPropagation();

      if (status !== "authenticated") {
        router.push("/app/login");
        return;
      }

      if (isPending) return;
      setIsPending(true);
      try {
        await toggleRsvp(room);
      } catch {
        // Optimistic revert already applied by the store; swallow here so the
        // UI recovers gracefully.
      } finally {
        setIsPending(false);
      }
    },
    [isPending, room, router, status, toggleRsvp],
  );

  return (
    <Button
      variant={isGoing ? "ghost" : "secondary"}
      size="sm"
      disabled={isPending}
      aria-busy={isPending}
      loading={isPending}
      onClick={handleClick}
      className="shrink-0 text-[11px]"
    >
      {isPending ? null : isGoing ? "Going ✓" : "RSVP"}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Juke-hosted upcoming card
// ---------------------------------------------------------------------------

function JukeUpcomingSpaceCard({ room }: { room: Space }) {
  const isUpcoming = isUpcomingScheduledSpace(room);
  const googleCalendarUrl = isUpcoming ? buildGoogleCalendarUrl(room) : null;
  const isGoing = room.rsvp_summary?.is_going ?? false;
  const safePfp = safeImageUrl(room.host.pfp_url);

  return (
    <div className="group flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 transition-colors hover:border-white/20 hover:bg-white/[0.06]">
      {/* Clickable card body → space detail page */}
      <Link
        href={`/app/space/${encodeURIComponent(room.id)}`}
        className="flex flex-col gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
      >
        {/* Host row */}
        <div className="flex items-center gap-2">
          {safePfp ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={safePfp}
              alt=""
              width={20}
              height={20}
              referrerPolicy="no-referrer"
              className="h-5 w-5 shrink-0 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[9px] font-bold">
              {room.host.display_name.charAt(0).toUpperCase() || "?"}
            </div>
          )}
          <span className="truncate text-[11px] font-medium text-white/60">
            @{room.host.username}
          </span>
        </div>

        {/* Title */}
        <p className="text-xs font-semibold leading-tight text-white/90">
          {room.title}
        </p>

        {/* Start time */}
        {room.scheduled_at && (
          <p className="font-mono text-[10px] text-white/40">
            {formatScheduledTime(room.scheduled_at)}
          </p>
        )}
      </Link>

      {/* RSVP avatar row */}
      {room.rsvp_summary && room.rsvp_summary.count > 0 && (
        <RsvpAvatarRow summary={room.rsvp_summary} />
      )}

      {/* Action row: RSVP button + calendar links.
          Both are only meaningful for future-dated rooms; guard with isUpcoming
          so a stale scheduled room (scheduled_at in the past, status not yet
          updated by backend) shows neither control. */}
      {isUpcoming && (
        <div className="flex flex-wrap items-center gap-2">
          <RsvpButton room={room} isGoing={isGoing} />

          {googleCalendarUrl && (
            <a
              href={googleCalendarUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-white/10 px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-wide text-white/40 transition-colors hover:border-white/20 hover:text-white/60"
              onClick={(e) => e.stopPropagation()}
            >
              Google
            </a>
          )}
          <a
            href={`/space/${encodeURIComponent(room.id)}/calendar.ics`}
            download={getSpaceCalendarFilename(room.id)}
            type="text/calendar"
            className="rounded-full border border-white/10 px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-wide text-white/40 transition-colors hover:border-white/20 hover:text-white/60"
            onClick={(e) => e.stopPropagation()}
          >
            ICS
          </a>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Farcaster-native upcoming card (read-only, no RSVP)
// ---------------------------------------------------------------------------

function FarcasterUpcomingSpaceCard({ space }: { space: FarcasterNativeSpace }) {
  const label = hostLabel(space.host);
  const handle = hostHandle(space.host);
  const title = space.title?.trim() || "Scheduled space";
  const externalUrl = farcasterSpaceUrl(space.id);

  return (
    <a
      href={externalUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 transition-colors hover:border-white/20 hover:bg-white/[0.06]"
      aria-label={`View ${title} on Farcaster`}
    >
      {/* Header: host + Farcaster badge */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar src={space.host.pfp_url} name={label} size="xs" />
          <span className="truncate text-[11px] font-medium text-white/60">
            {handle}
          </span>
        </div>
        <span className="shrink-0 rounded-full bg-[#8a63d2]/20 px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wide text-[#b79cf0]">
          Farcaster
        </span>
      </div>

      {/* Title */}
      <p className="text-xs font-semibold leading-tight text-white/90">
        {title}
      </p>

      {/* Start time */}
      {space.scheduled_at && (
        <p className="font-mono text-[10px] text-white/40">
          {formatScheduledTime(space.scheduled_at)}
        </p>
      )}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Dispatching UpcomingSpaceCard
// ---------------------------------------------------------------------------

export function UpcomingSpaceCard({ item }: { item: DiscoverySpace }) {
  if (item.isFarcasterNative) {
    return <FarcasterUpcomingSpaceCard space={item.space} />;
  }
  return <JukeUpcomingSpaceCard room={item.space} />;
}
