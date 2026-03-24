import { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { useAuthStore } from '@/stores/authStore';
import { useFeed } from '@/hooks/useFeed';
import { useLiveSpaces } from '@/hooks/useLiveSpaces';
import { SpacesRail } from '@/components/spaces/SpacesRail';
import { FeedList } from '@/components/feed/FeedList';

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
  } = useFeed();

  useLiveSpaces();

  useEffect(() => {
    fetch();
  }, [fetch]);

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
        ListHeaderComponent={<SpacesRail />}
        error={error}
        onRetry={fetch}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f23',
  },
});
