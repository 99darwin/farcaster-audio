"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { getActiveSpaces, type Space } from "@/lib/spaces";

const POLL_INTERVAL_MS = 30_000;

/**
 * Horizontal scrolling strip of currently-live spaces.
 *
 * Renders nothing when there are no active spaces so the home feed stays
 * clean. Polls every 30s while mounted; stops on unmount.
 */
export function LiveSpacesStrip() {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchSpaces() {
      try {
        const res = await getActiveSpaces();
        if (cancelled) return;
        setSpaces(res.rooms);
      } catch {
        // Silent failure — strip simply stays empty if backend is unreachable.
      } finally {
        if (!cancelled) setIsInitialLoad(false);
      }
    }

    fetchSpaces();
    pollTimerRef.current = setInterval(fetchSpaces, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  // Skeleton while we wait for the first fetch — matches the voice-note
  // skeleton rhythm so the page doesn't jank.
  if (isInitialLoad) {
    return (
      <div className="border-b border-white/10 px-4 py-3">
        <div className="mb-2 flex items-center gap-1.5">
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/20" />
          <div className="h-3 w-20 animate-pulse rounded bg-white/10" />
        </div>
        <div className="flex gap-2 overflow-hidden">
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              className="h-24 w-44 shrink-0 animate-pulse rounded-xl bg-white/5"
            />
          ))}
        </div>
      </div>
    );
  }

  if (spaces.length === 0) return null;

  return (
    <section
      aria-label="Live now"
      className="border-b border-white/10 px-4 py-3"
    >
      <h2 className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-white/50">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500" />
        </span>
        Live now
      </h2>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {spaces.map((space) => (
          <LiveSpaceCard key={space.id} space={space} />
        ))}
      </div>
    </section>
  );
}

function LiveSpaceCard({ space }: { space: Space }) {
  const listenerLabel =
    space.listener_count === 1
      ? "1 listener"
      : `${space.listener_count.toLocaleString()} listeners`;

  return (
    <Link
      href={`/miniapp/spaces/${space.id}`}
      className="group relative flex h-24 w-44 shrink-0 flex-col justify-between overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 transition-colors hover:border-white/20 hover:bg-white/[0.06]"
    >
      <div className="flex items-center gap-2">
        {space.host.pfp_url ? (
          <img
            src={space.host.pfp_url}
            alt=""
            width={24}
            height={24}
            className="h-6 w-6 shrink-0 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold">
            {space.host.display_name.charAt(0).toUpperCase()}
          </div>
        )}
        <span className="truncate text-[11px] font-medium text-white/60">
          @{space.host.username}
        </span>
      </div>

      <p className="line-clamp-2 text-xs font-semibold leading-tight text-white/90">
        {space.title}
      </p>

      <div className="flex items-center gap-1.5 font-mono text-[10px] text-white/40">
        <span className="relative flex h-1 w-1">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex h-1 w-1 rounded-full bg-red-500" />
        </span>
        <span className="tabular-nums">{listenerLabel}</span>
      </div>
    </Link>
  );
}
