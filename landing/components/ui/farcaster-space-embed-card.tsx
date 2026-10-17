"use client";

/**
 * Cast-embed renderer for `https://farcaster.xyz/~/spaces/<uuid>` URLs — the
 * web port of the mobile client's `FarcasterSpaceEmbedCard`
 * (`farcaster-audio/components/feed/FarcasterSpaceEmbedCard.tsx`).
 *
 * Behaviour (mobile parity):
 *   - Lazily resolve the room snapshot via Juke's backend proxy
 *     (`/v1/farcaster-spaces/{id}`) to show host, title, live state, and
 *     listener count.
 *   - Click: mirror the upstream space into a Juke room (idempotent on
 *     `farcaster_room_id`) and navigate to `/app/space/{id}`. Anonymous
 *     visitors bounce to `/app/login`; a failed mirror falls back to the
 *     canonical farcaster.xyz deeplink in a new tab so the click never
 *     feels broken.
 *   - Loading: skeleton card.
 *   - Not-found / error: call `onFallback` and render null so the parent
 *     shows the generic OG card / link chip instead.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/lib/auth/AuthProvider";
import { mirrorNativeSpace } from "@/lib/native/nativeSpaceApi";
import {
  fetchFarcasterSpace,
  farcasterSpaceUrl,
  type FarcasterNativeSpace,
} from "@/lib/spaces";

interface FarcasterSpaceEmbedCardProps {
  /** Canonical lowercase UUID — pre-validated via `parseFarcasterSpaceUrl`. */
  spaceId: string;
  /** Called when no room data is available so the parent can fall back. */
  onFallback?: () => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; room: FarcasterNativeSpace }
  | { kind: "missing" };

function stateLabel(state: FarcasterNativeSpace["state"]): string {
  if (state === "ended") return "Ended";
  return "Scheduled";
}

export function FarcasterSpaceEmbedCard({
  spaceId,
  onFallback,
}: FarcasterSpaceEmbedCardProps) {
  const router = useRouter();
  const { status, user } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [isJoining, setIsJoining] = useState(false);

  // Stash the latest `onFallback` in a ref so the resolution effect depends
  // on `spaceId` alone — parents pass inline arrows and re-fetching on every
  // parent render would burn API calls.
  const onFallbackRef = useRef(onFallback);
  useEffect(() => {
    onFallbackRef.current = onFallback;
  }, [onFallback]);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    // `fetchFarcasterSpace` collapses 4xx/5xx/network failures to `null`.
    fetchFarcasterSpace(spaceId).then((room) => {
      if (cancelled) return;
      if (!room) {
        setState({ kind: "missing" });
        onFallbackRef.current?.();
        return;
      }
      setState({ kind: "ready", room });
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  const handleClick = useCallback(async () => {
    if (state.kind !== "ready" || isJoining) return;
    const room = state.room;

    // Mirror is JWT-gated; bounce anonymous visitors to connect first.
    if (status !== "authenticated" || !user) {
      router.push("/app/login");
      return;
    }

    setIsJoining(true);
    try {
      const mirrored = await mirrorNativeSpace({
        farcaster_room_id: room.id,
        title: room.title,
        state: room.state,
        host_fid: room.host.fid,
      });
      router.push(`/app/space/${encodeURIComponent(mirrored.id)}`);
    } catch {
      // Mirror failed (offline, 5xx) — open the canonical deeplink instead.
      window.open(farcasterSpaceUrl(spaceId), "_blank", "noopener,noreferrer");
      setIsJoining(false);
    }
  }, [state, isJoining, status, user, router, spaceId]);

  if (state.kind === "loading") {
    return (
      <div
        role="progressbar"
        aria-label="Loading Farcaster space"
        className="mt-2 flex items-center gap-3 rounded-xl border border-juke-border bg-[#8a63d2]/[0.08] p-3"
      >
        <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-white/10" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="h-3.5 w-2/3 animate-pulse rounded bg-white/10" />
          <div className="h-3 w-2/5 animate-pulse rounded bg-white/10" />
        </div>
      </div>
    );
  }

  if (state.kind === "missing") {
    // Parent renders the generic OG card / link chip via `onFallback`.
    return null;
  }

  const room = state.room;
  const host = room.host;
  const displayName = host.display_name || host.username || "—";
  const isLive = room.state === "live";
  // Upstream-controlled field — clamp to a finite non-negative number.
  const listeners =
    typeof room.listener_count === "number" &&
    Number.isFinite(room.listener_count) &&
    room.listener_count > 0
      ? room.listener_count
      : 0;
  const title = room.title?.trim() || "Audio space";

  return (
    <button
      type="button"
      onClick={(event) => {
        // Never trigger the parent CastCard's whole-card thread navigation.
        event.stopPropagation();
        void handleClick();
      }}
      disabled={isJoining}
      aria-busy={isJoining}
      aria-label={`Join ${title} on Farcaster, hosted by ${displayName}`}
      className="mt-2 flex w-full items-center gap-3 rounded-xl border border-juke-border bg-[#8a63d2]/[0.08] p-3 text-left transition-colors hover:border-white/20 hover:bg-[#8a63d2]/[0.14] disabled:cursor-progress"
    >
      <Avatar src={host.pfp_url} name={displayName} size="md" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="truncate text-sm font-semibold text-white/90">{title}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {isLive ? (
            <span className="flex items-center gap-1 rounded-md bg-[#8a63d2] px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-white">
              <span className="h-1.5 w-1.5 rounded-full bg-white" />
              Live
            </span>
          ) : (
            <span className="text-xs font-semibold text-white/50">
              {stateLabel(room.state)}
            </span>
          )}
          {isLive && listeners > 0 && (
            <span className="text-xs tabular-nums text-white/50">
              {listeners.toLocaleString()} listening
            </span>
          )}
          <span className="truncate text-xs text-white/50">{displayName}</span>
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-[#8a63d2] px-3 py-1.5 text-[13px] font-bold text-white">
        {isJoining && <Spinner size="sm" className="h-3 w-3 border" />}
        {isJoining ? "Opening…" : "Join"}
      </span>
    </button>
  );
}
