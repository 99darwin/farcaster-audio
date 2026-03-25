import { useEffect, useState, useCallback } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/stores/authStore';
import { useSpaceStore } from '@/stores/spaceStore';
import { useFeed } from '@/hooks/useFeed';
import { useLiveSpaces } from '@/hooks/useLiveSpaces';
import { SpacesRail } from '@/components/spaces/SpacesRail';
import { FeedList } from '@/components/feed/FeedList';
import { ComposeModal } from '@/components/feed/ComposeModal';
import { colors } from '@/constants/theme';
import type { NeynarCast } from '@/types/neynar';

const MINI_BAR_HEIGHT = 50;

export default function HomeScreen() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const room = useSpaceStore((s) => s.room);

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

  useLiveSpaces();

  useEffect(() => {
    fetch();
  }, [fetch]);

  const [isComposeVisible, setIsComposeVisible] = useState(false);
  const [replyTarget, setReplyTarget] = useState<NeynarCast | null>(null);
  const [quoteCastTarget, setQuoteCastTarget] = useState<NeynarCast | null>(null);

  const openCompose = useCallback(() => {
    setReplyTarget(null);
    setQuoteCastTarget(null);
    setIsComposeVisible(true);
  }, []);

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

      <Pressable
        style={[styles.fab, room && styles.fabWithMiniBar]}
        onPress={openCompose}
        accessibilityLabel="New cast"
        accessibilityRole="button"
      >
        <Ionicons name="create-outline" size={24} color={colors.text.primary} />
      </Pressable>

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
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.purple,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.purple,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  fabWithMiniBar: {
    bottom: 24 + MINI_BAR_HEIGHT,
  },
});
