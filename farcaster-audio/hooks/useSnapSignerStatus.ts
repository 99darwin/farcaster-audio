/**
 * Shared subscription for snap signer status, keyed by fid.
 *
 * Multiple `SnapCard` instances must share a single status view so we do
 * not fan out N backend checks as FlatList virtualization recycles cards.
 * This hook exposes a zustand-backed slice with a lazy fast-path read from
 * SecureStore and an explicit `refresh` / `invalidate` surface.
 */

import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import {
  getSnapSignerStatus,
  invalidateSnapSigner,
  type SnapSignerStatus,
} from '@/services/snapSigner';

interface SignerEntry {
  status: SnapSignerStatus;
  lastCheckedAt: number;
  hydrated: boolean;
  inFlight: boolean;
}

interface SnapSignerStore {
  byFid: Record<number, SignerEntry>;
  set: (fid: number, patch: Partial<SignerEntry>) => void;
}

const EMPTY: SignerEntry = {
  status: 'none',
  lastCheckedAt: 0,
  hydrated: false,
  inFlight: false,
};

const useSnapSignerStore = create<SnapSignerStore>((set) => ({
  byFid: {},
  set: (fid, patch) =>
    set((state) => ({
      byFid: {
        ...state.byFid,
        [fid]: { ...(state.byFid[fid] ?? EMPTY), ...patch },
      },
    })),
}));

// Module-level dedupe: only one in-flight fetch per fid across all subscribers.
const inFlightByFid = new Map<number, Promise<SnapSignerStatus>>();

async function fetchStatus(fid: number, force: boolean): Promise<SnapSignerStatus> {
  const existing = inFlightByFid.get(fid);
  if (existing && !force) return existing;

  const promise = (async () => {
    try {
      return await getSnapSignerStatus(fid, { force });
    } finally {
      inFlightByFid.delete(fid);
    }
  })();
  inFlightByFid.set(fid, promise);
  return promise;
}

export interface UseSnapSignerStatusResult {
  status: SnapSignerStatus;
  lastCheckedAt: number;
  refresh: (opts?: { force?: boolean }) => Promise<SnapSignerStatus>;
  invalidate: () => Promise<void>;
}

export function useSnapSignerStatus(fid: number): UseSnapSignerStatusResult {
  const entry = useSnapSignerStore((s) => s.byFid[fid]) ?? EMPTY;
  const setEntry = useSnapSignerStore((s) => s.set);

  const refresh = useMemo(
    () =>
      async (opts: { force?: boolean } = {}): Promise<SnapSignerStatus> => {
        if (!fid) return 'none';
        setEntry(fid, { inFlight: true });
        try {
          const next = await fetchStatus(fid, opts.force ?? false);
          setEntry(fid, {
            status: next,
            lastCheckedAt: Date.now(),
            hydrated: true,
            inFlight: false,
          });
          return next;
        } catch {
          setEntry(fid, { hydrated: true, inFlight: false });
          return entry.status;
        }
      },
    // entry.status is only used in the catch fallback; capturing the current
    // closure is fine.
    [fid, setEntry, entry.status],
  );

  const invalidate = useMemo(
    () => async (): Promise<void> => {
      if (!fid) return;
      await invalidateSnapSigner(fid);
      setEntry(fid, {
        status: 'none',
        lastCheckedAt: Date.now(),
        hydrated: true,
        inFlight: false,
      });
    },
    [fid, setEntry],
  );

  // First subscriber for this fid triggers a lazy load. SecureStore-backed
  // fast path keeps this off the network when the signer is already approved.
  useEffect(() => {
    if (!fid) return;
    if (entry.hydrated || entry.inFlight) return;
    void refresh();
  }, [fid, entry.hydrated, entry.inFlight, refresh]);

  return {
    status: entry.status,
    lastCheckedAt: entry.lastCheckedAt,
    refresh,
    invalidate,
  };
}
