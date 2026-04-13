import { useEffect, useState, useCallback, useRef } from "react";
import { View, FlatList, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useScrollToTop } from "@react-navigation/native";
import { useAuthStore } from "@/stores/authStore";
import { useComposeStore } from "@/stores/composeStore";
import { useFeed } from "@/hooks/useFeed";
import { useLiveSpaces } from "@/hooks/useLiveSpaces";
import { SpacesRail } from "@/components/spaces/SpacesRail";
import { FeedList } from "@/components/feed/FeedList";
import { ComposeModal } from "@/components/feed/ComposeModal";
import { colors } from "@/constants/theme";
import type { NeynarCast } from "@/types/neynar";

export default function HomeScreen() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  const {
    feedItems,
    isLoading,
    isRefreshing,
    hasMore,
    error,
    fetch,
    fetchMore,
    refresh,
    handleLike,
    handleRecast,
    handleVoiceNoteLike,
    handleVoiceNoteRecast,
    handlePublishCast,
  } = useFeed();

  const feedRef = useRef<FlatList>(null);
  useScrollToTop(feedRef);

  useLiveSpaces();

  useEffect(() => {
    fetch();
  }, [fetch]);

  // Compose modal state
  const [isComposeVisible, setIsComposeVisible] = useState(false);
  const [replyTarget, setReplyTarget] = useState<NeynarCast | null>(null);
  const [quoteCastTarget, setQuoteCastTarget] = useState<NeynarCast | null>(
    null,
  );

  // Listen for compose requests from the tab bar or snap compose intents
  const composeSignal = useComposeStore((s) => s.composeSignal);
  const composeDraft = useComposeStore((s) => s.draft);
  const clearDraft = useComposeStore((s) => s.clearDraft);
  const composeSignalRef = useRef(composeSignal);
  useEffect(() => {
    if (composeSignal > composeSignalRef.current) {
      setReplyTarget(null);
      setQuoteCastTarget(null);
      setIsComposeVisible(true);
    }
    composeSignalRef.current = composeSignal;
  }, [composeSignal]);

  const openReply = useCallback((cast: NeynarCast) => {
    setReplyTarget(cast);
    setQuoteCastTarget(null);
    setIsComposeVisible(true);
  }, []);

  const openQuoteCast = useCallback((cast: NeynarCast) => {
    setQuoteCastTarget(cast);
    setReplyTarget(null);
    setIsComposeVisible(true);
  }, []);

  const closeCompose = useCallback(() => {
    setIsComposeVisible(false);
    setReplyTarget(null);
    setQuoteCastTarget(null);
    clearDraft();
  }, [clearDraft]);

  return (
    <View style={styles.container}>
      <FeedList
        ref={feedRef}
        items={feedItems}
        myFid={user?.fid ?? 0}
        isLoading={isLoading}
        isRefreshing={isRefreshing}
        hasMore={hasMore}
        onRefresh={refresh}
        onEndReached={fetchMore}
        onLike={handleLike}
        onRecast={handleRecast}
        onQuoteCast={openQuoteCast}
        onReply={openReply}
        onVoiceNoteLike={handleVoiceNoteLike}
        onVoiceNoteRecast={handleVoiceNoteRecast}
        ListHeaderComponent={<SpacesRail />}
        error={error}
        onRetry={fetch}
      />

      <ComposeModal
        isVisible={isComposeVisible}
        onClose={closeCompose}
        onPublish={handlePublishCast}
        replyTo={replyTarget}
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
});
