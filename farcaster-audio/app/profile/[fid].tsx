import { useEffect, useCallback, useMemo, useState } from "react";
import { FlatList, View, Text, StyleSheet, RefreshControl } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useRef } from "react";
import { useAuthStore } from "@/stores/authStore";
import { useComposeStore } from "@/stores/composeStore";
import { useProfile } from "@/hooks/useProfile";
import {
  ProfileHeader,
  type ProfileTab,
} from "@/components/profile/ProfileHeader";
import { CastCard } from "@/components/feed/CastCard";
import { VoiceNoteFeedItem } from "@/components/voice-notes/VoiceNoteFeedItem";
import { RecordingFeedItem } from "@/components/profile/RecordingFeedItem";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { ErrorView } from "@/components/common/ErrorView";
import { colors } from "@/constants/theme";
import { ComposeModal } from "@/components/feed/ComposeModal";
import {
  likeCast,
  recastCast,
  removeLike,
  removeRecast,
  publishCast,
} from "@/services/neynar";
import * as voiceNotesApi from "@/services/voiceNotes";
import * as api from "@/services/api";
import type { RecordingItem } from "@/services/api";
import type { NeynarCast } from "@/types/neynar";
import type { VoiceNoteDetail } from "@/types/voiceNote";

export default function ProfileScreen() {
  const { fid: fidParam } = useLocalSearchParams<{ fid: string }>();
  const fid = Number(fidParam);
  const router = useRouter();
  const myFid = useAuthStore((s) => s.user?.fid) ?? 0;
  const isOwnProfile = fid === myFid;

  const [activeTab, setActiveTab] = useState<ProfileTab>("casts");
  const [composeVisible, setComposeVisible] = useState(false);
  const [quoteCastTarget, setQuoteCastTarget] = useState<NeynarCast | null>(
    null,
  );

  // Listen for compose intents from snap buttons
  const composeSignal = useComposeStore((s) => s.composeSignal);
  const composeDraft = useComposeStore((s) => s.draft);
  const clearDraft = useComposeStore((s) => s.clearDraft);
  const composeSignalRef = useRef(composeSignal);
  useEffect(() => {
    if (composeSignal > composeSignalRef.current) {
      setQuoteCastTarget(null);
      setComposeVisible(true);
    }
    composeSignalRef.current = composeSignal;
  }, [composeSignal]);

  const {
    user,
    casts,
    isLoading,
    isCastsLoading,
    hasMoreCasts,
    error,
    fetchProfile,
    fetchMoreCasts,
    toggleFollow,
    updateCastReaction,
  } = useProfile(fid);

  // Voice notes state
  const [profileVoiceNotes, setProfileVoiceNotes] = useState<VoiceNoteDetail[]>(
    [],
  );
  const [vnCursor, setVnCursor] = useState<string | null>(null);
  const [vnLoading, setVnLoading] = useState(false);

  const fetchVoiceNotes = useCallback(async () => {
    setVnLoading(true);
    try {
      const data = await voiceNotesApi.getUserVoiceNotes(fid);
      setProfileVoiceNotes(data.voice_notes);
      setVnCursor(data.next_cursor);
    } catch {}
    setVnLoading(false);
  }, [fid]);

  const fetchMoreVoiceNotes = useCallback(async () => {
    if (vnLoading || !vnCursor) return;
    setVnLoading(true);
    try {
      const data = await voiceNotesApi.getUserVoiceNotes(fid, 20, vnCursor);
      setProfileVoiceNotes((prev) => [...prev, ...data.voice_notes]);
      setVnCursor(data.next_cursor);
    } catch {}
    setVnLoading(false);
  }, [fid, vnCursor, vnLoading]);

  // Recordings state
  const [recordings, setRecordings] = useState<RecordingItem[]>([]);
  const [recordingsCursor, setRecordingsCursor] = useState<string | null>(null);
  const [recordingsLoading, setRecordingsLoading] = useState(false);

  const fetchRecordings = useCallback(async () => {
    setRecordingsLoading(true);
    try {
      const data = await api.getUserRecordings(fid);
      setRecordings(data.recordings);
      setRecordingsCursor(data.next_cursor);
    } catch {}
    setRecordingsLoading(false);
  }, [fid]);

  const fetchMoreRecordings = useCallback(async () => {
    if (recordingsLoading || !recordingsCursor) return;
    setRecordingsLoading(true);
    try {
      const data = await api.getUserRecordings(fid, recordingsCursor);
      setRecordings((prev) => [...prev, ...data.recordings]);
      setRecordingsCursor(data.next_cursor);
    } catch {}
    setRecordingsLoading(false);
  }, [fid, recordingsCursor, recordingsLoading]);

  const filteredCasts = useMemo(() => {
    if (activeTab === "casts") return casts.filter((c) => !c.parent_hash);
    if (activeTab === "replies") return casts.filter((c) => !!c.parent_hash);
    // Voice notes / recordings render their own FlatList, so this value is
    // only read when on casts or replies — return an empty array otherwise.
    return [];
  }, [casts, activeTab]);

  useEffect(() => {
    fetchProfile();
    fetchVoiceNotes();
  }, [fetchProfile, fetchVoiceNotes]);

  // Lazy-fetch recordings the first time the user opens that tab.
  useEffect(() => {
    if (activeTab === "recordings" && recordings.length === 0) {
      fetchRecordings();
    }
  }, [activeTab, recordings.length, fetchRecordings]);

  const handleLike = useCallback(
    async (castHash: string, isLiked: boolean) => {
      if (!myFid) return;
      updateCastReaction(castHash, "like", !isLiked, myFid);
      try {
        if (isLiked) await removeLike(castHash);
        else await likeCast(castHash);
      } catch {
        updateCastReaction(castHash, "like", isLiked, myFid);
      }
    },
    [myFid, updateCastReaction],
  );

  const handleRecast = useCallback(
    async (castHash: string, isRecasted: boolean) => {
      if (!myFid) return;
      updateCastReaction(castHash, "recast", !isRecasted, myFid);
      try {
        if (isRecasted) await removeRecast(castHash);
        else await recastCast(castHash);
      } catch {
        updateCastReaction(castHash, "recast", isRecasted, myFid);
      }
    },
    [myFid, updateCastReaction],
  );

  const handleReply = useCallback(
    (_cast: NeynarCast) => {
      router.push(`/cast/${_cast.hash}`);
    },
    [router],
  );

  const handleQuoteCast = useCallback((cast: NeynarCast) => {
    setQuoteCastTarget(cast);
    setComposeVisible(true);
  }, []);

  const handlePublish = useCallback(
    async (
      text: string,
      _parentHash?: string,
      imageUris?: string[],
      quote?: { fid: number; hash: string },
    ): Promise<{ hash: string } | void> => {
      const result = await publishCast(
        text,
        undefined,
        imageUris && imageUris.length > 0 ? imageUris : undefined,
        quote,
      );
      await fetchProfile();
      return result;
    },
    [fetchProfile],
  );

  const handleCastPress = useCallback(
    (castHash: string) => {
      router.push(`/cast/${castHash}`);
    },
    [router],
  );

  const handleVoiceNoteLike = useCallback(
    async (id: string, isLiked: boolean) => {
      // Optimistic update
      setProfileVoiceNotes((prev) =>
        prev.map((vn) => {
          if (vn.voice_note.id !== id) return vn;
          const counts = { ...vn.reaction_counts };
          const viewer = [...vn.viewer_reactions];
          if (isLiked) {
            counts.like = Math.max(0, (counts.like || 0) - 1);
            const idx = viewer.indexOf("like");
            if (idx !== -1) viewer.splice(idx, 1);
          } else {
            counts.like = (counts.like || 0) + 1;
            if (!viewer.includes("like")) viewer.push("like");
          }
          return { ...vn, reaction_counts: counts, viewer_reactions: viewer };
        }),
      );
      try {
        if (isLiked) await voiceNotesApi.removeReaction(id, "like");
        else await voiceNotesApi.addReaction(id, "like");
      } catch {
        fetchVoiceNotes();
      }
    },
    [fetchVoiceNotes],
  );

  const handleVoiceNoteRecast = useCallback(
    async (id: string, isRecasted: boolean) => {
      setProfileVoiceNotes((prev) =>
        prev.map((vn) => {
          if (vn.voice_note.id !== id) return vn;
          const counts = { ...vn.reaction_counts };
          const viewer = [...vn.viewer_reactions];
          if (isRecasted) {
            counts.recast = Math.max(0, (counts.recast || 0) - 1);
            const idx = viewer.indexOf("recast");
            if (idx !== -1) viewer.splice(idx, 1);
          } else {
            counts.recast = (counts.recast || 0) + 1;
            if (!viewer.includes("recast")) viewer.push("recast");
          }
          return { ...vn, reaction_counts: counts, viewer_reactions: viewer };
        }),
      );
      try {
        if (isRecasted) await voiceNotesApi.removeReaction(id, "recast");
        else await voiceNotesApi.addReaction(id, "recast");
      } catch {
        fetchVoiceNotes();
      }
    },
    [fetchVoiceNotes],
  );

  const handleVoiceNoteDelete = useCallback(async (id: string) => {
    try {
      await voiceNotesApi.deleteVoiceNote(id);
      setProfileVoiceNotes((prev) =>
        prev.filter((vn) => vn.voice_note.id !== id),
      );
    } catch {}
  }, []);

  if (isLoading && !user) {
    return <LoadingSpinner fullScreen />;
  }

  if (error && !user) {
    return <ErrorView message={error} onRetry={fetchProfile} fullScreen />;
  }

  const profileHeader = user ? (
    <ProfileHeader
      user={user}
      isOwnProfile={isOwnProfile}
      onFollowToggle={toggleFollow}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  ) : null;

  return (
    <View style={styles.container}>
      {activeTab === "recordings" ? (
        <FlatList
          data={recordings}
          keyExtractor={(item) => `rec-${item.room_id}`}
          ListHeaderComponent={profileHeader}
          renderItem={({ item }) => <RecordingFeedItem item={item} />}
          onEndReached={fetchMoreRecordings}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={() => {
                fetchProfile();
                fetchRecordings();
              }}
              tintColor={colors.accent}
            />
          }
          ListFooterComponent={
            recordingsLoading ? (
              <View style={styles.footer}>
                <LoadingSpinner size="small" />
              </View>
            ) : null
          }
          ListEmptyComponent={
            !recordingsLoading ? (
              <View style={styles.empty}>
                <Text style={styles.emptyText}>No recordings yet</Text>
              </View>
            ) : null
          }
        />
      ) : activeTab === "voice_notes" ? (
        <FlatList
          data={profileVoiceNotes}
          keyExtractor={(item) => `vn-${item.voice_note.id}`}
          ListHeaderComponent={profileHeader}
          renderItem={({ item }) => (
            <VoiceNoteFeedItem
              item={item}
              onLike={handleVoiceNoteLike}
              onRecast={handleVoiceNoteRecast}
              onDelete={handleVoiceNoteDelete}
            />
          )}
          onEndReached={fetchMoreVoiceNotes}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={() => {
                fetchProfile();
                fetchVoiceNotes();
              }}
              tintColor={colors.accent}
            />
          }
          ListFooterComponent={
            vnLoading ? (
              <View style={styles.footer}>
                <LoadingSpinner size="small" />
              </View>
            ) : null
          }
          ListEmptyComponent={
            !vnLoading ? (
              <View style={styles.empty}>
                <Text style={styles.emptyText}>No voice notes yet</Text>
              </View>
            ) : null
          }
        />
      ) : (
        <FlatList
          data={filteredCasts}
          keyExtractor={(item) => item.hash}
          ListHeaderComponent={profileHeader}
          renderItem={({ item }) => (
            <CastCard
              cast={item}
              myFid={myFid}
              onLike={handleLike}
              onRecast={handleRecast}
              onQuoteCast={handleQuoteCast}
              onReply={handleReply}
              onPress={() => handleCastPress(item.hash)}
            />
          )}
          onEndReached={fetchMoreCasts}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={fetchProfile}
              tintColor={colors.accent}
            />
          }
          ListFooterComponent={
            isCastsLoading && casts.length > 0 ? (
              <View style={styles.footer}>
                <LoadingSpinner size="small" />
              </View>
            ) : null
          }
          ListEmptyComponent={
            !isLoading ? (
              <View style={styles.empty}>
                <Text style={styles.emptyText}>
                  {activeTab === "casts" ? "No casts yet" : "No replies yet"}
                </Text>
              </View>
            ) : null
          }
        />
      )}
      <ComposeModal
        isVisible={composeVisible}
        onClose={() => {
          setComposeVisible(false);
          setQuoteCastTarget(null);
          clearDraft();
        }}
        onPublish={handlePublish}
        quoteCast={quoteCastTarget}
        defaultText={composeDraft?.text}
        defaultEmbeds={composeDraft?.embeds}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.main,
  },
  footer: {
    padding: 20,
    alignItems: "center",
  },
  empty: {
    alignItems: "center",
    paddingTop: 40,
  },
  emptyText: {
    color: colors.text.secondary,
    fontSize: 15,
  },
});
