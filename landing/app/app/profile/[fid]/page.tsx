"use client";

/**
 * User profile screen — mirrors mobile `app/profile/[fid].tsx`.
 *
 * Header (pfp, name, handle, bio, follower/following counts) with follow +
 * block controls, and a tabbed body (Casts | Recordings). The `[fid]` route
 * param accepts either a numeric FID or a Farcaster username (the app header
 * links profiles by handle), resolving via the matching backend endpoint.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { FeedList } from "@/components/ui/feed-list";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { TabBar } from "@/components/ui/tab-bar";
import { Modal } from "@/components/ui/modal";
import { CastCard } from "@/components/ui/cast-card";
import { RecordingFeedItem } from "@/components/recording-feed-item";
import { AwardBadges } from "@/components/leaderboard/AwardBadges";
import { getLeaderboardAwards, type LeaderboardAward } from "@/lib/api/leaderboard";
import {
  identityCast,
  useCastListNavigation,
} from "@/lib/keyboard/useCastListNavigation";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useComposeStore } from "@/lib/stores/composeStore";
import type { Cast } from "@/lib/api/types";
import type { Recording } from "@/lib/recordings";
import {
  applyBookmark,
  applyReaction,
  blockUser,
  bookmarkCast,
  followUser,
  getUser,
  getUserByUsername,
  getUserCasts,
  getUserRecordings,
  likeCast,
  recastCast,
  toRecordingFeedItems,
  unblockUser,
  unbookmarkCast,
  unfollowUser,
  unlikeCast,
  unrecastCast,
  type ProfileUser,
} from "@/lib/api/users";

type ProfileTab = "casts" | "replies" | "recordings";

const TABS = [
  { key: "casts" as const, label: "Casts" },
  { key: "replies" as const, label: "Replies" },
  { key: "recordings" as const, label: "Recordings" },
];

/** Stable empty list so the keyboard hook no-ops on the recordings tab. */
const NO_CASTS: Cast[] = [];

/** Compute "Part N of M" badges for spaces with multiple recorded segments. */
function computePartInfo(recordings: Recording[]) {
  const byRoom = new Map<string, Recording[]>();
  for (const r of recordings) {
    const arr = byRoom.get(r.room_id) ?? [];
    arr.push(r);
    byRoom.set(r.room_id, arr);
  }
  const map = new Map<string, { index: number; total: number }>();
  for (const segments of byRoom.values()) {
    if (segments.length < 2) continue;
    const total = segments.length;
    // Backend returns DESC by started_at; label the earliest segment Part 1.
    segments.forEach((seg, i) => {
      map.set(seg.id ?? seg.room_id, { index: total - i, total });
    });
  }
  return map;
}

export default function ProfilePage() {
  const params = useParams<{ fid: string }>();
  const router = useRouter();
  const slug = params.fid;
  const { user: me, status } = useAuth();
  const openCompose = useComposeStore((s) => s.openCompose);

  const [profile, setProfile] = useState<ProfileUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ProfileTab>("casts");
  const [awards, setAwards] = useState<LeaderboardAward[]>([]);

  const [casts, setCasts] = useState<Cast[]>([]);
  const [castsCursor, setCastsCursor] = useState<string | null>(null);
  const [castsLoading, setCastsLoading] = useState(false);

  const [replies, setReplies] = useState<Cast[]>([]);
  const [repliesCursor, setRepliesCursor] = useState<string | null>(null);
  const [repliesLoading, setRepliesLoading] = useState(false);
  const [repliesLoaded, setRepliesLoaded] = useState(false);

  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [recordingsCursor, setRecordingsCursor] = useState<string | null>(null);
  const [recordingsLoading, setRecordingsLoading] = useState(false);
  const [recordingsLoaded, setRecordingsLoaded] = useState(false);

  const [followBusy, setFollowBusy] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [confirmBlockOpen, setConfirmBlockOpen] = useState(false);

  const isOwnProfile = !!me && !!profile && me.fid === profile.fid;

  // --- Load profile (by fid or username) + first casts page. ---
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setCasts([]);
    setCastsCursor(null);
    setReplies([]);
    setRepliesCursor(null);
    setRepliesLoaded(false);
    setRecordings([]);
    setRecordingsLoaded(false);
    setActiveTab("casts");

    const loadProfile = /^\d+$/.test(slug)
      ? getUser(Number(slug))
      : getUserByUsername(slug);

    loadProfile
      .then((p) => {
        if (!active) return;
        setProfile(p);
        setCastsLoading(true);
        return getUserCasts(p.fid).then((page) => {
          if (!active) return;
          setCasts(page.casts);
          setCastsCursor(page.nextCursor);
        });
      })
      .catch(() => {
        if (active) setError("Could not load this profile.");
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          setCastsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [slug]);

  // --- Load recognition-leaderboard award badges (empty list renders nothing). ---
  useEffect(() => {
    setAwards([]);
    if (!profile) return;
    let active = true;
    getLeaderboardAwards(profile.fid).then((data) => {
      if (active) setAwards(data);
    });
    return () => {
      active = false;
    };
  }, [profile?.fid]);

  const loadMoreCasts = useCallback(() => {
    if (!profile || castsLoading || !castsCursor) return;
    setCastsLoading(true);
    getUserCasts(profile.fid, castsCursor)
      .then((page) => {
        setCasts((prev) => [...prev, ...page.casts]);
        setCastsCursor(page.nextCursor);
      })
      .catch(() => {})
      .finally(() => setCastsLoading(false));
  }, [profile, castsCursor, castsLoading]);

  // --- Lazy-load replies the first time the Replies tab opens. ---
  useEffect(() => {
    if (activeTab !== "replies" || !profile || repliesLoaded) return;
    setRepliesLoaded(true);
    setRepliesLoading(true);
    getUserCasts(profile.fid, undefined, { includeReplies: true })
      .then((page) => {
        // Client-side guard: keep only reply casts (parent_hash set).
        // When the backend honours include_replies=true upstream this filter
        // becomes the main separator; until then it's a safety net so the tab
        // never shows top-level casts that leaked through.
        const filtered = page.casts.filter((c) => c.parent_hash !== null);
        setReplies(filtered);
        // Only advance the cursor when the page contained actual replies.
        // If the backend doesn't forward include_replies yet, all casts will be
        // top-level (filtered to zero), and we must not keep the cursor — doing
        // so would make hasMore=true and trigger infinite loadMoreReplies calls.
        setRepliesCursor(filtered.length > 0 ? page.nextCursor : null);
      })
      .catch(() => {})
      .finally(() => setRepliesLoading(false));
  }, [activeTab, profile, repliesLoaded]);

  const loadMoreReplies = useCallback(() => {
    if (!profile || repliesLoading || !repliesCursor) return;
    setRepliesLoading(true);
    getUserCasts(profile.fid, repliesCursor, { includeReplies: true })
      .then((page) => {
        const filtered = page.casts.filter((c) => c.parent_hash !== null);
        setReplies((prev) => [...prev, ...filtered]);
        // Same guard: drop the cursor if the page produced no replies after
        // filtering, preventing an infinite chain of empty fetch-and-filter.
        setRepliesCursor(filtered.length > 0 ? page.nextCursor : null);
      })
      .catch(() => {})
      .finally(() => setRepliesLoading(false));
  }, [profile, repliesCursor, repliesLoading]);

  // --- Lazy-load recordings the first time the tab opens. ---
  useEffect(() => {
    if (activeTab !== "recordings" || !profile || recordingsLoaded) return;
    setRecordingsLoaded(true);
    setRecordingsLoading(true);
    getUserRecordings(profile.fid)
      .then((page) => {
        setRecordings(page.recordings);
        setRecordingsCursor(page.nextCursor);
      })
      .catch(() => {})
      .finally(() => setRecordingsLoading(false));
  }, [activeTab, profile, recordingsLoaded]);

  const loadMoreRecordings = useCallback(() => {
    if (!profile || recordingsLoading || !recordingsCursor) return;
    setRecordingsLoading(true);
    getUserRecordings(profile.fid, recordingsCursor)
      .then((page) => {
        setRecordings((prev) => [...prev, ...page.recordings]);
        setRecordingsCursor(page.nextCursor);
      })
      .catch(() => {})
      .finally(() => setRecordingsLoading(false));
  }, [profile, recordingsCursor, recordingsLoading]);

  // --- Cast reaction / bookmark / reply wiring (optimistic). ---
  // Patches both the casts list and the replies list so optimistic updates work
  // regardless of which tab is currently visible.
  const patchCast = useCallback((hash: string, fn: (c: Cast) => Cast) => {
    setCasts((prev) => prev.map((c) => (c.hash === hash ? fn(c) : c)));
    setReplies((prev) => prev.map((c) => (c.hash === hash ? fn(c) : c)));
  }, []);

  const handleLike = useCallback(
    (cast: Cast) => {
      const wasLiked = cast.reactions.viewer_liked;
      patchCast(cast.hash, (c) => applyReaction(c, "like"));
      (wasLiked ? unlikeCast(cast.hash) : likeCast(cast.hash)).catch(() =>
        patchCast(cast.hash, (c) => applyReaction(c, "like")),
      );
    },
    [patchCast],
  );

  const handleRecast = useCallback(
    (cast: Cast) => {
      const wasRecast = cast.reactions.viewer_recasted;
      patchCast(cast.hash, (c) => applyReaction(c, "recast"));
      (wasRecast ? unrecastCast(cast.hash) : recastCast(cast.hash)).catch(() =>
        patchCast(cast.hash, (c) => applyReaction(c, "recast")),
      );
    },
    [patchCast],
  );

  const handleBookmark = useCallback(
    (cast: Cast) => {
      const wasBookmarked = cast.viewer_bookmarked;
      patchCast(cast.hash, applyBookmark);
      (wasBookmarked
        ? unbookmarkCast(cast.hash)
        : bookmarkCast(cast.hash)
      ).catch(() => patchCast(cast.hash, applyBookmark));
    },
    [patchCast],
  );

  const handlePress = useCallback(
    (cast: Cast) => router.push(`/app/cast/${cast.hash}`),
    [router],
  );

  const handleReply = useCallback(
    (cast: Cast) =>
      openCompose({
        mode: "reply",
        target: { hash: cast.hash, author: cast.author },
      }),
    [openCompose],
  );

  const handleQuote = useCallback(
    (cast: Cast) =>
      openCompose({
        mode: "quote",
        target: { hash: cast.hash, author: cast.author },
      }),
    [openCompose],
  );

  // --- Follow / block writes (optimistic). ---
  const handleFollowToggle = useCallback(async () => {
    if (!profile || isOwnProfile || followBusy) return;
    const wasFollowing = profile.following;
    setFollowBusy(true);
    setProfile((p) =>
      p
        ? {
            ...p,
            following: !wasFollowing,
            follower_count: Math.max(
              0,
              p.follower_count + (wasFollowing ? -1 : 1),
            ),
          }
        : p,
    );
    try {
      await (wasFollowing ? unfollowUser(profile.fid) : followUser(profile.fid));
    } catch {
      setProfile((p) =>
        p
          ? {
              ...p,
              following: wasFollowing,
              follower_count: Math.max(
                0,
                p.follower_count + (wasFollowing ? 1 : -1),
              ),
            }
          : p,
      );
    } finally {
      setFollowBusy(false);
    }
  }, [profile, isOwnProfile, followBusy]);

  const applyBlockedLocally = useCallback((blocked: boolean) => {
    setProfile((p) => (p ? { ...p, blocked } : p));
    if (blocked) {
      setCasts([]);
      setCastsCursor(null);
      setReplies([]);
      setRepliesCursor(null);
      setRepliesLoaded(false);
      setRecordings([]);
      setRecordingsCursor(null);
      setRecordingsLoaded(false);
    }
  }, []);

  const handleBlock = useCallback(async () => {
    if (!profile || isOwnProfile) return;
    setConfirmBlockOpen(false);
    setBlockBusy(true);
    applyBlockedLocally(true);
    try {
      await blockUser(profile.fid);
    } catch {
      applyBlockedLocally(false);
    } finally {
      setBlockBusy(false);
    }
  }, [profile, isOwnProfile, applyBlockedLocally]);

  const handleUnblock = useCallback(async () => {
    if (!profile || isOwnProfile) return;
    setBlockBusy(true);
    applyBlockedLocally(false);
    try {
      await unblockUser(profile.fid);
      setRepliesLoaded(false); // allow refetch after unblock
      setRecordingsLoaded(false); // allow refetch after unblock
    } catch {
      applyBlockedLocally(true);
    } finally {
      setBlockBusy(false);
    }
  }, [profile, isOwnProfile, applyBlockedLocally]);

  const handleBlockToggle = useCallback(() => {
    if (!profile) return;
    if (profile.blocked) {
      handleUnblock();
      return;
    }
    setConfirmBlockOpen(true);
  }, [profile, handleUnblock]);

  // Feed keyboard navigation over the active tab's cast list. The recordings
  // tab is exempt (its rows aren't casts) — pointing at an empty list makes
  // j/k/actions no-op there. Focus resets when the tab switches.
  const focusCasts =
    activeTab === "casts" ? casts : activeTab === "replies" ? replies : NO_CASTS;
  const { focusedIndex, getRowProps } = useCastListNavigation({
    items: focusCasts,
    getCast: identityCast,
    onOpen: handlePress,
    onLike: handleLike,
    onReply: handleReply,
    onRecast: handleRecast,
    onBookmark: handleBookmark,
    resetKey: activeTab,
  });

  const recordingItems = useMemo(
    () => (profile ? toRecordingFeedItems(recordings, profile) : []),
    [recordings, profile],
  );
  const partInfo = useMemo(() => computePartInfo(recordings), [recordings]);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <EmptyState
        title="Profile unavailable"
        description={error ?? "This profile could not be loaded."}
        action={
          <Button variant="ghost" onClick={() => router.refresh()}>
            Retry
          </Button>
        }
      />
    );
  }

  const canWrite = status === "authenticated";

  return (
    <div>
      {/* Header */}
      <header className="border-b border-juke-border px-4 py-5">
        <div className="flex items-start gap-4">
          <Avatar src={profile.pfp_url} name={profile.display_name} size="xl" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold text-juke-text-on-dark">
              {profile.display_name}
            </h1>
            <p className="truncate text-sm text-juke-text-on-dark-secondary">
              @{profile.username}
            </p>
            {profile.followed_by && (
              <span className="mt-1 inline-block rounded bg-juke-surface px-1.5 py-0.5 text-[10px] font-semibold text-juke-text-on-dark-secondary">
                Follows you
              </span>
            )}
          </div>
          {!isOwnProfile && canWrite && (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant={profile.following ? "ghost" : "primary"}
                loading={followBusy}
                onClick={handleFollowToggle}
              >
                {profile.following ? "Following" : "Follow"}
              </Button>
              <Button
                size="sm"
                variant={profile.blocked ? "danger" : "ghost"}
                loading={blockBusy}
                onClick={handleBlockToggle}
              >
                {profile.blocked ? "Blocked" : "Block"}
              </Button>
            </div>
          )}
        </div>

        {profile.bio && (
          <p className="mt-3 whitespace-pre-wrap break-words text-sm text-juke-text-on-dark">
            {profile.bio}
          </p>
        )}

        <div className="mt-3 flex gap-4 text-sm">
          <span className="text-juke-text-on-dark">
            <strong className="font-semibold tabular-nums">
              {profile.following_count.toLocaleString()}
            </strong>{" "}
            <span className="text-juke-text-on-dark-secondary">Following</span>
          </span>
          <span className="text-juke-text-on-dark">
            <strong className="font-semibold tabular-nums">
              {profile.follower_count.toLocaleString()}
            </strong>{" "}
            <span className="text-juke-text-on-dark-secondary">Followers</span>
          </span>
        </div>

        <AwardBadges awards={awards} className="mt-3" />
      </header>

      <TabBar
        tabs={TABS}
        value={activeTab}
        onChange={(k) => setActiveTab(k as ProfileTab)}
      />

      {profile.blocked ? (
        <EmptyState
          title="You blocked this user"
          description="Unblock them to see their casts and recordings again."
        />
      ) : activeTab === "casts" ? (
        <FeedList
          items={casts}
          getKey={(c) => c.hash}
          loading={castsLoading}
          hasMore={!!castsCursor}
          onLoadMore={loadMoreCasts}
          emptyState={<EmptyState title="No casts yet" />}
          renderItem={(cast, index) => (
            <div {...getRowProps(index)}>
              <CastCard
                cast={cast}
                focused={index === focusedIndex}
                onLike={handleLike}
                onRecast={handleRecast}
                onBookmark={handleBookmark}
                onReply={handleReply}
                onQuote={handleQuote}
                onPress={handlePress}
              />
            </div>
          )}
        />
      ) : activeTab === "replies" ? (
        <FeedList
          items={replies}
          getKey={(c) => c.hash}
          loading={repliesLoading}
          hasMore={!!repliesCursor}
          onLoadMore={loadMoreReplies}
          emptyState={<EmptyState title="No replies yet" />}
          renderItem={(cast, index) => (
            <div {...getRowProps(index)}>
              <CastCard
                cast={cast}
                focused={index === focusedIndex}
                onLike={handleLike}
                onRecast={handleRecast}
                onBookmark={handleBookmark}
                onReply={handleReply}
                onQuote={handleQuote}
                onPress={handlePress}
              />
            </div>
          )}
        />
      ) : (
        <FeedList
          items={recordingItems}
          getKey={(item) => item.recording.id ?? item.recording.room_id}
          loading={recordingsLoading}
          hasMore={!!recordingsCursor}
          onLoadMore={loadMoreRecordings}
          emptyState={<EmptyState title="No recordings yet" />}
          renderItem={(item) => (
            <RecordingFeedItem
              item={item}
              partInfo={partInfo.get(
                item.recording.id ?? item.recording.room_id,
              )}
            />
          )}
        />
      )}

      <Modal
        open={confirmBlockOpen}
        onClose={() => setConfirmBlockOpen(false)}
        title="Block user?"
      >
        <p className="text-sm text-juke-text-on-dark-secondary">
          You won&apos;t see their casts or recordings, and they won&apos;t be
          able to join spaces you host.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmBlockOpen(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleBlock}>
            Block
          </Button>
        </div>
      </Modal>
    </div>
  );
}
