import { create } from "zustand";
import type { FarcasterCast } from "@/types/farcaster";
import {
  appendUniqueCasts,
  removeCastsByAuthor,
  updateCastBookmark,
  updateCastReaction,
} from "@/utils/castUpdates";

interface FeedStore {
  casts: FarcasterCast[];
  cursor: string | null;
  isLoading: boolean;
  isRefreshing: boolean;
  hasMore: boolean;
  error: string | null;

  // Actions
  setCasts: (casts: FarcasterCast[], cursor: string | null) => void;
  appendCasts: (casts: FarcasterCast[], cursor: string | null) => void;
  setLoading: (loading: boolean) => void;
  setRefreshing: (refreshing: boolean) => void;
  setError: (error: string | null) => void;
  updateCastReaction: (
    hash: string,
    type: "like" | "recast",
    added: boolean,
    myFid: number,
  ) => void;
  updateCastBookmark: (hash: string, bookmarked: boolean) => void;
  removeAuthor: (fid: number) => void;
  reset: () => void;
}

export const useFeedStore = create<FeedStore>((set) => ({
  casts: [],
  cursor: null,
  isLoading: false,
  isRefreshing: false,
  hasMore: true,
  error: null,

  setCasts: (casts, cursor) =>
    set({
      casts,
      cursor,
      hasMore: cursor !== null,
      isLoading: false,
      isRefreshing: false,
      error: null,
    }),

  appendCasts: (newCasts, cursor) =>
    set((state) => ({
      casts: appendUniqueCasts(state.casts, newCasts),
      cursor,
      hasMore: cursor !== null,
      isLoading: false,
      error: null,
    })),

  setLoading: (isLoading) => set({ isLoading }),
  setRefreshing: (isRefreshing) => set({ isRefreshing }),
  setError: (error) => set({ error, isLoading: false, isRefreshing: false }),

  updateCastReaction: (hash, type, added, myFid) =>
    set((state) => ({
      casts: updateCastReaction(state.casts, { hash, type, added, myFid }),
    })),

  updateCastBookmark: (hash, bookmarked) =>
    set((state) => ({
      casts: updateCastBookmark(state.casts, hash, bookmarked),
    })),

  removeAuthor: (fid) =>
    set((state) => ({ casts: removeCastsByAuthor(state.casts, fid) })),

  reset: () =>
    set({
      casts: [],
      cursor: null,
      isLoading: false,
      isRefreshing: false,
      hasMore: true,
      error: null,
    }),
}));
