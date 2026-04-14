import { create } from "zustand";
import type { NeynarCast } from "@/types/neynar";

interface FeedStore {
  casts: NeynarCast[];
  cursor: string | null;
  isLoading: boolean;
  isRefreshing: boolean;
  hasMore: boolean;
  error: string | null;

  // Actions
  setCasts: (casts: NeynarCast[], cursor: string | null) => void;
  appendCasts: (casts: NeynarCast[], cursor: string | null) => void;
  setLoading: (loading: boolean) => void;
  setRefreshing: (refreshing: boolean) => void;
  setError: (error: string | null) => void;
  updateCastReaction: (
    hash: string,
    type: "like" | "recast",
    added: boolean,
    myFid: number,
  ) => void;
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
      casts: [...state.casts, ...newCasts],
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
      casts: state.casts.map((cast) => {
        if (cast.hash !== hash) return cast;
        const reactions = { ...cast.reactions };
        const viewerContext = {
          liked: false,
          recasted: false,
          ...cast.viewer_context,
        };
        if (type === "like") {
          reactions.likes_count = added
            ? reactions.likes_count + 1
            : Math.max(0, reactions.likes_count - 1);
          reactions.likes = added
            ? [...reactions.likes, { fid: myFid }]
            : reactions.likes.filter((l) => l.fid !== myFid);
          viewerContext.liked = added;
        } else {
          reactions.recasts_count = added
            ? reactions.recasts_count + 1
            : Math.max(0, reactions.recasts_count - 1);
          reactions.recasts = added
            ? [...reactions.recasts, { fid: myFid }]
            : reactions.recasts.filter((r) => r.fid !== myFid);
          viewerContext.recasted = added;
        }
        return { ...cast, reactions, viewer_context: viewerContext };
      }),
    })),

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
