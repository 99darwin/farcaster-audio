"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";
import { useSpaceStore } from "@/lib/space/spaceStore";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/components/ui/cn";

/**
 * Persistent mini audio bar. Lives in the app layout's client subtree so it
 * survives route changes while a space is active. Reads the space store and
 * renders nothing when there is no active room. Tapping the bar (not the
 * controls) routes to the full space screen.
 *
 * Positioning: on mobile it stacks just above the fixed BottomNav; on md+ it
 * pins to the bottom edge (no bottom nav there).
 */
export function SpaceMiniBar() {
  const router = useRouter();
  const pathname = usePathname();
  const room = useSpaceStore((s) => s.room);
  const isConnected = useSpaceStore((s) => s.isConnected);
  const isMuted = useSpaceStore((s) => s.isMuted);
  const toggleMute = useSpaceStore((s) => s.toggleMute);
  const leaveSpace = useSpaceStore((s) => s.leaveSpace);

  const handleLeave = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      await leaveSpace();
    },
    [leaveSpace],
  );

  const handleToggleMute = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleMute();
    },
    [toggleMute],
  );

  const openSpace = useCallback(() => {
    if (room) router.push(`/app/space/${encodeURIComponent(room.id)}`);
  }, [room, router]);

  // No active room → occupy no space at all.
  if (!room) return null;

  // Hide while viewing this space's own full screen (listener or host view):
  // the in-room Controls bar owns the bottom edge there, so a mini-bar would
  // overlap it. It reappears the moment you navigate elsewhere.
  const roomId = encodeURIComponent(room.id);
  if (
    pathname === `/app/space/${roomId}` ||
    pathname === `/app/space/host/${roomId}`
  ) {
    return null;
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open space: ${room.title}`}
      onClick={openSpace}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openSpace();
        }
      }}
      className={cn(
        "fixed inset-x-0 z-40 mx-auto flex max-w-2xl cursor-pointer items-center gap-3 border-t border-juke-border bg-juke-surface px-3 py-2 shadow-2xl md:px-4",
        // Stack above the mobile bottom-nav; pin to the edge on desktop.
        "bottom-[calc(3.5rem+env(safe-area-inset-bottom))] md:bottom-0",
      )}
    >
      <Avatar src={room.host.pfp_url} name={room.host.display_name} size="sm" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            {isConnected && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-juke-orange opacity-75" />
            )}
            <span
              className={cn(
                "relative inline-flex h-1.5 w-1.5 rounded-full",
                isConnected ? "bg-juke-orange" : "bg-juke-text-on-dark-tertiary",
              )}
            />
          </span>
          <p className="truncate text-sm font-semibold text-juke-text-on-dark">
            {room.title}
          </p>
        </div>
        <p className="truncate text-xs text-juke-text-on-dark-secondary">
          {isConnected ? `@${room.host.username}` : "Connecting…"}
        </p>
      </div>

      <button
        type="button"
        onClick={handleToggleMute}
        aria-label={isMuted ? "Unmute" : "Mute"}
        aria-pressed={isMuted}
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors",
          isMuted
            ? "bg-juke-navy text-juke-text-on-dark-secondary hover:text-juke-text-on-dark"
            : "bg-juke-orange text-white hover:bg-juke-orange-hover",
        )}
      >
        {isMuted ? <MicOffIcon /> : <MicIcon />}
      </button>

      <button
        type="button"
        onClick={handleLeave}
        aria-label="Leave space"
        className="flex h-9 shrink-0 items-center rounded-full bg-juke-navy px-3 text-xs font-semibold text-red-400 transition-colors hover:bg-red-500/10"
      >
        Leave
      </button>
    </div>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <rect
        x="9"
        y="3"
        width="6"
        height="11"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M5 11a7 7 0 0 0 14 0M12 18v3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <path
        d="M9 9v2a3 3 0 0 0 4.5 2.6M15 11V6a3 3 0 0 0-5.6-1.5M5 11a7 7 0 0 0 10.5 6M12 18v3M4 4l16 16"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
