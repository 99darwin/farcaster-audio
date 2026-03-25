import { useState, useCallback } from 'react';
import * as api from '@/services/api';
import type { NeynarUser, NeynarCast } from '@/types/neynar';

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
        error: err instanceof Error ? err.message : 'Failed to load profile',
      }));
    }
  }, [fid]);

  const fetchMoreCasts = useCallback(async () => {
    if (state.isCastsLoading || !state.hasMoreCasts || !state.castsCursor) return;
    setState((s) => ({ ...s, isCastsLoading: true }));
    try {
      const data = await api.getUserCasts(fid, { limit: 25, cursor: state.castsCursor });
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

  const toggleFollow = useCallback(async () => {
    if (!state.user) return;
    const wasFollowing = state.user.viewer_context?.following ?? false;

    // Optimistic update
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
  };
}
