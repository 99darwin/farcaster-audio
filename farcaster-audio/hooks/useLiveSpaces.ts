import { useEffect, useRef, useCallback } from 'react';
import { useSpaceStore } from '@/stores/spaceStore';
import * as api from '@/services/api';

const POLL_INTERVAL_MS = 15_000;

export function useLiveSpaces() {
  const setActiveLiveSpaces = useSpaceStore((s) => s.setActiveLiveSpaces);
  const activeLiveSpaces = useSpaceStore((s) => s.activeLiveSpaces);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSpaces = useCallback(async () => {
    try {
      const { rooms } = await api.listRooms({ status: 'active', limit: 20 });
      setActiveLiveSpaces(rooms);
    } catch (err) {
      console.error('Failed to fetch live spaces:', err);
    }
  }, [setActiveLiveSpaces]);

  useEffect(() => {
    fetchSpaces();
    intervalRef.current = setInterval(fetchSpaces, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchSpaces]);

  return { activeLiveSpaces, refresh: fetchSpaces };
}
