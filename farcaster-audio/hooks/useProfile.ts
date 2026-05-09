import { useState, useCallback } from "react";
import * as api from "@/services/api";
import { haptic } from "@/utils/haptics";
import type { NeynarUser, NeynarCast } from "@/types/neynar";

interface ProfileState {
  user: NeynarUser | null;
  casts: NeynarCast[];
  isLoading: boolean;
  isCastsLoading: boolean;
  hasMoreCasts: boolean;
  castsCursor: string | null;
  error: string | null;
}

export function useProfile(fid: number) {
  const [state, setState] = useState<ProfileState>({
    user: null,
    casts: [],
    isLoading: false,
    isCastsLoading: false,
    hasMoreCasts: true,
    castsCursor: null,
    error: null,
  });

  const fetchProfile = useCallback(async () => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const [profileData, castsData] = await Promise.all([
        api.getUserProfile(fid),
        api.getUserCasts(fid, { limit: 25 }),
      ]);
      setState({
        user: profileData.user,
        casts: castsData.casts ?? [],
        isLoading: false,
        isCastsLoading: false,
        hasMoreCasts: !!castsData.next?.cursor,
        castsCursor: castsData.next?.cursor ?? null,
        error: null,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to load profile",
      }));
    }
  }, [fid]);

  const fetchMoreCasts = useCallback(async () => {
    if (state.isCastsLoading || !state.hasMoreCasts || !state.castsCursor)
      return;
    setState((s) => ({ ...s, isCastsLoading: true }));
    try {
      const data = await api.getUserCasts(fid, {
        limit: 25,
        cursor: state.castsCursor,
      });
      setState((s) => ({
        ...s,
        casts: [...s.casts, ...(data.casts ?? [])],
        isCastsLoading: false,
        hasMoreCasts: !!data.next?.cursor,
        castsCursor: data.next?.cursor ?? null,
      }));
    } catch {
      setState((s) => ({ ...s, isCastsLoading: false }));
    }
  }, [fid, state.isCastsLoading, state.hasMoreCasts, state.castsCursor]);

  const updateCastReaction = useCallback(
    (hash: string, type: "like" | "recast", added: boolean, myFid: number) => {
      setState((s) => ({
        ...s,
        casts: s.casts.map((cast) => {
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
      }));
    },
    [],
  );

  const updateCastBookmark = useCallback((hash: string, bookmarked: boolean) => {
    setState((s) => ({
      ...s,
      casts: s.casts.map((cast) =>
        cast.hash === hash
          ? {
              ...cast,
              viewer_context: {
                liked: false,
                recasted: false,
                ...cast.viewer_context,
                bookmarked,
              },
            }
          : cast,
      ),
    }));
  }, []);

  const toggleFollow = useCallback(async () => {
    if (!state.user) return;
    const wasFollowing = state.user.viewer_context?.following ?? false;

    // Optimistic update + haptic
    if (wasFollowing) {
      haptic.selection();
    } else {
      haptic.success();
    }
    setState((s) => ({
      ...s,
      user: s.user
        ? {
            ...s.user,
            follower_count: s.user.follower_count + (wasFollowing ? -1 : 1),
            viewer_context: {
              ...s.user.viewer_context!,
              following: !wasFollowing,
            },
          }
        : null,
    }));

    try {
      if (wasFollowing) {
        await api.unfollowUser(fid);
      } else {
        await api.followUser(fid);
      }
    } catch {
      // Rollback
      setState((s) => ({
        ...s,
        user: s.user
          ? {
              ...s.user,
              follower_count: s.user.follower_count + (wasFollowing ? 1 : -1),
              viewer_context: {
                ...s.user.viewer_context!,
                following: wasFollowing,
              },
            }
          : null,
      }));
    }
  }, [fid, state.user]);

  return {
    ...state,
    fetchProfile,
    fetchMoreCasts,
    toggleFollow,
    updateCastReaction,
    updateCastBookmark,
  };
}
