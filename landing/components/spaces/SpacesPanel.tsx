"use client";

/**
 * SpacesPanel — right-rail widget showing live + upcoming audio spaces.
 *
 * Consumes `useSpacesDiscovery()` (refcounted WS + poll, shared across the
 * page so no duplicate socket). Two sections:
 *   • **Live now** — all live `DiscoverySpace` items, narrowed per-item to
 *     `LiveSpaceCard` (Juke) or `NativeSpaceCard` (Farcaster), layout="list".
 *     Pulsing red dot header, same font-mono uppercase style as the strips.
 *   • **Upcoming** — scheduled items → `UpcomingSpaceCard`.
 *
 * Each section caps at `SECTION_LIMIT` items with a "Show more" expander.
 * Renders skeletons while `!hydrated`; quiet empty-state text when empty.
 * Footer CTA: "Start a space" → `/app/space/create`.
 *
 * No props — the shell worker (`RightRail`) imports and mounts this directly.
 */

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useSpacesDiscovery } from "@/lib/hooks/useSpacesDiscovery";
import type { DiscoverySpace } from "@/lib/spaces";
import { LiveSpaceCard, NativeSpaceCard } from "./cards";
import { UpcomingSpaceCard } from "./UpcomingSpaceCard";

const SECTION_LIMIT = 8;

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4" aria-busy aria-label="Loading spaces">
      {/* Section header */}
      <div className="mb-1 h-3 w-20 animate-pulse rounded bg-white/10" />
      {/* Cards */}
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="h-20 w-full animate-pulse rounded-xl bg-white/5" />
      ))}
      {/* Upcoming header */}
      <div className="mt-2 h-3 w-24 animate-pulse rounded bg-white/10" />
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i} className="h-20 w-full animate-pulse rounded-xl bg-white/5" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

interface SectionHeaderProps {
  children: ReactNode;
  live?: boolean;
}

function SectionHeader({ children, live = false }: SectionHeaderProps) {
  return (
    <h2 className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-white/50">
      {live && (
        <span className="relative flex h-1.5 w-1.5" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75 motion-reduce:animate-none" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500" />
        </span>
      )}
      {children}
    </h2>
  );
}

// ---------------------------------------------------------------------------
// "Show more" expander
// ---------------------------------------------------------------------------

interface ShowMoreProps {
  total: number;
  shown: number;
  onExpand: () => void;
}

function ShowMore({ total, shown, onExpand }: ShowMoreProps) {
  const remaining = total - shown;
  if (remaining <= 0) return null;

  return (
    <button
      type="button"
      onClick={onExpand}
      className="min-h-11 w-full rounded-xl border border-white/10 px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wide text-white/50 transition-colors hover:border-white/20 hover:text-white/70"
    >
      Show {remaining} more
    </button>
  );
}

// ---------------------------------------------------------------------------
// Live dispatch (Juke → LiveSpaceCard; Farcaster → NativeSpaceCard)
// ---------------------------------------------------------------------------

function LiveItem({ item }: { item: DiscoverySpace }) {
  if (item.isFarcasterNative) {
    return <NativeSpaceCard space={item.space} layout="list" />;
  }
  return <LiveSpaceCard space={item.space} layout="list" />;
}

// ---------------------------------------------------------------------------
// SpacesPanel
// ---------------------------------------------------------------------------

export function SpacesPanel() {
  const { live, upcoming, hydrated } = useSpacesDiscovery();
  const [liveExpanded, setLiveExpanded] = useState(false);
  const [upcomingExpanded, setUpcomingExpanded] = useState(false);

  if (!hydrated) return <PanelSkeleton />;

  const hasLive = live.length > 0;
  const hasUpcoming = upcoming.length > 0;
  const hasAny = hasLive || hasUpcoming;

  const visibleLive = liveExpanded ? live : live.slice(0, SECTION_LIMIT);
  const visibleUpcoming = upcomingExpanded
    ? upcoming
    : upcoming.slice(0, SECTION_LIMIT);

  return (
    <div className="flex flex-col gap-5 p-4">
      {/* ---- Live now ---- */}
      <section aria-label="Live now">
        <SectionHeader live>Live now</SectionHeader>

        {hasLive ? (
          <div className="mt-3 flex flex-col gap-2">
            {visibleLive.map((item) => {
              const key = item.isFarcasterNative
                ? `fc-${item.space.id}`
                : `juke-${item.space.id}`;
              return <LiveItem key={key} item={item} />;
            })}
            {!liveExpanded && (
              <ShowMore
                total={live.length}
                shown={visibleLive.length}
                onExpand={() => setLiveExpanded(true)}
              />
            )}
          </div>
        ) : (
          <p className="mt-3 text-[11px] text-white/50">
            No spaces live right now.
          </p>
        )}
      </section>

      {/* ---- Upcoming ---- */}
      <section aria-label="Upcoming spaces">
        <SectionHeader>Upcoming</SectionHeader>

        {hasUpcoming ? (
          <div className="mt-3 flex flex-col gap-2">
            {visibleUpcoming.map((item) => {
              const key = item.isFarcasterNative
                ? `fc-up-${item.space.id}`
                : `juke-up-${item.space.id}`;
              return <UpcomingSpaceCard key={key} item={item} />;
            })}
            {!upcomingExpanded && (
              <ShowMore
                total={upcoming.length}
                shown={visibleUpcoming.length}
                onExpand={() => setUpcomingExpanded(true)}
              />
            )}
          </div>
        ) : (
          <p className="mt-3 text-[11px] text-white/50">
            No upcoming spaces scheduled.
          </p>
        )}
      </section>

      {/* ---- Footer CTA ---- */}
      {!hasAny && (
        <p className="text-center text-[11px] text-white/50">
          It&apos;s quiet in here — be the first to go live.
        </p>
      )}

      <div className="pt-1">
        <Link
          href="/app/space/create"
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-white/10 px-3 py-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-white/60 transition-colors hover:border-white/25 hover:text-white/80"
        >
          <span aria-hidden>+</span> Start a space
        </Link>
      </div>
    </div>
  );
}
