import { useEffect, useRef, useCallback } from "react";
import { useSpaceStore } from "@/stores/spaceStore";
import * as api from "@/services/api";

const POLL_INTERVAL_MS = 15_000;

export function useLiveSpaces() {
  const setActiveLiveSpaces = useSpaceStore((s) => s.setActiveLiveSpaces);
  const setScheduledSpaces = useSpaceStore((s) => s.setScheduledSpaces);
  const activeLiveSpaces = useSpaceStore((s) => s.activeLiveSpaces);
  const scheduledSpaces = useSpaceStore((s) => s.scheduledSpaces);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSpaces = useCallback(async () => {
    try {
      const [activeRes, scheduledRes] = await Promise.all([
        api.listRooms({ status: "active", limit: 20 }),
        api.listRooms({ status: "scheduled", limit: 20 }),
      ]);
      setActiveLiveSpaces(activeRes.rooms);
      setScheduledSpaces(scheduledRes.rooms);
    } catch (err) {
      console.error("Failed to fetch live spaces:", err);
    }
  }, [setActiveLiveSpaces, setScheduledSpaces]);

  useEffect(() => {
    fetchSpaces();
    intervalRef.current = setInterval(fetchSpaces, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchSpaces]);

  return { activeLiveSpaces, scheduledSpaces, refresh: fetchSpaces };
}
