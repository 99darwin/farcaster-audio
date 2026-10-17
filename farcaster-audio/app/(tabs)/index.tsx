import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { View, FlatList } from "react-native";
import { useScrollToTop } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuthStore } from "@/stores/authStore";
import { useFeed } from "@/hooks/useFeed";
import { useLiveSpaces } from "@/hooks/useLiveSpaces";
import { SpacesRail } from "@/components/spaces/SpacesRail";
import { FeedList } from "@/components/feed/FeedList";
import { ComposeModal } from "@/components/feed/ComposeModal";
import { TAB_BAR_CONTENT_INSET } from "@/components/navigation/GlassTabBar";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import type { FarcasterCast } from "@/types/farcaster";

export default function HomeScreen() {
  const user = useAuthStore((s) => s.user);
  const styles = useStyles();
  const insets = useSafeAreaInsets();

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
    handleBookmark,
    handleVoiceNoteLike,
    handleVoiceNoteRecast,
    handleVoiceNoteDelete,
    handleBlockAuthor,
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
  const [replyTarget, setReplyTarget] = useState<FarcasterCast | null>(null);
  const [quoteCastTarget, setQuoteCastTarget] = useState<FarcasterCast | null>(
    null,
  );

  const openReply = useCallback((cast: FarcasterCast) => {
    setReplyTarget(cast);
    setQuoteCastTarget(null);
    setIsComposeVisible(true);
  }, []);

  const openQuoteCast = useCallback((cast: FarcasterCast) => {
    setQuoteCastTarget(cast);
    setReplyTarget(null);
    setIsComposeVisible(true);
  }, []);

  const feedHeader = useMemo(() => <SpacesRail />, []);

  const closeCompose = useCallback(() => {
    setIsComposeVisible(false);
    setReplyTarget(null);
    setQuoteCastTarget(null);
  }, []);

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
        onBookmark={handleBookmark}
        onQuoteCast={openQuoteCast}
        onReply={openReply}
        onBlockAuthor={handleBlockAuthor}
        onVoiceNoteLike={handleVoiceNoteLike}
        onVoiceNoteRecast={handleVoiceNoteRecast}
        onVoiceNoteDelete={handleVoiceNoteDelete}
        ListHeaderComponent={feedHeader}
        error={error}
        onRetry={fetch}
        contentContainerStyle={{
          paddingBottom: insets.bottom + TAB_BAR_CONTENT_INSET,
        }}
      />

      <ComposeModal
        isVisible={isComposeVisible}
        onClose={closeCompose}
        onPublish={handlePublishCast}
        replyTo={replyTarget}
        quoteCast={quoteCastTarget}
      />
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flex: 1,
      backgroundColor: colors.background.main,
    },
  }));
