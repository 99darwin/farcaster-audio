"use client";

/**
 * Shared space card components used by both the horizontal rail strips and the
 * vertical SpacesPanel.
 *
 * `layout="rail"` (default) preserves the original h-24 w-44 shrink-0 sizing
 * used in the horizontal strips. `layout="list"` renders a full-width row for
 * the vertical panel.
 *
 * DECISION (user-approved): LiveSpaceCard links to `/app/space/{id}` — the
 * previous `/miniapp/spaces/{id}` route is retired.
 */

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/lib/auth/AuthProvider";
import { mirrorNativeSpace } from "@/lib/native/nativeSpaceApi";
import { safeImageUrl } from "@/lib/safe-url";
import type { Space, FarcasterNativeSpace } from "@/lib/spaces";

export type CardLayout = "rail" | "list";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listenerLabel(count: number | undefined): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
    return null;
  }
  return count === 1 ? "1 listener" : `${count.toLocaleString()} listeners`;
}

function hostLabel(host: FarcasterNativeSpace["host"]): string {
  return host.display_name || host.username || `fid ${host.fid}`;
}

function hostHandle(host: FarcasterNativeSpace["host"]): string {
  return host.username ? `@${host.username}` : `fid ${host.fid}`;
}

// ---------------------------------------------------------------------------
// LiveSpaceCard (Juke-hosted)
// ---------------------------------------------------------------------------

interface LiveSpaceCardProps {
  space: Space;
  layout?: CardLayout;
}

export function LiveSpaceCard({ space, layout = "rail" }: LiveSpaceCardProps) {
  const label =
    space.listener_count === 1
      ? "1 listener"
      : `${space.listener_count.toLocaleString()} listeners`;

  const isRail = layout === "rail";
  const safePfp = safeImageUrl(space.host.pfp_url);

  return (
    <Link
      href={`/app/space/${encodeURIComponent(space.id)}`}
      aria-label={`Join ${space.title}, hosted by ${space.host.display_name}. ${label}`}
      className={
        isRail
          ? "group relative flex h-24 w-44 shrink-0 flex-col justify-between overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 transition-colors hover:border-white/20 hover:bg-white/[0.06]"
          : "group flex w-full flex-col gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 transition-colors hover:border-white/20 hover:bg-white/[0.06]"
      }
    >
      {/* Host row */}
      <div className="flex items-center gap-2">
        {safePfp ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={safePfp}
            alt=""
            width={24}
            height={24}
            referrerPolicy="no-referrer"
            className="h-6 w-6 shrink-0 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold">
            {space.host.display_name.charAt(0).toUpperCase() || "?"}
          </div>
        )}
        <span className="truncate text-[11px] font-medium text-white/60">
          @{space.host.username}
        </span>
      </div>

      {/* Title */}
      <p
        className={
          isRail
            ? "line-clamp-2 text-xs font-semibold leading-tight text-white/90"
            : "text-xs font-semibold leading-tight text-white/90"
        }
      >
        {space.title}
      </p>

      {/* Listener count */}
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-white/40">
        <span className="relative flex h-1 w-1">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex h-1 w-1 rounded-full bg-red-500" />
        </span>
        <span className="tabular-nums">{label}</span>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// NativeSpaceCard (Farcaster-native)
// ---------------------------------------------------------------------------

interface NativeSpaceCardProps {
  space: FarcasterNativeSpace;
  layout?: CardLayout;
}

export function NativeSpaceCard({
  space,
  layout = "rail",
}: NativeSpaceCardProps) {
  const router = useRouter();
  const { status, user } = useAuth();
  const [isJoining, setIsJoining] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleTap = useCallback(async () => {
    if (isJoining) return;

    // Mirror is JWT-gated; bounce anonymous visitors to connect first.
    if (status !== "authenticated" || !user) {
      router.push("/app/login");
      return;
    }

    setIsJoining(true);
    setFailed(false);
    try {
      const mirrored = await mirrorNativeSpace({
        farcaster_room_id: space.id,
        title: space.title,
        state: space.state,
        host_fid: space.host.fid,
      });
      router.push(`/app/space/${encodeURIComponent(mirrored.id)}`);
    } catch {
      // Surface a retry affordance rather than silently stranding the user.
      setFailed(true);
      setIsJoining(false);
    }
  }, [isJoining, status, user, router, space]);

  const label = hostLabel(space.host);
  const handle = hostHandle(space.host);
  const title = space.title?.trim() || "Live space";
  const listeners = listenerLabel(space.listener_count);

  const isRail = layout === "rail";

  return (
    <button
      type="button"
      onClick={handleTap}
      disabled={isJoining}
      aria-busy={isJoining}
      aria-label={`Join ${title} on Farcaster, hosted by ${label}`}
      className={
        isRail
          ? "group relative flex h-24 w-44 shrink-0 flex-col justify-between overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-left transition-colors hover:border-white/20 hover:bg-white/[0.06] disabled:cursor-progress"
          : "group relative flex w-full flex-col gap-1.5 overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-left transition-colors hover:border-white/20 hover:bg-white/[0.06] disabled:cursor-progress"
      }
    >
      {/* Farcaster badge */}
      <span className="absolute right-2 top-2 rounded-full bg-[#8a63d2]/20 px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wide text-[#b79cf0]">
        Farcaster
      </span>

      {/* Host row */}
      <div className="flex items-center gap-2 pr-14">
        <Avatar src={space.host.pfp_url} name={label} size="xs" />
        <span className="truncate text-[11px] font-medium text-white/60">
          {handle}
        </span>
      </div>

      {/* Title */}
      <p
        className={
          isRail
            ? "line-clamp-2 text-xs font-semibold leading-tight text-white/90"
            : "text-xs font-semibold leading-tight text-white/90"
        }
      >
        {title}
      </p>

      {/* Status row */}
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-white/40">
        {isJoining ? (
          <>
            <Spinner size="sm" className="h-3 w-3 border" />
            <span>Opening…</span>
          </>
        ) : failed ? (
          <span className="text-red-400">Tap to retry</span>
        ) : (
          <>
            <span className="relative flex h-1 w-1">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#8a63d2] opacity-75" />
              <span className="relative inline-flex h-1 w-1 rounded-full bg-[#8a63d2]" />
            </span>
            <span className="tabular-nums">{listeners ?? "Live"}</span>
          </>
        )}
      </div>
    </button>
  );
}
