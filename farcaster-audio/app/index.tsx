import { useEffect, useState, useCallback } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '@/stores/authStore';
import { useFeed } from '@/hooks/useFeed';
import { useLiveSpaces } from '@/hooks/useLiveSpaces';
import { SpacesRail } from '@/components/spaces/SpacesRail';
import { FeedList } from '@/components/feed/FeedList';
import { ComposeModal } from '@/components/feed/ComposeModal';
import { colors } from '@/constants/theme';
import type { NeynarCast } from '@/types/neynar';

export default function HomeScreen() {
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

  useLiveSpaces();

  useEffect(() => {
    fetch();
  }, [fetch]);

  const [isComposeVisible, setIsComposeVisible] = useState(false);
  const [replyTarget, setReplyTarget] = useState<NeynarCast | null>(null);

  const openCompose = useCallback(() => {
    setReplyTarget(null);
    setIsComposeVisible(true);
  }, []);

  const openReply = useCallback((cast: NeynarCast) => {
    setReplyTarget(cast);
    setIsComposeVisible(true);
  }, []);

  const closeCompose = useCallback(() => {
    setIsComposeVisible(false);
    setReplyTarget(null);
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
        onReply={openReply}
        ListHeaderComponent={<SpacesRail />}
        error={error}
        onRetry={fetch}
      />

      <Pressable
        style={styles.fab}
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
});
