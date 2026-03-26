import { useEffect, useState, useCallback, useRef } from 'react';
import { View, FlatList, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useScrollToTop } from '@react-navigation/native';
import { useAuthStore } from '@/stores/authStore';
import { useComposeStore } from '@/stores/composeStore';
import { useFeed } from '@/hooks/useFeed';
import { useLiveSpaces } from '@/hooks/useLiveSpaces';
import { SpacesRail } from '@/components/spaces/SpacesRail';
import { FeedList } from '@/components/feed/FeedList';
import { ComposeModal } from '@/components/feed/ComposeModal';
import { colors } from '@/constants/theme';
import type { NeynarCast } from '@/types/neynar';

export default function HomeScreen() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  const {
    casts,
    isLoading,
    isRefreshing,
    hasMore,
    error,
    fetch,
    fetchMore,
    refresh,
    handleLike,
    handleRecast,
    handlePublishCast,
  } = useFeed();

  const feedRef = useRef<FlatList>(null);
  useScrollToTop(feedRef);

  useLiveSpaces();

  useEffect(() => {
    fetch();
  }, [fetch]);

  const [isComposeVisible, setIsComposeVisible] = useState(false);
  const [replyTarget, setReplyTarget] = useState<NeynarCast | null>(null);
  const [quoteCastTarget, setQuoteCastTarget] = useState<NeynarCast | null>(null);

  // Listen for compose requests from the tab bar
  const composeSignal = useComposeStore((s) => s.composeSignal);
  useEffect(() => {
    if (composeSignal > 0) {
      setReplyTarget(null);
      setQuoteCastTarget(null);
      setIsComposeVisible(true);
    }
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
  }, []);

  return (
    <View style={styles.container}>
      <FeedList
        ref={feedRef}
        casts={casts}
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
