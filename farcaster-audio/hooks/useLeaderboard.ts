import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthStore } from "@/stores/authStore";
import { getErrorMessage } from "@/services/api";
import {
  CATEGORY_ORDER,
  FIRST_CYCLE,
  currentCycle,
  getLeaderboard,
  getMyLeaderboardStanding,
  isAtOrAfterCurrentCycle,
  shiftCycle,
  type LeaderboardCategoryKey,
  type LeaderboardMeResponse,
  type LeaderboardResponse,
} from "@/services/leaderboard";

export function useLeaderboard() {
  const user = useAuthStore((s) => s.user);
  const [cycle, setCycle] = useState(() => currentCycle());
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] =
    useState<LeaderboardCategoryKey>("top_hosts");

  const [standing, setStanding] = useState<LeaderboardMeResponse | null>(
    null,
  );
  const [isStandingLoading, setIsStandingLoading] = useState(false);

  // Monotonic request id: only the latest fetch may write state, so rapid
  // cycle switches can never render an older response under a newer cycle
  // label (out-of-order resolution).
  const fetchSeq = useRef(0);

  const fetchLeaderboard = useCallback(async (forCycle: string) => {
    const seq = ++fetchSeq.current;
    // Clear the outgoing cycle's board immediately — showing July's rows
    // under June's header (even briefly, or after a failed fetch) is worse
    // than a spinner.
    setData(null);
    setIsLoading(true);
    setError(null);
    try {
      const response = await getLeaderboard(forCycle);
      if (seq !== fetchSeq.current) return;
      setData(response);
    } catch (err) {
      if (seq !== fetchSeq.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (seq === fetchSeq.current) setIsLoading(false);
    }
  }, []);

  const fetchStanding = useCallback(async () => {
    if (!user) return;
    setIsStandingLoading(true);
    try {
      const response = await getMyLeaderboardStanding();
      setStanding(response);
    } catch {
      // "Your standing" is a supplement to the public board — swallow
      // errors so a failure here never blocks the board from rendering.
      setStanding(null);
    } finally {
      setIsStandingLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchLeaderboard(cycle);
  }, [cycle, fetchLeaderboard]);

  useEffect(() => {
    fetchStanding();
  }, [fetchStanding]);

  const canGoNext = !isAtOrAfterCurrentCycle(cycle);
  const canGoPrevious = cycle > FIRST_CYCLE;
  const goToPreviousCycle = useCallback(() => {
    setCycle((c) => (c > FIRST_CYCLE ? shiftCycle(c, -1) : c));
  }, []);
  const goToNextCycle = useCallback(() => {
    setCycle((c) => (isAtOrAfterCurrentCycle(c) ? c : shiftCycle(c, 1)));
  }, []);

  const categories = useMemo(
    () => data?.categories ?? [],
    [data],
  );

  const activeEntries = useMemo(
    () =>
      categories.find((category) => category.key === activeCategory)
        ?.entries ?? [],
    [categories, activeCategory],
  );

  const isEmpty =
    !isLoading &&
    !error &&
    data !== null &&
    categories.every((category) => category.entries.length === 0);

  const refresh = useCallback(() => {
    fetchLeaderboard(cycle);
    fetchStanding();
  }, [cycle, fetchLeaderboard, fetchStanding]);

  return {
    cycle,
    data,
    isLoading,
    error,
    categories,
    categoryOrder: CATEGORY_ORDER,
    activeCategory,
    setActiveCategory,
    activeEntries,
    isEmpty,
    canGoNext,
    canGoPrevious,
    goToPreviousCycle,
    goToNextCycle,
    refresh,
    standing,
    isStandingLoading,
  };
}
