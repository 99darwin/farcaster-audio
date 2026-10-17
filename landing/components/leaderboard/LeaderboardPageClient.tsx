"use client";

/**
 * Public recognition leaderboard — `juke.audio/leaderboard` (spec §4.1).
 *
 * Status-only: badges, placement, and a monthly spotlight. No auth required
 * to view. Client-fetched (mirrors the `ProfilePage`/`SettingsPage`
 * convention elsewhere in `landing/`) because the cycle switcher and the
 * signed-in "Your standing" strip both need client interactivity; the public
 * `GET /v1/leaderboard` call itself is a plain unauthenticated fetch so it
 * works identically for anonymous visitors.
 *
 * Session detection reads the global `authStore`/`session` singletons
 * directly rather than mounting `<AuthProvider>` — this route sits outside
 * the `/app` shell, and a silent cookie refresh is all "is this visitor
 * signed in" needs (no sign-in button lives on this page).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Navbar } from "@/components/navbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { CategoryBoard } from "@/components/leaderboard/CategoryBoard";
import { CycleSwitcher } from "@/components/leaderboard/CycleSwitcher";
import { HowPlacementsWork } from "@/components/leaderboard/HowPlacementsWork";
import { SupportCta } from "@/components/leaderboard/SupportCta";
import { YourStandingStrip } from "@/components/leaderboard/YourStandingStrip";
import { TrophyIcon } from "@/components/leaderboard/icons";
import {
  getLeaderboard,
  getLeaderboardMe,
  type LeaderboardMeResponse,
  type LeaderboardResponse,
} from "@/lib/api/leaderboard";
import { refreshSession } from "@/lib/auth/authRefresh";
import { useAuthStore } from "@/lib/stores/authStore";
import { earliestBrowsableCycle, getCurrentCycle } from "@/lib/leaderboard-cycles";

const CYCLE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Deep-linked `?cycle=` must be well-formed AND within the switcher's own
 * browsable bounds — otherwise fall back to the current cycle. */
function initialCycle(searchParams: URLSearchParams): string {
  const fromQuery = searchParams.get("cycle");
  const currentCycle = getCurrentCycle();
  if (
    fromQuery &&
    CYCLE_PATTERN.test(fromQuery) &&
    fromQuery >= earliestBrowsableCycle() &&
    fromQuery <= currentCycle
  ) {
    return fromQuery;
  }
  return currentCycle;
}

export function LeaderboardPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [cycle, setCycle] = useState(() => initialCycle(searchParams));
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [authChecked, setAuthChecked] = useState(false);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [me, setMe] = useState<LeaderboardMeResponse | null>(null);

  // Silent cookie-based session check — no full AuthProvider needed here.
  useEffect(() => {
    let active = true;
    refreshSession()
      .catch(() => {})
      .finally(() => {
        if (active) setAuthChecked(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!authChecked || !isAuthenticated) {
      setMe(null);
      return;
    }
    let active = true;
    getLeaderboardMe().then((data) => {
      if (active) setMe(data);
    });
    return () => {
      active = false;
    };
  }, [authChecked, isAuthenticated]);

  // Tracks the most recently requested cycle so a slow, stale response (e.g.
  // from rapidly clicking prev/next) can't clobber a newer one that resolved
  // first — the same race the auth/`me` effects above guard with `active`.
  const latestRequestedCycle = useRef(cycle);

  const loadCycle = useCallback((targetCycle: string) => {
    latestRequestedCycle.current = targetCycle;
    setLoading(true);
    getLeaderboard(targetCycle).then((data) => {
      if (latestRequestedCycle.current !== targetCycle) return; // stale
      setLeaderboard(data);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    loadCycle(cycle);
  }, [cycle, loadCycle]);

  // Keep the URL shareable without adding history entries per switch.
  useEffect(() => {
    router.replace(`/leaderboard?cycle=${encodeURIComponent(cycle)}`, {
      scroll: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router identity is stable; only re-run on cycle change
  }, [cycle]);

  const isCurrentCycle = cycle === getCurrentCycle();

  const computedAtLabel = useMemo(() => {
    // `computed_at` is nullable on the wire (no aggregation run yet); guard
    // explicitly since `new Date(null)` resolves to the epoch, not "invalid".
    if (!leaderboard?.computed_at) return null;
    const date = new Date(leaderboard.computed_at);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }, [leaderboard]);

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>

      <Navbar />

      <main id="main-content">
        {/* ── Hero ── */}
        <section className="relative bg-juke-cream px-6 pb-14 pt-28 sm:px-12 sm:pb-16 sm:pt-32">
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute top-0 right-0 h-full w-1/2 bg-gradient-to-l from-juke-purple/[0.05] to-transparent" />
          </div>

          <div className="relative z-10 mx-auto max-w-3xl">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-juke-orange/[0.09] py-1.5 pl-3 pr-4 text-sm font-semibold text-juke-orange ring-1 ring-juke-orange/20">
              <TrophyIcon className="h-4 w-4" />
              Community recognition
            </div>

            <h1 className="font-display mb-4 text-4xl font-bold leading-tight tracking-tight text-juke-text-primary sm:text-5xl">
              Leaderboard
            </h1>
            <p className="mb-8 max-w-xl text-lg text-juke-text-secondary">
              The people making Juke louder every month — hosts, voices, casters,
              and the community around them. Status only: badges and a spotlight,
              nothing to cash out.
            </p>

            <div className="mb-8 flex flex-wrap items-center gap-3">
              <CycleSwitcher cycle={cycle} onChange={setCycle} />
              {loading && leaderboard && <Spinner size="sm" />}
              {leaderboard && (
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${
                    leaderboard.status === "final"
                      ? "bg-juke-purple/10 text-juke-purple"
                      : "bg-juke-navy/[0.06] text-juke-text-tertiary"
                  }`}
                >
                  {leaderboard.status === "final" ? "Final" : "Provisional"}
                </span>
              )}
            </div>

            <HowPlacementsWork />

            {computedAtLabel && (
              <p className="mt-4 text-xs text-juke-text-tertiary">
                Last updated {computedAtLabel}
              </p>
            )}
          </div>
        </section>

        {/* ── Bridge ── */}
        <div className="h-14 bg-gradient-to-b from-juke-cream to-juke-navy sm:h-20" aria-hidden="true" />

        {/* ── Boards ── */}
        <section className="bg-juke-navy px-6 pb-24 sm:px-12">
          <div className="mx-auto max-w-5xl">
            {authChecked && isAuthenticated && me && (
              <YourStandingStrip
                me={me}
                categories={leaderboard?.categories ?? []}
                className="mb-8"
              />
            )}

            {loading && !leaderboard && (
              <div className="flex justify-center py-20">
                <Spinner size="lg" />
              </div>
            )}

            {!loading && !leaderboard && (
              <EmptyState
                icon={<TrophyIcon className="h-10 w-10" />}
                title={isCurrentCycle ? "First cycle in progress" : "No data for this cycle"}
                description={
                  isCurrentCycle
                    ? "Juke's recognition boards are warming up as the first monthly cycle plays out. Check back soon."
                    : "We don't have leaderboard data for this month."
                }
                action={
                  isCurrentCycle ? (
                    <Button variant="ghost" onClick={() => loadCycle(cycle)}>
                      Try again
                    </Button>
                  ) : undefined
                }
              />
            )}

            {leaderboard && (
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                {leaderboard.categories.map((category) => (
                  <CategoryBoard key={category.key} category={category} />
                ))}
              </div>
            )}

            <div className="mt-8">
              <SupportCta />
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
